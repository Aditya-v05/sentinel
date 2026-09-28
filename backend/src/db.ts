import fs from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config, DATA_DIR } from "./config.js";

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(config.dbFile);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- A channel / group we collect from. 'platform' keeps the schema ready for X later.
CREATE TABLE IF NOT EXISTS sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  platform        TEXT    NOT NULL,
  ext_id          TEXT    NOT NULL,
  access_hash     TEXT,
  handle          TEXT,
  title           TEXT,
  kind            TEXT,               -- channel | group
  linked_source_id INTEGER,           -- channel <-> its discussion group
  last_message_id INTEGER NOT NULL DEFAULT 0,
  last_synced_at  INTEGER,
  added_at        INTEGER NOT NULL,
  UNIQUE (platform, ext_id)
);

-- Authors seen in any source. key = "<platform>:<id>" (or "<platform>:@username" for unresolved mentions).
CREATE TABLE IF NOT EXISTS users (
  key          TEXT PRIMARY KEY,
  platform     TEXT NOT NULL,
  username     TEXT,
  display_name TEXT,
  bio          TEXT,
  kind         TEXT NOT NULL DEFAULT 'user',   -- user | channel
  is_bot       INTEGER NOT NULL DEFAULT 0,
  bio_fetched  INTEGER NOT NULL DEFAULT 0,
  first_seen   INTEGER
);
CREATE INDEX IF NOT EXISTS users_username ON users(platform, username);

-- Time-stamped message history. Analysis columns are filled in by the pipeline.
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id       INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  ext_id          INTEGER NOT NULL,
  author_key      TEXT,
  text            TEXT,
  ts              INTEGER NOT NULL,     -- unix seconds (UTC)
  reply_to_ext_id INTEGER,
  fwd_from_key    TEXT,
  fwd_from_name   TEXT,
  views           INTEGER,
  forwards        INTEGER,
  reactions       INTEGER,
  mentions        TEXT,                 -- JSON array of user keys
  hashtags        TEXT,                 -- JSON array of lowercase tags
  analyzed        INTEGER NOT NULL DEFAULT 0,  -- 0 pending, 1 done, 2 skipped (no usable text)
  sentiment       TEXT,                 -- positive | neutral | negative
  sentiment_score REAL,                 -- -1 .. 1
  emotion         TEXT,
  sarcasm         INTEGER,
  stance          TEXT,                 -- supportive | against | neutral
  topic_id        INTEGER,
  UNIQUE (source_id, ext_id)
);
CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts);
CREATE INDEX IF NOT EXISTS messages_source_ts ON messages(source_id, ts);
CREATE INDEX IF NOT EXISTS messages_analyzed ON messages(analyzed);
CREATE INDEX IF NOT EXISTS messages_author ON messages(author_key);

-- Discussion topics discovered by the LLM. New ones are added as conversations shift.
CREATE TABLE IF NOT EXISTS topics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label       TEXT NOT NULL,
  keywords    TEXT,            -- JSON array
  description TEXT,
  created_at  INTEGER NOT NULL
);

-- Inferred (anonymised in the API: only aggregates are ever returned).
CREATE TABLE IF NOT EXISTS profiles (
  user_key     TEXT PRIMARY KEY,
  language     TEXT,
  region       TEXT,
  age_bracket  TEXT,
  interests    TEXT,           -- JSON array
  profession   TEXT,
  profiled_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Posts whose replies are worth collecting (the reply tree is the network). One queue for
-- every platform that fetches replies as a second step (X conversations, Reddit comments).
CREATE TABLE IF NOT EXISTS threads (
  platform        TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  source_id       INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  reply_count     INTEGER NOT NULL DEFAULT 0,
  replies_stored  INTEGER,
  seen_at         INTEGER NOT NULL,
  fetched_at      INTEGER,
  PRIMARY KEY (platform, conversation_id)
);
CREATE INDEX IF NOT EXISTS threads_pending ON threads(platform, fetched_at);
`);

// The X-only queue from iteration 2 folds into the shared one.
try {
  db.exec(`INSERT OR IGNORE INTO threads (platform, conversation_id, source_id, reply_count, replies_stored, seen_at, fetched_at)
           SELECT 'x', conversation_id, source_id, reply_count, replies_stored, seen_at, fetched_at FROM x_threads;
           DROP TABLE x_threads;`);
} catch {
  // no legacy table
}

// Columns added after iteration 1. ALTER is the one non-additive change SQLite allows cheaply,
// so an existing analytics.db keeps working without being deleted.
for (const ddl of [
  "ALTER TABLE users ADD COLUMN location TEXT",
  "ALTER TABLE users ADD COLUMN followers INTEGER",
  "ALTER TABLE users ADD COLUMN account_created INTEGER",   // unix s; X profiles carry it, Telegram does not
  "ALTER TABLE sources ADD COLUMN removed_at INTEGER",       // soft delete: rows stay so the collection log stays whole
  "ALTER TABLE messages ADD COLUMN collected_at INTEGER",
  "ALTER TABLE messages ADD COLUMN prev_hash TEXT",
  "ALTER TABLE messages ADD COLUMN entry_hash TEXT",
]) {
  try {
    db.exec(ddl);
  } catch {
    // already there
  }
}

db.exec("CREATE INDEX IF NOT EXISTS messages_unsealed ON messages(id) WHERE entry_hash IS NULL");

export type Row = Record<string, any>;

export const all = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as Row[];
export const get = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params) as Row | undefined;
export const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params);

export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const kvGet = (key: string) => get("SELECT value FROM kv WHERE key = ?", key)?.value as string | undefined;
export const kvSet = (key: string, value: string) =>
  run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);

export const nowSec = () => Math.floor(Date.now() / 1000);

/** Common WHERE clause for the dashboard's source + time-range filters (alias m = messages). */
export function scope(q: { source?: number; from: number; to: number }) {
  // Removed sources keep their rows (the collection log must stay whole) but leave every view.
  const where = ["m.ts >= ?", "m.ts <= ?", "m.source_id IN (SELECT id FROM sources WHERE removed_at IS NULL)"];
  const params: SQLInputValue[] = [q.from, q.to];
  if (q.source) {
    where.push("m.source_id = ?");
    params.push(q.source);
  }
  return { where: where.join(" AND "), params };
}
