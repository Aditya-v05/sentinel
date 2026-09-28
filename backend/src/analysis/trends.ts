import { all, nowSec, scope } from "../db.js";
import { bucketCount, bucketOf, bucketStarts, type Range } from "../util/range.js";
import { tokenize } from "../util/text.js";

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

/**
 * Holt's linear exponential smoothing: a level and a trend, each updated with more weight on
 * recent buckets than old ones, projected `ahead` buckets forward. Still two lines of
 * arithmetic an analyst can check, but unlike a least-squares line it reacts to the last
 * few buckets rather than treating a week-old peak as equal evidence.
 */
export function forecast(series: number[], ahead = 3, alpha = 0.5, beta = 0.3) {
  const ys = series.slice(-12);
  if (ys.length < 3) return { slope: 0, next: Array(ahead).fill(ys.at(-1) ?? 0) as number[] };
  let level = ys[0];
  let trend = ys[1] - ys[0];
  for (let i = 1; i < ys.length; i++) {
    const prev = level;
    level = alpha * ys[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prev) + (1 - beta) * trend;
  }
  const next = Array.from({ length: ahead }, (_, k) => Math.max(0, +(level + trend * (k + 1)).toFixed(2)));
  return { slope: trend, next };
}

/**
 * Burst detection: how many standard deviations the latest bucket sits above the term's own
 * history. A term that always gets ten mentions an hour is not bursting at twelve; a term
 * that gets one and suddenly gets nine is. This is the "predict rising trends" signal that
 * fires before the growth ratio does, because it needs one anomalous bucket, not a quarter
 * of the window.
 */
export function burstScore(series: number[]) {
  if (series.length < 4) return 0;
  const latest = series.at(-1)!;
  const history = series.slice(0, -1);
  const mean = sum(history) / history.length;
  const sd = Math.sqrt(sum(history.map((v) => (v - mean) ** 2)) / history.length);
  return +((latest - mean) / (sd + 0.5)).toFixed(2);   // +0.5: a flat history should not make z infinite
}

function direction(series: number[], slope: number) {
  const mean = sum(series.slice(-8)) / Math.max(1, Math.min(8, series.length));
  const change = (slope * Math.min(8, series.length)) / Math.max(mean, 1);
  return change > 0.3 ? "rising" : change < -0.3 ? "falling" : "stable";
}

/**
 * Trend detection over the selected window:
 *  - keywords/hashtags: volume per bucket, "rising" = recent quarter vs the rest (smoothed ratio)
 *  - LLM topics: volume + avg sentiment per bucket, with a linear forecast of the next buckets
 *  - viral posts: highest engagement (forwards, reactions, replies, views)
 */
export function trends(r: Range) {
  const s = scope(r);
  const n = bucketCount(r);
  const buckets = bucketStarts(r);

  // --- keywords ---
  const msgs = all(`SELECT m.ts, m.text FROM messages m WHERE ${s.where} AND m.analyzed != 2`, ...s.params);
  const series = new Map<string, number[]>();
  for (const m of msgs) {
    const b = bucketOf(m.ts, r);
    for (const w of new Set(tokenize(m.text ?? ""))) {
      let arr = series.get(w);
      if (!arr) series.set(w, (arr = new Array(n).fill(0)));
      arr[b]++;
    }
  }
  const recentN = Math.max(1, Math.round(n * 0.25));
  const keywords = [...series.entries()]
    .map(([term, arr]) => {
      const total = sum(arr);
      const recent = sum(arr.slice(-recentN));
      const baseRate = (total - recent) / Math.max(1, n - recentN);
      const recentRate = recent / recentN;
      const growth = (recentRate + 0.5) / (baseRate + 0.5);
      return { term, total, recent, growthPct: Math.round((growth - 1) * 100), score: growth * Math.log1p(recent), series: arr };
    })
    .filter((k) => k.total >= 3);

  const rising = keywords
    .filter((k) => k.recent >= 3 && k.growthPct > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);
  const bursting = keywords
    .map((k) => ({ term: k.term, latest: k.series.at(-1)!, baseline: +(sum(k.series.slice(0, -1)) / Math.max(1, n - 1)).toFixed(2), zScore: burstScore(k.series), series: k.series }))
    .filter((k) => k.latest >= 3 && k.zScore >= 2)
    .sort((a, b) => b.zScore - a.zScore)
    .slice(0, 12);
  const top = [...keywords].sort((a, b) => b.total - a.total).slice(0, 15);

  // --- topics ---
  const topicRows = all(
    `SELECT t.id, t.label, t.keywords, t.description, t.created_at, m.ts, m.sentiment_score
       FROM messages m JOIN topics t ON t.id = m.topic_id
      WHERE ${s.where}`,
    ...s.params,
  );
  const topicMap = new Map<number, any>();
  for (const row of topicRows) {
    let t = topicMap.get(row.id);
    if (!t) {
      t = {
        id: row.id, label: row.label, keywords: JSON.parse(row.keywords ?? "[]"), description: row.description,
        discoveredAt: row.created_at, series: new Array(n).fill(0), scoreSum: 0, scored: 0,
      };
      topicMap.set(row.id, t);
    }
    t.series[bucketOf(row.ts, r)]++;
    if (row.sentiment_score != null) {
      t.scoreSum += row.sentiment_score;
      t.scored++;
    }
  }
  // A topic is "new" if it emerged after the initial discovery pass, within the last day.
  const firstDiscovery = Number(all("SELECT MIN(created_at) AS t FROM topics")[0]?.t ?? 0);
  const topics = [...topicMap.values()]
    .map(({ scoreSum, scored, ...t }) => {
      const f = forecast(t.series);
      return {
        ...t,
        total: sum(t.series),
        recent: sum(t.series.slice(-recentN)),
        avgSentiment: scored ? +(scoreSum / scored).toFixed(2) : 0,
        trend: direction(t.series, f.slope),
        forecast: f.next,
        isNew: t.discoveredAt > firstDiscovery + 3600 && nowSec() - t.discoveredAt < 24 * 3600,
      };
    })
    .sort((a, b) => b.recent - a.recent || b.total - a.total);

  // --- viral posts ---
  const viral = all(
    `SELECT m.id, m.text, m.ts, m.views, m.forwards, m.reactions, m.sentiment, m.emotion, src.title AS source,
            (SELECT COUNT(*) FROM messages c WHERE c.source_id = m.source_id AND c.reply_to_ext_id = m.ext_id) AS replies
       FROM messages m JOIN sources src ON src.id = m.source_id
      WHERE ${s.where} AND m.analyzed != 2
      ORDER BY COALESCE(m.forwards, 0) * 3 + COALESCE(m.reactions, 0) * 2 + replies * 2 + COALESCE(m.views, 0) / 100.0 DESC
      LIMIT 8`,
    ...s.params,
  );

  return { buckets, bucketSec: r.bucket, forecastBuckets: 3, forecastMethod: "holt", rising, bursting, top, topics, viral };
}
