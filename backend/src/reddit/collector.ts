import { config } from "../config.js";
import { all, get, nowSec, run, tx, type Row } from "../db.js";
import { base36ToBigInt, hashtagsOf, mentionsOf } from "../util/ids.js";

/**
 * Reddit collector. Sources are subreddits ("r/isro", "reddit.com/r/isro"). Posts are
 * messages; each post with comments is queued in `threads` and its comment tree is fetched
 * a few per cycle, replies linked by reply_to_ext_id, so the network sees the whole thread.
 *
 * Two transports behind one interface:
 *   OAuth  (REDDIT_CLIENT_ID/SECRET, a free "script" app): the JSON API, 100 requests a minute.
 *   Feed   (no keys): the public Atom feeds. Reddit throttles these to a request every few
 *          seconds per address and returns no comment tree past the first level, so it is a
 *          fallback for a demo without keys, not the way to collect.
 */

const PLATFORM = "reddit";
const userKey = (id: string) => `reddit:${id}`;
const MENTION_RE = /(?:^|\s)u\/([A-Za-z0-9_-]{3,20})/g;

export function parseRedditInput(input: string): { kind: "subreddit"; query: string } | null {
  const s = input.trim();
  const m = s.match(/^(?:https?:\/\/)?(?:www\.|old\.)?reddit\.com\/r\/([A-Za-z0-9_]{2,21})\/?/i) ?? s.match(/^\/?r\/([A-Za-z0-9_]{2,21})$/i);
  return m ? { kind: "subreddit", query: m[1] } : null;
}

export async function addSource(input: string): Promise<Row[]> {
  const parsed = parseRedditInput(input);
  if (!parsed) throw new Error(`"${input}" is not a subreddit. Use r/name or a reddit.com/r/name link.`);
  const extId = `subreddit:${parsed.query.toLowerCase()}`;
  run(
    `INSERT INTO sources (platform, ext_id, handle, title, kind, added_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, ext_id) DO UPDATE SET title = excluded.title`,
    PLATFORM, extId, parsed.query, `r/${parsed.query}`, "subreddit", nowSec(),
  );
  return [get("SELECT * FROM sources WHERE platform = ? AND ext_id = ?", PLATFORM, extId)!];
}

// ---- transport -----------------------------------------------------------------------

export const redditConfigured = () => Boolean(config.reddit.clientId && config.reddit.clientSecret);
let token: { value: string; expires: number } | null = null;
let lastFeedAt = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bearer() {
  if (token && Date.now() < token.expires - 60_000) return token.value;
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      authorization: "Basic " + Buffer.from(`${config.reddit.clientId}:${config.reddit.clientSecret}`).toString("base64"),
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": config.reddit.userAgent,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Reddit auth ${res.status}: check REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET`);
  const d = (await res.json()) as { access_token: string; expires_in: number };
  token = { value: d.access_token, expires: Date.now() + d.expires_in * 1000 };
  return token.value;
}

async function apiJSON<T>(path: string): Promise<T> {
  const res = await fetch(`https://oauth.reddit.com${path}${path.includes("?") ? "&" : "?"}raw_json=1`, {
    headers: { authorization: `Bearer ${await bearer()}`, "user-agent": config.reddit.userAgent },
  });
  if (res.status === 429) throw new Error("Reddit rate limit (429); the next cycle will continue");
  if (!res.ok) throw new Error(`Reddit ${res.status} for ${path}`);
  return (await res.json()) as T;
}

/** The public Atom feed, at most one request every eight seconds so Reddit keeps answering. */
async function feed(path: string): Promise<string> {
  const wait = lastFeedAt + 8000 - Date.now();
  if (wait > 0) await sleep(wait);
  lastFeedAt = Date.now();
  const res = await fetch(`https://www.reddit.com${path}`, { headers: { "user-agent": config.reddit.userAgent } });
  if (res.status === 429) throw new Error("Reddit feed throttled (429); add REDDIT_CLIENT_ID/SECRET for the API");
  if (!res.ok) throw new Error(`Reddit feed ${res.status} for ${path}`);
  return res.text();
}

// ---- normalisation -------------------------------------------------------------------

interface Post { id: string; author?: string; author_fullname?: string; created_utc: number; title?: string; selftext?: string; num_comments?: number; score?: number; permalink?: string; url?: string }
interface Comment { id: string; author?: string; author_fullname?: string; created_utc: number; body?: string; parent_id?: string; score?: number; replies?: { data?: { children?: { kind: string; data: Comment }[] } } | "" }

function upsertUser(name: string | undefined, fullname: string | undefined, ts: number) {
  if (!name || name === "[deleted]" || name === "AutoModerator") return null;
  const key = userKey(fullname?.replace(/^t2_/, "") || "u:" + name.toLowerCase());
  run(
    `INSERT INTO users (key, platform, username, display_name, kind, is_bot, bio_fetched, first_seen) VALUES (?, ?, ?, ?, 'user', 0, 2, ?)
     ON CONFLICT(key) DO UPDATE SET username = excluded.username, first_seen = MIN(users.first_seen, excluded.first_seen)`,
    key, PLATFORM, name, name, ts,
  );
  return key;
}

function mentionKeys(text: string) {
  return mentionsOf(text, MENTION_RE).map((name) => {
    const known = get("SELECT key FROM users WHERE platform = ? AND username = ? COLLATE NOCASE", PLATFORM, name);
    if (known) return known.key as string;
    const key = userKey("u:" + name.toLowerCase());
    run("INSERT OR IGNORE INTO users (key, platform, username, display_name, bio_fetched) VALUES (?, ?, ?, ?, 2)", key, PLATFORM, name, name);
    return key;
  });
}

function storePost(source: Row, p: Post): boolean {
  const ts = Math.floor(p.created_utc);
  const authorKey = upsertUser(p.author, p.author_fullname, ts);
  const text = [p.title ?? "", p.selftext ?? ""].filter(Boolean).join("\n").trim();
  const r = run(
    `INSERT OR IGNORE INTO messages (source_id, ext_id, author_key, text, ts, reply_to_ext_id, views, forwards, reactions, mentions, hashtags, analyzed)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
    source.id, base36ToBigInt(p.id), authorKey, text, ts, p.score ?? null,
    JSON.stringify(mentionKeys(text)), JSON.stringify(hashtagsOf(text)), text.length < 3 ? 2 : 0,
  );
  const isNew = Number(r.changes) > 0;
  if (isNew && (p.num_comments ?? 0) > 0) {
    run("INSERT OR IGNORE INTO threads (platform, conversation_id, source_id, reply_count, seen_at) VALUES ('reddit', ?, ?, ?, ?)",
      p.id, source.id, p.num_comments ?? 0, ts);
  }
  return isNew;
}

function storeComment(source: Row, c: Comment, postId: string): number {
  if (!c?.id || !c.created_utc) return 0;
  const ts = Math.floor(c.created_utc);
  const authorKey = upsertUser(c.author, c.author_fullname, ts);
  const text = (c.body ?? "").trim();
  const parent = c.parent_id?.replace(/^t[13]_/, "") ?? postId;
  const r = run(
    `INSERT OR IGNORE INTO messages (source_id, ext_id, author_key, text, ts, reply_to_ext_id, reactions, mentions, hashtags, analyzed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    source.id, base36ToBigInt(c.id), authorKey, text, ts, base36ToBigInt(parent), c.score ?? null,
    JSON.stringify(mentionKeys(text)), JSON.stringify(hashtagsOf(text)), text.length < 3 || text === "[deleted]" || text === "[removed]" ? 2 : 0,
  );
  let n = Number(r.changes) > 0 ? 1 : 0;
  const kids = typeof c.replies === "object" ? c.replies?.data?.children ?? [] : [];
  for (const k of kids) if (k.kind === "t1") n += storeComment(source, k.data, postId);
  return n;
}

// ---- feed parsing (fallback) ---------------------------------------------------------

const unescape = (s: string) =>
  s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const stripHtml = (s: string) => unescape(unescape(s)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** Posts out of an Atom feed: enough of the fields the JSON API gives to store a post. */
export function parseFeedPosts(xml: string): Post[] {
  const out: Post[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const id = e.match(/<id>t3_([a-z0-9]+)<\/id>/)?.[1];
    if (!id) continue;
    const title = unescape(e.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const author = e.match(/<author>[\s\S]*?<name>\/u\/([^<]+)<\/name>/)?.[1];
    const published = e.match(/<published>([^<]+)<\/published>/)?.[1] ?? e.match(/<updated>([^<]+)<\/updated>/)?.[1];
    const content = stripHtml(e.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? "");
    // The feed's content is the post body followed by "submitted by /u/x [link] [comments]".
    const body = content.replace(/\s*submitted by\s+\/u\/[\s\S]*$/i, "").replace(/\[link\]|\[comments\]/g, "").trim();
    out.push({ id, author, created_utc: Math.floor(Date.parse(published ?? "") / 1000), title, selftext: body.startsWith(title) ? body.slice(title.length).trim() : body, num_comments: 1 });
  }
  return out;
}

/** Comments out of a post's Atom feed. Only what the feed carries: id, author, time, text; the
 *  parent is taken as the post, since the feed does not say. */
export function parseFeedComments(xml: string, postId: string): Comment[] {
  const out: Comment[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const id = e.match(/<id>t1_([a-z0-9]+)<\/id>/)?.[1];
    if (!id) continue;
    const author = e.match(/<author>[\s\S]*?<name>\/u\/([^<]+)<\/name>/)?.[1];
    const published = e.match(/<published>([^<]+)<\/published>/)?.[1] ?? e.match(/<updated>([^<]+)<\/updated>/)?.[1];
    out.push({ id, author, created_utc: Math.floor(Date.parse(published ?? "") / 1000), body: stripHtml(e.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? ""), parent_id: `t3_${postId}` });
  }
  return out;
}

// ---- sync ----------------------------------------------------------------------------

/** New posts for a subreddit. First run pages back to REDDIT_BACKFILL_LIMIT; later runs stop at the first page with nothing new. */
export async function syncSource(source: Row, onProgress?: (n: number) => void) {
  const firstRun = !source.last_synced_at;
  let count = 0;
  if (redditConfigured()) {
    let after: string | null = null;
    let fetched = 0;
    do {
      const page: { data: { after: string | null; children: { data: Post }[] } } =
        await apiJSON(`/r/${source.handle}/new?limit=100${after ? `&after=${after}` : ""}`);
      const posts = page.data.children.map((c) => c.data);
      let fresh = 0;
      tx(() => { for (const p of posts) if (storePost(source, p)) { fresh++; count++; } });
      fetched += posts.length;
      onProgress?.(count);
      after = page.data.after;
      if (!posts.length || !fresh || (!firstRun && fresh < posts.length) || fetched >= config.reddit.backfillLimit) break;
    } while (after);
  } else {
    const xml = await feed(`/r/${source.handle}/new.rss?limit=100`);
    const posts = parseFeedPosts(xml);
    tx(() => { for (const p of posts) if (storePost(source, p)) count++; });
    onProgress?.(count);
  }
  run("UPDATE sources SET last_synced_at = ? WHERE id = ?", nowSec(), source.id);
  return count;
}

/** Comment trees for the busiest posts not yet fetched. */
export async function fetchThreads(limit: number) {
  const pending = all(
    `SELECT t.conversation_id AS cid, s.* FROM threads t JOIN sources s ON s.id = t.source_id
      WHERE t.platform = 'reddit' AND t.fetched_at IS NULL ORDER BY t.reply_count DESC LIMIT ?`,
    limit,
  );
  let stored = 0;
  for (const p of pending) {
    let n = 0;
    if (redditConfigured()) {
      const listing: [unknown, { data: { children: { kind: string; data: Comment }[] } }] =
        await apiJSON(`/comments/${p.cid}?limit=200&depth=10&sort=old`);
      tx(() => { for (const c of listing[1]?.data?.children ?? []) if (c.kind === "t1") n += storeComment(p, c.data, p.cid); });
    } else {
      const xml = await feed(`/r/${p.handle}/comments/${p.cid}/.rss?limit=100`);
      tx(() => { for (const c of parseFeedComments(xml, p.cid)) n += storeComment(p, c, p.cid); });
    }
    run("UPDATE threads SET fetched_at = ?, replies_stored = ? WHERE platform = 'reddit' AND conversation_id = ?", nowSec(), n, p.cid);
    stored += n;
  }
  return stored;
}

export const pendingThreads = () => Number(get("SELECT COUNT(*) AS n FROM threads WHERE platform = 'reddit' AND fetched_at IS NULL")?.n ?? 0);
