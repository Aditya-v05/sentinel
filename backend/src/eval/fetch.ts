/**
 * `npm run eval:fetch` — pulls public labelled tweet sets so the labeller can be scored.
 *
 * TweetEval (Barbieri et al., 2020) ships sentiment, emotion, irony and stance test sets
 * as plain text on GitHub. We take a fixed-seed sample of each so a run costs cents and
 * two runs are comparable. Files land in backend/eval/data/<task>.jsonl (git-ignored).
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "../config.js";

const BASE = "https://raw.githubusercontent.com/cardiffnlp/tweeteval/main/datasets";
const TASKS: Record<string, { dir: string; target?: string }> = {
  sentiment: { dir: "sentiment" },
  emotion: { dir: "emotion" },
  irony: { dir: "irony" },
  stance: { dir: "stance/climate", target: "climate change is a real concern" },
};
const PER_TASK = Number(process.argv[2] ?? 200);

const text = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  return (await r.text()).split("\n");
};

/** Fixed-seed shuffle so the sample is the same on every machine. */
function seeded(n: number) {
  let s = 20260927;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * n;
}

const out = path.join(ROOT_DIR, "eval", "data");
fs.mkdirSync(out, { recursive: true });
for (const [task, t] of Object.entries(TASKS)) {
  const [texts, labels, mapping] = await Promise.all([
    text(`${BASE}/${t.dir}/test_text.txt`),
    text(`${BASE}/${t.dir}/test_labels.txt`),
    text(`${BASE}/${t.dir.split("/")[0]}/mapping.txt`),
  ]);
  const names = new Map(mapping.filter(Boolean).map((l) => l.split("\t")).map(([k, v]) => [k.trim(), v.trim()]));
  const rows = texts.map((x, i) => ({ text: x.trim(), label: names.get((labels[i] ?? "").trim()) ?? "" })).filter((r) => r.text && r.label);
  const rnd = seeded(rows.length);
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rnd()) % (i + 1);
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  const sample = rows.slice(0, PER_TASK).map((r) => ({ ...r, ...(t.target ? { target: t.target } : {}) }));
  fs.writeFileSync(path.join(out, `${task}.jsonl`), sample.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`${task}: ${sample.length} of ${rows.length} rows -> eval/data/${task}.jsonl`);
}
