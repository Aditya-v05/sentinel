import assert from "node:assert/strict";
import { test } from "node:test";
import { issue, login, verify } from "../auth.js";

// APP_PASSWORD=test-pass is set by the npm test script.
test("the right password yields a token, the wrong one nothing, and tampering or expiry is rejected", () => {
  assert.equal(login("nope"), null);
  assert.equal(login(""), null);
  const token = login("test-pass")!;
  assert.equal(verify(token), true);
  assert.equal(verify(token + "x"), false);
  const [payload] = token.split(".");
  assert.equal(verify(`${payload}.${"0".repeat(43)}`), false);
  assert.equal(verify(issue(-1)), false);
  assert.equal(verify(undefined), false);
});
