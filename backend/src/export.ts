import { all, scope } from "./db.js";
import { coordination } from "./analysis/coordination.js";
import { demographics } from "./analysis/demographics.js";
import { network, spread } from "./analysis/network.js";
import { sentimentTimeline, overview } from "./analysis/timeline.js";
import { trends } from "./analysis/trends.js";
import { userLabels } from "./analysis/users.js";
import type { Range } from "./util/range.js";

/**
 * Everything the dashboard computes, as files. The dashboard is one client of the API; an
 * analyst's own tooling is another, and it wants CSV or JSON, not a React page.
 *
 * Per-user demographic profiles are never exported, same as they are never served: only
 * the aggregates leave. Message rows carry the author's public handle, which is what the
 * platform itself shows.
 */

export const DATASETS = ["messages", "sentiment", "keywords", "topics", "nodes", "edges", "segments", "audience", "coordination", "report"] as const;
export type Dataset = (typeof DATASETS)[number];

const iso = (ts: number) => new Date(ts * 1000).toISOString();

export function dataset(name: Dataset, r: Range): { rows: Record<string, unknown>[] } | { json: unknown } {
  switch (name) {
    case "messages": {
      const s = scope(r);
      const rows = all(
        `SELECT m.id, src.platform, src.title AS source, CAST(m.ext_id AS TEXT) AS ext_id, m.author_key, m.text, m.ts,
                CAST(m.reply_to_ext_id AS TEXT) AS reply_to, m.fwd_from_key, m.views, m.forwards, m.reactions, m.hashtags,
                m.sentiment, m.sentiment_score, m.emotion, m.sarcasm, m.stance, t.label AS topic, m.collected_at, m.entry_hash
           FROM messages m JOIN sources src ON src.id = m.source_id LEFT JOIN topics t ON t.id = m.topic_id
          WHERE ${s.where} ORDER BY m.ts`,
        ...s.params,
      );
      const labels = userLabels(rows.flatMap((m) => [m.author_key, m.fwd_from_key]).filter(Boolean));
      return {
        rows: rows.map((m) => ({
          id: m.id, platform: m.platform, source: m.source, ext_id: m.ext_id, author: labels.get(m.author_key)?.label ?? "",
          time: iso(m.ts), text: m.text, reply_to: m.reply_to ?? "", reshared_from: m.fwd_from_key ? labels.get(m.fwd_from_key)?.label ?? "" : "",
          views: m.views, reshares: m.forwards, reactions: m.reactions, hashtags: JSON.parse(m.hashtags ?? "[]").join(" "),
          sentiment: m.sentiment, score: m.sentiment_score, emotion: m.emotion, sarcasm: m.sarcasm, stance: m.stance, topic: m.topic,
          collected_at: m.collected_at ? iso(m.collected_at) : "", seal: m.entry_hash,
        })),
      };
    }
    case "sentiment": {
      const t = sentimentTimeline(r);
      return {
        rows: t.buckets.map((b, i) => ({
          bucket_start: iso(b), analysed: t.analyzed[i], avg_score: t.avgScore[i],
          positive: t.sentiment.positive[i], neutral: t.sentiment.neutral[i], negative: t.sentiment.negative[i],
          supportive: t.stance.supportive[i], against: t.stance.against[i], sarcastic: t.sarcasm[i],
          ...Object.fromEntries(Object.entries(t.emotion).map(([k, v]) => [`emotion_${k}`, v[i]])),
        })),
      };
    }
    case "keywords": {
      const t = trends(r);
      const burst = new Map(t.bursting.map((b) => [b.term, b.zScore]));
      return { rows: t.top.concat(t.rising.filter((k) => !t.top.some((x) => x.term === k.term))).map((k) => ({ term: k.term, total: k.total, recent: k.recent, growth_pct: k.growthPct, burst_z: burst.get(k.term) ?? "", series: k.series.join(" ") })) };
    }
    case "topics": {
      const t = trends(r);
      return { rows: t.topics.map((x) => ({ id: x.id, label: x.label, keywords: x.keywords.join(" "), total: x.total, recent: x.recent, avg_sentiment: x.avgSentiment, trend: x.trend, forecast: x.forecast.join(" "), discovered_at: iso(x.discoveredAt), series: x.series.join(" ") })) };
    }
    case "nodes": {
      const n = network(r);
      return { rows: n.nodes.map((x) => ({ id: x.id, label: x.label, kind: x.kind, messages: x.messages, pagerank: x.pagerank, betweenness: x.betweenness, reach: x.reach, interactions_received: x.inWeight, interactions_made: x.outWeight, segment: x.community, first_seen: iso(x.firstTs), dominant_sentiment: x.sentiment })) };
    }
    case "edges": {
      const n = network(r);
      return { rows: n.edges.map((e) => ({ source: e.source, target: e.target, weight: e.weight, replies: e.replies, mentions: e.mentions, reshares: e.forwards, first_seen: iso(e.firstTs) })) };
    }
    case "segments": {
      const n = network(r);
      return { rows: n.communities.map((c) => ({ segment: c.id, people: c.size, messages: c.messages, first_seen: iso(c.firstTs), positive: c.sentiment.positive ?? 0, neutral: c.sentiment.neutral ?? 0, negative: c.sentiment.negative ?? 0, top_topics: c.topics.map((t: any) => t.label).join(" | "), leaders: c.leaders.join(" | ") })) };
    }
    case "audience":
      return { json: demographics(r) };
    case "coordination":
      return { json: coordination(r) };
    case "report":
      return {
        json: {
          generated_at: new Date().toISOString(), range: { from: iso(r.from), to: iso(r.to), bucket_sec: r.bucket, source: r.source ?? null },
          overview: overview(r), sentiment: sentimentTimeline(r), trends: trends(r), audience: demographics(r),
          network: network(r), spread: spread(r), coordination: coordination(r),
        },
      };
  }
}

/** RFC 4180-ish: quote everything that needs it, CRLF lines, UTF-8 BOM so Excel reads Devanagari. */
export function toCSV(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => {
    if (v == null) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}
