import { test } from "node:test";
import assert from "node:assert/strict";
import { startRun } from "../extension/lib/run-client.js";

const OK = { ok: true, stdout: "done\n", error: null };

// Stand-ins for chrome.runtime.sendMessage and chrome.runtime.onMessage.
// `answers` maps a message type to a reply, or to a function that makes one.
// When the test `t` ends, even on a failed assertion, every question is
// answered with nothing, so a run that is still polling gives up and no timer
// keeps the test process alive.
function fakeBackground(t, answers) {
  const listeners = new Set();
  const sent = [];
  let closed = false;
  t.after(() => (closed = true));
  return {
    sent,
    listeners,
    emit: (msg) => listeners.forEach((listener) => listener(msg)),
    options: {
      pollMs: 5,
      events: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
      send: async (msg) => {
        if (closed) return undefined;
        sent.push(msg);
        const answer = answers[msg.type];
        return typeof answer === "function" ? answer(msg) : answer;
      },
    },
  };
}

test("resolves with the result announced by run-finished", async (t) => {
  const bg = fakeBackground(t, { "run-in-tab": { ok: true }, "run-status": { state: "running" } });
  const run = startRun(7, "print(1)", bg.options);
  assert.equal(await run.started, true);
  assert.deepEqual(bg.sent[0], {
    type: "run-in-tab", runId: run.runId, tabId: 7, scriptId: null, code: "print(1)", timeout: undefined,
  });

  bg.emit({ target: "panel", type: "run-finished", runId: "someone-else", result: { ok: false } });
  bg.emit({ target: "panel", type: "run-finished", runId: run.runId, result: OK });
  assert.deepEqual(await run.result, OK);
  assert.equal(bg.listeners.size, 0); // cleaned up after itself
});

test("recovers the result by asking when run-finished was missed", async (t) => {
  let asked = 0;
  const bg = fakeBackground(t, {
    "run-in-tab": { ok: true },
    "run-status": () => (++asked < 3 ? { state: "running" } : { state: "done", result: OK }),
  });
  assert.deepEqual(await startRun(1, "", bg.options).result, OK);
  assert.equal(asked, 3);
});

test("a run that no longer exists is an error, not an endless wait", async (t) => {
  const bg = fakeBackground(t, { "run-in-tab": { ok: true }, "run-status": { state: "unknown" } });
  const result = await startRun(1, "", bg.options).result;
  assert.equal(result.ok, false);
  assert.match(result.error, /result of this run was lost/);
});

test("a background that stops answering is an error, not an endless wait", async (t) => {
  const bg = fakeBackground(t, {
    "run-in-tab": { ok: true },
    "run-status": () => Promise.reject(new Error("Extension context invalidated.")),
  });
  const result = await startRun(1, "", bg.options).result;
  assert.equal(result.ok, false);
  assert.match(result.error, /stopped answering/);
  assert.equal(bg.sent.filter((msg) => msg.type === "run-status").length, 3);
});

test("a run that could not start reports why and never polls", async (t) => {
  const bg = fakeBackground(t, { "run-in-tab": { ok: false, error: "PyMonkey could not start the script: nope" } });
  const run = startRun(1, "", bg.options);
  assert.equal(await run.started, false);
  assert.deepEqual(await run.result, { ok: false, stdout: "", error: "PyMonkey could not start the script: nope" });
  assert.deepEqual(bg.sent.map((msg) => msg.type), ["run-in-tab"]);
});

test("a start request that throws is reported the same way", async (t) => {
  const bg = fakeBackground(t, { "run-in-tab": () => Promise.reject(new Error("message channel closed")) });
  const result = await startRun(1, "", bg.options).result;
  assert.deepEqual(result, { ok: false, stdout: "", error: "message channel closed" });
});

test("the time limit and the script's id are sent along with the start request", async (t) => {
  const bg = fakeBackground(t, { "run-in-tab": { ok: false } });
  const run = startRun(7, "print(1)", { ...bg.options, timeout: 600, scriptId: "s1" });
  await run.result;
  assert.deepEqual(bg.sent[0], {
    type: "run-in-tab", runId: run.runId, tabId: 7, scriptId: "s1", code: "print(1)", timeout: 600,
  });
});

test("stop() asks for this run to be stopped; the result arrives as usual", async (t) => {
  const stopped = { ok: false, stdout: "", error: "Stopped by user." };
  const bg = fakeBackground(t, {
    "run-in-tab": { ok: true },
    "run-status": { state: "running" },
    "stop-run": (msg) => {
      bg.emit({ target: "panel", type: "run-finished", runId: msg.runId, result: stopped });
      return { ok: true };
    },
  });
  const run = startRun(1, "while True: pass", bg.options);
  await run.started;
  await run.stop();
  assert.deepEqual(await run.result, stopped);
  assert.deepEqual(bg.sent.at(-1), { type: "stop-run", runId: run.runId });
});
