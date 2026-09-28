import { config } from "../config.js";
import { all, get, nowSec, run, tx, type Row } from "../db.js";
import { fnv64, hashtagsOf } from "../util/ids.js";
import { runActor } from "../x/apify.js";

/**
 * Instagram and Facebook: the "desirable" platforms. Neither exposes public-page comments to
 * anyone but the page's owner through its official API, so both come through Apify's
 * scrapers on the same token and monthly budget as X. Sources are public profiles or pages;
 * posts are messages, inline comments are stored at once, and posts with more comments than
 * the inline sample are queued for the comment scraper a couple per cycle.
 *
 * Instagram gives no stable numeric id for comment authors, so their key is ig:@username.
 * Facebook comment ids are opaque strings and are hashed onto 64 bits like YouTube's.
 */

const IG = { posts: "apify~instagram-scraper", comments: "apify~instagram-comment-scraper" };
const FB = { posts: "apify~facebook-posts-scraper", comments: "apify~facebook-comments-scraper" };

export function parseMetaInput(input: string): { platform: "instagram" | "facebook"; query: string } | null {
  const s = input.trim();
  const ig = s.match(/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:\?.*)?$/i) ?? s.match(/^ig:@?([A-Za-z0-9._]{1,30})$/i);
  if (ig && !["p", "reel", "explore", "stories"].includes(ig[1].toLowerCase())) return { platform: "instagram", query: ig[1] };
  const fb = s.match(/^(?:https?:\/\/)?(?:www\.|m\.)?facebook\.com\/([A-Za-z0-9.]{3,60})\/?(?:\?.*)?$/i) ?? s.match(/^fb:@?([A-Za-z0-9.]{3,60})$/i);
  if (fb && !["posts", "groups", "watch", "events"].includes(fb[1].toLowerCase())) return { platform: "facebook", query: fb[1] };
  return null;
}

export async function addSource(input: string): Promise<Row[]> {
  const parsed = parseMetaInput(input);
  if (!parsed) throw new Error(`"${input}" is not an Instagram profile or Facebook page. Use instagram.com/<user> or facebook.com/<page>.`);
  const extId = `page:${parsed.query.toLowerCase()}`;
  const title = parsed.platform === "instagram" ? `@${parsed.query}` : parsed.query;
  run(
    `INSERT INTO sources (platform, ext_id, handle, title, kind, added_at) VALUES (?, ?, ?, ?, 'page', ?)
     ON CONFLICT(platform, ext_id) DO UPDATE SET title = excluded.title`,
    parsed.platform, extId, parsed.query, title, nowSec(),
  );
  return [get("SELECT * FROM sources WHERE platform = ? AND ext_id = ?", parsed.platform, extId)!];
}

const toTs = (v: string | number | undefined) => (typeof v === "number" ? Math.floor(v) : Math.floor(Date.parse(v ?? "") / 1000));

function upsertUser(platform: string, key: string, username: string | null, name: string | null, ts: number) {
  run(
    `INSERT INTO users (key, platform, username, display_name, kind, is_bot, bio_fetched, first_seen) VALUES (?, ?, ?, ?, 'user', 0, 2, ?)
     ON CONFLICT(key) DO UPDATE SET username = COALESCE(excluded.username, users.username), display_name = COALESCE(excluded.display_name, users.display_name),
       first_seen = MIN(users.first_seen, excluded.first_seen)`,
    key, platform, username, name, ts,
  );
  return key;
}

function store(source: Row, extId: bigint, authorKey: string | null, text: string, ts: number, parent: bigint | null, reactions: number | null, forwards: number | null, views: number | null, mentions: string[] = []) {
  if (!Number.isFinite(ts)) return false;
  const r = run(
    `INSERT OR IGNORE INTO messages (source_id, ext_id, author_key, text, ts, reply_to_ext_id, views, forwards, reactions, mentions, hashtags, analyzed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    source.id, extId, authorKey, text, ts, parent, views, forwards, reactions, JSON.stringify(mentions), JSON.stringify(hashtagsOf(text)), text.trim().length < 3 ? 2 : 0,
  );
  return Number(r.changes) > 0;
}

// ---- Instagram -----------------------------------------------------------------------

interface IgComment { id: string; text?: string; ownerUsername?: string; timestamp?: string; likesCount?: number }
interface IgPost { id: string; shortCode?: string; url?: string; caption?: string; timestamp?: string; likesCount?: number; commentsCount?: number; ownerUsername?: string; ownerId?: string; ownerFullName?: string; mentions?: string[]; latestComments?: IgComment[]; videoViewCount?: number }

const igUser = (username: string | undefined, id: string | undefined, name: string | undefined, ts: number) =>
  username || id ? upsertUser("instagram", id ? `ig:${id}` : `ig:@${username!.toLowerCase()}`, username ?? null, name ?? username ?? null, ts) : null;

function storeIgComment(source: Row, c: IgComment, parent: bigint, fallbackTs: number) {
  const ts = c.timestamp ? toTs(c.timestamp) : fallbackTs;
  const author = igUser(c.ownerUsername, undefined, undefined, ts);
  return store(source, /^\d+$/.test(c.id) ? BigInt(c.id) : fnv64(c.id), author, c.text ?? "", ts, parent, c.likesCount ?? null, null, null);
}

async function syncInstagram(source: Row) {
  const firstRun = !source.last_synced_at;
  const posts = await runActor<IgPost>({
    directUrls: [`https://www.instagram.com/${source.handle}/`], resultsType: "posts",
    resultsLimit: firstRun ? config.meta.postsPerSource : 4,
    ...(firstRun ? {} : { onlyPostsNewerThan: new Date((source.last_synced_at - 7 * 86400) * 1000).toISOString().slice(0, 10) }),
  }, 240, IG.posts);
  let count = 0;
  tx(() => {
    for (const p of posts) {
      if (!p?.id || !p.timestamp) continue;
      const ts = toTs(p.timestamp);
      const author = igUser(p.ownerUsername, p.ownerId, p.ownerFullName, ts);
      const ext = BigInt(p.id);
      const mentions = (p.mentions ?? []).map((u) => igUser(u, undefined, undefined, ts)!).filter(Boolean);
      if (store(source, ext, author, p.caption ?? "", ts, null, p.likesCount ?? null, null, p.videoViewCount ?? null, mentions)) count++;
      for (const c of p.latestComments ?? []) if (storeIgComment(source, c, ext, ts)) count++;
      if ((p.commentsCount ?? 0) > (p.latestComments?.length ?? 0) && p.url) {
        run("INSERT OR IGNORE INTO threads (platform, conversation_id, source_id, reply_count, seen_at) VALUES ('instagram', ?, ?, ?, ?)", `${p.id}|${p.url}`, source.id, p.commentsCount ?? 0, ts);
      }
    }
  });
  return count;
}

// ---- Facebook ------------------------------------------------------------------------

interface FbComment { id?: string; commentId?: string; text?: string; date?: string; profileName?: string; profileId?: string; profileUrl?: string; likesCount?: number }
interface FbPost { postId?: string; url?: string; topLevelUrl?: string; text?: string; time?: string; timestamp?: number; likes?: number; comments?: number; shares?: number; user?: { id?: string; name?: string }; pageName?: string; topComments?: FbComment[] }

const fbUser = (id: string | undefined, name: string | undefined, ts: number) =>
  id || name ? upsertUser("facebook", id ? `fb:${id}` : `fb:@${name!.toLowerCase().replace(/\s+/g, "_")}`, null, name ?? null, ts) : null;

function storeFbComment(source: Row, c: FbComment, parent: bigint, fallbackTs: number) {
  const id = c.commentId ?? c.id;
  if (!id) return false;
  const ts = c.date ? toTs(c.date) : fallbackTs;
  const author = fbUser(c.profileId ?? c.profileUrl?.match(/facebook\.com\/(\d+)/)?.[1], c.profileName, ts);
  return store(source, /^\d+$/.test(id) ? BigInt(id) : fnv64(id), author, c.text ?? "", ts, parent, c.likesCount ?? null, null, null);
}

async function syncFacebook(source: Row) {
  const firstRun = !source.last_synced_at;
  const posts = await runActor<FbPost>({
    startUrls: [{ url: `https://www.facebook.com/${source.handle}/` }],
    resultsLimit: firstRun ? config.meta.postsPerSource : 4,
    ...(firstRun ? {} : { onlyPostsNewerThan: new Date((source.last_synced_at - 7 * 86400) * 1000).toISOString().slice(0, 10) }),
  }, 240, FB.posts);
  let count = 0;
  tx(() => {
    for (const p of posts) {
      if (!p?.postId || (!p.time && !p.timestamp)) continue;
      const ts = p.timestamp ? toTs(p.timestamp) : toTs(p.time);
      const author = fbUser(p.user?.id, p.user?.name ?? p.pageName, ts);
      const ext = BigInt(p.postId);
      if (store(source, ext, author, p.text ?? "", ts, null, p.likes ?? null, p.shares ?? null, null)) count++;
      for (const c of p.topComments ?? []) if (storeFbComment(source, c, ext, ts)) count++;
      const url = p.topLevelUrl ?? p.url;
      if ((p.comments ?? 0) > (p.topComments?.length ?? 0) && url) {
        run("INSERT OR IGNORE INTO threads (platform, conversation_id, source_id, reply_count, seen_at) VALUES ('facebook', ?, ?, ?, ?)", `${p.postId}|${url}`, source.id, p.comments ?? 0, ts);
      }
    }
  });
  return count;
}

// ---- shared --------------------------------------------------------------------------

export async function syncSource(source: Row) {
  const n = source.platform === "instagram" ? await syncInstagram(source) : await syncFacebook(source);
  run("UPDATE sources SET last_synced_at = ? WHERE id = ?", nowSec(), source.id);
  return n;
}

/** Comment threads queued above, busiest first. */
export async function fetchThreads(limit: number) {
  const pending = all(
    `SELECT t.platform AS tp, t.conversation_id AS cid, s.* FROM threads t JOIN sources s ON s.id = t.source_id
      WHERE t.platform IN ('instagram', 'facebook') AND t.fetched_at IS NULL ORDER BY t.reply_count DESC LIMIT ?`,
    limit,
  );
  let stored = 0;
  for (const p of pending) {
    const [postId, url] = String(p.cid).split("|");
    const parent = BigInt(postId);
    let n = 0;
    if (p.tp === "instagram") {
      const items = await runActor<IgComment>({ directUrls: [url], resultsLimit: config.meta.commentsPerPost }, 240, IG.comments);
      tx(() => { for (const c of items) if (c?.id && storeIgComment(p, c, parent, nowSec())) n++; });
    } else {
      const items = await runActor<FbComment & { error?: string }>({ startUrls: [{ url }], resultsLimit: config.meta.commentsPerPost, viewOption: "RECENT_ACTIVITY" }, 280, FB.comments);
      tx(() => { for (const c of items) if (!c?.error && storeFbComment(p, c, parent, nowSec())) n++; });
    }
    run("UPDATE threads SET fetched_at = ?, replies_stored = ? WHERE platform = ? AND conversation_id = ?", nowSec(), n, p.tp, p.cid);
    stored += n;
  }
  return stored;
}

export const pendingThreads = () => Number(get("SELECT COUNT(*) AS n FROM threads WHERE platform IN ('instagram','facebook') AND fetched_at IS NULL")?.n ?? 0);
