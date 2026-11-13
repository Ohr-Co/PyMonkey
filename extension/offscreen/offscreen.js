// Offscreen document: owns the Pyodide web worker and keeps it warm.
// Unlike the background service worker, this page is NOT killed by Chrome
// when idle, so Python stays loaded between runs. For the same reason it is
// the place that remembers which runs are queued, running and finished.
//
// Its jobs:
//   * queue run requests from the background and feed them to the worker one at a time
//   * pass Python's requests for the page or for saved values back out (workers have no chrome.* APIs)
//   * kill the worker when a script passes its time limit or the user presses Stop;
//     the next request starts a new one
//   * announce each result to the background, and keep it for anyone who asks later
//   * give memory back: replace the worker after a run that needed a lot, and
//     close this whole document when nobody has asked for Python for a while
//     (the background opens a new one when Python is next needed)

import { createIdleTimer, grownTooLarge, idleSeconds } from "../lib/memory.js";
import { createRunQueue } from "../lib/run-queue.js";
import { STOPPED_BY_USER, overTimeLimit } from "../lib/run-state.js";
import { timeoutSeconds } from "../lib/timeout.js";

const SNAPSHOT_TIMEOUT_MS = 15_000;
const SERVICES = ["dom", "store"]; // what Python may ask the background for

let worker = null;
let activeTimeout = 0; // time limit, in seconds, of the run that is executing (0 = none)
let runTimer = null; // its timer, counted from when the script actually starts
let nextWarmId = 1;
const warmPending = new Map(); // id -> resolve

const toBackground = (message) => chrome.runtime.sendMessage({ ...message, target: "background" });

const runs = createRunQueue({ start: startRun, onFinished: announce });

// ---------- closing when idle ----------
//
// Python loaded and doing nothing still holds about a hundred megabytes (see
// docs/memory.md). So this document counts down whenever it has no work, and
// closes itself at zero.
// With it gone and the service worker stopped (which Chrome does after 30
// seconds), nothing of PyMonkey is left running until it is needed again.
// What is lost is the list of recent results, which by then nobody is waiting for.

let closing = false;
const idle = createIdleTimer({ seconds: idleSeconds(location.search), onIdle: shutDown });

// Call after anything that happens here: it starts the countdown from the top,
// or switches it off while a run is queued or executing or Python is loading for someone.
function touch() {
  idle.update(!runs.isEmpty() || warmPending.size > 0);
}

function shutDown() {
  // Closing takes a moment. A message that arrives during it gets no answer,
  // which tells the background to open a new document and send it there.
  closing = true;
  worker?.terminate();
  window.close();
}

// ---------- the worker ----------

function startWorker() {
  worker = new Worker("../worker/pyodide-worker.js", { type: "module" });
  worker.onmessage = ({ data }) => onWorkerMessage(data);
  worker.onerror = (e) => {
    // No message means the worker file itself failed to load, which in practice
    // means the Pyodide files are missing from extension/vendor/pyodide.
    const reason = e.message
      ? `Python runtime crashed: ${e.message}`
      : "Pyodide files not found in extension/vendor/pyodide. In the project folder run " +
        "`npm install` then `npm run setup`, then reload the extension at chrome://extensions.";
    // Python itself is broken: fail everything in flight, including "warm" requests.
    worker?.terminate();
    worker = null;
    const failed = { ok: false, stdout: "", error: reason };
    for (const resolve of warmPending.values()) resolve(failed);
    warmPending.clear();
    finishRun(failed);
  };
}

// Swap the worker for a new one. Whoever is waiting for Python to load keeps
// waiting, on the new one.
function restartWorker() {
  worker?.terminate();
  startWorker();
  for (const id of warmPending.keys()) worker.postMessage({ type: "warm", id });
}

// End the run that is executing by killing the worker: the only way to stop
// Python that is busy (e.g. `while True: pass`). The next run gets a fresh worker.
function killRun(reason) {
  worker?.terminate();
  worker = null;
  finishRun({ ok: false, stdout: "", error: reason });
  // Python was fine, so anyone waiting for it to load keeps waiting, on a new worker.
  if (warmPending.size > 0) restartWorker();
}

// The user pressed Stop.
function stopRun(runId) {
  if (runs.isActive(runId)) killRun(STOPPED_BY_USER);
  else runs.cancel(runId, { ok: false, stdout: "", error: STOPPED_BY_USER }); // not started yet: just drop it
}

function warm() {
  return new Promise((resolve) => {
    if (!worker) startWorker();
    const id = `warm-${nextWarmId++}`;
    warmPending.set(id, resolve);
    worker.postMessage({ type: "warm", id });
  });
}

function onWorkerMessage(data) {
  if (data.type === "started") {
    // Python is loaded and the script is now executing: start the clock.
    // (activeTimeout is 0 when the script has no time limit.)
    if (runs.isActive(data.id) && activeTimeout > 0) {
      const limit = activeTimeout;
      runTimer = setTimeout(() => killRun(overTimeLimit(limit)), limit * 1000);
    }
  } else if (data.type === "result") {
    if (warmPending.has(data.id)) {
      warmPending.get(data.id)(data.result);
      warmPending.delete(data.id);
      touch();
    } else if (runs.isActive(data.id)) {
      // A run that made Python's memory grow a lot (a very large page, say)
      // leaves it that large. The run is over, so nothing is lost by starting
      // Python afresh, and it is loaded again by the time it is next needed.
      const restart = grownTooLarge(data.heap);
      finishRun(data.result);
      if (restart) restartWorker();
    }
  } else if (data.type === "call") {
    // Python asked for something only the extension can do. Relay it to the
    // background as a message named after the service: "dom" (touch the page,
    // background -> tab) or "store" (the script's saved values).
    const { callId, service, ...request } = data;
    const reply = SERVICES.includes(service)
      ? toBackground({ ...request, type: service })
      : Promise.reject(new Error(`Unknown service: ${service}`));
    reply
      .catch((err) => ({ ok: false, error: String(err?.message ?? err) }))
      .then((result) => worker?.postMessage({ type: "call-result", callId, result }));
  }
}

// ---------- runs ----------

// Called by the queue when a run reaches the front.
async function startRun(run) {
  // Snapshot the page now, not when the run was requested, so a script queued
  // behind another one sees the changes that one made.
  let page;
  try {
    const reply = await withTimeout(
      toBackground({ type: "dom", tabId: run.tabId, op: "snapshot" }),
      SNAPSHOT_TIMEOUT_MS,
      "the page did not answer.",
    );
    if (!reply?.ok) throw new Error(reply?.error ?? "no reply from the page.");
    // Browser pages (chrome://, the Web Store, other extensions) can't be scripted.
    if (!reply.value?.html) throw new Error("this kind of page does not allow extensions.");
    page = reply.value;
  } catch (err) {
    if (runs.isActive(run.runId)) {
      finishRun({ ok: false, stdout: "", error: `PyMonkey could not run on this page: ${err.message}` });
    }
    return;
  }
  if (!runs.isActive(run.runId)) return; // stopped, or the worker crashed, while we were waiting for the page
  activeTimeout = timeoutSeconds(run.timeout);
  if (!worker) startWorker();
  worker.postMessage({ type: "run", id: run.runId, tabId: run.tabId, scriptId: run.scriptId, code: run.code, page });
}

// The run that is executing is over, one way or another.
function finishRun(result) {
  clearTimeout(runTimer);
  runTimer = null;
  runs.finishActive(result); // calls announce(), then starts the next queued run
  touch();
}

// Called by the queue with each result. The background passes it on to the
// panel. If the message gets lost, the queue still has the result for "run-status".
function announce(run, result) {
  toBackground({ type: "run-finished", runId: run.runId, meta: run.meta, result }).catch(() => {});
}

function withTimeout(promise, ms, message) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
  return Promise.race([promise, timeout]);
}

// ---------- messages from the background ----------

// Returns true if the answer will be sent later.
function onMessage(msg, sendResponse) {
  if (msg.type === "ping") {
    sendResponse({ ok: true });
  } else if (msg.type === "run") {
    // Answer at once: the result is announced later with "run-finished".
    const { runId, tabId, scriptId, code, timeout, meta } = msg;
    runs.add({ runId, tabId, scriptId, code, timeout, meta });
    sendResponse({ ok: true });
  } else if (msg.type === "stop-run") {
    stopRun(msg.runId);
    sendResponse({ ok: true });
  } else if (msg.type === "run-status") {
    sendResponse(runs.status(msg.runId));
  } else if (msg.type === "warm") {
    warm().then(sendResponse);
    return true;
  }
  return false;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen" || closing) return;
  const answerLater = onMessage(msg, sendResponse);
  // Every message counts as something happening, "ping" too. The background
  // sends that just before each real message, so the message that follows
  // always has a full idle period in hand.
  touch();
  return answerLater;
});

startWorker();
touch();
