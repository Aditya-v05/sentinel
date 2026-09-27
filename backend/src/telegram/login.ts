/**
 * One-time interactive login: `npm run telegram:login`.
 * Telegram sends a code to the phone's Telegram app; the resulting session is saved
 * to data/telegram.session so the server can reconnect without prompting.
 */
import fs from "node:fs";
import readline from "node:readline/promises";
import { config, DATA_DIR } from "../config.js";
import { newClient } from "./client.js";

if (!config.tg.apiId || !config.tg.apiHash) {
  console.error("Set TG_API_ID and TG_API_HASH in backend/.env first (from https://my.telegram.org).");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const client = newClient("");

await client.start({
  phoneNumber: async () => config.tg.phone || (await rl.question("Phone number (e.g. +919876543210): ")),
  phoneCode: async () => await rl.question("Code sent to your Telegram app: "),
  password: async () => await rl.question("2FA password (leave empty if none): "),
  onError: (err) => console.error("Login error:", err.message),
});

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(config.tg.sessionFile, String(client.session.save()));
const me = await client.getMe();
console.log(`Logged in as ${me.username ? "@" + me.username : me.firstName}. Session saved to ${config.tg.sessionFile}`);

rl.close();
await client.disconnect();
process.exit(0);
