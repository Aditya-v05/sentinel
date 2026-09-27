export const fmtNum = (n: number | null | undefined) =>
  n == null ? "—" : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();

export const fmtPct = (n: number, digits = 0) => `${(n * 100).toFixed(digits)}%`;

export const fmtScore = (n: number | null | undefined) => (n == null ? "—" : (n > 0 ? "+" : "") + n.toFixed(2));

/** Bucket start -> short axis label; hourly buckets show time, daily show date. */
export function fmtBucket(ts: number, bucketSec: number) {
  const d = new Date(ts * 1000);
  if (bucketSec >= 86400) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (bucketSec >= 6 * 3600) return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" });
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export const fmtDate = (ts: number | null | undefined) =>
  ts ? new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

export function fmtAgo(ts: number | null | undefined) {
  if (!ts) return "never";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Semantic text class for a sentiment-ish score or label. */
export function toneClass(v: number | string | null | undefined) {
  if (typeof v === "number") return v > 0.1 ? "pos" : v < -0.1 ? "neg" : "";
  if (v === "positive" || v === "supportive" || v === "rising") return "pos";
  if (v === "negative" || v === "against" || v === "falling") return "neg";
  return "";
}
