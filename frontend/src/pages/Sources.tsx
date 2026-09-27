import { useState, type FormEvent } from "react";
import { Card, Empty, ErrorBox, Page } from "../components/ui";
import { api, useApi, type Source, type Status } from "../lib/api";
import { fmtAgo, fmtDate, fmtNum } from "../lib/format";

export default function Sources({ status }: { status: Status | null }) {
  const { data: sources, reload } = useApi<Source[]>("/sources", 5000);
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!handle.trim()) return;
    setBusy(true);
    setError("");
    setAdded("");
    try {
      const res = await api<Source[]>("/sources", { method: "POST", body: JSON.stringify({ handle }) });
      setAdded(
        res.length > 1
          ? `Added “${res[0].title}” and its discussion group “${res[1].title}”. Collection has started.`
          : `Added “${res[0].title}”. Collection has started.`,
      );
      setHandle("");
      reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (s: Source) => {
    if (!confirm(`Remove “${s.title}” and all its collected messages?`)) return;
    await api(`/sources/${s.id}`, { method: "DELETE" });
    reload();
  };

  const tg = status?.telegram;
  const steps = [
    { done: !!tg?.configured, text: "Telegram API ID + hash in backend/.env", hint: "my.telegram.org → API development tools" },
    { done: !!tg?.authorized, text: "Telegram session logged in", hint: "cd backend && npm run telegram:login" },
    { done: !!status?.llm.configured, text: "Groq API key in backend/.env", hint: "console.groq.com/keys" },
    { done: !!sources?.length, text: "At least one public group or channel added", hint: "Use the form below" },
  ];

  return (
    <Page title="Sources" sub="Public Telegram channels and groups the pipeline collects from." filters={false}>
      <div className="grid g2">
        <Card title="Setup">
          {steps.map((s) => (
            <div key={s.text} className="bar-row" style={{ gridTemplateColumns: "20px 1fr" }}>
              <span className={s.done ? "pos" : "faint"}>{s.done ? "✓" : "○"}</span>
              <span>
                {s.text}
                {!s.done && <span className="mono faint"> — {s.hint}</span>}
              </span>
            </div>
          ))}
          {tg?.error && <p className="note warn">{tg.error}</p>}
        </Card>

        <Card title="Add a source" note="@username or t.me link">
          <form onSubmit={submit} style={{ display: "flex", gap: 8 }}>
            <input
              className="input"
              placeholder="@groupname or https://t.me/channel"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              disabled={busy}
            />
            <button className="btn" disabled={busy || !handle.trim()}>
              {busy ? "Adding…" : "Add"}
            </button>
          </form>
          {error && <p className="note neg">{error}</p>}
          {added && <p className="note pos">{added}</p>}
          <p className="note">
            Groups work best: that's where followers actually talk. For a broadcast channel, its linked discussion group is added
            automatically.
          </p>
        </Card>
      </div>

      <div className="section-label">Collected</div>
      <Card>
        {!sources?.length ? (
          <Empty>No sources yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Type</th>
                  <th className="num">Messages</th>
                  <th>History from</th>
                  <th>Last synced</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.title}
                      <div className="mono faint">{s.handle ? "@" + s.handle : "linked group"}</div>
                    </td>
                    <td>
                      <span className="tag">{s.kind}</span>
                    </td>
                    <td className="num">{fmtNum(s.messages)}</td>
                    <td className="muted">{fmtDate(s.first_ts)}</td>
                    <td className="muted">{fmtAgo(s.last_synced_at)}</td>
                    <td className="num">
                      <button className="btn ghost" onClick={() => remove(s)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="section-label">Pipeline</div>
      <div className="grid g2">
        <Card
          title="Status"
          note={
            <button className="btn ghost" onClick={() => api("/pipeline/run", { method: "POST" })} disabled={status?.pipeline.running}>
              {status?.pipeline.running ? "Running…" : "Run now"}
            </button>
          }
        >
          <ErrorBox error={status?.pipeline.lastError ?? ""} />
          <table className="table">
            <tbody>
              <tr><td className="muted">Stage</td><td className="mono">{status?.pipeline.stage ?? "—"}</td></tr>
              <tr><td className="muted">Messages stored</td><td className="num">{fmtNum(status?.counts.messages)}</td></tr>
              <tr><td className="muted">Awaiting AI analysis</td><td className="num">{fmtNum(status?.counts.pendingAnalysis)}</td></tr>
              <tr><td className="muted">Authors / profiled</td><td className="num">{fmtNum(status?.counts.users)} / {fmtNum(status?.counts.profiled)}</td></tr>
              <tr><td className="muted">Topics discovered</td><td className="num">{fmtNum(status?.counts.topics)}</td></tr>
              <tr><td className="muted">Model</td><td className="mono">{status?.llm.model}</td></tr>
              <tr><td className="muted">Next run</td><td className="num">{status?.pipeline.nextRunAt ? fmtDate(status.pipeline.nextRunAt) : "—"}</td></tr>
            </tbody>
          </table>
        </Card>
        <Card title="Activity log">
          {!status?.pipeline.log.length ? (
            <Empty>Nothing yet</Empty>
          ) : (
            status.pipeline.log.slice(0, 12).map((l, i) => (
              <div key={i} className="bar-row" style={{ gridTemplateColumns: "72px 1fr" }}>
                <span className="mono faint">{new Date(l.at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                <span className={l.text.startsWith("Error") ? "neg" : l.text.includes("paused") ? "warn" : ""}>{l.text}</span>
              </div>
            ))
          )}
        </Card>
      </div>
    </Page>
  );
}
