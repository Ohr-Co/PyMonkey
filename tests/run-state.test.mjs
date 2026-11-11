import { test } from "node:test";
import assert from "node:assert/strict";
import { STOPPED_BY_USER, overTimeLimit, runState } from "../extension/lib/run-state.js";

const failed = (error) => ({ ok: false, stdout: "", error });

test("a run that reached its end is done, whatever it printed", () => {
  assert.equal(runState({ ok: true, stdout: "", error: null }), "done");
  assert.equal(runState({ ok: true, stdout: "Stopped by user.\n", error: null }), "done");
});

test("the Stop button and the time limit both count as stopped", () => {
  assert.equal(runState(failed(STOPPED_BY_USER)), "stopped");
  assert.equal(runState(failed(overTimeLimit(30))), "stopped");
  assert.equal(runState(failed(overTimeLimit(0.5))), "stopped");
});

test("the messages read as before", () => {
  assert.equal(STOPPED_BY_USER, "Stopped by user.");
  assert.equal(overTimeLimit(30), "Script stopped: it ran longer than 30s. Its time limit can be changed in the panel.");
});

test("everything else that is not ok is an error", () => {
  const traceback = 'Traceback (most recent call last):\n  File "<pymonkey script>", line 1, in <module>\nZeroDivisionError: division by zero\n';
  assert.equal(runState(failed(traceback)), "error");
  assert.equal(runState(failed("PyMonkey could not run on this page.")), "error");
  // A script that raises with those very words broke on its own: its error is a traceback.
  assert.equal(runState(failed(`${traceback}RuntimeError: Stopped by user.\n`)), "error");
  assert.equal(runState(failed("")), "error");
  assert.equal(runState({ ok: false }), "error");
  assert.equal(runState(undefined), "error");
});
