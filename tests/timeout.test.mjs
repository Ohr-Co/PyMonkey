import { test } from "node:test";
import assert from "node:assert/strict";
import { timeoutSeconds, DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S } from "../extension/lib/timeout.js";

test("a script without a time limit gets the default", () => {
  assert.equal(DEFAULT_TIMEOUT_S, 30);
  assert.equal(timeoutSeconds(undefined), 30);
  assert.equal(timeoutSeconds(null), 30);
  assert.equal(timeoutSeconds(""), 30);
});

test("numbers and numeric text are taken as seconds", () => {
  assert.equal(timeoutSeconds(600), 600);
  assert.equal(timeoutSeconds("600"), 600);
  assert.equal(timeoutSeconds("2.5"), 2.5);
});

test("0 means no limit and is kept", () => {
  assert.equal(timeoutSeconds(0), 0);
  assert.equal(timeoutSeconds("0"), 0);
});

test("nonsense falls back to the default instead of disabling the limit", () => {
  assert.equal(timeoutSeconds("soon"), 30);
  assert.equal(timeoutSeconds(-5), 30);
  assert.equal(timeoutSeconds(NaN), 30);
  assert.equal(timeoutSeconds(Infinity), 30);
});

test("very long limits are capped at what a timer can count", () => {
  assert.equal(timeoutSeconds(10 ** 12), MAX_TIMEOUT_S);
  assert.ok(MAX_TIMEOUT_S * 1000 < 2 ** 31); // setTimeout's ceiling in milliseconds
});
