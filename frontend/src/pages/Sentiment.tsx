import { useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { axisProps, Card, ChartTip, Empty, ErrorBox, Legend, Page, Spark, Stat } from "../components/ui";
import { useApi, type Series } from "../lib/api";
import { useFilters } from "../lib/filters";
import { capitalize, fmtBucket, fmtDate, fmtScore, toneClass } from "../lib/format";

interface SentimentData extends Series {
  analyzed: number[];
  avgScore: (number | null)[];
  sentiment: Record<"positive" | "neutral" | "negative", number[]>;
  emotion: Record<string, number[]>;
  stance: Record<"supportive" | "neutral" | "against", number[]>;
  sarcasm: number[];
  totals: {
    analyzed: number;
    sentiment: Record<string, number>;
    emotion: Record<string, number>;
    stance: Record<string, number>;
    sarcasm: number;
  };
  samples: Record<string, { text: string; ts: number; sarcasm: number; stance: string }[]>;
  sarcasticSamples: { text: string; ts: number }[];
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

export default function Sentiment() {
  const { qs } = useFilters();
  const { data, error } = useApi<SentimentData>(`/sentiment${qs}`, 30000);
  const [emotion, setEmotion] = useState("anxiety");

  if (!data) return <Page title="Sentiment"><ErrorBox error={error} /></Page>;
  const T = data.totals;
  const fmt = (v: number) => fmtBucket(v, data.bucketSec);

  const polarity = data.buckets.map((b, i) => ({
    b,
    positive: data.sentiment.positive[i],
    negative: -data.sentiment.negative[i],
    neutral: data.sentiment.neutral[i],
  }));
  const score = data.buckets.map((b, i) => ({
    b,
    score: data.avgScore[i],
    sarcasm: data.analyzed[i] ? +((data.sarcasm[i] / data.analyzed[i]) * 100).toFixed(1) : null,
  }));
  const emotions = Object.entries(T.emotion)
    .filter(([k]) => k !== "neutral")
    .sort((a, b) => b[1] - a[1]);
  const stanceTotal = T.stance.supportive + T.stance.neutral + T.stance.against;

  return (
    <Page title="Sentiment" sub="How the audience feels — polarity, emotion, stance and sarcasm along the timeline.">
      <ErrorBox error={error} />
      {!T.analyzed ? (
        <Card><Empty>No analysed messages in this range yet. The pipeline labels new messages every few minutes.</Empty></Card>
      ) : (
        <>
          <div className="grid g4">
            <Stat value={`${pct(T.sentiment.positive, T.analyzed)}%`} label="Positive" className="pos" />
            <Stat value={`${pct(T.sentiment.negative, T.analyzed)}%`} label="Negative" className="neg" />
            <Stat value={`${pct(T.sarcasm, T.analyzed)}%`} label="Sarcastic or ironic" className="accent" />
            <Stat
              value={<><span className="pos">{pct(T.stance.supportive, stanceTotal)}</span><span className="faint"> / </span><span className="neg">{pct(T.stance.against, stanceTotal)}</span></>}
              label="Supportive / against (%)"
            />
          </div>

          <div className="section-label">Over time</div>
          <div className="grid g2">
            <Card title="Positive vs negative messages" note={<Legend items={[{ label: "Positive (up)", fill: "var(--g1)" }, { label: "Negative (down)", fill: "var(--g3)" }]} />}>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={polarity} stackOffset="sign" margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis dataKey="b" tickFormatter={fmt} minTickGap={40} {...axisProps} />
                  <YAxis tickFormatter={(v) => String(Math.abs(v))} allowDecimals={false} {...axisProps} />
                  <ReferenceLine y={0} stroke="var(--ink-3)" />
                  <Tooltip content={<ChartTip fmtLabel={fmt} />} cursor={{ fill: "var(--hover)" }} />
                  <Bar isAnimationActive={false} dataKey="positive" name="Positive" stackId="s" fill="var(--g1)" radius={[3, 3, 0, 0]} maxBarSize={18} />
                  <Bar isAnimationActive={false} dataKey="negative" name="Negative" stackId="s" fill="var(--g3)" radius={[3, 3, 0, 0]} maxBarSize={18} />
                  <Bar isAnimationActive={false} dataKey="neutral" name="Neutral" hide />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card title="Average sentiment score" note="−1 negative · +1 positive">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={score} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis dataKey="b" tickFormatter={fmt} minTickGap={40} {...axisProps} />
                  <YAxis domain={[-1, 1]} ticks={[-1, -0.5, 0, 0.5, 1]} {...axisProps} />
                  <ReferenceLine y={0} stroke="var(--ink-3)" strokeDasharray="3 3" />
                  <Tooltip content={<ChartTip fmtLabel={fmt} />} cursor={{ stroke: "var(--ink-3)" }} />
                  <Line isAnimationActive={false} dataKey="score" name="Avg score" stroke="var(--g1)" strokeWidth={2} dot={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </Card>
          </div>

          <div className="section-label">Emotions</div>
          <div className="grid g4">
            {emotions.map(([name, total]) => (
              <button
                key={name}
                className="card"
                style={{ textAlign: "left", cursor: "pointer", outline: emotion === name ? "1.5px solid var(--ink)" : undefined }}
                onClick={() => setEmotion(name)}
              >
                <div className="card-h" style={{ marginBottom: 8 }}>
                  <h3>{capitalize(name)}</h3>
                  <span className="mono">{pct(total, T.analyzed)}%</span>
                </div>
                <Spark values={data.emotion[name]} width={220} height={36} />
              </button>
            ))}
          </div>

          <div className="grid g2" style={{ marginTop: 16 }}>
            <Card title={`“${capitalize(emotion)}” examples`} note="latest">
              {data.samples[emotion]?.length ? (
                data.samples[emotion].map((s, i) => (
                  <blockquote key={i} className="quote">
                    {s.text}
                    <span className="meta">
                      {fmtDate(s.ts)} · <span className={toneClass(s.stance)}>{s.stance}</span>
                      {s.sarcasm ? <span className="accent"> · sarcastic</span> : null}
                    </span>
                  </blockquote>
                ))
              ) : (
                <Empty>No examples in this range</Empty>
              )}
            </Card>

            <div className="stack">
              <Card title="Stance" note="toward the subject under discussion">
                <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", gap: 2 }}>
                  <div style={{ flex: T.stance.supportive, background: "var(--g1)" }} />
                  <div style={{ flex: T.stance.neutral, background: "var(--g5)" }} />
                  <div style={{ flex: T.stance.against, background: "var(--g3)" }} />
                </div>
                <div className="legend" style={{ marginTop: 10 }}>
                  <span className="pos">Supportive {pct(T.stance.supportive, stanceTotal)}%</span>
                  <span>Neutral {pct(T.stance.neutral, stanceTotal)}%</span>
                  <span className="neg">Against {pct(T.stance.against, stanceTotal)}%</span>
                </div>
              </Card>
              <Card title="Sarcasm rate" note="% of analysed messages">
                <ResponsiveContainer width="100%" height={120}>
                  <LineChart data={score} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
                    <XAxis dataKey="b" tickFormatter={fmt} minTickGap={50} {...axisProps} />
                    <YAxis allowDecimals={false} {...axisProps} />
                    <Tooltip content={<ChartTip fmtLabel={fmt} />} cursor={{ stroke: "var(--ink-3)" }} />
                    <Line isAnimationActive={false} dataKey="sarcasm" name="Sarcasm %" stroke="var(--g1)" strokeWidth={2} dot={false} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
                {data.sarcasticSamples[0] && (
                  <blockquote className="quote" style={{ marginTop: 12 }}>
                    {data.sarcasticSamples[0].text}
                    <span className="meta accent">flagged sarcastic · {fmtDate(data.sarcasticSamples[0].ts)}</span>
                  </blockquote>
                )}
              </Card>
            </div>
          </div>
          <p className="note">Avg score in the latest bucket: <span className={toneClass(data.avgScore.at(-1) ?? 0)}>{fmtScore(data.avgScore.at(-1))}</span></p>
        </>
      )}
    </Page>
  );
}
