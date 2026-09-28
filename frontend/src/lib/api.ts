import { useCallback, useEffect, useState } from "react";

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

/** GET with loading/error state; re-fetches when `path` changes or every `refreshMs`. */
export function useApi<T = any>(path: string | null, refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    load();
    if (!refreshMs) return;
    const t = setInterval(load, refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);

  return { data, error, loading, reload: load };
}

// ---- response shapes (only the fields the UI reads) ----
export interface Source {
  id: number;
  platform: "telegram" | "x" | "reddit" | "youtube";
  handle: string | null;
  title: string;
  kind: "channel" | "group" | "handle" | "search" | "subreddit" | "video";
  linked_source_id: number | null;
  last_synced_at: number | null;
  messages: number;
  first_ts: number | null;
  last_ts: number | null;
}

export interface Status {
  telegram: { configured: boolean; authorized: boolean; error: string };
  llm: { configured: boolean; model: string; pausedUntil: number; error: string };
  x: {
    configured: boolean;
    actor: string;
    spendMonthUsd: number;
    budgetUsd: number;
    account: { monthlyUsageUsd: number; maxMonthlyUsageUsd: number } | null;
  };
  reddit: { configured: boolean; mode: "api" | "feed" };
  youtube: { configured: boolean };
  pipeline: { running: boolean; stage: string; lastRunAt: number; nextRunAt: number; lastError: string; log: { at: number; text: string }[] };
  counts: { sources: number; messages: number; pendingAnalysis: number; users: number; profiled: number; topics: number };
}

export interface Series {
  buckets: number[];
  bucketSec: number;
}

export interface Keyword {
  term: string;
  total: number;
  recent: number;
  growthPct: number;
  series: number[];
}

export interface Topic {
  id: number;
  label: string;
  keywords: string[];
  description: string;
  total: number;
  recent: number;
  avgSentiment: number;
  trend: "rising" | "falling" | "stable";
  forecast: number[];
  series: number[];
  isNew: boolean;
}

export interface GraphNode {
  id: string;
  label: string;
  kind: string;
  messages: number;
  pagerank: number;
  betweenness: number;
  inWeight: number;
  outWeight: number;
  reach: number;
  community: number;
  firstTs: number;
  sentiment: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  weight: number;
  replies: number;
  mentions: number;
  forwards: number;
  firstTs: number;
}

export interface Community {
  id: number;
  size: number;
  messages: number;
  firstTs: number;
  sentiment: Record<string, number>;
  topics: { id: number; label: string; count: number }[];
  leaders: string[];
}
