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

async function runInTab(tabId, code) {
  try {
    const page = await sendToTab(tabId, { type: "snapshot" });
    // Browser pages (chrome://, the Web Store, other extensions) can't be scripted.
    if (!page?.html) throw new Error("this kind of page does not allow extensions.");
    return await sendToOffscreen({ type: "run", tabId, code, page });
  } catch (err) {
    return { ok: false, stdout: "", error: `PyMonkey could not run on this page: ${err.message}` };
  }
}

async function autoRun(tabId, url) {
  const scripts = await getScripts();
  for (const script of scripts) {
    if (!script.enabled || !script.match || !urlMatches(script.match, url)) continue;
    const result = await runInTab(tabId, script.code);
    if (!result.ok) console.warn(`[PyMonkey] "${script.name}" failed on ${url}\n${result.error}`);
    // Let the side panel show the result if it happens to be open.
    chrome.runtime
      .sendMessage({ target: "panel", type: "run-finished", scriptId: script.id, name: script.name, url, result })
      .catch(() => {}); // nobody listening: fine
  }
}

// ---------- the router ----------

const handlers = {
  // content script -> a page finished loading
  "page-ready": (msg, sender) => (sender.tab ? autoRun(sender.tab.id, msg.url) : undefined),

  // panel -> "Run on this page"
  "run-in-tab": (msg) => runInTab(msg.tabId, msg.code),

  // panel -> start loading Python now so the first run is fast
  warm: () => sendToOffscreen({ type: "warm" }),

  // offscreen -> Python wants to touch the page
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
