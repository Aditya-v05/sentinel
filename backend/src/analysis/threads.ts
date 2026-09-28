import { all, get, scope } from "../db.js";
import type { Range } from "../util/range.js";
import { userLabels } from "./users.js";

/**
 * Sentiment inside one conversation. The timeline pages aggregate by hour or day across a
 * source; a thread is the other axis the statement asks for: how a discussion under one
 * post moved from its first reply to its last.
 */

/** The most-discussed root posts in range, each with its replies' sentiment trajectory. */
export function threads(r: Range, limit = 12) {
  const s = scope(r);
  const roots = all(
    `SELECT m.id, m.source_id, m.ext_id, m.author_key, m.text, m.ts, src.title AS source, src.platform,
            (SELECT COUNT(*) FROM messages c WHERE c.source_id = m.source_id AND c.reply_to_ext_id = m.ext_id) AS replies
       FROM messages m JOIN sources src ON src.id = m.source_id
      WHERE ${s.where} AND m.reply_to_ext_id IS NULL
      ORDER BY replies DESC, m.ts DESC LIMIT ?`,
    ...s.params, limit * 3,
  ).filter((m) => m.replies >= 3).slice(0, limit);

  const labels = userLabels(roots.map((m) => m.author_key).filter(Boolean));
  return roots.map((root) => {
    const scores = all(
      `SELECT c.sentiment_score AS score FROM messages c
        WHERE c.source_id = ? AND c.reply_to_ext_id = ? AND c.analyzed = 1 ORDER BY c.ts`,
      root.source_id, root.ext_id,
    ).map((x) => x.score as number);
    const third = Math.max(1, Math.floor(scores.length / 3));
    const avg = (a: number[]) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) : null);
    return {
      id: root.id, text: String(root.text ?? "").slice(0, 200), author: labels.get(root.author_key)?.label ?? "", source: root.source,
      platform: root.platform, ts: root.ts, replies: root.replies, labelled: scores.length,
      scores, avg: avg(scores), start: avg(scores.slice(0, third)), end: avg(scores.slice(-third)),
      drift: scores.length >= 4 ? +((avg(scores.slice(-third))! - avg(scores.slice(0, third))!).toFixed(3)) : null,
    };
  });
}

/** One conversation in order: the root, then every reply with its labels. */
export function thread(id: number) {
  const root = get(
    `SELECT m.*, src.title AS source, src.platform FROM messages m JOIN sources src ON src.id = m.source_id WHERE m.id = ?`, id);
  if (!root) throw new Error(`no message ${id}`);
  const replies = all(
    `SELECT c.id, c.author_key, c.text, c.ts, c.sentiment, c.sentiment_score, c.emotion, c.stance, c.sarcasm, c.reply_to_ext_id
       FROM messages c WHERE c.source_id = ? AND c.reply_to_ext_id = ? ORDER BY c.ts`,
    root.source_id, root.ext_id,
  );
  const labels = userLabels([root.author_key, ...replies.map((c) => c.author_key)].filter(Boolean));
  const shape = (m: any) => ({
    id: m.id, author: labels.get(m.author_key)?.label ?? "", text: m.text, ts: m.ts,
    sentiment: m.sentiment, score: m.sentiment_score, emotion: m.emotion, stance: m.stance, sarcasm: m.sarcasm,
  });
  return { root: { ...shape(root), source: root.source, platform: root.platform }, replies: replies.map(shape) };
}
