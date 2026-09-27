import { all, nowSec, run, scope, tx, type Row } from "../db.js";
import { chatJSON, clip } from "../llm/groq.js";
import type { Range } from "../util/range.js";
import { AGE_BRACKETS, INTERESTS, pick, PROFESSIONS } from "./labels.js";

const BATCH = 10;
/** Buckets smaller than this are folded into "other" so no individual can be singled out. */
export const MIN_GROUP = 3;

interface Profiled {
  results: { i: number; language: string; region: string; age_bracket: string; interests: string[]; profession: string }[];
}

/**
 * Infers language, region, age bracket, interests and profession from public signals:
 * display name, bio and a few sample messages. Stored per user but only ever exposed
 * as aggregates.
 */
export async function profileUsers(limit: number, onProgress?: (done: number, total: number) => void) {
  const users = all(
    `SELECT u.key, u.display_name, u.username, u.bio, u.location,
            (SELECT json_group_array(text) FROM (
               SELECT text FROM messages WHERE author_key = u.key AND analyzed != 2 ORDER BY ts DESC LIMIT 5)) AS samples
       FROM users u
      WHERE u.kind = 'user' AND u.is_bot = 0 AND u.key NOT LIKE 'tg:@%'
        AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.user_key = u.key)
        AND u.bio_fetched != 0
        AND EXISTS (SELECT 1 FROM messages WHERE author_key = u.key AND analyzed != 2)
      LIMIT ?`,
    limit,
  );
  if (!users.length) return 0;

  let done = 0;
  for (let start = 0; start < users.length; start += BATCH) {
    const batch = users.slice(start, start + BATCH);
    const items = batch.map((u: Row, i) => ({
      i,
      name: clip(u.display_name, 60),
      username: u.username ?? "",
      bio: clip(u.bio, 200),
      ...(u.location ? { location: clip(u.location, 60) } : {}),
      messages: (JSON.parse(u.samples ?? "[]") as string[]).map((t) => clip(t, 160)),
    }));

    const res = await chatJSON<Profiled>(
      "You estimate aggregate audience demographics from public social media signals for anonymised analytics. Make a best guess from names, language, spelling, slang, places and topics; use \"unknown\" only when there is no signal at all. Reply with JSON only.",
      `For each user estimate:
- language: main language they write in (English name, e.g. "Hindi", "English", "Malayalam")
- region: most likely country (English name) or "unknown"; a stated location field is the strongest signal
- age_bracket: one of ${AGE_BRACKETS.join(", ")}
- interests: 1-3 of ${INTERESTS.join(", ")}
- profession: one of ${PROFESSIONS.join(", ")}

Users (JSON):
${JSON.stringify(items)}

Return: {"results":[{"i":0,"language":"...","region":"...","age_bracket":"...","interests":["..."],"profession":"..."}, ...]}`,
      { maxTokens: 2000 },
    );

    const byIndex = new Map((res.results ?? []).map((r) => [Number(r.i), r]));
    tx(() => {
      batch.forEach((u, i) => {
        const r = byIndex.get(i);
        run(
          `INSERT OR REPLACE INTO profiles (user_key, language, region, age_bracket, interests, profession, profiled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          u.key, clip(r?.language, 30) || "unknown", clip(r?.region, 40) || "unknown",
          pick(AGE_BRACKETS, r?.age_bracket, "unknown"),
          JSON.stringify([...new Set((r?.interests ?? []).map((x) => pick(INTERESTS, x, "other")))].slice(0, 3)),
          pick(PROFESSIONS, r?.profession, "unknown"), nowSec(),
        );
      });
    });
    done += batch.length;
    onProgress?.(done, users.length);
  }
  return done;
}

function tally(values: string[]) {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let other = 0;
  const rows: { label: string; count: number }[] = [];
  for (const [label, count] of counts) {
    if (label === "unknown") continue;
    if (count < MIN_GROUP) other += count;
    else rows.push({ label, count });
  }
  rows.sort((a, b) => b.count - a.count);
  if (other) rows.push({ label: "other (small groups)", count: other });
  return { rows, unknown: counts.get("unknown") ?? 0 };
}

/** Aggregate demographics of people who posted in the selected scope. */
export function demographics(r: Range) {
  const s = scope(r);
  const profiles = all(
    `SELECT p.* FROM profiles p
      WHERE p.user_key IN (SELECT DISTINCT m.author_key FROM messages m WHERE ${s.where})`,
    ...s.params,
  );
  const activeAuthors = all(
    `SELECT COUNT(DISTINCT m.author_key) AS n FROM messages m JOIN users u ON u.key = m.author_key
      WHERE ${s.where} AND u.kind = 'user' AND u.is_bot = 0`,
    ...s.params,
  )[0]?.n ?? 0;

  return {
    audience: activeAuthors,
    profiled: profiles.length,
    minGroup: MIN_GROUP,
    language: tally(profiles.map((p) => p.language)),
    region: tally(profiles.map((p) => p.region)),
    age: (() => {
      const t = tally(profiles.map((p) => p.age_bracket));
      const order = (l: string) => { const i = AGE_BRACKETS.indexOf(l as any); return i < 0 ? 99 : i; };
      t.rows.sort((a, b) => order(a.label) - order(b.label));
      return t;
    })(),
    interests: tally(profiles.flatMap((p) => JSON.parse(p.interests ?? "[]") as string[])),
    profession: tally(profiles.map((p) => p.profession)),
  };
}
