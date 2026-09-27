import { useEffect, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { axisProps, Card, ChartTip, Empty, ErrorBox, Page, Stat } from "../components/ui";
import { api, useApi, type Series } from "../lib/api";
import { useFilters } from "../lib/filters";
import { fmtBucket, fmtNum, fmtScore, toneClass } from "../lib/format";

interface OverviewData extends Series {
  volume: number[];
  totals: { messages: number; authors: number; analyzed: number; pending: number; replies: number; avgSentiment: number | null };
}

export default function Overview() {
  const { qs } = useFilters();
  const { data, error } = useApi<OverviewData>(`/overview${qs}`, 30000);
  const t = data?.totals;
  const rows = data?.buckets.map((b, i) => ({ b, volume: data.volume[i] })) ?? [];

  return (
    <Page title="Overview" sub="Conversation volume and the headline read on your audience.">
      <ErrorBox error={error} />
      <div className="grid g4">
        <Stat value={fmtNum(t?.messages)} label="Messages in range" />
        <Stat value={fmtNum(t?.authors)} label="Active participants" />
        <Stat value={t?.messages ? `${Math.round(((t.analyzed ?? 0) / t.messages) * 100)}%` : "—"} label="Analysed by AI" />
        <Stat value={fmtScore(t?.avgSentiment)} label="Average sentiment (−1 to +1)" className={toneClass(t?.avgSentiment ?? 0)} />
      </div>

      <div className="section-label">Timeline</div>
      <Card title="Message volume" note={data ? `per ${data.bucketSec >= 86400 ? "day" : data.bucketSec >= 21600 ? "6 hours" : "hour"}` : ""}>
        {!t?.messages ? (
          <Empty>No messages yet — add a source on the Sources page.</Empty>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis dataKey="b" tickFormatter={(v) => fmtBucket(v, data!.bucketSec)} minTickGap={40} {...axisProps} />
              <YAxis allowDecimals={false} {...axisProps} />
              <Tooltip content={<ChartTip fmtLabel={(v: number) => fmtBucket(v, data!.bucketSec)} />} cursor={{ stroke: "var(--ink-3)" }} />
              <Area isAnimationActive={false} type="monotone" dataKey="volume" name="Messages" stroke="var(--g1)" strokeWidth={2} fill="var(--g5)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </Card>

      <div className="section-label">AI briefing</div>
      <Briefing qs={qs} />
    </Page>
  );
}

function Briefing({ qs }: { qs: string }) {
  const [data, setData] = useState<{ headline: string; bullets: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => setData(null), [qs]);

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      setData(await api(`/insights${qs}`, { method: "POST" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      className="insight"
      title="Summary of sentiment, trends, audience and influencers"
      note={
        <button className="btn ghost" onClick={run} disabled={busy}>
          {busy ? "Writing…" : data ? "Regenerate" : "Generate"}
        </button>
      }
    >
      {error && <p className="neg">{error}</p>}
      {data ? (
        <>
          <h2>{data.headline}</h2>
          <ul>
            {data.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </>
      ) : (
        !error && <p className="faint">Generates a short analyst briefing from the computed metrics (not raw messages).</p>
      )}
    </Card>
  );
}
