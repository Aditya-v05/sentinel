import type { ReactNode } from "react";
import { useApi, type Source } from "../lib/api";
import { useFilters } from "../lib/filters";
import { fmtNum } from "../lib/format";

export function Page({ title, sub, children, filters = true }: { title: string; sub?: string; children: ReactNode; filters?: boolean }) {
  return (
    <>
      <header className="top">
        <div>
          <h1>{title}</h1>
          {sub && <p>{sub}</p>}
        </div>
        {filters && <FilterBar />}
      </header>
      {children}
    </>
  );
}

const RANGES = [1, 7, 30, 90];

function FilterBar() {
  const { source, setSource, days, setDays } = useFilters();
  const { data: sources } = useApi<Source[]>("/sources");
  return (
    <div className="filters">
      <select
        className="select"
        aria-label="Source"
        value={source ?? ""}
        onChange={(e) => setSource(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">All sources</option>
        {sources?.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title}
          </option>
        ))}
      </select>
      <div className="seg" role="group" aria-label="Time range">
        {RANGES.map((d) => (
          <button key={d} className={d === days ? "on" : ""} onClick={() => setDays(d)}>
            {d === 1 ? "24h" : `${d}d`}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Card({ title, note, children, className = "" }: { title?: ReactNode; note?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || note) && (
        <div className="card-h">
          <h3>{title}</h3>
          {note && <span>{note}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ value, label, className = "" }: { value: ReactNode; label: ReactNode; className?: string }) {
  return (
    <div className="card stat">
      <div className={`v ${className}`}>{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;

export const ErrorBox = ({ error }: { error: string }) => (error ? <div className="error neg">{error}</div> : null);

/** Horizontal single-ink bars: label, bar, value. Used for categorical totals. */
export function BarList({ rows, total }: { rows: { label: string; count: number }[]; total?: number }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  const sum = total ?? rows.reduce((a, r) => a + r.count, 0);
  if (!rows.length) return <Empty>No data yet</Empty>;
  return (
    <div>
      {rows.map((r) => (
        <div className="bar-row" key={r.label} title={`${r.label}: ${r.count}`}>
          <span className="lab">{r.label}</span>
          <span className="track">
            <span className="fill" style={{ width: `${(r.count / max) * 100}%`, display: "block" }} />
          </span>
          <span className="num mono">{sum ? `${Math.round((r.count / sum) * 100)}%` : fmtNum(r.count)}</span>
        </div>
      ))}
    </div>
  );
}

/** Tiny inline trend line (plain SVG, no axes). Optional dashed forecast tail. */
export function Spark({ values, forecast = [], width = 120, height = 28 }: { values: number[]; forecast?: number[]; width?: number; height?: number }) {
  const all = [...values, ...forecast];
  const max = Math.max(1, ...all);
  const x = (i: number) => (i / Math.max(1, all.length - 1)) * (width - 4) + 2;
  const y = (v: number) => height - 2 - (v / max) * (height - 4);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const tail = forecast.length
    ? [values.length - 1, ...forecast.map((_, k) => values.length + k)]
        .map((i, k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(i < values.length ? values[i] : forecast[i - values.length]).toFixed(1)}`)
        .join("")
    : "";
  return (
    <svg width={width} height={height} aria-hidden style={{ display: "block" }}>
      <path d={line} fill="none" stroke="var(--g1)" strokeWidth={1.5} strokeLinejoin="round" />
      {tail && <path d={tail} fill="none" stroke="var(--g3)" strokeWidth={1.5} strokeDasharray="3 3" />}
    </svg>
  );
}

/** Recharts tooltip in the house style. */
export function ChartTip({ active, payload, label, fmtLabel }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tt">
      <b>{fmtLabel ? fmtLabel(label) : label}</b>
      {payload.map((p: any) => (
        <div className="row" key={p.dataKey}>
          <span>{p.name}</span>
          <span>{typeof p.value === "number" ? Math.abs(p.value).toLocaleString(undefined, { maximumFractionDigits: 2 }) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; fill: string; dashed?: boolean }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.label}>
          <i style={{ background: i.dashed ? "transparent" : i.fill, border: i.dashed ? `1.5px dashed ${i.fill}` : undefined }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export const axisProps = {
  stroke: "var(--line-strong)",
  tickLine: false,
  axisLine: false,
  tick: { fill: "var(--ink-3)", fontSize: 11 },
} as const;
