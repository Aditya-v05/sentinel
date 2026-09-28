import { useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { axisProps, BarList, Card, ChartTip, Empty, ErrorBox, Legend, Page, Spark } from "../components/ui";
import { useApi, type Keyword, type Series, type Topic } from "../lib/api";
import { useFilters } from "../lib/filters";
import { fmtBucket, fmtDate, fmtNum, fmtScore, toneClass } from "../lib/format";

interface TrendsData extends Series {
  forecastBuckets: number;
  rising: Keyword[];
  bursting: { term: string; latest: number; baseline: number; zScore: number; series: number[] }[];
  top: Keyword[];
  topics: Topic[];
  viral: { id: number; text: string; ts: number; views: number | null; forwards: number | null; reactions: number | null; replies: number; sentiment: string | null; source: string }[];
}

const ARROW = { rising: "↑", falling: "↓", stable: "→" } as const;

export default function Trends() {
  const { qs } = useFilters();
  const { data, error } = useApi<TrendsData>(`/trends${qs}`, 60000);
  const [picked, setPicked] = useState<number | null>(null);

  if (!data) return <Page title="Trends"><ErrorBox error={error} /></Page>;
  const topic = data.topics.find((t) => t.id === picked) ?? data.topics[0];
  const fmt = (v: number) => fmtBucket(v, data.bucketSec);

  return (
    <Page title="Trends" sub="What people are talking about, what's rising, and where it's heading.">
      <ErrorBox error={error} />

      <div className="section-label">Topics</div>
      <div className="grid g2">
        <Card title="Discussion topics" note="click a row to chart it">
          {!data.topics.length ? (
            <Empty>Topics are discovered once enough messages are analysed.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Topic</th>
                    <th className="num">Msgs</th>
                    <th className="num">Mood</th>
                    <th>Trend</th>
                    <th>Volume + forecast</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topics.map((t) => (
                    <tr key={t.id} className={`click ${t.id === topic?.id ? "sel" : ""}`} onClick={() => setPicked(t.id)}>
                      <td>
                        {t.label} {t.isNew && <span className="tag accent">new</span>}
                      </td>
                      <td className="num">{fmtNum(t.total)}</td>
                      <td className={`num ${toneClass(t.avgSentiment)}`}>{fmtScore(t.avgSentiment)}</td>
                      <td className={toneClass(t.trend)} style={{ whiteSpace: "nowrap" }}>
                        {ARROW[t.trend]} {t.trend}
                      </td>
                      <td>
                        <Spark values={t.series} forecast={t.forecast} width={110} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {topic ? <TopicChart topic={topic} data={data} fmt={fmt} /> : <Card><Empty>No topic selected</Empty></Card>}
      </div>

      <div className="section-label">Keywords</div>
      <div className="grid g3">
        <Card title="Bursting in the latest bucket" note="standard deviations above the term's own history">
          {!data.bursting.length ? (
            <Empty>No term is spiking beyond its usual level right now.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Keyword</th>
                  <th className="num">Now</th>
                  <th className="num">Usual</th>
                  <th className="num">σ</th>
                </tr>
              </thead>
              <tbody>
                {data.bursting.map((k) => (
                  <tr key={k.term}>
                    <td className="mono">{k.term}</td>
                    <td className="num warn">{k.latest}</td>
                    <td className="num muted">{k.baseline}</td>
                    <td className="num mono">{k.zScore.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Rising now" note="recent quarter of the range vs. before">
          {!data.rising.length ? (
            <Empty>Nothing is spiking right now</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Keyword</th>
                  <th className="num">Recent</th>
                  <th className="num">Growth</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.rising.map((k) => (
                  <tr key={k.term}>
                    <td className="mono">{k.term}</td>
                    <td className="num">{k.recent}</td>
                    <td className="num pos">+{k.growthPct}%</td>
                    <td><Spark values={k.series} width={90} height={22} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Most mentioned" note="messages containing the term">
          <BarList rows={data.top.map((k) => ({ label: k.term, count: k.total }))} total={Math.max(...data.top.map((k) => k.total), 0)} />
        </Card>
      </div>

      <div className="section-label">Viral messages</div>
      <Card title="Highest engagement" note="forwards, reactions, replies, views">
        {!data.viral.length ? (
          <Empty>No messages in range</Empty>
        ) : (
          data.viral.map((v) => (
            <blockquote key={v.id} className="quote">
              {v.text.length > 280 ? v.text.slice(0, 280) + "…" : v.text}
              <span className="meta">
                {v.source} · {fmtDate(v.ts)} · {fmtNum(v.forwards ?? 0)} forwards · {fmtNum(v.reactions ?? 0)} reactions · {v.replies} replies
                {v.views ? ` · ${fmtNum(v.views)} views` : ""}
                {v.sentiment && <> · <span className={toneClass(v.sentiment)}>{v.sentiment}</span></>}
              </span>
            </blockquote>
          ))
        )}
      </Card>
    </Page>
  );
}

function TopicChart({ topic, data, fmt }: { topic: Topic; data: TrendsData; fmt: (v: number) => string }) {
  const last = data.buckets.length - 1;
  const rows = [
    ...data.buckets.map((b, i) => ({ b, actual: topic.series[i], forecast: i === last ? topic.series[i] : null as number | null })),
    ...topic.forecast.map((f, k) => ({ b: data.buckets[last] + (k + 1) * data.bucketSec, actual: null as number | null, forecast: f })),
  ];
  return (
    <Card
      title={topic.label}
      note={<span className={toneClass(topic.trend)}>{ARROW[topic.trend]} {topic.trend}</span>}
    >
      <p className="muted" style={{ marginTop: -8 }}>{topic.description}</p>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey="b" tickFormatter={fmt} minTickGap={40} {...axisProps} />
          <YAxis allowDecimals={false} {...axisProps} />
          <ReferenceLine x={data.buckets[last]} stroke="var(--line-strong)" />
          <Tooltip content={<ChartTip fmtLabel={fmt} />} cursor={{ stroke: "var(--ink-3)" }} />
          <Line isAnimationActive={false} dataKey="actual" name="Messages" stroke="var(--g1)" strokeWidth={2} dot={false} connectNulls={false} />
          <Line isAnimationActive={false} dataKey="forecast" name="Forecast" stroke="var(--g3)" strokeWidth={2} strokeDasharray="4 4" dot={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
        <Legend items={[{ label: "Observed", fill: "var(--g1)" }, { label: "Forecast (Holt smoothing)", fill: "var(--g3)", dashed: true }]} />
        <span className="mono faint">{topic.keywords.join(" · ")}</span>
      </div>
    </Card>
  );
}
