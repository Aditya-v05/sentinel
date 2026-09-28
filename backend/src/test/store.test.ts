import assert from "node:assert/strict";
import { test } from "node:test";
import { all, get, nowSec, run } from "../db.js";
import { storeTweet, type Tweet } from "../x/collector.js";

const source = () => {
  run("INSERT OR IGNORE INTO sources (platform, ext_id, handle, title, kind, added_at) VALUES ('x','handle:t','t','@t','handle',?)", nowSec());
  return get("SELECT * FROM sources WHERE platform='x' AND ext_id='handle:t'")!;
};
const tweet = (over: Partial<Tweet>): Tweet => ({
  id: "2104262716030321131", createdAt: "Sun Sep 27 17:31:41 +0000 2026", text: "Hello #Chandrayaan @isro",
  replyCount: 2, retweetCount: 1, likeCount: 4, viewCount: 100,
  entities: { hashtags: [{ text: "Chandrayaan" }], user_mentions: [{ id_str: "12", screen_name: "isro", name: "ISRO" }] },
  author: { id: "99", userName: "alice", name: "Alice", description: "bio", location: "Pune", followers: 10, createdAt: "Tue Jul 05 20:22:50 +0000 2011" },
  ...over,
});

test("a tweet is stored once, with a 64-bit id kept exact and its author, mentions and hashtags", () => {
  const s = source();
  assert.equal(storeTweet(s, tweet({})), true);
  assert.equal(storeTweet(s, tweet({})), false);                              // INSERT OR IGNORE
  const m = get("SELECT CAST(ext_id AS TEXT) AS ext, author_key, mentions, hashtags, forwards, reactions, views, analyzed FROM messages WHERE source_id = ?", s.id)!;
  assert.equal(m.ext, "2104262716030321131");                                 // no rounding
  assert.equal(m.author_key, "x:99");
  assert.deepEqual(JSON.parse(m.mentions), ["x:12"]);
  assert.deepEqual(JSON.parse(m.hashtags), ["#chandrayaan"]);
  assert.equal(m.analyzed, 0);
  const u = get("SELECT username, bio, location, followers, account_created FROM users WHERE key = 'x:99'")!;
  assert.equal(u.location, "Pune");
  assert.equal(u.account_created, Math.floor(Date.parse("Tue Jul 05 20:22:50 +0000 2011") / 1000));
  assert.equal(get("SELECT COUNT(*) AS n FROM threads WHERE platform='x'")!.n, 1);   // replyCount > 0 queued
});

test("a reply links to its parent in SQL; a retweet carries the original text and points at its author", () => {
  const s = source();
  storeTweet(s, tweet({ id: "3", createdAt: "Sun Sep 27 17:40:00 +0000 2026", text: "reply", inReplyToId: "2104262716030321131", replyCount: 0 }));
  const linked = all(
    `SELECT c.text FROM messages c JOIN messages p ON p.source_id = c.source_id AND p.ext_id = c.reply_to_ext_id WHERE c.source_id = ?`, s.id);
  assert.deepEqual(linked.map((r) => r.text), ["reply"]);

  storeTweet(s, tweet({
    id: "4", createdAt: "Sun Sep 27 17:50:00 +0000 2026", text: "RT @bob: original words", isRetweet: true, replyCount: 0,
    retweet: { id: "5", createdAt: "Sun Sep 27 17:00:00 +0000 2026", fullText: "original words", author: { id: "7", userName: "bob" } },
  }));
  const rt = get("SELECT text, fwd_from_key, fwd_from_name FROM messages WHERE source_id = ? AND ext_id = 4", s.id)!;
  assert.equal(rt.text, "original words");
  assert.equal(rt.fwd_from_key, "x:7");
  assert.equal(rt.fwd_from_name, "bob");
});
