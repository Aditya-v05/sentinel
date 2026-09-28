/**
 * `npm run eval` — scores the labeller against labelled tweets and freezes the result.
 *
 * Same prompt, same model, same snapping as the pipeline (analysis/sentiment.ts), so the
 * accuracy reported here is the accuracy the dashboard runs on. Four dimensions:
 *   sentiment  TweetEval sentiment   positive / neutral / negative
 *   emotion    TweetEval emotion     anger / joy / optimism / sadness  (ours mapped onto theirs)
 *   irony      TweetEval irony       our sarcasm flag
 *   stance     TweetEval stance      favor / against / none, toward a stated target
 * Each has a majority-class baseline; sentiment also has an AFINN lexicon baseline, which is
 * the "just use a dictionary" alternative a judge will ask about.
 *
 * `npm run eval -- --check` exits non-zero if any metric falls below eval/thresholds.json.
 */
import fs from "node:fs";
import path from "node:path";
import Sentiment from "sentiment";
import { ROOT_DIR } from "../config.js";
import { llmModelName } from "../llm/groq.js";
import { labelTexts, type Label } from "../analysis/sentiment.js";

const DATA = path.join(ROOT_DIR, "eval", "data");
const RESULTS = path.join(ROOT_DIR, "eval", "results");
const THRESHOLDS = path.join(ROOT_DIR, "eval", "thresholds.json");
const check = process.argv.includes("--check");
const limit = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? Infinity);
const BATCH = 20;

interface Row { text: string; label: string; target?: string }
const load = (task: string): Row[] => {
  const f = path.join(DATA, `${task}.jsonl`);
  if (!fs.existsSync(f)) throw new Error(`${f} missing — run \`npm run eval:fetch\` first`);
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).slice(0, limit);
};

// Our vocabulary -> the dataset's. Anything unmapped counts as wrong, which is the honest choice.
const EMOTION_MAP: Record<string, string> = { anger: "anger", joy: "joy", excitement: "joy", hope: "optimism", sadness: "sadness", anxiety: "sadness" };
const STANCE_MAP: Record<string, string> = { supportive: "favor", against: "against", neutral: "none" };
const predict: Record<string, (l: Label) => string> = {
  sentiment: (l) => l.sentiment,
  emotion: (l) => EMOTION_MAP[l.emotion] ?? "other",
  irony: (l) => (l.sarcasm ? "irony" : "non_irony"),
  stance: (l) => STANCE_MAP[l.stance] ?? "none",
};

function metrics(gold: string[], pred: string[]) {
  const classes = [...new Set(gold)];
  const acc = gold.filter((g, i) => g === pred[i]).length / gold.length;
  const f1s = classes.map((c) => {
    const tp = gold.filter((g, i) => g === c && pred[i] === c).length;
    const fp = pred.filter((p, i) => p === c && gold[i] !== c).length;
    const fn = gold.filter((g, i) => g === c && pred[i] !== c).length;
    const p = tp + fp ? tp / (tp + fp) : 0, r = tp + fn ? tp / (tp + fn) : 0;
    return p + r ? (2 * p * r) / (p + r) : 0;
  });
  const confusion: Record<string, Record<string, number>> = {};
  gold.forEach((g, i) => { (confusion[g] ??= {})[pred[i]] = (confusion[g][pred[i]] ?? 0) + 1; });
  return { n: gold.length, accuracy: +acc.toFixed(4), macroF1: +(f1s.reduce((a, b) => a + b, 0) / f1s.length).toFixed(4), confusion };
}

const majority = (gold: string[]) => {
  const c = new Map<string, number>();
  gold.forEach((g) => c.set(g, (c.get(g) ?? 0) + 1));
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
};

const afinn = new Sentiment();
const lexicon = (t: string) => { const s = afinn.analyze(t).comparative; return s > 0.1 ? "positive" : s < -0.1 ? "negative" : "neutral"; };

const report: Record<string, any> = { at: new Date().toISOString(), model: llmModelName(), tasks: {} };
for (const task of ["sentiment", "emotion", "irony", "stance"]) {
  const rows = load(task);
  const pred: string[] = new Array(rows.length).fill("");
  let skipped = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const items = batch.map((r, k) => ({ i: k, text: r.text.slice(0, 300), ...(r.target ? { in_reply_to: `Discussion topic: ${r.target}` } : {}) }));
    let labels: Map<number, Label>;
    try { labels = await labelTexts(items); } catch (e) { console.error(`${task} batch ${i}: ${(e as Error).message}`); labels = new Map(); }
    batch.forEach((_, k) => { const l = labels.get(k); if (l) pred[i + k] = predict[task](l); else skipped++; });
    process.stdout.write(`\r${task}: ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  const gold = rows.map((r) => r.label);
  const m = metrics(gold, pred);
  const baselines: Record<string, any> = { majority: metrics(gold, gold.map(() => majority(gold))) };
  if (task === "sentiment") baselines.afinnLexicon = metrics(gold, rows.map((r) => lexicon(r.text)));
  report.tasks[task] = { ...m, skipped, baselines: Object.fromEntries(Object.entries(baselines).map(([k, v]) => [k, { accuracy: v.accuracy, macroF1: v.macroF1 }])) };
  console.log(`\r${task.padEnd(10)} n=${m.n}  accuracy ${m.accuracy}  macro-F1 ${m.macroF1}  (majority ${baselines.majority.accuracy}${baselines.afinnLexicon ? `, lexicon ${baselines.afinnLexicon.accuracy}` : ""})${skipped ? `  skipped ${skipped}` : ""}`);
}

fs.mkdirSync(RESULTS, { recursive: true });
const file = path.join(RESULTS, `${report.at.replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(RESULTS, "latest.json"), JSON.stringify(report, null, 2));
console.log(`written ${path.relative(ROOT_DIR, file)}`);

if (check) {
  const thresholds = JSON.parse(fs.readFileSync(THRESHOLDS, "utf8")) as Record<string, { accuracy?: number; macroF1?: number }>;
  const failures: string[] = [];
  for (const [task, t] of Object.entries(thresholds)) {
    const got = report.tasks[task];
    if (!got) continue;
    if (t.accuracy != null && got.accuracy < t.accuracy) failures.push(`${task}.accuracy ${got.accuracy} < ${t.accuracy}`);
    if (t.macroF1 != null && got.macroF1 < t.macroF1) failures.push(`${task}.macroF1 ${got.macroF1} < ${t.macroF1}`);
  }
  if (failures.length) { console.error("THRESHOLDS NOT MET:\n  " + failures.join("\n  ")); process.exit(1); }
  console.log("all thresholds held");
}
