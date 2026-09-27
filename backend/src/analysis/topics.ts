import { all, get, kvGet, kvSet, nowSec, run, type Row } from "../db.js";
import { chatJSON, clip } from "../llm/groq.js";

const MAX_TOPICS = 24;
const REFRESH_EVERY_SEC = 6 * 3600;
const SAMPLE = 80;

export const listTopics = () => all("SELECT id, label, keywords, description, created_at FROM topics ORDER BY id");

interface DiscoveredTopics {
  topics: { label: string; keywords?: string[]; description?: string }[];
}

/** Asks the LLM for up to `want` themes in `sample` that aren't already known; stores them. */
async function discover(sample: Row[], want: number) {
  const existing = listTopics();
  want = Math.min(want, MAX_TOPICS - existing.length);
  if (want <= 0) return 0;
  const known = existing.length
    ? `Already known topics (do NOT repeat these): ${existing.map((t) => t.label).join("; ")}.\nOnly return genuinely NEW themes; return an empty list if there are none.`
    : "";

  const res = await chatJSON<DiscoveredTopics>(
    "You find discussion topics in social media conversations. Reply with JSON only.",
    `Below are recent messages from online communities (one per line).
Identify up to ${want} distinct recurring discussion themes. Each theme must cover several messages — group related news items together (e.g. "Crypto regulation", "Fuel price hike", "Exam results delay"). Not single headlines, and not generic labels like "General chat".
${known}
Return: {"topics":[{"label":"2-4 word title","keywords":["3-6 lowercase keywords"],"description":"one sentence"}]}

Messages:
${sample.map((m) => "- " + clip(m.text, 160)).join("\n")}`,
    { maxTokens: 1500 },
  );

  const norm = (l: string) => l.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const knownLabels = new Set(existing.map((t) => norm(String(t.label))));
  let added = 0;
  for (const t of (res.topics ?? []).slice(0, want)) {
    const label = clip(t.label, 60);
    if (!label || knownLabels.has(norm(label))) continue;
    knownLabels.add(norm(label));
    run(
      "INSERT INTO topics (label, keywords, description, created_at) VALUES (?, ?, ?, ?)",
      label, JSON.stringify((t.keywords ?? []).slice(0, 6)), clip(t.description, 200), nowSec(),
    );
    added++;
  }
  return added;
}

/**
 * Topic discovery: the LLM reads a sample of messages and names the discussion themes.
 *  - every source gets its own discovery pass the first time it has data (before its
 *    messages are labelled), so a busy source can't crowd out a quieter one;
 *  - every few hours, new messages from all sources are checked for *new* themes, so
 *    the list grows as conversations shift (created_at marks when a theme emerged).
 */
export async function ensureTopics() {
  let added = 0;

  for (const src of all("SELECT id FROM sources ORDER BY id")) {
    const key = `topics_source_${src.id}`;
    if (kvGet(key)) continue;
    const sample = all(
      "SELECT text FROM messages WHERE source_id = ? AND analyzed != 2 ORDER BY ts DESC LIMIT ?",
      src.id, SAMPLE,
    );
    if (sample.length < 10) continue;
    added += await discover(sample, listTopics().length ? 5 : 8);
    kvSet(key, String(nowSec()));
  }

  const lastRefresh = Number(kvGet("topics_discovered_at") ?? 0);
  if (nowSec() - lastRefresh >= REFRESH_EVERY_SEC) {
    const sources = all("SELECT id FROM sources");
    const per = Math.max(10, Math.ceil(SAMPLE / Math.max(1, sources.length)));
    const sample = sources.flatMap((s) =>
      all("SELECT text FROM messages WHERE source_id = ? AND analyzed != 2 AND ts > ? ORDER BY ts DESC LIMIT ?", s.id, lastRefresh, per),
    );
    if (sample.length >= 30 || !lastRefresh) {
      if (lastRefresh) added += await discover(sample, 3);
      kvSet("topics_discovered_at", String(nowSec()));
    }
  }
  return added;
}

export const topicCount = () => Number(get("SELECT COUNT(*) AS n FROM topics")?.n ?? 0);
