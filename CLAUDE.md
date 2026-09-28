# Sentinel — notes for Claude (and anyone else working on this)

Social media analytics framework for SIH 2026 problem statement **SIH26152** (NTRO, theme
"Blockchain & Cybersecurity"). Collects public conversations from six platforms into one
timestamped SQLite history, labels them with an LLM, and answers: how do followers feel, who
are they, what is trending, who influences whom, and (our addition) is any of it coordinated
and where did it start. Read `README.md` for the full reference; this file is the working
knowledge that is not obvious from the code.

## Stack facts

- Backend: Node **22.13+** (developed on 24/25), TypeScript run directly with `tsx`, Express 5,
  `node:sqlite` (synchronous, WAL). No build step. Imports inside `backend/src` use `.js`
  extensions (NodeNext). Type-check: `npm run typecheck`. Tests: `npm test` (node:test,
  in-memory DB, mock model).
- Frontend: React 19 + Vite + TypeScript, Recharts, react-force-graph-2d. Type-check with
  `npx tsc --noEmit`. Dev server proxies `/api` to `:4000`. Monochrome design system; colour is
  for text only (`.pos .neg .accent .warn`); data marks use the grey ramp `--g1…--g5`.
- One process does everything: `pipeline.ts` runs a cycle (collect → seal → topics →
  sentiment → demographics) every `SYNC_INTERVAL_SEC`, or every 15 s while an LLM backlog
  exists **and an LLM is configured** (without one the quick loop would fetch paid X threads
  forever — that bug happened).

## Run

```bash
cd backend && cp .env.example .env   # fill keys; .env is git-ignored, never commit it
npm install && npm run dev            # API on :4000
cd ../frontend && npm install && npm run dev   # UI on :5173 (Meridian uses 5173 on this laptop; use --port 5174)
```

Useful: `npm run verify` (collection log), `npm run eval -- --check` (labeller vs frozen
thresholds), `npm run db:snapshot` (consistent copy of the DB for a demo), `npm test`.

## Keys and money

| Key | For | Cost |
|---|---|---|
| `APIFY_TOKEN` | X, Instagram, Facebook | Starter plan $29/mo; ~$0.40 per 1k tweets. **`X_MONTHLY_BUDGET_USD` stops collection**; the Sources page shows spend. Apify fills in a run's cost a few seconds *after* it reports SUCCEEDED — `runActor()` waits for it. |
| `TG_API_ID/HASH/PHONE` + `npm run telegram:login` | Telegram | free; one process may hold the session at a time |
| `YOUTUBE_API_KEY` | YouTube Data API v3 | free, 10k units/day |
| `REDDIT_CLIENT_ID/SECRET` | Reddit OAuth | free; without them the public feed is used and Reddit 429s after one or two requests |
| `AZURE_OPENAI_*` / `GROQ_API_KEY` / `LLM_PROVIDER=ollama` | labelling | Azure is what we demo with; Ollama is the on-premise story |
| `APP_PASSWORD` | sign-in | set on any host; empty = open API |

Keys pasted in chat during development (Apify, YouTube, Azure) must be rotated after the event.

## Conventions that matter

- **All LLM calls go through `chatJSON()` in `llm/groq.ts`** (provider switch, pacing, pauses,
  JSON parsing, mock). Label values are snapped with `pick()` onto `analysis/labels.ts`;
  free text breaks every chart. The pipeline and the eval harness share `labelTexts()` so the
  measured accuracy is the shipped accuracy.
- **Every collector has the same shape**: `parse…Input(input)`, `addSource(input)`,
  `syncSource(source)`, optional `fetchThreads(limit)` / `pendingThreads()`. Rows go in the
  shared tables with `platform` set and user keys `"<platform>:<id>"`. `POST /sources`
  branches on the input's shape (`x:`, `r/`, youtube URL, instagram/facebook URL, else
  Telegram). Add a platform by copying `x/collector.ts`.
- **`messages.ext_id` is a 64-bit INTEGER.** Write tweet/IG/FB ids as `BigInt`, Reddit ids via
  `base36ToBigInt`, opaque ids (YouTube) via `fnv64`. Never read `ext_id` into a JS number;
  in SQL use `CAST(ext_id AS TEXT)` if it must reach JavaScript. Joins on
  `reply_to_ext_id = ext_id` happen in SQL and are exact. The X sync cursor is a string in `kv`.
- **`threads`** (platform, conversation_id) is the queue of posts whose replies are fetched
  later, busiest first, a few per cycle. Replies are the network; fetch them.
- **Dashboard reads use `scope(range)`** from `db.ts`, which also excludes soft-deleted
  sources. Sources are never hard-deleted: their rows stay sealed in the collection log.
- **Collection log**: `chain.sealNew()` runs once per cycle after collection; `chain.verify()`
  is public (`GET /integrity/verify`). Never update or delete `messages` rows in application
  code. Tests prove an edit and a deletion are caught.
- **Privacy**: per-user demographic profiles never leave the backend (aggregates only, groups
  < 3 folded). `/export` follows the same rule. The AI briefing receives computed metrics, not
  raw text.
- **Coordination/origin (`analysis/coordination.ts`) are counts and timestamps, not model
  output**, on purpose: an analyst must be able to say why a row is there.

## Evaluation

`eval/README.md`. First real run (azure/gpt-5.6-terra, reasoning low, 200 TweetEval samples
per task): sentiment 0.60 acc / 0.59 F1 (AFINN 0.55), emotion 0.72/0.72, irony 0.945/0.944,
stance 0.76/0.66 (majority 0.73). Thresholds in `eval/thresholds.json` sit a little under;
raise them when the labeller improves, never lower them to pass.

## Demo plan

Collect days ahead, `npm run db:snapshot`, run from `DB_FILE=data/snapshots/<file>` with live
sync on top. Default UI range is 7d; most collected history is older — switch to 30d/90d.
Terminal beside the browser: `npm run dev` log, `npm run verify` then a `sqlite3` edit to turn
the Integrity badge red and back, `npm run eval -- --check`, `curl …/api/export?dataset=report`.
The Integrity page already shows a real coordinated burst (a film promo posted by five
accounts within seven minutes) on the collected data.

## Known gaps / next

- Telegram must be connected on the demo machine (the essential platform besides X).
- Reddit comments need OAuth keys; the feed path is posts-only in practice.
- Facebook comment scraper is the least reliable collector; inline top comments always work.
- UI polish wanted: default 30d, per-platform tile on Overview, coloured segments on the
  graph, auto-generated briefing, Origin pre-filled with the top topic.
- Hosting configs exist (`railway.json`, `frontend/vercel.json`) but nothing is deployed yet.
- Work lives on the `x-collector` branch of the fork `Aditya-v05/sentinel`, PR #1 into
  `AnanthuNarashimman/sentinel` (Aditya's account has no push access to the upstream repo).
