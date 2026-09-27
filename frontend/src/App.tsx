import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useApi, type Status } from "./lib/api";
import { fmtAgo } from "./lib/format";
import Audience from "./pages/Audience";
import Network from "./pages/Network";
import Overview from "./pages/Overview";
import Sentiment from "./pages/Sentiment";
import Sources from "./pages/Sources";
import Trends from "./pages/Trends";

const NAV = [
  { to: "/overview", label: "Overview" },
  { to: "/sentiment", label: "Sentiment" },
  { to: "/audience", label: "Audience" },
  { to: "/trends", label: "Trends" },
  { to: "/network", label: "Network" },
  { to: "/sources", label: "Sources" },
];

export default function App() {
  const { data: status } = useApi<Status>("/status", 4000);

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          Audience Intelligence
          <small>Social media analytics</small>
        </div>
        <nav className="nav">
          {NAV.map((n, i) => (
            <NavLink key={n.to} to={n.to}>
              <span className="n">0{i + 1}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="side-foot">
          <div>
            <span className={`dot ${status?.telegram.authorized ? "on" : ""}`} />
            Telegram {status?.telegram.authorized ? "connected" : "offline"}
          </div>
          <div>
            <span className={`dot ${status?.llm.configured ? "on" : ""}`} />
            Groq {status?.llm.configured ? (status.llm.pausedUntil > Date.now() ? <span className="warn">rate-limited</span> : "ready") : "no key"}
          </div>
          {status && (
            <div className="stage">
              {status.pipeline.running ? status.pipeline.stage : `Last run ${fmtAgo(status.pipeline.lastRunAt)}`}
              {status.counts.pendingAnalysis > 0 && <div>{status.counts.pendingAnalysis} messages queued for analysis</div>}
            </div>
          )}
        </div>
      </aside>

      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to={status && !status.counts.sources ? "/sources" : "/overview"} replace />} />
          <Route path="/overview" element={<Overview />} />
          <Route path="/sentiment" element={<Sentiment />} />
          <Route path="/audience" element={<Audience />} />
          <Route path="/trends" element={<Trends />} />
          <Route path="/network" element={<Network />} />
          <Route path="/sources" element={<Sources status={status} />} />
        </Routes>
      </main>
    </div>
  );
}
