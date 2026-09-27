import { get, nowSec } from "../db.js";

export interface Range {
  source?: number;
  from: number;
  to: number;
  bucket: number; // seconds per time bucket
}

/**
 * Turns ?source=&days= into a concrete window. The window ends at the newest message
 * in scope (not "now"), so a channel that went quiet still shows its last N days.
 */
export function resolveRange(query: Record<string, unknown>): Range {
  const source = Number(query.source) || undefined;
  const days = Math.min(Math.max(Number(query.days) || 7, 1), 365);
  const latest = source
    ? get("SELECT MAX(ts) AS t FROM messages WHERE source_id = ?", source)?.t
    : get("SELECT MAX(ts) AS t FROM messages")?.t;
  const to = (latest as number | null) ?? nowSec();
  const from = to - days * 86400;
  const bucket = days <= 3 ? 3600 : days <= 14 ? 6 * 3600 : 86400;
  return { source, from, to, bucket };
}

export const bucketCount = (r: Range) => Math.max(1, Math.ceil((r.to - r.from) / r.bucket));
/** The newest message (ts === to) belongs to the last full bucket, not a sliver bucket of its own. */
export const bucketOf = (ts: number, r: Range) => Math.min(bucketCount(r) - 1, Math.max(0, Math.floor((ts - r.from) / r.bucket)));
/** Start time (unix seconds) of every bucket in the range, for chart x-axes. */
export const bucketStarts = (r: Range) => Array.from({ length: bucketCount(r) }, (_, i) => r.from + i * r.bucket);
