import { config } from "./config.js";
import { all, get, nowSec } from "./db.js";
import { analyzeMessages } from "./analysis/sentiment.js";
import { profileUsers } from "./analysis/demographics.js";
import { ensureTopics } from "./analysis/topics.js";
import { llmAvailable, LlmPausedError, llmState } from "./llm/groq.js";
import { fetchBios, syncSource } from "./telegram/collector.js";
import { getTelegram } from "./telegram/client.js";
import { apifyConfigured, ApifyBudgetError } from "./x/apify.js";
import { fetchThreads, pendingThreads, syncSource as syncX } from "./x/collector.js";

export const pipeline = {
  running: false,
  stage: "idle",
  lastRunAt: 0 as number,
  nextRunAt: 0 as number,
  lastError: "",
  log: [] as { at: number; text: string }[],
};

const note = (text: string) => {
  pipeline.stage = text;
  pipeline.log.unshift({ at: nowSec(), text });
  pipeline.log.length = Math.min(pipeline.log.length, 30);
};

/** Wraps an LLM step so a rate limit skips the rest of the LLM work instead of failing the cycle. */
async function llmStep(name: string, fn: () => Promise<number>) {
  if (!llmAvailable()) return;
  pipeline.stage = name;
  try {
    const n = await fn();
    if (n) note(`${name}: ${n} done`);
  } catch (e) {
    if (e instanceof LlmPausedError) note(`${name} paused: ${e.message}`);
    else throw e;
  }
}

/**
 * One cycle: collect -> enrich -> analyse. Each step is incremental, so a cycle
 * only does new work and the free-tier LLM quota is spread across cycles.
 */
export async function runCycle() {
  if (pipeline.running) return;
  pipeline.running = true;
  pipeline.lastError = "";
  try {
    if (await getTelegram()) {
      for (const source of all("SELECT * FROM sources WHERE platform = 'telegram' ORDER BY id")) {
        const name = source.handle ? "@" + source.handle : source.title;
        note(`Collecting ${name}`);
        const n = await syncSource(source, (c) => (pipeline.stage = `Collecting ${name}: ${c} messages`));
        note(`Collected ${n} new messages from ${name}`);
      }
      note("Fetching public bios");
      await fetchBios(config.pipeline.bioFetchPerCycle);
    }

    if (apifyConfigured()) {
      try {
        for (const source of all("SELECT * FROM sources WHERE platform = 'x' ORDER BY id")) {
          note(`Collecting X ${source.title}`);
          const n = await syncX(source);
          note(`Collected ${n} new posts from X ${source.title}`);
        }
        if (pendingThreads()) {
          note("Fetching X reply threads");
          const n = await fetchThreads(config.x.threadsPerCycle);
          note(`Stored ${n} X replies`);
        }
      } catch (e) {
        // A used-up budget is a state, not a failure: say so and carry on with the LLM work.
        if (e instanceof ApifyBudgetError) note(`X paused: ${e.message}`);
        else throw e;
      }
    }

    await llmStep("Topic discovery", ensureTopics);
    await llmStep("Sentiment analysis", () =>
      analyzeMessages(config.pipeline.analyzePerCycle, (d, t) => (pipeline.stage = `Analysing sentiment ${d}/${t}`)),
    );
    await llmStep("Demographic profiling", () =>
      profileUsers(config.pipeline.profilePerCycle, (d, t) => (pipeline.stage = `Profiling audience ${d}/${t}`)),
    );
  } catch (e) {
    pipeline.lastError = (e as Error).message;
    note(`Error: ${pipeline.lastError}`);
  } finally {
    pipeline.running = false;
    pipeline.stage = llmState.lastError ? `idle (${llmState.lastError})` : "idle";
    pipeline.lastRunAt = nowSec();
    // While there is an analysis backlog, come back quickly instead of waiting a full interval.
    // Only an LLM backlog justifies the quick return: without a model configured the backlog
    // never shrinks, and every quick cycle would fetch more paid X threads for nothing.
    const backlog = llmAvailable() ? Number(get("SELECT COUNT(*) AS n FROM messages WHERE analyzed = 0")?.n ?? 0) : 0;
    // If Groq paused us, resume right when the pause ends (but never later than the normal interval).
    const normal = pipeline.lastRunAt + config.pipeline.syncIntervalSec;
    const resume = Math.max(pipeline.lastRunAt + 15, Math.ceil(llmState.pausedUntil / 1000) + 1);
    pipeline.nextRunAt = backlog ? Math.min(normal, resume) : normal;
  }
}


/** Run a cycle as soon as possible (e.g. right after a source is added). */
export function triggerNow() {
  pipeline.nextRunAt = 0;
}

export function startScheduler() {
  pipeline.nextRunAt = nowSec() + 2;
  setInterval(() => {
    if (!pipeline.running && nowSec() >= pipeline.nextRunAt) void runCycle();
  }, 3000);
}
