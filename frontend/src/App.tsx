import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { getToken, useApi, type Status } from "./lib/api";
import Login from "./pages/Login";
import { fmtAgo } from "./lib/format";
import Audience from "./pages/Audience";
import Integrity from "./pages/Integrity";
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
  { to: "/integrity", label: "Integrity" },
  { to: "/sources", label: "Sources" },
];

export default function App() {
  const [needsLogin, setNeedsLogin] = useState(false);
  const { data: status, reload } = useApi<Status>("/status", 4000);

  // Any 401 anywhere flips to the sign-in screen; a successful login flips back.
  useEffect(() => {
    const on = () => setNeedsLogin(true);
    window.addEventListener("auth:required", on);
    return () => window.removeEventListener("auth:required", on);
  }, []);

  if (needsLogin) return <Login onDone={() => { setNeedsLogin(false); reload(); }} />;

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
            Model {status?.llm.configured ? (status.llm.pausedUntil > Date.now() ? <span className="warn">rate-limited</span> : "ready") : "not configured"}
          </div>
          {status?.auth === "open" && (
            <div>
              <span className="dot" />
              <span className="warn">API open</span> (no APP_PASSWORD)
            </div>
          )}
          {status?.auth === "password" && getToken() && (
            <div>
              <span className="dot on" />
              Signed in
            </div>
          )}
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
          <Route path="/integrity" element={<Integrity />} />
          <Route path="/sources" element={<Sources status={status} />} />
        </Routes>
      </main>
    </div>
  );
}
