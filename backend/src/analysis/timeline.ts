import { all, get, scope } from "../db.js";
import { bucketCount, bucketOf, bucketStarts, type Range } from "../util/range.js";
import { EMOTIONS, SENTIMENTS, STANCES } from "./labels.js";

/** Headline numbers + message volume over time. */
export function overview(r: Range) {
  const s = scope(r);
  const n = bucketCount(r);
  const volume = new Array(n).fill(0);
  for (const row of all(`SELECT m.ts FROM messages m WHERE ${s.where}`, ...s.params)) volume[bucketOf(row.ts, r)]++;

  const totals = get(
    `SELECT COUNT(*) AS messages,
            COUNT(DISTINCT m.author_key) AS authors,
            SUM(m.analyzed = 1) AS analyzed,
            SUM(m.analyzed = 0) AS pending,
            SUM(m.reply_to_ext_id IS NOT NULL) AS replies,
            AVG(m.sentiment_score) AS avgSentiment
       FROM messages m WHERE ${s.where}`,
    ...s.params,
  )!;
  return { buckets: bucketStarts(r), bucketSec: r.bucket, from: r.from, to: r.to, volume, totals };
}

/** Sentiment, emotion, stance and sarcasm along the timeline, plus example messages. */
export function sentimentTimeline(r: Range) {
  const s = scope(r);
  const n = bucketCount(r);
  const zeros = () => new Array(n).fill(0);
  const sentiment = Object.fromEntries(SENTIMENTS.map((k) => [k, zeros()])) as Record<string, number[]>;
  const emotion = Object.fromEntries(EMOTIONS.map((k) => [k, zeros()])) as Record<string, number[]>;
  const stance = Object.fromEntries(STANCES.map((k) => [k, zeros()])) as Record<string, number[]>;
  const sarcasm = zeros();
  const analyzed = zeros();
  const scoreSum = zeros();

  const rows = all(
    `SELECT m.ts, m.sentiment, m.sentiment_score, m.emotion, m.stance, m.sarcasm FROM messages m
      WHERE ${s.where} AND m.analyzed = 1`,
    ...s.params,
  );
  for (const row of rows) {
    const b = bucketOf(row.ts, r);
    analyzed[b]++;
    scoreSum[b] += row.sentiment_score ?? 0;
    sentiment[row.sentiment] && sentiment[row.sentiment][b]++;
    emotion[row.emotion] && emotion[row.emotion][b]++;
    stance[row.stance] && stance[row.stance][b]++;
    if (row.sarcasm) sarcasm[b]++;
  }
  const total = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

  const samples = Object.fromEntries(
    EMOTIONS.filter((e) => e !== "neutral").map((e) => [
      e,
      all(
        `SELECT m.text, m.ts, m.sarcasm, m.stance FROM messages m
          WHERE ${s.where} AND m.analyzed = 1 AND m.emotion = ? AND length(m.text) BETWEEN 20 AND 400
          ORDER BY m.ts DESC LIMIT 3`,
        ...s.params, e,
      ),
    ]),
  );
  const sarcasticSamples = all(
    `SELECT m.text, m.ts FROM messages m
      WHERE ${s.where} AND m.sarcasm = 1 AND length(m.text) BETWEEN 15 AND 400 ORDER BY m.ts DESC LIMIT 5`,
    ...s.params,
  );

  return {
    buckets: bucketStarts(r),
    bucketSec: r.bucket,
    analyzed,
    avgScore: scoreSum.map((v, i) => (analyzed[i] ? +(v / analyzed[i]).toFixed(3) : null)),
    sentiment,
    emotion,
    stance,
    sarcasm,
    totals: {
      analyzed: total(analyzed),
      sentiment: Object.fromEntries(Object.entries(sentiment).map(([k, v]) => [k, total(v)])),
      emotion: Object.fromEntries(Object.entries(emotion).map(([k, v]) => [k, total(v)])),
      stance: Object.fromEntries(Object.entries(stance).map(([k, v]) => [k, total(v)])),
      sarcasm: total(sarcasm),
    },
    samples,
    sarcasticSamples,
  };
}
