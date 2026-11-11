// Background service worker: a message ROUTER. It holds no state.
// Chrome kills it after ~30s idle and wipes its globals, so nothing important
// may live here -- Python lives in the offscreen document instead.
//
//   content script  <-- chrome.tabs.sendMessage -->  background  <-- chrome.runtime.sendMessage -->  offscreen doc
//   (real page DOM)                                  (this file)                                     (Pyodide worker)
//
// Every message carries a `target` so each context can ignore the others' mail.

import { urlMatches } from "./lib/match.js";
import { getScripts } from "./lib/storage.js";

const OFFSCREEN_URL = "offscreen/offscreen.html";

// Clicking the toolbar icon opens the editor side panel.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// ---------- offscreen document (where Python runs) ----------

let creatingOffscreen = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length === 0) {
    // Two callers at once must not both call createDocument (only one doc is allowed).
    creatingOffscreen ??= chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["WORKERS"],
        justification: "Runs the Python (Pyodide/WebAssembly) runtime in a web worker.",
      })
      .finally(() => (creatingOffscreen = null));
    await creatingOffscreen;
  }
  // The document can exist a moment before its script is listening. Wait for a
  // reply to a ping so the real message is never sent into the void.
  for (let attempt = 0; attempt < 100; attempt++) {
    const reply = await chrome.runtime.sendMessage({ target: "offscreen", type: "ping" }).catch(() => null);
    if (reply?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the Python runtime page did not start.");
}

async function sendToOffscreen(message) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

// ---------- talking to a tab ----------

async function sendToTab(tabId, message) {
  const payload = { ...message, target: "content" };
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    // No content script there yet (tab was open before PyMonkey was installed
    // or reloaded). Inject it and try once more.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tabId, payload);
  }
}

// ---------- running a script ----------
//
// A script can outlive this service worker: Chrome stops it after ~30s idle,
// and after 5 minutes on a single request no matter what. A reply that is
// still pending at that moment is dropped. So a run is NOT one request that
// waits for its answer. It is three short messages:
//
//   1. start   panel -> background -> offscreen       answered at once with { ok: true }
//   2. finish  offscreen -> background -> panel       "run-finished", a new message that
//                                                     wakes this worker up if it was stopped
//   3. check   panel -> background -> offscreen       "run-status", asked every few seconds
//
// The offscreen document remembers recent results, so step 3 recovers a
// "run-finished" that nobody heard, and reports a run that no longer exists
// as lost instead of leaving the panel waiting (see lib/run-client.js).
//
// Everything known about a run (its id, which script, which page) travels in
// the messages as `runId` and `meta` and is kept by the offscreen document.
// Nothing about it is stored here.

async function startRun(tabId, code, runId, meta = {}) {
  try {
    return await sendToOffscreen({ type: "run", runId, tabId, code, meta });
  } catch (err) {
    return { ok: false, error: `PyMonkey could not start the script: ${err.message}` };
  }
}

function runFinished({ runId, meta, result }) {
  if (meta?.auto && !result.ok) console.warn(`[PyMonkey] "${meta.name}" failed on ${meta.url}\n${result.error}`);
  // Let the side panel show the result if it happens to be open.
  chrome.runtime
    .sendMessage({ target: "panel", type: "run-finished", runId, meta, result })
    .catch(() => {}); // nobody listening: fine
}

async function autoRun(tabId, url) {
  const scripts = await getScripts();
  for (const script of scripts) {
    if (!script.enabled || !script.match || !urlMatches(script.match, url)) continue;
    // Matching scripts are queued in this order; the offscreen document runs them one at a time.
    const runId = crypto.randomUUID();
    const meta = { auto: true, scriptId: script.id, name: script.name, url };
    const started = await startRun(tabId, script.code, runId, meta);
    if (!started?.ok) runFinished({ runId, meta, result: { ok: false, stdout: "", error: started?.error } });
  }
}

// ---------- the router ----------

const handlers = {
  // content script -> a page finished loading
  "page-ready": (msg, sender) => (sender.tab ? autoRun(sender.tab.id, msg.url) : undefined),

  // panel -> "Run on this page" (answers as soon as the run is queued)
  "run-in-tab": (msg) => startRun(msg.tabId, msg.code, msg.runId),

  // panel -> is this run queued, running, done or unknown?
  "run-status": (msg) => sendToOffscreen({ type: "run-status", runId: msg.runId }),

  // offscreen -> a run is over
  "run-finished": (msg) => runFinished(msg),

  // panel -> start loading Python now so the first run is fast
  warm: () => sendToOffscreen({ type: "warm" }),

  // offscreen -> Python wants to touch the page, or needs a snapshot of it
  dom: (msg) => sendToTab(msg.tabId, { type: "dom", op: msg.op, args: msg.args }),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== "background") return;
  const handler = handlers[msg.type];
  if (!handler) return;

  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, stdout: "", error: String(err?.message ?? err) }));
  return true; // keep the channel open: we answer asynchronously
});
