import { config } from "../config.js";
import { all, get, kvGet, kvSet, nowSec, run, tx, type Row } from "../db.js";
import { runActor } from "./apify.js";

/**
 * X (Twitter) collector. Same contract as the Telegram one: addSource(input) and
 * syncSource(source), writing the shared tables so everything downstream is unchanged.
 *
 * Two kinds of source:
 *   handle  — "x:@isro", "https://x.com/isro"      : the account's posts and replies
 *   search  — "x:chandrayaan"  (anything else after "x:") : a search query
 *
 * Tweet ids are 64-bit. They are written as BigInt so SQLite stores them exactly (a JS
 * number would round them), and the sync cursor is kept in kv as a string for the same
 * reason. The SQL joins on ext_id never see JavaScript, so replies still link.
 */

const PLATFORM = "x";
const userKey = (id: string | number) => `x:${String(id)}`;

export function parseXInput(input: string): { kind: "handle" | "search"; query: string } | null {
  const s = input.trim();
  const url = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})\/?(?:\?.*)?$/i);
  if (url) return { kind: "handle", query: url[1] };
  if (!/^x:/i.test(s)) return null;
  const rest = s.slice(2).trim();
  const handle = rest.match(/^@([A-Za-z0-9_]{1,15})$/);
  if (handle) return { kind: "handle", query: handle[1] };
  if (!rest) throw new Error('Nothing after "x:". Use x:@handle or x:<search terms>.');
  return { kind: "search", query: rest };
}

export async function addSource(input: string): Promise<Row[]> {
  const parsed = parseXInput(input);
  if (!parsed) throw new Error(`"${input}" is not an X source. Use x:@handle, an x.com profile URL, or x:<search terms>.`);
  const extId = `${parsed.kind}:${parsed.query.toLowerCase()}`;
  const title = parsed.kind === "handle" ? `@${parsed.query}` : `“${parsed.query}”`;
  run(
    `INSERT INTO sources (platform, ext_id, handle, title, kind, added_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, ext_id) DO UPDATE SET title = excluded.title`,
    PLATFORM, extId, parsed.kind === "handle" ? parsed.query : null, title, parsed.kind, nowSec(),
  );
  return [get("SELECT * FROM sources WHERE platform = ? AND ext_id = ?", PLATFORM, extId)!];
}

// ---- normalisation -------------------------------------------------------------------

interface Author {
  id: string; userName: string; name?: string; description?: string; location?: string;
  followers?: number; createdAt?: string; isVerified?: boolean; isBlueVerified?: boolean;
}
export interface Tweet {
  id: string; createdAt: string; text?: string; fullText?: string; lang?: string;
  conversationId?: string; inReplyToId?: string | null; inReplyToUserId?: string | null;
  isReply?: boolean; isRetweet?: boolean; isQuote?: boolean; quoteId?: string | null;
  quote?: Tweet | null; retweet?: Tweet | null;
  replyCount?: number; retweetCount?: number; likeCount?: number; quoteCount?: number; viewCount?: number;
  entities?: { hashtags?: { text: string }[]; user_mentions?: { id_str: string; screen_name: string; name?: string }[] };
  author?: Author;
}

function upsertAuthor(a: Author | undefined, ts: number): string | null {
  if (!a?.id) return null;
  const key = userKey(a.id);
  run(
    `INSERT INTO users (key, platform, username, display_name, bio, location, followers, kind, is_bot, bio_fetched, first_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 0, 1, ?)
     ON CONFLICT(key) DO UPDATE SET username = excluded.username, display_name = excluded.display_name,
       bio = COALESCE(NULLIF(excluded.bio, ''), users.bio), location = COALESCE(NULLIF(excluded.location, ''), users.location),
       followers = COALESCE(excluded.followers, users.followers), bio_fetched = 1`,
    key, PLATFORM, a.userName ?? null, a.name ?? a.userName ?? null, a.description ?? "", a.location ?? "",
    a.followers ?? null, ts,
  );
  return key;
}

function mentionKey(m: { id_str: string; screen_name: string; name?: string }) {
  const key = userKey(m.id_str);
  run(
    "INSERT OR IGNORE INTO users (key, platform, username, display_name, bio_fetched) VALUES (?, ?, ?, ?, 0)",
    key, PLATFORM, m.screen_name, m.name ?? m.screen_name,
  );
  return key;
}

const toTs = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** One tweet into the messages table. Returns true if it was new. */
export function storeTweet(source: Row, t: Tweet): boolean {
  if (!t?.id || !t.createdAt) return false;
  const ts = toTs(t.createdAt);
  if (!Number.isFinite(ts)) return false;
  const authorKey = upsertAuthor(t.author, ts);

  // A retweet carries the original's text and points at its author, like a Telegram forward.
  const original = t.isRetweet && t.retweet ? t.retweet : null;
  const text = (original?.fullText ?? original?.text ?? t.fullText ?? t.text ?? "").trim();
  let fwdKey: string | null = null;
  let fwdName: string | null = null;
  const fwdAuthor = original?.author ?? (t.isQuote && t.quote ? t.quote.author : undefined);
  if (fwdAuthor) {
    fwdKey = upsertAuthor(fwdAuthor, ts);
    fwdName = fwdAuthor.name ?? fwdAuthor.userName ?? null;
  }

  const mentions = new Set<string>();
  for (const m of (original ?? t).entities?.user_mentions ?? []) if (m?.id_str) mentions.add(mentionKey(m));
  const hashtags = [...new Set(((original ?? t).entities?.hashtags ?? []).map((h) => "#" + h.text.toLowerCase()))];

  const forwards = (t.retweetCount ?? 0) + (t.quoteCount ?? 0);
  const r = run(
    `INSERT OR IGNORE INTO messages
       (source_id, ext_id, author_key, text, ts, reply_to_ext_id, fwd_from_key, fwd_from_name,
        views, forwards, reactions, mentions, hashtags, analyzed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    source.id, BigInt(t.id), authorKey, text, ts, t.inReplyToId ? BigInt(t.inReplyToId) : null, fwdKey, fwdName,
    t.viewCount ?? null, forwards, t.likeCount ?? null, JSON.stringify([...mentions]), JSON.stringify(hashtags),
    text.length < 3 ? 2 : 0,
  );
  const isNew = Number(r.changes) > 0;
  // Threads worth fetching later: our own posts with replies we have not collected.
  if (isNew && (t.replyCount ?? 0) > 0 && !t.isRetweet) {
    run(
      "INSERT OR IGNORE INTO x_threads (source_id, conversation_id, reply_count, seen_at) VALUES (?, ?, ?, ?)",
      source.id, String(t.conversationId ?? t.id), t.replyCount ?? 0, ts,
    );
  }
  return isNew;
}

// ---- sync ----------------------------------------------------------------------------

const cursorKey = (source: Row) => `x_since_id_${source.id}`;
const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

/**
 * First run: newest X_BACKFILL_LIMIT posts within BACKFILL_DAYS. Later runs: only posts newer
 * than the last one seen, using the since_id search operator so the actor returns (and bills)
 * nothing we already hold.
 */
export async function syncSource(source: Row, onProgress?: (n: number) => void) {
  const sinceId = kvGet(cursorKey(source));
  const firstRun = !sinceId;
  const base = source.kind === "handle" ? `from:${source.handle}` : String(source.ext_id).replace(/^search:/, "");
  const query = firstRun ? base : `${base} since_id:${sinceId}`;
  const input: Record<string, unknown> = {
    searchTerms: [query],
    sort: "Latest",
    maxItems: firstRun ? config.x.backfillLimit : config.x.syncLimit,
    ...(firstRun ? { start: day(nowSec() - config.pipeline.backfillDays * 86400) } : {}),
  };

  const tweets = await runActor<Tweet>(input);
  let count = 0;
  let maxId = sinceId ? BigInt(sinceId) : 0n;
  tx(() => {
    for (const t of tweets) {
      if (!t?.id) continue; // the actor emits a {noResults:true} row when a query is empty
      if (storeTweet(source, t)) count++;
      const id = BigInt(t.id);
      if (id > maxId) maxId = id;
    }
  });
  if (maxId > 0n) kvSet(cursorKey(source), maxId.toString());
  run("UPDATE sources SET last_synced_at = ? WHERE id = ?", nowSec(), source.id);
  onProgress?.(count);
  return count;
}

/**
 * Replies are the network. For up to X_THREADS_PER_CYCLE posts that have replies we have
 * not fetched, pull the conversation (busiest first) and store the replies under the same
 * source, linked by reply_to_ext_id.
 */
export async function fetchThreads(limit: number) {
  const pending = all(
    `SELECT t.*, s.* , t.conversation_id AS cid FROM x_threads t JOIN sources s ON s.id = t.source_id
      WHERE t.fetched_at IS NULL ORDER BY t.reply_count DESC LIMIT ?`,
    limit,
  );
  let stored = 0;
  for (const p of pending) {
    const tweets = await runActor<Tweet>({
      conversationIds: [String(p.cid)],
      sort: "Latest",
      maxItems: config.x.threadLimit,
    });
    tx(() => {
      for (const t of tweets) if (t?.id && storeTweet(p, t)) stored++;
      run("UPDATE x_threads SET fetched_at = ?, replies_stored = ? WHERE conversation_id = ?", nowSec(),
        tweets.filter((t) => t?.id).length, String(p.cid));
    });
  }
  return stored;
}

export const pendingThreads = () => Number(get("SELECT COUNT(*) AS n FROM x_threads WHERE fetched_at IS NULL")?.n ?? 0);
