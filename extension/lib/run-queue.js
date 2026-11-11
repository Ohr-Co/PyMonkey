// The list of script runs, kept by the offscreen document (the one context
// that stays alive). Runs execute one at a time, in the order they were added,
// and the results of recent runs are remembered so they can be asked for later.
//
// Pure logic, no chrome.* calls: see tests/run-queue.test.mjs.

const KEEP_FINISHED = 20; // how many finished results to remember

/**
 * start(run)              -- called when a run reaches the front of the queue
 * onFinished(run, result) -- called once when that run is over
 * A run is any object with a unique `runId`.
 */
export function createRunQueue({ start, onFinished, keep = KEEP_FINISHED }) {
  const waiting = [];
  const finished = new Map(); // runId -> result, oldest first
  let active = null;

  function startNext() {
    if (active || waiting.length === 0) return;
    active = waiting.shift();
    start(active);
  }

  function remember(run, result) {
    finished.set(run.runId, result);
    // A Map keeps insertion order, so the first key is the oldest result.
    while (finished.size > keep) finished.delete(finished.keys().next().value);
    onFinished(run, result);
  }

  return {
    add(run) {
      waiting.push(run);
      startNext();
    },

    /** True if `runId` is the run executing right now. */
    isActive: (runId) => active?.runId === runId,

    /** True if no run is executing or waiting. */
    isEmpty: () => !active && waiting.length === 0,

    /** The active run is over (result, timeout, crash). Remember it, start the next one. */
    finishActive(result) {
      if (!active) return;
      const run = active;
      active = null;
      remember(run, result);
      startNext();
    },

    /** Take a run that has not started yet out of the queue. Returns false if it was not waiting. */
    cancel(runId, result) {
      const i = waiting.findIndex((run) => run.runId === runId);
      if (i === -1) return false;
      const [run] = waiting.splice(i, 1);
      remember(run, result);
      return true;
    },

    /** Where a run is: queued, running, done (with its result) or unknown. */
    status(runId) {
      if (finished.has(runId)) return { state: "done", result: finished.get(runId) };
      if (active?.runId === runId) return { state: "running" };
      if (waiting.some((run) => run.runId === runId)) return { state: "queued" };
      return { state: "unknown" };
    },
  };
}
