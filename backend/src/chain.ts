import crypto from "node:crypto";
import { all, get, kvGet, kvSet, nowSec, run, tx } from "./db.js";

/**
 * The collection log is tamper-evident. Every stored message is sealed with a SHA-256 over
 * its content and the seal of the message before it, in id order. Change a text, delete a
 * row, or slip one in, and every seal after that point stops matching; `verify()` names the
 * first row where the chain parts. The check is public (no sign-in), so someone who does not
 * trust the operator can run it themselves.
 *
 * What this proves: that what the dashboard shows is what was collected, and when. What it
 * does not prove: that the platform showed the same thing (that needs the platform's own
 * signature, which none of them offer). collected_at is set at sealing, which happens in the
 * same pipeline cycle as the fetch, seconds after the row is written.
 */

export const GENESIS = "0".repeat(64);

const canonical = (m: Record<string, any>, prev: string) =>
  JSON.stringify([m.id, m.source_id, m.ext, m.author_key, m.text, m.ts, m.reply_ext, m.collected_at, prev]);
export const digest = (m: Record<string, any>, prev: string) => crypto.createHash("sha256").update(canonical(m, prev)).digest("hex");

// ext_id is 64-bit; read it as text so a JavaScript number never rounds it into a different hash.
const COLS = "id, source_id, CAST(ext_id AS TEXT) AS ext, author_key, text, ts, CAST(reply_to_ext_id AS TEXT) AS reply_ext, collected_at, prev_hash, entry_hash";

/** Seals every unsealed row, in id order, onto the current head. Returns how many. */
export function sealNew(): number {
  const pending = all(`SELECT ${COLS} FROM messages WHERE entry_hash IS NULL ORDER BY id`);
  if (!pending.length) return 0;
  let prev = kvGet("chain_head") ?? GENESIS;
  const now = nowSec();
  tx(() => {
    for (const m of pending) {
      m.collected_at ??= now;
      const hash = digest(m, prev);
      run("UPDATE messages SET collected_at = ?, prev_hash = ?, entry_hash = ? WHERE id = ?", m.collected_at, prev, hash, m.id);
      prev = hash;
    }
    kvSet("chain_head", prev);
  });
  return pending.length;
}

export interface ChainStatus { entries: number; intact: boolean; brokenAt: number | null; reason: string; unsealed: number; head: string | null }

/** Walks the whole log and reports the first link that does not hold. */
export function verify(): ChainStatus {
  let prev = GENESIS;
  let entries = 0;
  for (const m of all(`SELECT ${COLS} FROM messages WHERE entry_hash IS NOT NULL ORDER BY id`)) {
    entries++;
    if (m.prev_hash !== prev) {
      return { entries, intact: false, brokenAt: m.id, unsealed: 0, head: null,
        reason: prev === GENESIS && entries === 1 ? "first sealed row does not start at genesis" : "previous-hash link does not match: a row before this one was altered, removed, or reordered" };
    }
    if (digest(m, prev) !== m.entry_hash) {
      return { entries, intact: false, brokenAt: m.id, unsealed: 0, head: null, reason: "content does not match its seal: this row was altered after collection" };
    }
    prev = m.entry_hash;
  }
  const head = kvGet("chain_head") ?? null;
  if (entries && head && head !== prev) {
    return { entries, intact: false, brokenAt: null, unsealed: 0, head, reason: "recorded head does not match the last sealed row: rows were removed from the end" };
  }
  const unsealed = Number(get("SELECT COUNT(*) AS n FROM messages WHERE entry_hash IS NULL")?.n ?? 0);
  return { entries, intact: true, brokenAt: null, reason: "", unsealed, head: prev === GENESIS ? null : prev };
}
