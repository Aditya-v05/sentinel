# Sentinel — Audience Intelligence

An AI-driven social media analytics framework. It collects public conversations, then uses an LLM and graph analysis to answer four questions about an audience:

| Question | Problem-statement component | How |
|---|---|---|
| How do they feel? | **B. Multi-dimensional sentiment** | LLM labels every message: polarity + score, emotion, sarcasm, stance, topic |
| Who are they? | **C. Demographic profiling** | LLM estimates language, region, age bracket, interests, profession — shown only as aggregates |
| What are they talking about? | **D. Trend & topic detection** | LLM-discovered topics, rising keywords, linear forecast, viral posts |
| Who influences whom? | **E. Link analysis & network topology** | Reply / mention / forward graph → PageRank, betweenness, Louvain communities, spread over time |
| (foundation) | **A. Continuous collection & timeline** | Backfill + incremental sync into a timestamped SQLite history |

**Iteration 1 covered Telegram; iteration 2 adds X (Twitter).** The schema is platform-agnostic (`platform` column, `"<platform>:<id>"` user keys), so both write the same tables and every metric works across them. Telegram and the LLM run on free tiers; X runs on Apify credit with a hard monthly budget.

---

## Contents

1. [Quick start](#quick-start)
2. [Architecture](#architecture)
3. [Repository map](#repository-map)
4. [Pipeline in detail](#pipeline-in-detail)
5. [Data model](#data-model)
6. [HTTP API](#http-api)
7. [Configuration](#configuration)
8. [Free-tier limits (important)](#free-tier-limits-important)
9. [Frontend](#frontend)
10. [Privacy & security](#privacy--security)
11. [Known limitations](#known-limitations)
12. [Extending (adding X, new metrics)](#extending)
13. [Notes for AI agents / contributors](#notes-for-ai-agents--contributors)

---

## Quick start

**Requirements:** Node.js **22.13+** (uses the built-in `node:sqlite` module and `process.loadEnvFile`; developed on Node 24). No Python, no database server.

### 1. Get the keys (all free)

| Variable | Where to get it |
|---|---|
| `TG_API_ID`, `TG_API_HASH` | https://my.telegram.org → log in with your phone → **API development tools** → create an app (platform: Desktop). Copy *App api_id* and *App api_hash*. |
| `TG_PHONE` | Phone number of the Telegram account used for reading, international format (`+91…`). Prefer an established spare account. |
| `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_CHAT_DEPLOYMENT` | Azure OpenAI, if you have a deployment (used when set). Otherwise: |
| `GROQ_API_KEY` | https://console.groq.com/keys (starts with `gsk_`) — free tier |
| `APIFY_TOKEN` | https://console.apify.com → Settings → Integrations. Needed for X only. The free plan's monthly credit covers roughly 10,000 tweets. |

### 2. Configure

```bash
cd backend
cp .env.example .env        # then fill in the four values above
```

`.env` is git-ignored. **Never commit it.**

### 3. Install and log in to Telegram (once)

```bash
cd backend
npm install
npm run telegram:login      # Telegram sends a code to your Telegram app; type it (and 2FA password if set)
```

This writes `backend/data/telegram.session`. The server reuses it — you won't be asked again. Treat this file like a password (it is full access to the account); it is git-ignored.

### 4. Run

```bash
# terminal 1
cd backend && npm run dev          # API on http://localhost:4000 (auto-restarts on code changes)

# terminal 2
cd frontend && npm install && npm run dev   # UI on http://localhost:5173 (proxies /api -> :4000)
```

### 5. Add sources

Open http://localhost:5173 → **Sources** → add a public group or channel: `@groupname` or `https://t.me/groupname`.

- **Public groups are best** — that is where followers actually write.
- Adding a **broadcast channel** automatically adds its linked **discussion group** (if it has one), because channel posts alone contain no audience text.
- Private invite links (`t.me/+…`) are not supported.
- **X:** `x:@handle` or an `x.com/handle` URL collects that account's posts; `x:<search terms>` collects a search (X search operators work, e.g. `x:chandrayaan lang:hi`). The busiest posts' reply threads are fetched afterwards, a few per cycle.

The pipeline starts immediately. The first backfill (up to 500 messages per source) takes a few minutes to collect and ~40 messages/min to label on the free tier; afterwards only new messages are processed.

---

## X (Twitter) collection and the demo dataset

There is no free way to read X: the official API's read access starts at about $200 a month. Sentinel collects X through **Apify** (`apidojo/tweet-scraper`, about $0.40 per 1,000 tweets, chosen over the cheaper actors because its thread fetches return only the thread and its language filter takes any ISO code). The actor runs on Apify's side; no X account of ours is involved.

How it spends, and how it stops:

- **First sync** of a source: newest `X_BACKFILL_LIMIT` posts within `BACKFILL_DAYS`. **Later syncs:** only posts newer than the last seen id (`since_id`), so a quiet source costs nothing.
- **Threads:** posts with replies are queued in `x_threads`; each cycle fetches `X_THREADS_PER_CYCLE` of them, busiest first, `X_THREAD_LIMIT` replies each. Replies are what build the network.
- **Budget:** every run's cost is read back from Apify into `kv` (`apify_spend_<month>`). Once it reaches `X_MONTHLY_BUDGET_USD` the collector pauses and the Sources page says so; Telegram and the LLM carry on. The page also shows the whole account's usage against its plan.

**Plan for a demo: collect early, snapshot, run from the snapshot.** Add the sources days ahead, let the backfill and threads finish, then

```bash
cd backend && npm run db:snapshot        # -> data/snapshots/analytics-<date>.db
DB_FILE=data/snapshots/analytics-<date>.db npm run dev
```

The demo then runs on data you hold, with live sync on top if the actor is up that morning. Snapshots are git-ignored.

Tweet ids are 64-bit and are written as BigInt; the sync cursor lives in `kv` as a string. Do not read `ext_id` into JavaScript numbers.

---

## Architecture

```
                    ┌──────────────────────────── backend (Node + TypeScript, Express) ───────────────────────────┐
 Telegram (MTProto) │  telegram/collector.ts ──► SQLite (node:sqlite, WAL)  ◄── analysis/*.ts (read-side metrics)  │
   via GramJS  ────►│        ▲                         ▲      │                          │                        │
                    │        │ pipeline.ts (scheduler)  │      ▼                          ▼                        │
 Groq LLM API  ◄────│  llm/groq.ts ◄── sentiment / demographics / topics / insights    routes.ts  (/api/*)        │
 (free tier)        └────────────────────────────────────────────────────────────────────────┬──────────────────┘
                                                                                             │ JSON
                                                         frontend (React + Vite, Recharts, force-graph) ◄┘
```

Two kinds of work:

- **Write side (background pipeline)** — collects messages and enriches them with LLM labels. Incremental, idempotent, rate-limit aware. Results are stored in columns of the same tables.
- **Read side (per request)** — the dashboard endpoints compute aggregates, trends, forecasts and graph metrics on the fly from SQLite for the selected source + time range. No LLM calls except the optional AI briefing.

---

## Repository map

```
backend/
  .env.example            all configuration keys, documented
  src/
    server.ts             Express app, mounts /api, starts the scheduler
    config.ts             reads .env (process.loadEnvFile) into a typed config object
    db.ts                 SQLite schema (CREATE TABLE IF NOT EXISTS), query helpers, scope() filter helper
    pipeline.ts           the background cycle: collect -> bios -> topics -> sentiment -> demographics
    routes.ts             all HTTP endpoints
    x/
      apify.ts            Apify runs: start, poll, read cost back, monthly budget guard
      collector.ts        add X sources, backfill / since_id sync, reply-thread fetch, tweet normalisation
    snapshot.ts           npm run db:snapshot — consistent copy of the database for a demo
    telegram/
      client.ts           shared GramJS client; connection + auth state
      login.ts            one-time interactive login (npm run telegram:login)
      collector.ts        add sources, backfill/incremental sync, message normalisation, bio fetching
    llm/
      groq.ts             chatJSON() wrapper: JSON mode, tokens-per-minute pacing, rate-limit pause, reasoning params
    analysis/
      labels.ts           fixed label vocabularies (sentiments, emotions, stances, age brackets, interests, professions)
      topics.ts           LLM topic discovery (per source + periodic refresh)
      sentiment.ts        batched message labelling (write side)
      demographics.ts     batched user profiling (write side) + aggregate view (read side)
      timeline.ts         overview + sentiment time series (read side)
      trends.ts           keyword trends, topic series, forecasts, viral posts (read side)
      network.ts          interaction graph, PageRank, betweenness, Louvain, spread (read side)
      insights.ts         LLM-written briefing from computed metrics (read side, on demand)
    util/
      range.ts            ?source=&days= -> time window + bucket size
      text.ts             tokenizer + stopwords for keyword trends
  data/                   (git-ignored) analytics.db + telegram.session

frontend/
  index.html              loads Geist / Geist Mono from Google Fonts
  vite.config.ts          dev server on :5173, proxies /api to :4000
  src/
    App.tsx               shell: sidebar nav, live status footer, routes
    styles.css            design tokens (light + dark), layout, components
    lib/api.ts            fetch helper, useApi() hook, response types
    lib/filters.tsx       global source + time-range filter (persisted in localStorage)
    lib/format.ts         number/date formatting, semantic tone classes
    components/ui.tsx     Page, Card, Stat, BarList, Spark (sparkline), ChartTip, Legend
    pages/                Overview, Sentiment, Audience, Trends, Network, Sources
```

---

## Pipeline in detail

`pipeline.ts` runs one **cycle** at a time. A cycle:

1. **Collect** (`collector.syncSource`) for every source.
   - First run: newest `BACKFILL_LIMIT` messages within `BACKFILL_DAYS`.
   - Later runs: only messages with id > `last_message_id`.
   - Each message is normalised: author, text, timestamp, reply-to, forward origin, views, forwards, reactions, @mentions (resolved to user keys), #hashtags. Very short / media-only messages are stored but marked `analyzed = 2` (skipped).
   - Authors use **raw** peer ids (`tg:<id>`). Telegram's "marked" channel ids (`-100…`) are deliberately not used so forwards and posts by the same channel map to one node.
2. **Fetch bios** (`collector.fetchBios`) — up to `BIO_FETCH_PER_CYCLE` users; stops on Telegram FloodWait.
3. **Topic discovery** (`topics.ensureTopics`)
   - Each source gets one discovery pass the first time it has ≥10 messages (so a busy source can't crowd out a quiet one).
   - Every 6 h, new messages from all sources are checked for *new* themes (max 3 per refresh, 24 total). `created_at` records when a theme emerged; the UI marks topics found after the initial pass as **new**.
   - Topics are broad recurring themes, deduplicated with Unicode-normalised labels.
4. **Sentiment** (`sentiment.analyzeMessages`) — up to `ANALYZE_PER_CYCLE` pending messages, 20 per LLM call, newest first. Replies include the parent message for context. The model returns compact rows `[i, sentiment, score, emotion, sarcasm, stance, topic]`; values are snapped onto the fixed vocabularies in `labels.ts`. If a batch fails (e.g. truncated JSON), it is split in half and retried; a single message that still fails is marked skipped.
5. **Demographics** (`demographics.profileUsers`) — up to `PROFILE_PER_CYCLE` users who have posted and whose bio fetch was attempted; 10 users per LLM call (name, username, bio, 5 sample messages).

Scheduling: after a cycle, if messages are still pending the next cycle starts in ~15 s (or right when a Groq pause ends); otherwise after `SYNC_INTERVAL_SEC`. `POST /api/pipeline/run` or adding a source triggers a cycle immediately. Only one cycle runs at a time.

### Label vocabularies (`analysis/labels.ts`)

| Field | Values |
|---|---|
| sentiment | positive, neutral, negative (+ score −1…1; sarcastic praise counts as negative) |
| emotion | excitement, joy, hope, neutral, surprise, anxiety, anger, sadness |
| sarcasm | 0 / 1 |
| stance | supportive, neutral, against (toward the subject under discussion / the parent message) |
| age_bracket | 13-17, 18-24, 25-34, 35-44, 45-54, 55+, unknown |
| interests (1–3) | technology, politics, finance & crypto, sports, entertainment, education, health, business, religion, news & current affairs, gaming, travel, other |
| profession | student, tech professional, business owner, finance professional, educator, healthcare, media / journalist, public sector, creative, homemaker, retired, unknown |

Changing a vocabulary: edit `labels.ts`; the prompts and the snapping use it automatically. The frontend reads whatever labels the API returns.

### Read-side algorithms

- **Time window** (`util/range.ts`): the window **ends at the newest message in scope** (not "now"), so a quiet source still shows its last N days. Buckets: 1 h for ≤3 days, 6 h for ≤14 days, else 1 day.
- **Rising keywords** (`trends.ts`): per-bucket document frequency; recent window = last 25 % of buckets; growth = smoothed ratio of recent rate vs. earlier rate; ranked by `growth × log(1 + recent)`, requiring ≥3 recent mentions.
- **Topic forecast**: least-squares line through the last 8 buckets, projected 3 buckets ahead; trend = rising / falling / stable if the fitted change over the window exceeds ±30 % of the mean.
- **Viral posts**: `forwards×3 + reactions×2 + replies×2 + views/100`.
- **Network** (`network.ts`): directed edge A→B when A replied to, @mentioned, or forwarded B (weights summed). PageRank = influence ("key opinion leaders"); reach = distinct accounts pointing at a node; betweenness = bridging (computed when ≤1500 nodes); Louvain = communities ("segments"), renumbered by size, the 7 largest with ≥3 members kept, the rest "Unclustered". The UI renders the top 400 nodes by PageRank. Results are cached for 60 s per (source, window).
- **Spread**: per community, message volume and average sentiment per bucket for a topic, ordered by when each community first discussed it.
- **AI briefing** (`insights.ts`): sends only computed metrics (never raw messages) to the insights model; cached 10 min.

---

## Data model

SQLite file `backend/data/analytics.db` (override with `DB_FILE`). Schema is created on startup in `db.ts`; there are no migrations — additive changes go into the `CREATE TABLE IF NOT EXISTS` block (delete the DB to rebuild during development).

| Table | Purpose | Key columns |
|---|---|---|
| `sources` | channels / groups being collected | `platform`, `ext_id`, `access_hash`, `handle`, `title`, `kind` (channel/group), `linked_source_id`, `last_message_id`, `last_synced_at` |
| `users` | every author / mentioned / forwarded account | `key` = `"tg:<id>"` (or `"tg:@username"` for unresolved mentions), `username`, `display_name`, `bio`, `kind` (user/channel), `is_bot`, `bio_fetched` (0 no, 1 yes, 2 unreachable) |
| `messages` | the timestamped history + analysis columns | `source_id`, `ext_id`, `author_key`, `text`, `ts` (unix s, UTC), `reply_to_ext_id`, `fwd_from_key`, `views`, `forwards`, `reactions`, `mentions` (JSON), `hashtags` (JSON), `analyzed` (0 pending, 1 done, 2 skipped), `sentiment`, `sentiment_score`, `emotion`, `sarcasm`, `stance`, `topic_id` |
| `topics` | discovered themes | `label`, `keywords` (JSON), `description`, `created_at` |
| `profiles` | inferred demographics per user (never exposed individually) | `user_key`, `language`, `region`, `age_bracket`, `interests` (JSON), `profession` |
| `kv` | small pipeline state | e.g. `topics_source_<id>`, `x_since_id_<source>`, `apify_spend_<month>` |
| `x_threads` | X posts whose replies are worth fetching | `conversation_id`, `source_id`, `reply_count`, `replies_stored`, `fetched_at` |

Useful resets (backend stopped or not — SQLite is WAL):
- Start over completely: delete `backend/data/analytics.db*` (keep `telegram.session`).
- Re-label everything: `UPDATE messages SET analyzed = 0 WHERE analyzed = 1;`
- Rediscover topics: `DELETE FROM topics; DELETE FROM kv WHERE key LIKE 'topics_%'; UPDATE messages SET topic_id = NULL;`

---

## HTTP API

Base: `http://localhost:4000/api`. All dashboard endpoints accept `?days=1|7|30|90` (default 7) and optional `&source=<id>`. Errors return `400 {"error": "..."}`.

| Method & path | Returns |
|---|---|
| `GET /status` | Telegram connection state, LLM config/pause state, pipeline stage + activity log, row counts |
| `GET /sources` | sources with message counts and history range |
| `POST /sources` `{"handle": "@name" \| "https://t.me/name"}` | the source(s) added (a channel may add its discussion group too); triggers a cycle |
| `DELETE /sources/:id` | removes a source and its messages |
| `POST /pipeline/run` | runs a cycle as soon as possible |
| `GET /topics` | all discovered topics |
| `GET /overview` | totals + message volume per bucket |
| `GET /sentiment` | per-bucket sentiment / emotion / stance / sarcasm counts, avg score, totals, example messages |
| `GET /demographics` | aggregate tallies for language, region, age, interests, profession (small groups folded into "other") |
| `GET /trends` | rising + top keywords (with series), topics (series, forecast, trend, avg sentiment, isNew), viral posts |
| `GET /network` | graph nodes/edges (top 400), influencers, communities |
| `GET /network/spread?topic=<id>` | per-community volume + sentiment over time for a topic (or all messages) |
| `POST /insights` | LLM briefing `{headline, bullets[]}` for the current filters |

Every time-series response carries `buckets` (unix start of each bucket) and `bucketSec`.

---

## Configuration

All in `backend/.env` (see `.env.example`):

| Key | Default | Meaning |
|---|---|---|
| `TG_API_ID`, `TG_API_HASH`, `TG_PHONE` | — | Telegram app credentials + login phone |
| `GROQ_API_KEY` | — | Groq key |
| `GROQ_MODEL` | `openai/gpt-oss-20b` | model for bulk labelling (sentiment, topics, demographics) |
| `GROQ_INSIGHTS_MODEL` | `openai/gpt-oss-120b` | model for the AI briefing |
| `GROQ_TPM` | `8000` | tokens-per-minute budget the client paces itself under |
| `PORT` | `4000` | API port |
| `SYNC_INTERVAL_SEC` | `300` | time between cycles when there's no backlog |
| `BACKFILL_LIMIT` | `500` | max messages per source on first sync |
| `BACKFILL_DAYS` | `30` | how far back the first sync goes |
| `ANALYZE_PER_CYCLE` | `200` | messages labelled per cycle |
| `PROFILE_PER_CYCLE` | `40` | users profiled per cycle |
| `BIO_FETCH_PER_CYCLE` | `30` | Telegram bios fetched per cycle |
| `DB_FILE` | `backend/data/analytics.db` | alternative database path (point it at a snapshot for a demo) |
| `APIFY_TOKEN`, `APIFY_ACTOR` | —, `apidojo~tweet-scraper` | X collection via Apify |
| `X_BACKFILL_LIMIT`, `X_SYNC_LIMIT` | `300`, `60` | posts per first sync / per later sync, per source |
| `X_THREADS_PER_CYCLE`, `X_THREAD_LIMIT` | `3`, `40` | reply threads fetched per cycle, replies per thread |
| `X_MONTHLY_BUDGET_USD` | `15` | X collection pauses once this month's Apify spend reaches it |

`.env` is read at startup only — restart the backend after editing it (with `npm run dev`, touching any `src` file also restarts it).

---

## Free-tier limits (important)

Measured on the Groq free tier (September 2026 — re-check, these change):

- ~**8,000 tokens/minute** and ~1,000 requests/day **per model**.
- Some models (e.g. `qwen/qwen3.8-27b`) additionally cap **output at 1,000 tokens/minute** and count `max_tokens` up front — too slow for bulk labelling. The `openai/gpt-oss-*` models don't have that extra cap, which is why they are the defaults.
- `llm/groq.ts` tracks actual token usage over a rolling minute and waits before exceeding `GROQ_TPM`. If Groq still returns 429, LLM work pauses until the retry time and collection continues.
- gpt-oss models are reasoning models; `reasoning_effort: "low"` and `include_reasoning: false` are sent to keep token use down.
- Practical throughput: **~40 labelled messages/minute** during a backfill.
- Model names get retired — list current ones at https://console.groq.com/docs/models (or call `GET https://api.groq.com/openai/v1/models`).

Telegram: reading public groups doesn't require joining them. Bio lookups are rate-limited by Telegram (FloodWait) and only work for users seen since the server started (their access hash is cached in memory).

---

## Frontend

React 19 + Vite + TypeScript. Pages: **Overview** (KPIs, volume, AI briefing), **Sentiment** (positive-vs-negative diverging bars, avg score, emotion small multiples, stance, sarcasm), **Audience** (aggregate bars), **Trends** (topics with forecast, rising/top keywords, viral posts), **Network** (force graph with time slider, KOL table, segments, spread table), **Sources** (setup checklist, add/remove sources, pipeline status + log).

Design system (keep it consistent when adding UI):
- Monochrome, Scandinavian: warm paper white / near-black, 1 px hairlines, 10 px radius, no shadows, generous spacing. Fonts: **Geist** (UI) and **Geist Mono** (numbers, labels).
- **Colour is for text only**, as semantic accents: `.pos` (positive / rising), `.neg` (negative / falling), `.accent` (sarcasm, "new"), `.warn`. Data marks use the grey ramp `--g1…--g5`.
- All colours are CSS variables in `styles.css` with light and dark values (follows the OS; `data-theme="light|dark"` on `<html>` forces one).
- The network graph draws on canvas, so it reads the tokens via `getComputedStyle` (`useTokens()` in `pages/Network.tsx`).

---

## Privacy & security

- Only **public** channels/groups are collected; no private chats.
- Demographics are exposed **only as aggregates**; any bucket with fewer than 3 people is folded into "other". Per-user profiles never leave the backend.
- The AI briefing sends only computed metrics to the LLM.
- Secrets live in `backend/.env` and `backend/data/telegram.session`, both git-ignored (see root `.gitignore`). If a session file leaks, terminate it in Telegram → Settings → Devices.
- The API has no authentication — it is meant to run locally. Don't expose port 4000 publicly as-is.

---

## Known limitations

- Telegram profiles have no age/location fields, so region and age are inferred from writing and are often "unknown". Present them as estimates.
- Broadcast channels without a discussion group yield almost no audience text.
- Topic forecasts are simple linear extrapolations (by design — cheap and explainable).
- Messages labelled before a new topic appears keep their old topic (no retroactive re-labelling).
- Bio fetches fail for users not seen since the last server start (Telegram access-hash cache is in memory).
- Rising keywords use an English stopword list; other languages will surface more common words.

---

## Extending

### Adding another platform (Reddit, YouTube, …)
`backend/src/x/collector.ts` is the template: `addSource(input)` and `syncSource(source)`, rows with `platform = '<name>'`, user keys `"<name>:<id>"`, the same `messages` columns (`reply_to_ext_id` = parent id, `fwd_from_key` = reshared author, `mentions` = user keys). Call it from `pipeline.runCycle()` for its platform and branch `POST /sources` on the input format. Everything downstream works unchanged because it only reads the shared tables.

### Adding a metric
Write a read-side function in `analysis/` taking a `Range` (use `scope(r)` for the WHERE clause and `bucketOf` / `bucketStarts` for time series), expose it in `routes.ts`, and add a page/card in `frontend/src/pages`.

---

## Notes for AI agents / contributors

- **Stack facts:** ESM TypeScript run directly with `tsx` (no build step for the backend). Type-check with `npm run typecheck` (backend) and `npx tsc --noEmit` (frontend). Imports inside `backend/src` use `.js` extensions (NodeNext resolution).
- **Never commit** `backend/.env`, `backend/data/`, or any `*.session` / `*.db` file.
- **LLM calls go through `chatJSON()`** in `llm/groq.ts` only — it handles pacing, pauses and JSON parsing, and picks Azure OpenAI or Groq from `config.llm.provider`. Throw/propagate `LlmPausedError` so the pipeline can skip gracefully.
- **Label values must come from `labels.ts`** and be snapped with `pick()`; free-text labels break aggregation.
- **SQLite access is synchronous** (`node:sqlite` `DatabaseSync`); wrap multi-row writes in `tx()`. Helpers: `all`, `get`, `run`, `kvGet`, `kvSet`.
- **graphology packages are CommonJS**; `network.ts` loads them via `createRequire` for correct interop — keep that pattern.
- **Telegram ids:** always derive user/channel keys from raw peer ids (`peerKey()` in `collector.ts`), never from `senderId` (marked ids for channels).
- Only one GramJS client should be connected with the session at a time — don't run ad-hoc scripts with the session while the server is running.
- Verify UI changes in both light and dark mode and at phone width (~390 px).
