import fs from "node:fs";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { LogLevel } from "telegram/extensions/Logger.js";
import { config } from "../config.js";

export function readSession() {
  try {
    return fs.readFileSync(config.tg.sessionFile, "utf8").trim();
  } catch {
    return "";
  }
}

export function newClient(session = readSession()) {
  const client = new TelegramClient(new StringSession(session), config.tg.apiId, config.tg.apiHash, {
    connectionRetries: 5,
  });
  client.setLogLevel(LogLevel.ERROR);
  return client;
}

let client: TelegramClient | null = null;
export const tgState = { configured: false, authorized: false, error: "" as string };

/** Connects the shared client once. Returns null if keys/session are missing so the API can still run. */
export async function getTelegram(): Promise<TelegramClient | null> {
  if (client?.connected && tgState.authorized) return client;
  tgState.configured = Boolean(config.tg.apiId && config.tg.apiHash);
  if (!tgState.configured) {
    tgState.error = "TG_API_ID / TG_API_HASH missing in .env";
    return null;
  }
  if (!readSession()) {
    tgState.error = "Not logged in — run `npm run telegram:login` once";
    return null;
  }
  try {
    client ??= newClient();
    if (!client.connected) await client.connect();
    tgState.authorized = await client.checkAuthorization();
    tgState.error = tgState.authorized ? "" : "Session expired — run `npm run telegram:login` again";
    return tgState.authorized ? client : null;
  } catch (e) {
    tgState.error = `Telegram connection failed: ${(e as Error).message}`;
    return null;
  }
}
