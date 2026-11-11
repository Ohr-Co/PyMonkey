import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_OUTPUT_CHARS, capText, countUnseenFailures, describeLastRun, isLastRunKey, lastRunKey, makeLastRun,
} from "../extension/lib/last-run.js";

const META = { auto: true, scriptId: "s1", name: "prices", url: "https://example.com/shop" };

test("a successful run is recorded with its time, URL and output", () => {
  const lastRun = makeLastRun(META, { ok: true, stdout: "3 items\n", error: null }, 1_700_000_000_000);
  assert.deepEqual(lastRun, {
    time: 1_700_000_000_000,
    url: "https://example.com/shop",
    ok: true,
    stdout: "3 items\n",
    error: null,
    seen: false,
  });
});

test("a failed run keeps what was printed and the error", () => {
  const lastRun = makeLastRun(META, { ok: false, stdout: "step 1\n", error: "Traceback...\nKeyError: 'price'" }, 5);
  assert.equal(lastRun.ok, false);
  assert.equal(lastRun.stdout, "step 1\n");
  assert.equal(lastRun.error, "Traceback...\nKeyError: 'price'");
});

test("a failure always has an error text, even if the run gave none", () => {
  assert.match(makeLastRun(META, { ok: false, stdout: "" }, 5).error, /failed without an error message/);
  assert.match(makeLastRun(META, undefined, 5).error, /failed without an error message/);
});

test("short text is stored as it is", () => {
  assert.equal(capText("hello"), "hello");
  assert.equal(capText(""), "");
  assert.equal(capText(undefined), "");
  assert.equal(capText("x".repeat(MAX_OUTPUT_CHARS)).length, MAX_OUTPUT_CHARS);
});

test("long text is cut to its end, and says so", () => {
  const capped = capText("a".repeat(50) + "the end", 7);
  assert.equal(capped, "[… 50 earlier characters not kept]\nthe end");
});

test("a stored run cannot grow past the cap, however much a script prints", () => {
  const huge = { ok: false, stdout: "x".repeat(5_000_000), error: "y".repeat(5_000_000) };
  const lastRun = makeLastRun(META, huge, 5);
  const note = "[… 4980000 earlier characters not kept]\n".length;
  assert.equal(lastRun.stdout.length, MAX_OUTPUT_CHARS + note);
  assert.equal(lastRun.error.length, MAX_OUTPUT_CHARS + note);
  assert.ok(JSON.stringify(lastRun).length < 3 * MAX_OUTPUT_CHARS);
});

test("the badge counts failures nobody has looked at", () => {
  const ok = { ok: true, seen: false };
  const failed = { ok: false, seen: false };
  const seen = { ok: false, seen: true };
  assert.equal(countUnseenFailures([]), 0);
  assert.equal(countUnseenFailures([ok, seen]), 0);
  assert.equal(countUnseenFailures([ok, failed, seen, failed]), 2);
  assert.equal(countUnseenFailures([undefined, failed]), 1);
});

test("each script's last run has its own storage key", () => {
  assert.equal(lastRunKey("s1"), "lastRun:s1");
  assert.notEqual(lastRunKey("s1"), lastRunKey("s2"));
  assert.ok(isLastRunKey(lastRunKey("s1")));
  assert.ok(!isLastRunKey("scripts"));
});

test("the panel's summary line says how it went and when", () => {
  const when = new Date(1_700_000_000_000).toLocaleString();
  assert.equal(describeLastRun({ ok: true, time: 1_700_000_000_000 }), `Last automatic run succeeded · ${when}`);
  assert.equal(describeLastRun({ ok: false, time: 1_700_000_000_000 }), `Last automatic run failed · ${when}`);
});
