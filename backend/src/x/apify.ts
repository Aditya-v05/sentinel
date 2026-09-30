import { config } from "../config.js";
import { kvGet, kvSet } from "../db.js";

/**
 * Apify is how X is collected: the actor runs on their side, we pay per tweet returned
 * (about $0.40 per thousand on the actor we use), and no X account of ours is involved.
 *
 * Two things this file guarantees, because the free credit is what the finals run on:
 *  - every run's cost is read back from Apify and added to a monthly total in the kv table,
 *    so the dashboard can show what has been spent;
 *  - a run is refused once that total reaches X_MONTHLY_BUDGET_USD, so a runaway search
 *    cannot spend the demo's money before the demo.
 */

const BASE = "https://api.apify.com/v2";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ApifyBudgetError extends Error {}

export const apifyConfigured = () => !!config.x.apifyToken;

const monthKey = () => `apify_spend_${new Date().toISOString().slice(0, 7)}`;
export const spendThisMonth = () => Number(kvGet(monthKey()) ?? 0);
const addSpend = (usd: number) => kvSet(monthKey(), String(spendThisMonth() + usd));

export const budgetLeft = () => Math.max(0, config.x.monthlyBudgetUsd - spendThisMonth());

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}token=${config.x.apifyToken}`;
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    // The plan's own cap, hit before our budget: a state to wait out, not a failure to retry.
    if (res.status === 403 && /usage hard limit|platform-feature-disabled/i.test(body)) {
      throw new ApifyBudgetError("Apify plan's monthly usage limit reached; collection resumes when the billing cycle resets or the limit is raised");
    }
    throw new Error(`Apify ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

interface Run {
  id: string;
  status: string;
  defaultDatasetId: string;
  usageTotalUsd?: number;
  statusMessage?: string;
}

/**
 * Starts the actor, waits for it, charges the run to this month, returns the items.
 * Async start + polling rather than the sync endpoint, so a slow run cannot hang a cycle
 * past `timeoutSec`; the actor is aborted if it does.
 */
export async function runActor<T = Record<string, any>>(input: Record<string, unknown>, timeoutSec = 240, actor = config.x.actor): Promise<T[]> {
  if (!apifyConfigured()) throw new Error("APIFY_TOKEN is not set");
  if (budgetLeft() <= 0) {
    throw new ApifyBudgetError(
      `Apify budget for this month is used up ($${spendThisMonth().toFixed(2)} of $${config.x.monthlyBudgetUsd}); raise X_MONTHLY_BUDGET_USD to continue`,
    );
  }

  const started = await call<{ data: Run }>(`/acts/${actor}/runs?timeout=${timeoutSec}&memory=1024`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  let run = started.data;

  const deadline = Date.now() + (timeoutSec + 30) * 1000;
  while (!["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(run.status)) {
    if (Date.now() > deadline) {
      await call(`/actor-runs/${run.id}/abort`, { method: "POST" }).catch(() => undefined);
      throw new Error(`Apify run ${run.id} did not finish in ${timeoutSec}s`);
    }
    await sleep(3000);
    run = (await call<{ data: Run }>(`/actor-runs/${run.id}`)).data;
  }
  // The cost is filled in a few seconds after the run reports SUCCEEDED; reading it at that
  // instant returns 0 and under-counts every run. Wait for it, briefly.
  for (let i = 0; i < 6 && !(run.usageTotalUsd! > 0); i++) {
    await sleep(2000);
    run = (await call<{ data: Run }>(`/actor-runs/${run.id}`)).data;
  }
  addSpend(run.usageTotalUsd ?? 0);
  if (run.status !== "SUCCEEDED") throw new Error(`Apify run ${run.status}: ${run.statusMessage ?? ""}`);

  const items = await call<T[]>(`/datasets/${run.defaultDatasetId}/items?clean=true&limit=100000`);
  return items;
}

interface Limits {
  monthlyUsageUsd: number;
  maxMonthlyUsageUsd: number;
}
let limitsCache: { at: number; value: Limits | null } = { at: 0, value: null };

/** What the whole Apify account has used against its plan this cycle, cached for five minutes. */
export async function accountLimits(): Promise<Limits | null> {
  if (!apifyConfigured()) return null;
  if (Date.now() - limitsCache.at < 300_000) return limitsCache.value;
  try {
    const d = (await call<{ data: { current: { monthlyUsageUsd: number }; limits: { maxMonthlyUsageUsd: number } } }>("/users/me/limits")).data;
    limitsCache = { at: Date.now(), value: { monthlyUsageUsd: d.current.monthlyUsageUsd, maxMonthlyUsageUsd: d.limits.maxMonthlyUsageUsd } };
  } catch {
    limitsCache = { at: Date.now(), value: limitsCache.value };
  }
  return limitsCache.value;
}
