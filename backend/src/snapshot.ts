import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { db } from "./db.js";

/**
 * `npm run db:snapshot` — a consistent copy of the database as it is right now.
 *
 * The plan for the finals: collect ahead of time, snapshot, and run the demo from the
 * snapshot (DB_FILE=data/snapshots/<file>) with live sync on top. A snapshot is a dataset
 * you hold; a live scraper the morning of a demo is a hope.
 */
const dir = path.join(DATA_DIR, "snapshots");
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
const target = path.join(dir, `analytics-${stamp}.db`);
db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
const rows = db.prepare("SELECT (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM sources) AS sources").get() as any;
console.log(`snapshot written: ${target}`);
console.log(`  ${rows.sources} sources, ${rows.messages} messages`);
console.log(`  run the demo from it with: DB_FILE=${target} npm run dev`);
