import { Api, errors, type TelegramClient } from "telegram";
import { returnBigInt } from "telegram/Helpers.js";
import { config } from "../config.js";
import { all, get, nowSec, run, tx, type Row } from "../db.js";
import { getTelegram } from "./client.js";

const PLATFORM = "telegram";
const userKey = (id: unknown) => `tg:${String(id)}`;
const peerKey = (p: Api.TypePeer) =>
  userKey(p instanceof Api.PeerUser ? p.userId : p instanceof Api.PeerChannel ? p.channelId : (p as Api.PeerChat).chatId);
const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function requireClient() {
  const client = await getTelegram();
  if (!client) throw new Error("Telegram is not connected (check keys and run `npm run telegram:login`).");
  return client;
}

/** "@name", "name", "https://t.me/name", "t.me/name/123" -> "name" */
export function parseHandle(input: string) {
  const s = input.trim();
  if (/t\.me\/(\+|joinchat)/i.test(s)) throw new Error("Private invite links aren't supported — use a public @username.");
  const m = s.match(/t\.me\/([A-Za-z0-9_]{4,})/i) ?? s.match(/^@?([A-Za-z0-9_]{4,})$/);
  if (!m) throw new Error(`"${input}" doesn't look like a Telegram @username or t.me link.`);
  return m[1];
}

function describeChat(entity: Api.TypeChat) {
  if (entity instanceof Api.Channel) {
    return {
      extId: entity.id.toString(),
      accessHash: entity.accessHash?.toString() ?? null,
      // accounts with collectible usernames have `usernames` instead of `username`
      handle: entity.username ?? entity.usernames?.find((u) => u.active)?.username ?? null,
      title: entity.title,
      kind: entity.broadcast ? "channel" : "group",
    };
  }
  if (entity instanceof Api.Chat) {
    return { extId: entity.id.toString(), accessHash: null, handle: null, title: entity.title, kind: "group" };
  }
  throw new Error("That handle is a user or unsupported chat, not a channel/group.");
}

function upsertSource(d: ReturnType<typeof describeChat>, linkedSourceId: number | null = null): Row {
  run(
    `INSERT INTO sources (platform, ext_id, access_hash, handle, title, kind, linked_source_id, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, ext_id) DO UPDATE SET
       access_hash = excluded.access_hash, handle = excluded.handle, title = excluded.title,
       linked_source_id = COALESCE(excluded.linked_source_id, sources.linked_source_id)`,
    PLATFORM, d.extId, d.accessHash, d.handle, d.title, d.kind, linkedSourceId, nowSec(),
  );
  return get(
    "SELECT id, platform, handle, title, kind, linked_source_id, last_message_id, added_at FROM sources WHERE platform = ? AND ext_id = ?",
    PLATFORM, d.extId,
  )!;
}

/**
 * Registers a public channel/group. For a broadcast channel we also register its linked
 * discussion group, because that's where followers actually write (the channel itself
 * only contains admin posts).
 */
export async function addSource(input: string) {
  const client = await requireClient();
  const entity = await client.getEntity(parseHandle(input));
  const source = upsertSource(describeChat(entity as Api.TypeChat));
  const added = [source];

  if (entity instanceof Api.Channel && entity.broadcast) {
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
    const linkedId = (full.fullChat as Api.ChannelFull).linkedChatId?.toString();
    const linked = linkedId && full.chats.find((c) => c.id.toString() === linkedId);
    if (linked) {
      const group = upsertSource(describeChat(linked), source.id);
      run("UPDATE sources SET linked_source_id = ? WHERE id = ?", group.id, source.id);
      added.push(group);
    }
  }
  return added;
}

function inputPeer(source: Row): Api.TypeInputPeer {
  if (source.access_hash) {
    return new Api.InputPeerChannel({ channelId: returnBigInt(source.ext_id), accessHash: returnBigInt(source.access_hash) });
  }
  return new Api.InputPeerChat({ chatId: returnBigInt(source.ext_id) });
}

function upsertAuthor(entity: unknown, ts: number) {
  if (entity instanceof Api.User) {
    const name = [entity.firstName, entity.lastName].filter(Boolean).join(" ");
    run(
      `INSERT INTO users (key, platform, username, display_name, kind, is_bot, first_seen) VALUES (?, ?, ?, ?, 'user', ?, ?)
       ON CONFLICT(key) DO UPDATE SET username = excluded.username, display_name = excluded.display_name,
         first_seen = MIN(COALESCE(users.first_seen, excluded.first_seen), excluded.first_seen)`,
      userKey(entity.id), PLATFORM, entity.username ?? null, name, entity.bot ? 1 : 0, ts,
    );
  } else if (entity instanceof Api.Channel || entity instanceof Api.Chat) {
    run(
      `INSERT INTO users (key, platform, username, display_name, kind, bio_fetched, first_seen) VALUES (?, ?, ?, ?, 'channel', 1, ?)
       ON CONFLICT(key) DO UPDATE SET display_name = excluded.display_name,
         first_seen = MIN(COALESCE(users.first_seen, excluded.first_seen), excluded.first_seen)`,
      userKey(entity.id), PLATFORM, (entity as Api.Channel).username ?? null, entity.title, ts,
    );
  }
}

/** Resolve "@username" to a known user key, or create a placeholder node for it. */
function mentionKey(username: string) {
  const known = get("SELECT key FROM users WHERE platform = ? AND username = ? COLLATE NOCASE", PLATFORM, username);
  if (known) return known.key as string;
  const key = `tg:@${username.toLowerCase()}`;
  run("INSERT OR IGNORE INTO users (key, platform, username, bio_fetched) VALUES (?, ?, ?, 1)", key, PLATFORM, username);
  return key;
}

function storeMessage(source: Row, m: Api.Message) {
  const text = m.message ?? "";
  const ts = m.date;
  const sender = m.sender;
  if (sender) upsertAuthor(sender, ts);
  // Use raw peer ids: `senderId` is "marked" for channels (-100…), which wouldn't match the
  // plain ids used in forwards and entities, splitting one account into two graph nodes.
  const authorPeer = m.fromId ?? m.peerId;
  const authorKey = authorPeer ? peerKey(authorPeer) : null;

  const mentions = new Set<string>();
  for (const e of m.entities ?? []) {
    if (e instanceof Api.MessageEntityMentionName) mentions.add(userKey(e.userId));
    else if (e instanceof Api.MessageEntityMention) mentions.add(mentionKey(text.slice(e.offset + 1, e.offset + e.length)));
  }
  const hashtags = [...new Set((text.match(HASHTAG_RE) ?? []).map((t) => t.toLowerCase()))];

  let fwdKey: string | null = null;
  const fwdName = m.fwdFrom?.fromName ?? null;
  const fromId = m.fwdFrom?.fromId;
  if (fromId instanceof Api.PeerUser) fwdKey = userKey(fromId.userId);
  else if (fromId instanceof Api.PeerChannel) {
    fwdKey = userKey(fromId.channelId);
    const chat = m.forward?.chat;
    if (chat) upsertAuthor(chat, ts);
    else run("INSERT OR IGNORE INTO users (key, platform, kind, bio_fetched) VALUES (?, ?, 'channel', 1)", fwdKey, PLATFORM);
  }

  const reactions = (m.reactions?.results ?? []).reduce((n, r) => n + r.count, 0);

  run(
    `INSERT OR IGNORE INTO messages
       (source_id, ext_id, author_key, text, ts, reply_to_ext_id, fwd_from_key, fwd_from_name,
        views, forwards, reactions, mentions, hashtags, analyzed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    source.id, m.id, authorKey, text, ts, m.replyToMsgId ?? null, fwdKey, fwdName,
    m.views ?? null, m.forwards ?? null, reactions, JSON.stringify([...mentions]), JSON.stringify(hashtags),
    text.trim().length < 3 ? 2 : 0,
  );
}

/** Backfills on first run (last N messages within BACKFILL_DAYS), then fetches only new messages. */
export async function syncSource(source: Row, onProgress?: (n: number) => void) {
  const client = await requireClient();
  const peer = inputPeer(source);
  const firstRun = !source.last_message_id;
  const since = nowSec() - config.pipeline.backfillDays * 86400;
  const iter = firstRun
    ? client.iterMessages(peer, { limit: config.pipeline.backfillLimit })
    : client.iterMessages(peer, { minId: source.last_message_id, reverse: true, limit: 2000 });

  let maxId = source.last_message_id as number;
  let count = 0;
  const batch: Api.Message[] = [];
  const flush = () => {
    tx(() => batch.forEach((m) => storeMessage(source, m)));
    batch.length = 0;
    onProgress?.(count);
  };

  for await (const m of iter) {
    if (!(m instanceof Api.Message)) continue; // skip service messages (joins, pins, ...)
    if (firstRun && m.date < since) break;
    batch.push(m);
    maxId = Math.max(maxId, m.id);
    count++;
    if (batch.length >= 100) flush();
  }
  if (batch.length) flush();

  run("UPDATE sources SET last_message_id = ?, last_synced_at = ? WHERE id = ?", maxId, nowSec(), source.id);
  return count;
}

/**
 * Bios feed the demographic model. Telegram rate-limits GetFullUser, so we fetch a few
 * per cycle and stop politely on FloodWait. Works for users seen since the server started
 * (their access hash is in the client's memory cache).
 */
export async function fetchBios(limit: number) {
  const client: TelegramClient = await requireClient();
  const pending = all(
    `SELECT key FROM users WHERE platform = ? AND kind = 'user' AND is_bot = 0 AND bio_fetched = 0
       AND key NOT LIKE 'tg:@%' LIMIT ?`,
    PLATFORM, limit,
  );
  let fetched = 0;
  for (const u of pending) {
    try {
      const id = await client.getInputEntity(returnBigInt(u.key.slice(3)));
      const full = await client.invoke(new Api.users.GetFullUser({ id }));
      run("UPDATE users SET bio = ?, bio_fetched = 1 WHERE key = ?", full.fullUser.about ?? "", u.key);
      fetched++;
      await sleep(600);
    } catch (e) {
      if (e instanceof errors.FloodWaitError) break;
      run("UPDATE users SET bio_fetched = 2 WHERE key = ?", u.key); // unreachable user: don't retry
    }
  }
  return fetched;
}
