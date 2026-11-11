// Offscreen document: owns the Pyodide web worker and keeps it warm.
// Unlike the background service worker, this page is NOT killed when idle,
// so Python stays loaded between runs. For the same reason it is the place
// that remembers which runs are queued, running and finished.
//
// Its jobs:
//   * queue run requests from the background and feed them to the worker one at a time
//   * pass the worker's DOM requests back out (workers have no chrome.* APIs)
//   * kill the worker if a script hangs; the next request starts a new one (e.g. `while True: pass`)
//   * announce each result to the background, and keep it for anyone who asks later

import { createRunQueue } from "../lib/run-queue.js";

const RUN_TIMEOUT_MS = 30_000; // counted from when the script actually starts
const SNAPSHOT_TIMEOUT_MS = 15_000;

let worker = null;
let runTimer = null; // timeout of the run that is executing
let nextWarmId = 1;
const warmPending = new Map(); // id -> resolve

const toBackground = (message) => chrome.runtime.sendMessage({ ...message, target: "background" });

const runs = createRunQueue({ start: startRun, onFinished: announce });

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
    stopWorker(reason);
  };
}

// Stop the worker and fail everything in flight. The next request starts a fresh one.
function stopWorker(reason) {
  worker?.terminate();
  worker = null;
  const failed = { ok: false, stdout: "", error: reason };
  for (const resolve of warmPending.values()) resolve(failed);
  warmPending.clear();
  finishRun(failed);
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
    if (runs.isActive(data.id)) {
      runTimer = setTimeout(
        () => stopWorker(`Script stopped: it ran longer than ${RUN_TIMEOUT_MS / 1000}s.`),
        RUN_TIMEOUT_MS,
      );
    }
  } else if (data.type === "result") {
    if (warmPending.has(data.id)) {
      warmPending.get(data.id)(data.result);
      warmPending.delete(data.id);
    } else if (runs.isActive(data.id)) {
      finishRun(data.result);
    }
  } else if (data.type === "dom") {
    // Python asked to touch the page. Relay: offscreen -> background -> tab.
    toBackground({ type: "dom", tabId: data.tabId, op: data.op, args: data.args })
      .catch((err) => ({ ok: false, error: String(err?.message ?? err) }))
      .then((result) => worker?.postMessage({ type: "dom-result", callId: data.callId, result }));
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
  if (!runs.isActive(run.runId)) return; // the worker crashed while we were waiting for the page
  if (!worker) startWorker();
  worker.postMessage({ type: "run", id: run.runId, tabId: run.tabId, code: run.code, page });
}

// The run that is executing is over, one way or another.
function finishRun(result) {
  clearTimeout(runTimer);
  runTimer = null;
  runs.finishActive(result); // calls announce(), then starts the next queued run
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "ping") {
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "run") {
    // Answer at once: the result is announced later with "run-finished".
    runs.add({ runId: msg.runId, tabId: msg.tabId, code: msg.code, meta: msg.meta });
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "run-status") {
    sendResponse(runs.status(msg.runId));
    return;
  }
  if (msg.type === "warm") {
    warm().then(sendResponse);
    return true;
  }
});

startWorker();
