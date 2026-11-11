// Offscreen document: owns the Pyodide web worker and keeps it warm.
// Unlike the background service worker, this page is NOT killed when idle,
// so Python stays loaded between runs.
//
// Its only jobs:
//   * pass run/warm requests from the background to the worker
//   * pass the worker's DOM requests back out (workers have no chrome.* APIs)
//   * kill the worker if a script hangs; the next request starts a new one (e.g. `while True: pass`)

const RUN_TIMEOUT_MS = 30_000; // counted from when the script actually starts

let worker = null;
let nextId = 1;
const pending = new Map(); // id -> { resolve, timer }

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
  for (const { resolve, timer } of pending.values()) {
    clearTimeout(timer);
    resolve({ ok: false, stdout: "", error: reason });
  }
  pending.clear();
}

function callWorker(message) {
  return new Promise((resolve) => {
    if (!worker) startWorker();
    const id = nextId++;
    pending.set(id, { resolve, timer: null });
    worker.postMessage({ ...message, id });
  });
}

function onWorkerMessage(data) {
  const entry = pending.get(data.id);

  if (data.type === "started") {
    // Python is loaded and the script is now executing: start the clock.
    if (entry) {
      entry.timer = setTimeout(
        () => stopWorker(`Script stopped: it ran longer than ${RUN_TIMEOUT_MS / 1000}s.`),
        RUN_TIMEOUT_MS,
      );
    }
  } else if (data.type === "result") {
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(data.id);
    entry.resolve(data.result);
  } else if (data.type === "dom") {
    // Python asked to touch the page. Relay: offscreen -> background -> tab.
    chrome.runtime
      .sendMessage({ target: "background", type: "dom", tabId: data.tabId, op: data.op, args: data.args })
      .catch((err) => ({ ok: false, error: String(err?.message ?? err) }))
      .then((result) => worker.postMessage({ type: "dom-result", callId: data.callId, result }));
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "ping") {
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "run") {
    callWorker({ type: "run", tabId: msg.tabId, code: msg.code, page: msg.page }).then(sendResponse);
    return true;
  }
  if (msg.type === "warm") {
    callWorker({ type: "warm" }).then(sendResponse);
    return true;
  }
});

startWorker();
