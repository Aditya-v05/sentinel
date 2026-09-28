import assert from "node:assert/strict";
import { test } from "node:test";
import { sealNew, verify } from "../chain.js";
import { get, nowSec, run } from "../db.js";

const seed = (n: number) => {
  run("INSERT OR IGNORE INTO sources (platform, ext_id, title, kind, added_at) VALUES ('telegram','c','c','channel',?)", nowSec());
  const sid = get("SELECT id FROM sources WHERE platform='telegram' AND ext_id='c'")!.id;
  for (let i = 0; i < n; i++) run("INSERT OR IGNORE INTO messages (source_id, ext_id, author_key, text, ts) VALUES (?, ?, 'tg:1', ?, ?)", sid, 1000 + i, `msg ${i}`, 1_700_000_000 + i);
};

test("sealing chains every row and verify holds; an edit and a deletion are each named", () => {
  seed(5);
  assert.equal(sealNew() >= 5, true);
  assert.equal(sealNew(), 0);
  const ok = verify();
  assert.equal(ok.intact, true);
  assert.equal(ok.unsealed, 0);

  const victim = get("SELECT id FROM messages WHERE text = 'msg 2'")!.id;
  run("UPDATE messages SET text = 'msg 2 (edited)' WHERE id = ?", victim);
  const edited = verify();
  assert.equal(edited.intact, false);
  assert.equal(edited.brokenAt, victim);
  assert.match(edited.reason, /altered after collection/);
  run("UPDATE messages SET text = 'msg 2' WHERE id = ?", victim);
  assert.equal(verify().intact, true);

  const gone = get("SELECT id FROM messages WHERE text = 'msg 3'")!.id;
  run("DELETE FROM messages WHERE id = ?", gone);
  const deleted = verify();
  assert.equal(deleted.intact, false);
  assert.equal(deleted.brokenAt, gone + 1);
  assert.match(deleted.reason, /removed/);
});
