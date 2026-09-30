import { useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { axisProps, Card, ChartTip, Empty, ErrorBox, Legend, Page, Spark, Stat } from "../components/ui";
import { useApi, type Series } from "../lib/api";
import { useFilters } from "../lib/filters";
import { capitalize, EMOTION_HUE, fmtBucket, fmtDate, fmtScore, toneClass } from "../lib/format";

interface ThreadRow { id: number; text: string; author: string; source: string; platform: string; ts: number; replies: number; labelled: number; scores: number[]; avg: number | null; start: number | null; end: number | null; drift: number | null }
interface ThreadDetail {
  root: { id: number; author: string; text: string; ts: number; source: string; platform: string };
  replies: { id: number; author: string; text: string; ts: number; sentiment: string | null; score: number | null; emotion: string | null; stance: string | null; sarcasm: number | null }[];
}

/** Sentiment inside single conversations: the thread axis, next to the time axis above. */
function Threads() {
  const { qs } = useFilters();
  const { data } = useApi<ThreadRow[]>(`/threads${qs}`, 60000);
  const [open, setOpen] = useState<number | null>(null);
  const { data: detail } = useApi<ThreadDetail>(open ? `/threads/${open}` : null);
  if (!data?.length) return null;
  return (
    <>
      <div className="section-label">Inside conversations</div>
      <Card title="Most-discussed posts" note="how replies' sentiment moved from first to last">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Post</th>
                <th className="num">Replies</th>
                <th className="num">Start</th>
                <th className="num">End</th>
                <th className="num">Drift</th>
                <th>Trajectory</th>
              </tr>
            </thead>
            <tbody>
              {data.map((t) => (
                <tr key={t.id} className={`click ${open === t.id ? "sel" : ""}`} onClick={() => setOpen(open === t.id ? null : t.id)}>
                  <td>
                    {t.text.length > 110 ? t.text.slice(0, 110) + "…" : t.text}
                    <div className="mono faint">{t.author} · {t.source} · {fmtDate(t.ts)}</div>
                  </td>
                  <td className="num">{t.replies}{t.labelled < t.replies ? <span className="faint"> ({t.labelled} labelled)</span> : null}</td>
                  <td className={`num mono ${toneClass(t.start)}`}>{fmtScore(t.start)}</td>
                  <td className={`num mono ${toneClass(t.end)}`}>{fmtScore(t.end)}</td>
                  <td className={`num mono ${toneClass(t.drift)}`}>{t.drift == null ? "—" : (t.drift > 0 ? "+" : "") + t.drift.toFixed(2)}</td>
                  <td>{t.scores.length >= 2 ? <Spark values={t.scores.map((v) => v + 1)} width={110} height={24} /> : <span className="faint">not labelled yet</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {open && detail && (
          <div style={{ marginTop: 16 }}>
            <blockquote className="quote">
              {detail.root.text}
              <span className="meta">{detail.root.author} · {detail.root.platform} · {fmtDate(detail.root.ts)}</span>
            </blockquote>
            {detail.replies.map((c) => (
              <div key={c.id} className="bar-row" style={{ gridTemplateColumns: "72px 1fr auto", alignItems: "start" }}>
                <span className={`mono ${toneClass(c.score)}`}>{fmtScore(c.score)}</span>
                <span>
                  {c.text}
                  <div className="mono faint">{c.author} · {fmtDate(c.ts)}</div>
                </span>
                <span className="mono faint" style={{ whiteSpace: "nowrap" }}>
                  {c.emotion && c.emotion !== "neutral" ? c.emotion : ""}{c.sarcasm ? <span className="accent"> sarcastic</span> : null}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="note">Drift = average score of the last third of replies minus the first third. A conversation that starts supportive and ends hostile shows as a negative drift.</p>
      </Card>
    </>
  );
}

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
            <Card title="Positive vs negative messages" note={<Legend items={[{ label: "Positive (up)", fill: "var(--pos)" }, { label: "Negative (down)", fill: "var(--neg)" }]} />}>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={polarity} stackOffset="sign" margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis dataKey="b" tickFormatter={fmt} minTickGap={40} {...axisProps} />
                  <YAxis tickFormatter={(v) => String(Math.abs(v))} allowDecimals={false} {...axisProps} />
                  <ReferenceLine y={0} stroke="var(--ink-3)" />
                  <Tooltip content={<ChartTip fmtLabel={fmt} />} cursor={{ fill: "var(--hover)" }} />
                  <Bar isAnimationActive={false} dataKey="positive" name="Positive" stackId="s" fill="var(--pos)" radius={[3, 3, 0, 0]} maxBarSize={18} />
                  <Bar isAnimationActive={false} dataKey="negative" name="Negative" stackId="s" fill="var(--neg)" radius={[3, 3, 0, 0]} maxBarSize={18} />
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
                  <Line isAnimationActive={false} dataKey="score" name="Avg score" stroke="var(--accent)" strokeWidth={2} dot={false} connectNulls />
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
                style={{ textAlign: "left", cursor: "pointer", outline: emotion === name ? `1.5px solid ${EMOTION_HUE[name] ?? "var(--ink)"}` : undefined }}
                onClick={() => setEmotion(name)}
              >
                <div className="card-h" style={{ marginBottom: 8 }}>
                  <h3><i className="swatch" style={{ ["--hue" as string]: EMOTION_HUE[name] ?? "var(--g4)" }} />{capitalize(name)}</h3>
                  <span className="mono">{pct(total, T.analyzed)}%</span>
                </div>
                <Spark values={data.emotion[name]} width={220} height={36} color={EMOTION_HUE[name] ?? "var(--accent)"} />
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
                  <div style={{ flex: T.stance.supportive, background: "var(--pos)" }} />
                  <div style={{ flex: T.stance.neutral, background: "var(--g5)" }} />
                  <div style={{ flex: T.stance.against, background: "var(--neg)" }} />
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
                    <Line isAnimationActive={false} dataKey="sarcasm" name="Sarcasm %" stroke="var(--c4)" strokeWidth={2} dot={false} connectNulls />
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
          <Threads />
        </>
      )}
    </Page>
  );
}
