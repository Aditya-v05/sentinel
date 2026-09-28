/**
 * messages.ext_id is a 64-bit integer. X and Telegram ids already are; Reddit ids are base36
 * strings and YouTube comment ids are opaque strings, so those are mapped onto 64 bits here.
 * Reddit's map is exact (base36 -> integer, reversible). YouTube's is a 64-bit FNV-1a hash:
 * not reversible, and a collision would need two comment ids on the same source with the same
 * hash, which at 2^64 does not happen in practice.
 */
export const base36ToBigInt = (s: string) => {
  let n = 0n;
  for (const ch of s.toLowerCase()) n = n * 36n + BigInt(parseInt(ch, 36));
  return n;
};

export function fnv64(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const ch of new TextEncoder().encode(s)) h = ((h ^ BigInt(ch)) * 0x100000001b3n) & 0xffffffffffffffffn;
  // SQLite INTEGER is signed; fold into the positive range so comparisons and ordering stay sane.
  return h & 0x7fffffffffffffffn;
}

export const mentionsOf = (text: string, re: RegExp) => [...new Set([...text.matchAll(re)].map((m) => m[1]))];
export const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;
export const hashtagsOf = (text: string) => [...new Set((text.match(HASHTAG_RE) ?? []).map((t) => t.toLowerCase()))];
