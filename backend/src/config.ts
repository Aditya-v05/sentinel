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
  tg: {
    apiId: num(process.env.TG_API_ID, 0),
    apiHash: process.env.TG_API_HASH ?? "",
    phone: process.env.TG_PHONE ?? "",
    sessionFile: path.join(DATA_DIR, "telegram.session"),
  },
  groq: {
    apiKey: process.env.GROQ_API_KEY ?? "",
    model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
    tpm: num(process.env.GROQ_TPM, 8000),
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
  dbFile: process.env.DB_FILE || path.join(DATA_DIR, "analytics.db"),
};
