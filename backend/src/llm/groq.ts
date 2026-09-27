import Groq, { RateLimitError } from "groq-sdk";
import { config } from "../config.js";

let client: Groq | null = null;

/** Set when the free-tier quota is exhausted; LLM steps are skipped until then. */
export const llmState = { pausedUntil: 0, lastError: "", throttledUntil: 0 };

// ---- client-side tokens-per-minute pacing (Groq free tier: GROQ_TPM, default 8000) ----
const usage: { at: number; tokens: number }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until sending ~`estimate` more tokens keeps us under the per-minute budget. */
async function throttle(estimate: number) {
  const budget = config.groq.tpm * 0.9;
  for (;;) {
    const now = Date.now();
    while (usage.length && now - usage[0].at > 60_000) usage.shift();
    const used = usage.reduce((a, u) => a + u.tokens, 0);
    if (!usage.length || used + estimate <= budget) {
      llmState.throttledUntil = 0;
      return;
    }
    const wait = 60_000 - (now - usage[0].at) + 250;
    llmState.throttledUntil = now + wait;
    await sleep(wait);
  }
}

export const llmConfigured = () => Boolean(config.groq.apiKey);
export const llmAvailable = () => llmConfigured() && Date.now() >= llmState.pausedUntil;

export class LlmPausedError extends Error {}

/**
 * Sends one prompt and parses a JSON object reply. The SDK already retries 429s with
 * backoff; if it still fails we pause all LLM work (quota is per-minute / per-day).
 */
export async function chatJSON<T>(system: string, user: string, opts: { model?: string; maxTokens?: number } = {}): Promise<T> {
  if (!llmConfigured()) throw new LlmPausedError("GROQ_API_KEY missing in .env");
  if (!llmAvailable()) throw new LlmPausedError("Groq rate limit reached — paused");
  client ??= new Groq({ apiKey: config.groq.apiKey, maxRetries: 3, timeout: 60_000 });

  const model = opts.model ?? config.groq.model;
  const maxTokens = opts.maxTokens ?? 2000;
  // ~3.5 chars per token for input; assume the reply uses about half its cap
  const estimate = Math.ceil((system.length + user.length) / 3.5) + Math.ceil(maxTokens / 2);
  await throttle(estimate);
  try {
    const res = await client.chat.completions.create({
      model,
      ...reasoningParams(model),
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    usage.push({ at: Date.now(), tokens: res.usage?.total_tokens ?? estimate });
    llmState.lastError = "";
    return JSON.parse(res.choices[0]?.message?.content ?? "{}") as T;
  } catch (e) {
    usage.push({ at: Date.now(), tokens: estimate });
    if (e instanceof RateLimitError) {
      const retryAfter = Number(e.headers?.get?.("retry-after")) || 60;
      llmState.pausedUntil = Date.now() + retryAfter * 1000;
      llmState.lastError = `Groq rate limit — resuming in ${retryAfter}s`;
      throw new LlmPausedError(llmState.lastError);
    }
    // Groq errors look like '400 {"error":{"message":...}}' — keep just the readable part
    const err = e as { error?: { error?: { message?: string } }; message: string };
    llmState.lastError = (err.error?.error?.message ?? err.message).slice(0, 160);
    throw new Error(llmState.lastError);
  }
}

/**
 * Reasoning models spend (free-tier) tokens thinking before answering. Labelling doesn't
 * need much of that, so keep it minimal and keep the reasoning text out of the reply.
 */
function reasoningParams(model: string) {
  if (model.startsWith("openai/gpt-oss")) return { reasoning_effort: "low" as const, include_reasoning: false };
  if (model.includes("qwen3")) return { reasoning_effort: "none" as const, include_reasoning: false };
  return {};
}

/** Keeps prompts small: collapse whitespace and cap length. */
export const clip = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
