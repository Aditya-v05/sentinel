import { config } from "../config.js";
import { chatJSON } from "../llm/groq.js";
import type { Range } from "../util/range.js";
import { demographics } from "./demographics.js";
import { network } from "./network.js";
import { sentimentTimeline } from "./timeline.js";
import { trends } from "./trends.js";

const cache = new Map<string, { at: number; value: unknown }>();

/** Turns the computed metrics (never raw messages) into a short analyst briefing. */
export async function insights(r: Range) {
  const key = `${r.source ?? "all"}|${r.from}|${r.to}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;

  const sent = sentimentTimeline(r);
  const tr = trends(r);
  const demo = demographics(r);
  const net = network(r);

  const facts = {
    sentimentTotals: sent.totals,
    sentimentTrend: sent.avgScore.filter((v) => v !== null).slice(-6),
    risingKeywords: tr.rising.slice(0, 8).map((k) => ({ term: k.term, recent: k.recent, growthPct: k.growthPct })),
    topics: tr.topics.slice(0, 8).map((t) => ({ label: t.label, total: t.total, trend: t.trend, avgSentiment: t.avgSentiment, isNew: t.isNew })),
    audience: {
      language: demo.language.rows.slice(0, 4),
      region: demo.region.rows.slice(0, 4),
      age: demo.age.rows,
      interests: demo.interests.rows.slice(0, 5),
    },
    influencers: net.influencers.slice(0, 5).map((n) => ({ label: n.label, reach: n.reach, community: n.community })),
    communities: net.communities
      .filter((c) => c.id >= 0)
      .map((c) => ({ id: c.id, size: c.size, sentiment: c.sentiment, topics: c.topics.map((t: any) => t.label) })),
  };

  const value = await chatJSON<{ headline: string; bullets: string[] }>(
    "You are a social media intelligence analyst. Write concise, specific, data-backed observations. Reply with JSON only.",
    `From these audience metrics, write a one-line headline and 4-6 bullet insights (sentiment shifts, rising narratives, who drives the conversation, audience makeup, a recommendation). Cite numbers.
Return: {"headline":"...","bullets":["..."]}

Metrics:
${JSON.stringify(facts)}`,
    { model: config.groq.insightsModel, maxTokens: 900 },
  );
  cache.set(key, { at: Date.now(), value });
  return value;
}
