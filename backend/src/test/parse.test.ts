import assert from "node:assert/strict";
import { test } from "node:test";
import { parseXInput } from "../x/collector.js";
import { parseRedditInput } from "../reddit/collector.js";
import { parseYouTubeInput } from "../youtube/collector.js";
import { base36ToBigInt, fnv64 } from "../util/ids.js";
import { parseMetaInput } from "../meta/collector.js";

test("X inputs: handle forms, search, and rejections", () => {
  assert.deepEqual(parseXInput("x:@isro"), { kind: "handle", query: "isro" });
  assert.deepEqual(parseXInput("https://x.com/isro"), { kind: "handle", query: "isro" });
  assert.deepEqual(parseXInput("twitter.com/ISRO?ref=x"), { kind: "handle", query: "ISRO" });
  assert.deepEqual(parseXInput("x:chandrayaan lang:hi"), { kind: "search", query: "chandrayaan lang:hi" });
  assert.equal(parseXInput("@telegramgroup"), null);
  assert.throws(() => parseXInput("x:"), /Nothing after/);
});

test("Reddit and YouTube inputs", () => {
  assert.deepEqual(parseRedditInput("r/isro"), { kind: "subreddit", query: "isro" });
  assert.deepEqual(parseRedditInput("https://www.reddit.com/r/ISRO/"), { kind: "subreddit", query: "ISRO" });
  assert.equal(parseRedditInput("x:@isro"), null);
  assert.deepEqual(parseYouTubeInput("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1"), { kind: "video", query: "dQw4w9WgXcQ" });
  assert.deepEqual(parseYouTubeInput("https://youtu.be/dQw4w9WgXcQ"), { kind: "video", query: "dQw4w9WgXcQ" });
  assert.deepEqual(parseYouTubeInput("https://www.youtube.com/@isro"), { kind: "channel", query: "@isro" });
  assert.equal(parseYouTubeInput("@isro"), null);
});

test("ids: base36 is exact and reversible in spirit; fnv64 is stable and positive", () => {
  assert.equal(base36ToBigInt("1wrsesq"), BigInt(parseInt("1wrsesq", 36)));
  assert.equal(base36ToBigInt("zzzzzzzzzzz") > 2n ** 53n, true);          // beyond a JS number, still exact
  assert.equal(fnv64("UgxK-abc"), fnv64("UgxK-abc"));
  assert.notEqual(fnv64("UgxK-abc"), fnv64("UgxK-abd"));
  assert.equal(fnv64("anything") >= 0n && fnv64("anything") < 2n ** 63n, true);
});

test("Instagram and Facebook inputs", () => {
  assert.deepEqual(parseMetaInput("https://www.instagram.com/isro.dos/"), { platform: "instagram", query: "isro.dos" });
  assert.deepEqual(parseMetaInput("ig:@isro.dos"), { platform: "instagram", query: "isro.dos" });
  assert.equal(parseMetaInput("https://www.instagram.com/p/Dc0FmIThO1h/"), null);
  assert.deepEqual(parseMetaInput("https://www.facebook.com/ISRO/"), { platform: "facebook", query: "ISRO" });
  assert.deepEqual(parseMetaInput("fb:ISRO"), { platform: "facebook", query: "ISRO" });
  assert.equal(parseMetaInput("r/isro"), null);
});
