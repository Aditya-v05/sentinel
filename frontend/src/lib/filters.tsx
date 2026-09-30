import { createContext, useContext, useState, type ReactNode } from "react";

interface Filters {
  source: number | null;
  days: number;
  setSource: (s: number | null) => void;
  setDays: (d: number) => void;
  /** "?source=..&days=.." for API calls */
  qs: string;
}

const Ctx = createContext<Filters | null>(null);

const read = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable: filters just won't persist
  }
};

export function FiltersProvider({ children }: { children: ReactNode }) {
  const [source, setSourceState] = useState<number | null>(() => read("filter.source", null));
  const [days, setDaysState] = useState<number>(() => read("filter.days", 30));
  const setSource = (s: number | null) => (setSourceState(s), write("filter.source", s));
  const setDays = (d: number) => (setDaysState(d), write("filter.days", d));
  const qs = `?days=${days}${source ? `&source=${source}` : ""}`;
  return <Ctx.Provider value={{ source, days, setSource, setDays, qs }}>{children}</Ctx.Provider>;
}

export function useFilters() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useFilters outside FiltersProvider");
  return ctx;
}
