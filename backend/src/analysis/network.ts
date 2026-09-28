import { DirectedGraph } from "graphology";
import { createRequire } from "node:module";
import { all, scope } from "../db.js";
import { bucketCount, bucketOf, bucketStarts, type Range } from "../util/range.js";

// These graphology packages are CommonJS with `export default` typings; load them via require for correct interop.
const require = createRequire(import.meta.url);
const pagerank: typeof import("graphology-metrics/centrality/pagerank.js").default = require("graphology-metrics/centrality/pagerank");
const betweenness: typeof import("graphology-metrics/centrality/betweenness.js").default = require("graphology-metrics/centrality/betweenness");
const louvain: typeof import("graphology-communities-louvain").default = require("graphology-communities-louvain");

const MAX_RENDER_NODES = 400;
const MIN_COMMUNITY = 3;
const MAX_COMMUNITIES = 7; // matches the frontend's categorical colour slots; the rest become "other"

interface NodeStat {
  key: string;
  messages: number;
  firstTs: number;
  sentiment: Record<string, number>;
  topics: Map<number, number>;
}
interface EdgeStat {
  source: string;
  target: string;
  weight: number;
  replies: number;
  mentions: number;
  forwards: number;
  firstTs: number;
}

const cache = new Map<string, { at: number; value: ReturnType<typeof compute> }>();

function buildNetwork(r: Range) {
  const key = `${r.source ?? "all"}|${r.from}|${r.to}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = compute(r);
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 20) cache.delete(cache.keys().next().value!);
  return value;
}

/**
 * Interaction graph: an edge A -> B means A paid attention to B (replied to, mentioned,
 * or forwarded B). PageRank over that graph surfaces key opinion leaders; Louvain
 * modularity finds user segments (communities).
 */
function compute(r: Range) {
  const s = scope(r);
  const rows = all(
    `SELECT m.author_key, m.ts, m.mentions, m.fwd_from_key, m.sentiment, m.topic_id, p.author_key AS parent_author
       FROM messages m
       LEFT JOIN messages p ON p.source_id = m.source_id AND p.ext_id = m.reply_to_ext_id
      WHERE ${s.where} AND m.author_key IS NOT NULL
      ORDER BY m.ts`,
    ...s.params,
  );

  const nodes = new Map<string, NodeStat>();
  const edges = new Map<string, EdgeStat>();
  const node = (k: string, ts: number) => {
    let n = nodes.get(k);
    if (!n) nodes.set(k, (n = { key: k, messages: 0, firstTs: ts, sentiment: {}, topics: new Map() }));
    return n;
  };
  const link = (from: string, to: string | null, kind: "replies" | "mentions" | "forwards", ts: number) => {
    if (!to || from === to) return;
    node(to, ts);
    const id = `${from}→${to}`;
    let e = edges.get(id);
    if (!e) edges.set(id, (e = { source: from, target: to, weight: 0, replies: 0, mentions: 0, forwards: 0, firstTs: ts }));
    e[kind]++;
    e.weight++;
  };

  for (const m of rows) {
    const n = node(m.author_key, m.ts);
    n.messages++;
    if (m.sentiment) n.sentiment[m.sentiment] = (n.sentiment[m.sentiment] ?? 0) + 1;
    if (m.topic_id) n.topics.set(m.topic_id, (n.topics.get(m.topic_id) ?? 0) + 1);
    link(m.author_key, m.parent_author, "replies", m.ts);
    link(m.author_key, m.fwd_from_key, "forwards", m.ts);
    for (const k of JSON.parse(m.mentions ?? "[]") as string[]) link(m.author_key, k, "mentions", m.ts);
  }

  const graph = new DirectedGraph();
  for (const k of nodes.keys()) graph.addNode(k);
  for (const e of edges.values()) graph.addEdge(e.source, e.target, { weight: e.weight });

  const rank = graph.order ? pagerank(graph, { getEdgeWeight: "weight" }) : {};
  const between = graph.order && graph.order <= 1500 ? betweenness(graph, { normalized: true }) : {};
  const rawCommunity: Record<string, number> = graph.size ? louvain(graph, { getEdgeWeight: "weight" }) : {};

  // Re-number communities by size; tiny ones and those beyond the colour budget become -1 ("other").
  const sizes = new Map<number, number>();
  for (const c of Object.values(rawCommunity)) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  const ordered = [...sizes.entries()].filter(([, n]) => n >= MIN_COMMUNITY).sort((a, b) => b[1] - a[1]);
  const renumber = new Map(ordered.slice(0, MAX_COMMUNITIES).map(([c], i) => [c, i]));
  const communityOf = (k: string) => renumber.get(rawCommunity[k]) ?? -1;

  const inW = new Map<string, number>();
  const outW = new Map<string, number>();
  const reach = new Map<string, Set<string>>();
  for (const e of edges.values()) {
    inW.set(e.target, (inW.get(e.target) ?? 0) + e.weight);
    outW.set(e.source, (outW.get(e.source) ?? 0) + e.weight);
    if (!reach.has(e.target)) reach.set(e.target, new Set());
    reach.get(e.target)!.add(e.source);
  }

  const keys = [...nodes.keys()];
  const users = new Map<string, any>();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    for (const u of all(
      `SELECT key, username, display_name, kind FROM users WHERE key IN (${chunk.map(() => "?").join(",")})`,
      ...chunk,
    )) users.set(u.key, u);
  }
  const label = (k: string) => {
    const u = users.get(k);
    if (u?.username) return "@" + u.username;
    if (u?.display_name) return u.display_name;
    return k.startsWith("tg:@") ? k.slice(3) : "user " + k.slice(-4);
  };

  const allNodes = keys.map((k) => {
    const n = nodes.get(k)!;
    const dominant = Object.entries(n.sentiment).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return {
      id: k,
      label: label(k),
      kind: (users.get(k)?.kind as string) ?? "user",
      messages: n.messages,
      pagerank: +(rank[k] ?? 0).toFixed(5),
      betweenness: +(between[k] ?? 0).toFixed(4),
      inWeight: inW.get(k) ?? 0,
      outWeight: outW.get(k) ?? 0,
      reach: reach.get(k)?.size ?? 0,
      community: communityOf(k),
      firstTs: n.firstTs,
      sentiment: dominant,
    };
  });
  allNodes.sort((a, b) => b.pagerank - a.pagerank);

  return { nodes: allNodes, edges: [...edges.values()], stats: nodes, communityOf };
}

/** The segment (Louvain community) each author belongs to in this window; -1 = unclustered. */
export function communityOfFn(r: Range) {
  return buildNetwork(r).communityOf;
}

export function network(r: Range) {
  const { nodes, edges, stats } = buildNetwork(r);
  const shown = new Set(nodes.slice(0, MAX_RENDER_NODES).map((n) => n.id));
  const topicLabels = new Map(all("SELECT id, label FROM topics").map((t) => [t.id as number, t.label as string]));

  const communities = new Map<number, any>();
  for (const n of nodes) {
    let c = communities.get(n.community);
    if (!c) {
      c = { id: n.community, size: 0, messages: 0, firstTs: n.firstTs, sentiment: {}, topics: new Map(), leaders: [] };
      communities.set(n.community, c);
    }
    const st = stats.get(n.id)!;
    c.size++;
    c.messages += st.messages;
    c.firstTs = Math.min(c.firstTs, n.firstTs);
    for (const [k, v] of Object.entries(st.sentiment)) c.sentiment[k] = (c.sentiment[k] ?? 0) + v;
    for (const [t, v] of st.topics) c.topics.set(t, (c.topics.get(t) ?? 0) + v);
    if (c.leaders.length < 3 && n.kind === "user") c.leaders.push(n.label);
  }

  return {
    totals: { nodes: nodes.length, edges: edges.length, shown: shown.size },
    nodes: nodes.filter((n) => shown.has(n.id)),
    edges: edges.filter((e) => shown.has(e.source) && shown.has(e.target)),
    influencers: nodes.filter((n) => n.inWeight > 0).slice(0, 15),
    communities: [...communities.values()]
      .map((c) => ({
        ...c,
        topics: [...c.topics.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([id, count]) => ({ id, label: topicLabels.get(id) ?? "?", count })),
      }))
      .sort((a, b) => (a.id === -1 ? 1 : b.id === -1 ? -1 : a.id - b.id)),
  };
}

/**
 * How a topic (or all conversation) spreads across communities over time:
 * per-community message volume and average sentiment for each time bucket.
 */
export function spread(r: Range, topicId?: number) {
  const { communityOf } = buildNetwork(r);
  const s = scope(r);
  const n = bucketCount(r);
  const rows = all(
    `SELECT m.author_key, m.ts, m.sentiment_score FROM messages m
      WHERE ${s.where} AND m.author_key IS NOT NULL ${topicId ? "AND m.topic_id = ?" : ""}`,
    ...s.params, ...(topicId ? [topicId] : []),
  );
  const series = new Map<number, { community: number; counts: number[]; scoreSum: number[]; scored: number[]; firstTs: number }>();
  for (const row of rows) {
    const c = communityOf(row.author_key);
    let e = series.get(c);
    if (!e) series.set(c, (e = { community: c, counts: new Array(n).fill(0), scoreSum: new Array(n).fill(0), scored: new Array(n).fill(0), firstTs: row.ts }));
    const b = bucketOf(row.ts, r);
    e.counts[b]++;
    e.firstTs = Math.min(e.firstTs, row.ts);
    if (row.sentiment_score != null) {
      e.scoreSum[b] += row.sentiment_score;
      e.scored[b]++;
    }
  }
  return {
    buckets: bucketStarts(r),
    bucketSec: r.bucket,
    series: [...series.values()]
      .map((e) => ({
        community: e.community,
        firstTs: e.firstTs,
        total: e.counts.reduce((a, b) => a + b, 0),
        counts: e.counts,
        avgSentiment: e.scoreSum.map((v, i) => (e.scored[i] ? +(v / e.scored[i]).toFixed(3) : null)),
      }))
      .sort((a, b) => a.firstTs - b.firstTs),
  };
}
