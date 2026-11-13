import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunQueue } from "../extension/lib/run-queue.js";

// A queue that records what it was asked to start and what it reported as finished.
function makeQueue(options = {}) {
  const started = [];
  const finished = [];
  const queue = createRunQueue({
    start: (run) => started.push(run.runId),
    onFinished: (run, result) => finished.push([run.runId, result]),
    ...options,
  });
  return { queue, started, finished };
}

test("runs start one at a time, in the order they were added", () => {
  const { queue, started } = makeQueue();
  queue.add({ runId: "a" });
  queue.add({ runId: "b" });
  queue.add({ runId: "c" });
  assert.deepEqual(started, ["a"]);

  queue.finishActive({ ok: true });
  assert.deepEqual(started, ["a", "b"]);
  queue.finishActive({ ok: true });
  assert.deepEqual(started, ["a", "b", "c"]);
});

test("status follows a run from queued to running to done", () => {
  const { queue } = makeQueue();
  queue.add({ runId: "a" });
  queue.add({ runId: "b" });
  assert.deepEqual(queue.status("a"), { state: "running" });
  assert.deepEqual(queue.status("b"), { state: "queued" });
  assert.ok(queue.isActive("a"));
  assert.ok(!queue.isActive("b"));

  queue.finishActive({ ok: true, stdout: "hi" });
  assert.deepEqual(queue.status("a"), { state: "done", result: { ok: true, stdout: "hi" } });
  assert.deepEqual(queue.status("b"), { state: "running" });
});

test("a run nobody added is unknown", () => {
  const { queue } = makeQueue();
  assert.deepEqual(queue.status("nope"), { state: "unknown" });
});

test("each result is reported exactly once, with its run", () => {
  const { queue, finished } = makeQueue();
  queue.add({ runId: "a", meta: { name: "first" } });
  queue.finishActive({ ok: false, error: "boom" });
  queue.finishActive({ ok: true }); // nothing is running: ignored
  assert.deepEqual(finished, [["a", { ok: false, error: "boom" }]]);
});

test("only the most recent results are remembered", () => {
  const { queue } = makeQueue({ keep: 2 });
  for (const runId of ["a", "b", "c"]) {
    queue.add({ runId });
    queue.finishActive({ ok: true, stdout: runId });
  }
  assert.deepEqual(queue.status("a"), { state: "unknown" });
  assert.equal(queue.status("b").state, "done");
  assert.equal(queue.status("c").result.stdout, "c");
});

test("a waiting run can be cancelled; it gets its result and never starts", () => {
  const { queue, started, finished } = makeQueue();
  queue.add({ runId: "a" });
  queue.add({ runId: "b" });
  queue.add({ runId: "c" });

  assert.equal(queue.cancel("b", { ok: false, error: "Stopped by user." }), true);
  assert.deepEqual(queue.status("b"), { state: "done", result: { ok: false, error: "Stopped by user." } });
  assert.deepEqual(finished, [["b", { ok: false, error: "Stopped by user." }]]);

  queue.finishActive({ ok: true });
  assert.deepEqual(started, ["a", "c"]);
});

test("cancel leaves the running run and unknown runs alone", () => {
  const { queue, finished } = makeQueue();
  queue.add({ runId: "a" });
  assert.equal(queue.cancel("a", { ok: false }), false);
  assert.equal(queue.cancel("nope", { ok: false }), false);
  assert.deepEqual(queue.status("a"), { state: "running" });
  assert.deepEqual(finished, []);
});

test("the queue is empty when no run is executing or waiting", () => {
  const { queue } = makeQueue();
  assert.ok(queue.isEmpty());
  queue.add({ runId: "a" });
  queue.add({ runId: "b" });
  assert.ok(!queue.isEmpty());
  queue.finishActive({ ok: true }); // "b" starts
  assert.ok(!queue.isEmpty());
  queue.finishActive({ ok: true });
  assert.ok(queue.isEmpty()); // finished results are remembered, but they are not work
  assert.equal(queue.status("a").state, "done");

  queue.add({ runId: "c" });
  queue.add({ runId: "d" });
  queue.cancel("d", { ok: false });
  assert.ok(!queue.isEmpty());
  queue.finishActive({ ok: true });
  assert.ok(queue.isEmpty());
});
