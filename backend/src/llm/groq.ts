import Groq, { RateLimitError } from "groq-sdk";
import { config } from "../config.js";

let client: Groq | null = null;

/** Set when the free-tier quota is exhausted; LLM steps are skipped until then. */
export const llmState = { pausedUntil: 0, lastError: "", throttledUntil: 0 };

// ---- client-side tokens-per-minute pacing (LLM_TPM: 8000 on the Groq free tier, 60000 on Azure) ----
const usage: { at: number; tokens: number }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until sending ~`estimate` more tokens keeps us under the per-minute budget. */
async function throttle(estimate: number) {
  const budget = config.llm.tpm * 0.9;
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

const azure = () => config.llm.provider === "azure";
export const llmConfigured = () =>
  azure() ? Boolean(config.azure.apiKey && config.azure.endpoint && config.azure.deployment) : Boolean(config.groq.apiKey);
/** What the dashboard shows as the model. */
export const llmModelName = () => (azure() ? `azure/${config.azure.deployment}` : config.groq.model);
export const llmAvailable = () => llmConfigured() && Date.now() >= llmState.pausedUntil;

export class LlmPausedError extends Error {}

/**
 * Sends one prompt and parses a JSON object reply. The SDK already retries 429s with
 * backoff; if it still fails we pause all LLM work (quota is per-minute / per-day).
 */
export async function chatJSON<T>(system: string, user: string, opts: { model?: string; maxTokens?: number } = {}): Promise<T> {
  if (!llmConfigured()) {
    throw new LlmPausedError(azure() ? "AZURE_OPENAI_* missing in .env" : "GROQ_API_KEY missing in .env");
  }
  if (!llmAvailable()) throw new LlmPausedError("LLM rate limit reached — paused");

  const maxTokens = opts.maxTokens ?? 2000;
  // ~3.5 chars per token for input; assume the reply uses about half its cap
  const estimate = Math.ceil((system.length + user.length) / 3.5) + Math.ceil(maxTokens / 2);
  await throttle(estimate);
  if (azure()) return azureJSON<T>(system, user, maxTokens, estimate);

  client ??= new Groq({ apiKey: config.groq.apiKey, maxRetries: 3, timeout: 60_000 });
  const model = opts.model ?? config.groq.model;
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
 * Azure OpenAI, plain fetch: the chat-completions endpoint of one deployment, JSON mode.
 * Reasoning deployments take max_completion_tokens (which includes the thinking) and no
 * temperature. A 429 pauses LLM work like a Groq one does.
 */
async function azureJSON<T>(system: string, user: string, maxTokens: number, estimate: number): Promise<T> {
  const url = `${config.azure.endpoint}/openai/deployments/${config.azure.deployment}/chat/completions?api-version=${config.azure.apiVersion}`;
  const body: Record<string, unknown> = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    // Reasoning happens before the answer and counts here, so leave room beyond the reply.
    max_completion_tokens: maxTokens + 1500,
    response_format: { type: "json_object" },
    ...(config.azure.reasoningEffort ? { reasoning_effort: config.azure.reasoningEffort } : {}),
  };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "api-key": config.azure.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after")) || 30;
      llmState.pausedUntil = Date.now() + retryAfter * 1000;
      llmState.lastError = `Azure rate limit — resuming in ${retryAfter}s`;
      usage.push({ at: Date.now(), tokens: estimate });
      throw new LlmPausedError(llmState.lastError);
    }
    const data = (await res.json()) as {
      error?: { message?: string };
      usage?: { total_tokens?: number };
      choices?: { message?: { content?: string } }[];
    };
    if (!res.ok) throw new Error(`Azure ${res.status}: ${data.error?.message ?? ""}`.slice(0, 160));
    usage.push({ at: Date.now(), tokens: data.usage?.total_tokens ?? estimate });
    llmState.lastError = "";
    return JSON.parse(data.choices?.[0]?.message?.content ?? "{}") as T;
  } catch (e) {
    if (e instanceof LlmPausedError) throw e;
    usage.push({ at: Date.now(), tokens: estimate });
    llmState.lastError = ((e as Error).message ?? String(e)).slice(0, 160);
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
