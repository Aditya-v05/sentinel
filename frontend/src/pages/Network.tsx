import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { Card, Empty, ErrorBox, Page, Spark } from "../components/ui";
import { useApi, type Community, type GraphEdge, type GraphNode, type Series } from "../lib/api";
import { useFilters } from "../lib/filters";
import { fmtDate, fmtNum, fmtScore, toneClass } from "../lib/format";

interface NetworkData {
  totals: { nodes: number; edges: number; shown: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
  influencers: GraphNode[];
  communities: Community[];
}
interface SpreadData extends Series {
  series: { community: number; firstTs: number; total: number; counts: number[]; avgSentiment: (number | null)[] }[];
}

export const segmentName = (id: number) => (id < 0 ? "Unclustered" : `Segment ${String.fromCharCode(65 + id)}`);

/** Canvas can't read CSS variables, so resolve the theme tokens and track light/dark changes. */
function useTokens() {
  const read = () => {
    const s = getComputedStyle(document.documentElement);
    const v = (k: string) => s.getPropertyValue(k).trim();
    return { ink: v("--ink"), g2: v("--g2"), g3: v("--g3"), g4: v("--g4"), g5: v("--g5"), bg: v("--bg"), pos: v("--pos"), neg: v("--neg"), font: v("--font") };
  };
  const [tokens, setTokens] = useState(read);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setTokens(read());
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return tokens;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export default function Network() {
  const { qs } = useFilters();
  const { data, error } = useApi<NetworkData>(`/network${qs}`);
  const [segment, setSegment] = useState<number | null>(null);

  return (
    <Page title="Network" sub="Who talks to whom, who holds influence, and how conversation moves between audience segments.">
      <ErrorBox error={error} />
      {!data ? null : !data.totals.nodes ? (
        <Card><Empty>No interactions in this range yet.</Empty></Card>
      ) : (
        <>
          <Graph data={data} segment={segment} />

          <div className="section-label">Key opinion leaders</div>
          <Card title="Most influential" note="PageRank over replies, mentions and forwards">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Account</th>
                    <th className="num">Reach</th>
                    <th className="num">Interactions received</th>
                    <th className="num">Messages</th>
                    <th className="num">Influence</th>
                    <th className="num">Bridging</th>
                    <th>Segment</th>
                  </tr>
                </thead>
                <tbody>
                  {data.influencers.map((n, i) => (
                    <tr key={n.id}>
                      <td className="mono faint">{i + 1}</td>
                      <td>
                        {n.label} {n.kind === "channel" && <span className="tag">channel</span>}
                        {n.sentiment && <div className={`mono ${toneClass(n.sentiment)}`}>mostly {n.sentiment}</div>}
                      </td>
                      <td className="num">{n.reach}</td>
                      <td className="num">{n.inWeight}</td>
                      <td className="num">{n.messages}</td>
                      <td className="num mono">{(n.pagerank * 100).toFixed(2)}</td>
                      <td className="num mono">{n.betweenness.toFixed(3)}</td>
                      <td className="muted">{segmentName(n.community)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note">Reach = distinct people who replied to, mentioned or forwarded the account. Bridging = betweenness centrality (connects otherwise separate groups).</p>
          </Card>

          <div className="section-label">Audience segments</div>
          <div className="grid g3">
            {data.communities.map((c) => {
              const s = c.sentiment;
              const total = (s.positive ?? 0) + (s.neutral ?? 0) + (s.negative ?? 0);
              const selected = segment === c.id;
              return (
                <button
                  key={c.id}
                  className="card"
                  style={{ textAlign: "left", cursor: "pointer", outline: selected ? "1.5px solid var(--ink)" : undefined }}
                  onClick={() => setSegment(selected ? null : c.id)}
                >
                  <div className="card-h">
                    <h3>{segmentName(c.id)}</h3>
                    <span>{c.size} people · {fmtNum(c.messages)} msgs</span>
                  </div>
                  <div className="legend" style={{ marginBottom: 8 }}>
                    <span className="pos">{total ? Math.round(((s.positive ?? 0) / total) * 100) : 0}% positive</span>
                    <span className="neg">{total ? Math.round(((s.negative ?? 0) / total) * 100) : 0}% negative</span>
                  </div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {c.topics.length ? c.topics.map((t) => t.label).join(" · ") : "No topics yet"}
                  </div>
                  {c.leaders.length > 0 && <div className="mono faint" style={{ marginTop: 6 }}>{c.leaders.join("  ")}</div>}
                  <div className="note" style={{ marginTop: 8 }}>{selected ? "Highlighted in graph — click to clear" : `Active since ${fmtDate(c.firstTs)}`}</div>
                </button>
              );
            })}
          </div>

          <div className="section-label">Spread</div>
          <Spread qs={qs} />
        </>
      )}
    </Page>
  );
}

function Graph({ data, segment }: { data: NetworkData; segment: number | null }) {
  const t = useTokens();
  const { ref, width } = useWidth();
  const fg = useRef<any>(null);
  const fitted = useRef(false);

  const graph = useMemo(
    () => ({ nodes: data.nodes.map((n) => ({ ...n })), links: data.edges.map((e) => ({ ...e })) }),
    [data],
  );
  const labelled = useMemo(() => new Set(data.nodes.slice(0, 8).map((n) => n.id)), [data]);
  const [minTs, maxTs] = useMemo(() => {
    const ts = data.nodes.map((n) => n.firstTs);
    return [Math.min(...ts), Math.max(...ts)];
  }, [data]);

  // Spread the layout out (defaults pack small graphs into a tight ball), then fit it to the box.
  useEffect(() => {
    const g = fg.current;
    if (!g) return;
    g.d3Force("charge")?.strength(-90);
    g.d3Force("link")?.distance(45);
    g.d3ReheatSimulation();
    const t = setTimeout(() => g.zoomToFit(400, 50), 2500);
    return () => clearTimeout(t);
  }, [graph]);

  const [cut, setCut] = useState(maxTs);
  const [playing, setPlaying] = useState(false);
  useEffect(() => { setCut(maxTs); fitted.current = false; }, [maxTs]);
  useEffect(() => {
    if (!playing) return;
    const step = (maxTs - minTs) / 80 || 1;
    const id = setInterval(() => {
      setCut((c) => {
        if (c >= maxTs) { setPlaying(false); return maxTs; }
        return Math.min(maxTs, c + step);
      });
    }, 100);
    return () => clearInterval(id);
  }, [playing, minTs, maxTs]);

  const maxRank = Math.max(...data.nodes.map((n) => n.pagerank), 1e-9);
  const visibleCount = data.nodes.filter((n) => n.firstTs <= cut).length;

  return (
    <Card title="Interaction graph" note={`${fmtNum(data.totals.nodes)} accounts · ${fmtNum(data.totals.edges)} links${data.totals.shown < data.totals.nodes ? ` · showing top ${data.totals.shown}` : ""}`}>
      <div className="graph-box" ref={ref}>
        <ForceGraph2D
          ref={fg}
          graphData={graph}
          width={width}
          height={ref.current?.clientHeight ?? 560}
          backgroundColor={t.bg}
          nodeId="id"
          nodeVisibility={(n: any) => n.firstTs <= cut}
          linkVisibility={(l: any) => l.firstTs <= cut}
          nodeVal={(n: any) => 1 + (n.pagerank / maxRank) * 12}
          nodeLabel={(n: any) => `${n.label} · ${n.messages} msgs · reach ${n.reach}`}
          linkColor={(l: any) => {
            const s = typeof l.source === "object" ? l.source.community : null;
            return segment == null || s === segment ? t.g4 : t.g5;
          }}
          linkWidth={(l: any) => Math.min(3, 0.4 + Math.log2(1 + l.weight) * 0.5)}
          linkDirectionalArrowLength={3}
          linkDirectionalArrowRelPos={1}
          cooldownTicks={120}
          onEngineStop={() => {
            if (!fitted.current) fg.current?.zoomToFit(400, 40);
            fitted.current = true;
          }}
          nodeCanvasObject={(n: any, ctx, scale) => {
            const r = Math.sqrt(1 + (n.pagerank / maxRank) * 12) * 3;
            const dim = segment != null && n.community !== segment;
            ctx.beginPath();
            ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
            ctx.fillStyle = dim ? t.g5 : n.kind === "channel" ? t.bg : t.ink;
            ctx.fill();
            if (n.kind === "channel" && !dim) {
              ctx.lineWidth = 1.5 / scale;
              ctx.strokeStyle = t.ink;
              ctx.stroke();
            }
            if (labelled.has(n.id) && !dim) {
              ctx.font = `500 ${12 / scale}px ${t.font || "sans-serif"}`;
              ctx.fillStyle = n.sentiment === "positive" ? t.pos : n.sentiment === "negative" ? t.neg : t.g2;
              ctx.fillText(n.label, n.x + r + 3 / scale, n.y + 4 / scale);
            }
          }}
          nodePointerAreaPaint={(n: any, color, ctx) => {
            const r = Math.sqrt(1 + (n.pagerank / maxRank) * 12) * 3 + 2;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
            ctx.fill();
          }}
        />
      </div>
      <div className="graph-controls">
        <button className="btn ghost" onClick={() => { if (cut >= maxTs) setCut(minTs); setPlaying((p) => !p); }}>
          {playing ? "Pause" : "Play spread"}
        </button>
        <input type="range" min={minTs} max={maxTs} value={cut} onChange={(e) => { setPlaying(false); setCut(Number(e.target.value)); }} aria-label="Timeline" />
        <span className="mono muted" style={{ minWidth: 150, textAlign: "right" }}>{fmtDate(cut)} · {visibleCount}</span>
      </div>
      <p className="note">
        Node size = influence. Filled = person, ring = channel. Arrows point to whoever received the reply, mention or forward. Labels are coloured by
        dominant sentiment (<span className="pos">positive</span> / <span className="neg">negative</span>). Drag the timeline to watch the network form.
      </p>
    </Card>
  );
}

function Spread({ qs }: { qs: string }) {
  const { data: topics } = useApi<{ id: number; label: string }[]>("/topics");
  const [topic, setTopic] = useState<number | "">("");
  const { data } = useApi<SpreadData>(`/network/spread${qs}${topic ? `&topic=${topic}` : ""}`);
  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };

  return (
    <Card
      title="How a topic travels between segments"
      note={
        <select className="select" value={topic} onChange={(e) => setTopic(e.target.value ? Number(e.target.value) : "")}>
          <option value="">All conversation</option>
          {topics?.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      }
    >
      {!data?.series.length ? (
        <Empty>No messages for this topic in range</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Segment</th>
              <th>First picked up</th>
              <th className="num">Messages</th>
              <th className="num">Mood</th>
              <th>Activity over time</th>
            </tr>
          </thead>
          <tbody>
            {data.series.map((s, i) => {
              const mood = avg(s.avgSentiment);
              return (
                <tr key={s.community}>
                  <td className="mono faint">{i + 1}</td>
                  <td>{segmentName(s.community)}</td>
                  <td className="muted">{fmtDate(s.firstTs)}</td>
                  <td className="num">{s.total}</td>
                  <td className={`num ${toneClass(mood ?? 0)}`}>{fmtScore(mood)}</td>
                  <td style={{ width: "35%" }}><Spark values={s.counts} width={260} height={26} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="note">Segments are ordered by when they first discussed the topic — the top rows are where it started.</p>
    </Card>
  );
}
