import path from "node:path";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile();
} catch {
  // no .env file — rely on real environment variables
}

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" ? n : fallback;
};

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT_DIR, "data");

export const config = {
  port: num(process.env.PORT, 4000),
  auth: {
    password: process.env.APP_PASSWORD ?? "",      // empty = API open (local demo only)
    secret: process.env.APP_SECRET ?? "",          // optional; derived from the password when unset
  },
  tg: {
    apiId: num(process.env.TG_API_ID, 0),
    apiHash: process.env.TG_API_HASH ?? "",
    phone: process.env.TG_PHONE ?? "",
    sessionFile: process.env.TG_SESSION_FILE || path.join(DATA_DIR, "telegram.session"),
  },
  // Which model labels messages. Azure OpenAI when its key is set (the deployment used across
  // our SIH work), otherwise Groq's free tier. Both go through llm/groq.ts chatJSON().
  llm: {
    // azure | groq | ollama (local, nothing leaves the machine) | mock (tests only)
    provider: (process.env.LLM_PROVIDER || (process.env.AZURE_OPENAI_API_KEY ? "azure" : "groq")) as "azure" | "groq" | "ollama" | "mock",
    tpm: num(process.env.LLM_TPM, process.env.AZURE_OPENAI_API_KEY ? 60000 : 8000),
  },
  ollama: {
    url: (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, ""),
    model: process.env.OLLAMA_MODEL || "qwen2.5:7b",
  },
  azure: {
    endpoint: (process.env.AZURE_OPENAI_ENDPOINT ?? "").replace(/\/+$/, ""),
    apiKey: process.env.AZURE_OPENAI_API_KEY ?? "",
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-10-21",
    deployment: process.env.AZURE_OPENAI_CHAT_DEPLOYMENT ?? "",
    // Reasoning deployments spend output tokens thinking; "low" keeps labelling cheap and fast.
    // Leave empty for a deployment or API version that rejects the parameter.
    reasoningEffort: process.env.AZURE_REASONING_EFFORT ?? "low",
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY ?? "",
    model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
    insightsModel: process.env.GROQ_INSIGHTS_MODEL || "openai/gpt-oss-120b",
  },
  pipeline: {
    syncIntervalSec: num(process.env.SYNC_INTERVAL_SEC, 300),
    backfillLimit: num(process.env.BACKFILL_LIMIT, 500),
    backfillDays: num(process.env.BACKFILL_DAYS, 30),
    analyzePerCycle: num(process.env.ANALYZE_PER_CYCLE, 200),
    profilePerCycle: num(process.env.PROFILE_PER_CYCLE, 40),
    bioFetchPerCycle: num(process.env.BIO_FETCH_PER_CYCLE, 30),
  },
  x: {
    apifyToken: process.env.APIFY_TOKEN ?? "",
    // apidojo/tweet-scraper: $0.40 per 1,000 tweets, exact thread fetches, any language filter.
    actor: process.env.APIFY_ACTOR || "apidojo~tweet-scraper",
    backfillLimit: num(process.env.X_BACKFILL_LIMIT, 300),
    syncLimit: num(process.env.X_SYNC_LIMIT, 60),
    threadsPerCycle: num(process.env.X_THREADS_PER_CYCLE, 3),
    threadLimit: num(process.env.X_THREAD_LIMIT, 40),
    monthlyBudgetUsd: num(process.env.X_MONTHLY_BUDGET_USD, 15),
  },
  // Instagram and Facebook public pages, through Apify's own scrapers (same token and budget as X).
  meta: {
    postsPerSource: num(process.env.META_POSTS_PER_SOURCE, 12),
    commentsPerPost: num(process.env.META_COMMENTS_PER_POST, 50),
    threadsPerCycle: num(process.env.META_THREADS_PER_CYCLE, 2),
  },
  reddit: {
    // A "script" app at https://www.reddit.com/prefs/apps gives 100 requests a minute for free.
    // Without one the collector falls back to the public Atom feeds, which Reddit throttles hard.
    clientId: process.env.REDDIT_CLIENT_ID ?? "",
    clientSecret: process.env.REDDIT_CLIENT_SECRET ?? "",
    userAgent: process.env.REDDIT_USER_AGENT || "sentinel-analytics/0.3 (audience research)",
    backfillLimit: num(process.env.REDDIT_BACKFILL_LIMIT, 200),
    threadsPerCycle: num(process.env.REDDIT_THREADS_PER_CYCLE, 5),
  },
  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY ?? "",           // Data API v3, free 10,000 units a day
    videosPerChannel: num(process.env.YOUTUBE_VIDEOS_PER_CHANNEL, 10),
    commentsPerVideo: num(process.env.YOUTUBE_COMMENTS_PER_VIDEO, 300),
  },
  dbFile: process.env.DB_FILE || path.join(DATA_DIR, "analytics.db"),
};
