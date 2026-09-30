import { useState, type FormEvent } from "react";
import { Card, Empty, ErrorBox, Page, Spark, Stat } from "../components/ui";
import { useApi, type Series, type Topic } from "../lib/api";
import { useFilters } from "../lib/filters";
import { fmtDate, fmtNum } from "../lib/format";
import { segmentName } from "./Network";

// Coordination and origin. Everything on this page is a count or a timestamp; nothing is
// a model's opinion. That is deliberate: an analyst has to be able to say why a row is here.

interface CoordinationData {
  totals: { messages: number; authors: number; bursts: number; syncPairs: number; amplifiers: number };
  bursts: { text: string; messages: number; authorCount: number; authorLabels: string[]; sources: string[]; platforms: string[]; firstTs: number; lastTs: number; tightestSpanSec: number; score: number }[];
  syncPairs: { labelA: string; labelB: string; hits: number; postsA: number; postsB: number; score: number }[];
  amplifiers: { label: string; platform: string; posts: number; forwardShare: number; accountAgeDays: number | null; burstClusters: number; distinctTextShare: number; score: number }[];
}
interface Arrival { key: string | number; firstTs: number; count: number; firstAuthor: string; delaySec: number }
interface OriginData extends Series {
  total: number;
  firstTs?: number;
  first: { id: number; ts: number; author: string; platform: string; source: string; text: string; replies: number; forwards: number | null }[];
  platforms: Arrival[];
  sources: Arrival[];
  segments: Arrival[];
  carriers: { label: string; posts: number; replies: number; forwards: number; reactions: number }[];
  volume: number[];
}

const span = (sec: number) => (sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.round(sec / 60)} min` : sec < 86400 ? `${(sec / 3600).toFixed(1)} h` : `${(sec / 86400).toFixed(1)} d`);

interface ChainStatus { entries: number; intact: boolean; brokenAt: number | null; reason: string; unsealed: number; head: string | null }

export default function Integrity() {
  const { qs } = useFilters();
  const { data, error } = useApi<CoordinationData>(`/coordination${qs}`, 60000);
  const { data: topics } = useApi<Topic[]>("/topics");
  const { data: chain } = useApi<ChainStatus>("/integrity/verify", 60000);

  return (
    <Page title="Integrity" sub="Coordinated posting, synchronised accounts, amplifiers, and where a narrative started.">
      <ErrorBox error={error} />
      {chain && (
        <Card
          title="Collection log"
          note={chain.intact ? <span className="pos">intact · {fmtNum(chain.entries)} sealed entries{chain.unsealed ? ` · ${chain.unsealed} awaiting seal` : ""}</span> : <span className="neg">broken at row {chain.brokenAt ?? "end"}</span>}
        >
          <p className="note" style={{ margin: 0 }}>
            {chain.intact
              ? "Every stored message is sealed with a SHA-256 over its content and the seal before it. Altering, removing or inserting a row breaks every seal after it. This check needs no sign-in, so anyone can run it against this instance."
              : chain.reason}
            {chain.head && <span className="mono faint"> · head {chain.head.slice(0, 16)}…</span>}
          </p>
        </Card>
      )}
      {data && (
        <>
          <div className="grid g4">
            <Stat value={fmtNum(data.totals.bursts)} label="Coordinated bursts" className={data.totals.bursts ? "warn" : ""} />
            <Stat value={fmtNum(data.totals.syncPairs)} label="Synchronised account pairs" className={data.totals.syncPairs ? "warn" : ""} />
            <Stat value={fmtNum(data.totals.amplifiers)} label="Amplifier accounts" className={data.totals.amplifiers ? "warn" : ""} />
            <Stat value={fmtNum(data.totals.authors)} label="Authors in range" />
          </div>

          <div className="section-label">Coordinated bursts</div>
          <Card title="Same wording, several accounts, minutes apart" note="original posts only; reshares are not counted">
            {!data.bursts.length ? (
              <Empty>No repeated wording across accounts in this range.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Wording</th>
                      <th className="num">Accounts</th>
                      <th className="num">Posts</th>
                      <th className="num">Tightest span</th>
                      <th>Where</th>
                      <th>First seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.bursts.map((b) => (
                      <tr key={b.firstTs + b.text.slice(0, 20)}>
                        <td>
                          {b.text.length > 160 ? b.text.slice(0, 160) + "…" : b.text}
                          <div className="mono faint">{b.authorLabels.join(" · ")}{b.authorCount > b.authorLabels.length ? ` · +${b.authorCount - b.authorLabels.length}` : ""}</div>
                        </td>
                        <td className="num warn">{b.authorCount}</td>
                        <td className="num">{b.messages}</td>
                        <td className={`num mono ${b.tightestSpanSec <= 600 ? "warn" : ""}`}>{span(b.tightestSpanSec)}</td>
                        <td className="muted">{b.platforms.join(", ")} · {b.sources.length} source{b.sources.length === 1 ? "" : "s"}</td>
                        <td className="muted">{fmtDate(b.firstTs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="note">Tightest span = shortest time in which three different accounts posted this wording. Under ten minutes is hard to explain without coordination.</p>
          </Card>

          <div className="section-label">Accounts</div>
          <div className="grid g2">
            <Card title="Synchronised pairs" note="post in the same minute, repeatedly">
              {!data.syncPairs.length ? (
                <Empty>No account pairs post in lockstep in this range.</Empty>
              ) : (
                <table className="table">
                  <thead><tr><th>Pair</th><th className="num">Same-minute hits</th><th className="num">Posts</th><th className="num">Score</th></tr></thead>
                  <tbody>
                    {data.syncPairs.map((p) => (
                      <tr key={p.labelA + p.labelB}>
                        <td>{p.labelA} <span className="faint">&amp;</span> {p.labelB}</td>
                        <td className="num warn">{p.hits}</td>
                        <td className="num muted">{p.postsA} / {p.postsB}</td>
                        <td className="num mono">{p.score.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title="Amplifiers" note="mostly reshares, repetitive, or newly created">
              {!data.amplifiers.length ? (
                <Empty>No accounts fit the amplifier pattern in this range.</Empty>
              ) : (
                <table className="table">
                  <thead><tr><th>Account</th><th className="num">Posts</th><th className="num">Reshare share</th><th className="num">Account age</th><th className="num">Bursts</th></tr></thead>
                  <tbody>
                    {data.amplifiers.map((a) => (
                      <tr key={a.label}>
                        <td>{a.label} <span className="tag">{a.platform}</span></td>
                        <td className="num">{a.posts}</td>
                        <td className={`num ${a.forwardShare >= 0.8 ? "warn" : ""}`}>{Math.round(a.forwardShare * 100)}%</td>
                        <td className={`num ${a.accountAgeDays != null && a.accountAgeDays < 90 ? "warn" : "muted"}`}>{a.accountAgeDays == null ? "—" : `${a.accountAgeDays} d`}</td>
                        <td className="num">{a.burstClusters || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="note">Account age = days between the account's creation and its first post we collected. Only X exposes creation dates.</p>
            </Card>
          </div>
        </>
      )}

      <div className="section-label">Origin</div>
      <Origin topics={topics ?? []} />
    </Page>
  );
}

function Origin({ topics }: { topics: Topic[] }) {
  const { qs } = useFilters();
  // ?term=… in the address bar pre-fills and runs a trace, so a finding can be linked to.
  const initial = new URLSearchParams(window.location.search).get("term") ?? "";
  const [term, setTerm] = useState(initial);
  const [topic, setTopic] = useState<number | "">("");
  const [query, setQuery] = useState<string | null>(initial ? `term=${encodeURIComponent(initial)}` : null);
  const { data, error } = useApi<OriginData>(query ? `/origin${qs}&${query}` : null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (topic) setQuery(`topic=${topic}`);
    else if (term.trim()) setQuery(`term=${encodeURIComponent(term.trim())}`);
  };

  return (
    <Card title="Where did it start?" note="a topic, or any word or phrase">
      <form onSubmit={submit} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select className="select" value={topic} onChange={(e) => { setTopic(e.target.value ? Number(e.target.value) : ""); setTerm(""); }}>
          <option value="">Pick a topic…</option>
          {topics.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <input className="input" placeholder="…or type a term, e.g. chandrayaan" value={term} onChange={(e) => { setTerm(e.target.value); setTopic(""); }} style={{ flex: 1, minWidth: 200 }} />
        <button className="btn" disabled={!topic && !term.trim()}>Trace</button>
      </form>
      <ErrorBox error={error} />
      {data && !data.total && <Empty>Nothing matches in this range.</Empty>}
      {data && data.total > 0 && (
        <>
          <div className="grid g2" style={{ marginTop: 16 }}>
            <div>
              <div className="section-label" style={{ marginTop: 0 }}>First voices</div>
              {data.first.map((f) => (
                <blockquote key={f.id} className="quote">
                  {f.text}
                  <span className="meta">{f.author} · {f.platform} · {f.source} · {fmtDate(f.ts)}{f.replies ? ` · ${f.replies} replies` : ""}{f.forwards ? ` · ${f.forwards} reshares` : ""}</span>
                </blockquote>
              ))}
            </div>
            <div>
              <div className="section-label" style={{ marginTop: 0 }}>Who picked it up, and when</div>
              <table className="table">
                <thead><tr><th>Segment</th><th className="num">After first mention</th><th className="num">Posts</th><th>First voice</th></tr></thead>
                <tbody>
                  {data.segments.map((s) => (
                    <tr key={String(s.key)}>
                      <td>{segmentName(Number(s.key))}</td>
                      <td className="num mono">{s.delaySec ? `+${span(s.delaySec)}` : "origin"}</td>
                      <td className="num">{s.count}</td>
                      <td className="muted">{s.firstAuthor}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <table className="table" style={{ marginTop: 12 }}>
                <thead><tr><th>Platform / source</th><th className="num">After first mention</th><th className="num">Posts</th></tr></thead>
                <tbody>
                  {data.platforms.map((p) => (
                    <tr key={"p" + p.key}><td className="mono">{p.key}</td><td className="num mono">{p.delaySec ? `+${span(p.delaySec)}` : "origin"}</td><td className="num">{p.count}</td></tr>
                  ))}
                  {data.sources.map((p) => (
                    <tr key={"s" + p.key}><td className="muted">{p.key}</td><td className="num mono">{p.delaySec ? `+${span(p.delaySec)}` : "origin"}</td><td className="num">{p.count}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
            <Spark values={data.volume} width={220} height={32} />
            <span className="muted">{fmtNum(data.total)} posts · carried furthest by {data.carriers.slice(0, 3).map((c) => c.label).join(", ")}</span>
          </div>
        </>
      )}
    </Card>
  );
}
