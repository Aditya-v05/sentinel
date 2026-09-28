import assert from "node:assert/strict";
import { test } from "node:test";
import { get, nowSec, run } from "../db.js";
import { burstScore, forecast } from "../analysis/trends.js";
import { coordination, normaliseText, origin } from "../analysis/coordination.js";
import { labelTexts } from "../analysis/sentiment.js";
import { budgetLeft, spendThisMonth } from "../x/apify.js";
import { kvSet } from "../db.js";

test("forecast follows recent buckets and stays flat on a flat series; burst fires on one anomalous bucket", () => {
  assert.deepEqual(forecast([3, 3, 3, 3, 3]).next, [3, 3, 3]);
  assert.equal(forecast([1, 2, 2, 3, 3, 4, 5, 6]).next[0] > 6, true);
  assert.equal(burstScore([1, 0, 2, 1, 1, 9]) > 3, true);
  assert.equal(burstScore([5, 6, 5, 6, 5, 6]) < 1, true);
});

test("normaliseText strips what an account would change to look different", () => {
  assert.equal(normaliseText("RT @a: Vote NOW!!! #tag https://x.co/1 @b"), "vote now");
});

test("coordination finds the same wording from several accounts within minutes, and origin orders arrivals", () => {
  run("INSERT OR IGNORE INTO sources (platform, ext_id, title, kind, added_at) VALUES ('x','search:q','q','search',?)", nowSec());
  const sid = get("SELECT id FROM sources WHERE ext_id='search:q'")!.id;
  const t0 = 1_780_000_000;
  const text = "Introducing our hero, coming to screens this friday, do not miss it";
  for (let i = 0; i < 4; i++) {
    run("INSERT INTO users (key, platform, username) VALUES (?, 'x', ?) ON CONFLICT(key) DO NOTHING", `x:a${i}`, `acct${i}`);
    run("INSERT INTO messages (source_id, ext_id, author_key, text, ts) VALUES (?, ?, ?, ?, ?)", sid, 500 + i, `x:a${i}`, text + (i % 2 ? "!" : "."), t0 + i * 90);
  }
  run("INSERT INTO messages (source_id, ext_id, author_key, text, ts) VALUES (?, 600, 'x:a0', 'something unrelated entirely here', ?)", sid, t0 + 5000);
  const r = { source: sid, from: t0 - 10, to: t0 + 6000, bucket: 3600 };
  const c = coordination(r);
  assert.equal(c.bursts.length, 1);
  assert.equal(c.bursts[0].authorCount, 4);
  assert.equal(c.bursts[0].tightestSpanSec, 180);
  const o = origin(r, { term: "hero" });
  assert.equal(o.total, 4);
  assert.equal(o.first[0].author, "@acct0");
  assert.equal(o.platforms[0].delaySec, 0);
});

test("the mock model labels every item with values on the fixed vocabularies", async () => {
  const out = await labelTexts([{ i: 0, text: "great launch" }, { i: 1, text: "terrible delay again" }]);
  assert.equal(out.size, 2);
  for (const l of out.values()) {
    assert.equal(["positive", "neutral", "negative"].includes(l.sentiment), true);
    assert.equal(l.score >= -1 && l.score <= 1, true);
  }
});

test("the Apify budget guard reads the monthly counter", () => {
  // X_MONTHLY_BUDGET_USD=1 in the npm test script.
  kvSet(`apify_spend_${new Date().toISOString().slice(0, 7)}`, "0.75");
  assert.equal(spendThisMonth(), 0.75);
  assert.equal(budgetLeft(), 0.25);
  kvSet(`apify_spend_${new Date().toISOString().slice(0, 7)}`, "1.5");
  assert.equal(budgetLeft(), 0);
});
