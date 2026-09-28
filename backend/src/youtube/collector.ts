import { config } from "../config.js";
import { all, get, nowSec, run, tx, type Row } from "../db.js";
import { fnv64, hashtagsOf } from "../util/ids.js";

/**
 * YouTube collector: comment threads under videos, through the Data API v3 (free, 10,000
 * units a day; a page of 100 comments costs one unit). Sources are a video URL or a channel
 * (@handle or channel URL), in which case the channel's latest uploads are the videos.
 *
 * The video itself is stored as the root message (title as text, channel as author) so
 * every comment has a parent and the thread reads like any other conversation.
 */

const PLATFORM = "youtube";
const API = "https://www.googleapis.com/youtube/v3";
const userKey = (channelId: string) => `youtube:${channelId}`;

export const youtubeConfigured = () => Boolean(config.youtube.apiKey);

export function parseYouTubeInput(input: string): { kind: "video" | "channel"; query: string } | null {
  const s = input.trim();
  const v = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i);
  if (v) return { kind: "video", query: v[1] };
  const h = s.match(/youtube\.com\/@([A-Za-z0-9._-]{3,30})/i) ?? s.match(/^(?:youtube|yt):@([A-Za-z0-9._-]{3,30})$/i);
  if (h) return { kind: "channel", query: "@" + h[1] };
  const c = s.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/i);
  if (c) return { kind: "channel", query: c[1] };
  return null;
}

async function api<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ ...params, key: config.youtube.apiKey });
  const res = await fetch(`${API}/${path}?${qs}`);
  const data = (await res.json()) as T & { error?: { message?: string; errors?: { reason?: string }[] } };
  if (!res.ok) {
    const reason = data.error?.errors?.[0]?.reason ?? "";
    throw new Error(`YouTube ${res.status}${reason ? ` (${reason})` : ""}: ${data.error?.message ?? ""}`.slice(0, 200));
  }
  return data;
}

export async function addSource(input: string): Promise<Row[]> {
  const parsed = parseYouTubeInput(input);
  if (!parsed) throw new Error(`"${input}" is not a YouTube video or channel. Use a watch URL, youtu.be link, or youtube.com/@handle.`);
  if (!youtubeConfigured()) throw new Error("YOUTUBE_API_KEY is not set (Google Cloud console → YouTube Data API v3).");

  let title = parsed.query;
  let extId = `${parsed.kind}:${parsed.query}`;
  if (parsed.kind === "video") {
    const v = await api<{ items: { snippet: { title: string; channelTitle: string } }[] }>("videos", { part: "snippet", id: parsed.query });
    if (!v.items.length) throw new Error("That video is not available (private, removed, or comments disabled).");
    title = `${v.items[0].snippet.title.slice(0, 60)} · ${v.items[0].snippet.channelTitle}`;
  } else {
    const c = await api<{ items: { id: string; snippet: { title: string }; contentDetails: { relatedPlaylists: { uploads: string } } }[] }>(
      "channels", { part: "snippet,contentDetails", ...(parsed.query.startsWith("@") ? { forHandle: parsed.query } : { id: parsed.query }) });
    if (!c.items.length) throw new Error("No such channel.");
    title = c.items[0].snippet.title;
    extId = `channel:${c.items[0].id}`;
    run("INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)", `yt_uploads_${c.items[0].id}`, c.items[0].contentDetails.relatedPlaylists.uploads);
  }
  run(
    `INSERT INTO sources (platform, ext_id, handle, title, kind, added_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, ext_id) DO UPDATE SET title = excluded.title`,
    PLATFORM, extId, parsed.query, title, parsed.kind, nowSec(),
  );
  return [get("SELECT * FROM sources WHERE platform = ? AND ext_id = ?", PLATFORM, extId)!];
}

// ---- normalisation -------------------------------------------------------------------

interface CommentSnippet { textOriginal?: string; textDisplay?: string; authorDisplayName?: string; authorChannelId?: { value: string }; likeCount?: number; publishedAt: string; parentId?: string; videoId?: string }

function upsertAuthor(channelId: string | undefined, name: string | undefined, ts: number) {
  if (!channelId) return null;
  const key = userKey(channelId);
  run(
    `INSERT INTO users (key, platform, username, display_name, kind, is_bot, bio_fetched, first_seen) VALUES (?, ?, NULL, ?, 'user', 0, 2, ?)
     ON CONFLICT(key) DO UPDATE SET display_name = excluded.display_name, first_seen = MIN(users.first_seen, excluded.first_seen)`,
    key, PLATFORM, name ?? channelId, ts,
  );
  return key;
}

function storeComment(source: Row, id: string, sn: CommentSnippet, parentExt: bigint): boolean {
  const ts = Math.floor(Date.parse(sn.publishedAt) / 1000);
  if (!Number.isFinite(ts)) return false;
  const text = (sn.textOriginal ?? sn.textDisplay ?? "").trim();
  const authorKey = upsertAuthor(sn.authorChannelId?.value, sn.authorDisplayName, ts);
  const r = run(
    `INSERT OR IGNORE INTO messages (source_id, ext_id, author_key, text, ts, reply_to_ext_id, reactions, mentions, hashtags, analyzed)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
    source.id, fnv64(id), authorKey, text, ts, parentExt, sn.likeCount ?? null, JSON.stringify(hashtagsOf(text)), text.length < 3 ? 2 : 0,
  );
  return Number(r.changes) > 0;
}

/** The video as the root of its thread. */
function storeVideoRoot(source: Row, videoId: string, title: string, channelId: string | undefined, channelTitle: string | undefined, publishedAt: string, views?: number) {
  const ts = Math.floor(Date.parse(publishedAt) / 1000);
  const authorKey = upsertAuthor(channelId, channelTitle, ts);
  run(
    `INSERT OR IGNORE INTO messages (source_id, ext_id, author_key, text, ts, views, mentions, hashtags, analyzed) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 2)`,
    source.id, fnv64(videoId), authorKey, title, ts, views ?? null, JSON.stringify(hashtagsOf(title)),
  );
  return fnv64(videoId);
}

// ---- sync ----------------------------------------------------------------------------

async function syncVideo(source: Row, videoId: string, limit: number) {
  const v = await api<{ items: { snippet: { title: string; channelId: string; channelTitle: string; publishedAt: string }; statistics?: { viewCount?: string } }[] }>(
    "videos", { part: "snippet,statistics", id: videoId });
  if (!v.items.length) return 0;
  const sn = v.items[0].snippet;
  const root = storeVideoRoot(source, videoId, sn.title, sn.channelId, sn.channelTitle, sn.publishedAt, Number(v.items[0].statistics?.viewCount) || undefined);

  let count = 0, fetched = 0, pageToken: string | undefined;
  do {
    let page: { nextPageToken?: string; items: { id: string; snippet: { topLevelComment: { id: string; snippet: CommentSnippet }; totalReplyCount: number }; replies?: { comments: { id: string; snippet: CommentSnippet }[] } }[] };
    try {
      page = await api("commentThreads", { part: "snippet,replies", videoId, maxResults: "100", order: "time", textFormat: "plainText", ...(pageToken ? { pageToken } : {}) });
    } catch (e) {
      if (String((e as Error).message).includes("commentsDisabled")) return count;
      throw e;
    }
    let fresh = 0;
    tx(() => {
      for (const t of page.items) {
        const top = t.snippet.topLevelComment;
        if (storeComment(source, top.id, top.snippet, root)) { fresh++; count++; }
        for (const rep of t.replies?.comments ?? []) if (storeComment(source, rep.id, rep.snippet, fnv64(top.id))) count++;
        // Beyond the five inline replies, the rest are one more call per thread; queue it.
        if (t.snippet.totalReplyCount > (t.replies?.comments.length ?? 0)) {
          run("INSERT OR IGNORE INTO threads (platform, conversation_id, source_id, reply_count, seen_at) VALUES ('youtube', ?, ?, ?, ?)",
            top.id, source.id, t.snippet.totalReplyCount, nowSec());
        }
      }
    });
    fetched += page.items.length;
    pageToken = page.nextPageToken;
    // Incremental: newest first, so a page with nothing new means the rest is known.
    if (!fresh || fetched >= limit) break;
  } while (pageToken);
  return count;
}

export async function syncSource(source: Row, onProgress?: (n: number) => void) {
  if (!youtubeConfigured()) throw new Error("YOUTUBE_API_KEY is not set");
  let count = 0;
  if (source.kind === "video") {
    count = await syncVideo(source, source.handle, config.youtube.commentsPerVideo);
  } else {
    const uploads = get("SELECT value FROM kv WHERE key = ?", `yt_uploads_${String(source.ext_id).replace(/^channel:/, "")}`)?.value as string | undefined;
    if (!uploads) throw new Error("channel uploads playlist unknown; remove and re-add the source");
    const firstRun = !source.last_synced_at;
    const items = await api<{ items: { contentDetails: { videoId: string } }[] }>(
      "playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: String(firstRun ? config.youtube.videosPerChannel : 3) });
    for (const it of items.items) {
      count += await syncVideo(source, it.contentDetails.videoId, config.youtube.commentsPerVideo);
      onProgress?.(count);
    }
  }
  run("UPDATE sources SET last_synced_at = ? WHERE id = ?", nowSec(), source.id);
  return count;
}

/** The rest of the replies under threads that had more than the inline five. */
export async function fetchThreads(limit: number) {
  const pending = all(
    `SELECT t.conversation_id AS cid, s.* FROM threads t JOIN sources s ON s.id = t.source_id
      WHERE t.platform = 'youtube' AND t.fetched_at IS NULL ORDER BY t.reply_count DESC LIMIT ?`,
    limit,
  );
  let stored = 0;
  for (const p of pending) {
    let n = 0, pageToken: string | undefined;
    do {
      const page: { nextPageToken?: string; items: { id: string; snippet: CommentSnippet }[] } =
        await api("comments", { part: "snippet", parentId: p.cid, maxResults: "100", textFormat: "plainText", ...(pageToken ? { pageToken } : {}) });
      tx(() => { for (const c of page.items) if (storeComment(p, c.id, c.snippet, fnv64(p.cid))) n++; });
      pageToken = page.nextPageToken;
    } while (pageToken && n < 500);
    run("UPDATE threads SET fetched_at = ?, replies_stored = ? WHERE platform = 'youtube' AND conversation_id = ?", nowSec(), n, p.cid);
    stored += n;
  }
  return stored;
}

export const pendingThreads = () => Number(get("SELECT COUNT(*) AS n FROM threads WHERE platform = 'youtube' AND fetched_at IS NULL")?.n ?? 0);
