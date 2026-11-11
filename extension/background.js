// Background service worker: a message ROUTER. It holds no state.
// Chrome kills it after ~30s idle and wipes its globals, so nothing important
// may live here -- Python lives in the offscreen document instead.
//
//   content script  <-- chrome.tabs.sendMessage -->  background  <-- chrome.runtime.sendMessage -->  offscreen doc
//   (real page DOM)                                  (this file)                                     (Pyodide worker)
//
// Every message carries a `target` so each context can ignore the others' mail.

import { countUnseenFailures, isLastRunKey, makeLastRun } from "./lib/last-run.js";
import { urlMatches } from "./lib/match.js";
import { NO_ACCESS_REASONS, hasAccess, pageAccess, siteOf } from "./lib/site-access.js";
import { getLastRuns, getScripts, saveLastRun, scriptStoreCall } from "./lib/storage.js";

const OFFSCREEN_URL = "offscreen/offscreen.html";

// ---------- the toolbar icon, and where PyMonkey may run ----------
//
// PyMonkey is installed with access to no site (see lib/site-access.js).
// Clicking the toolbar icon does two things: it opens the editor side panel,
// and it makes Chrome allow PyMonkey on the page in that tab ("activeTab" in
// the manifest), which is what lets "Run on this page" work there.
//
// Chrome can open the panel on a click by itself (openPanelOnActionClick), but
// a click it handles that way does not allow the tab. A click handled here does.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(console.error);

chrome.action.onClicked.addListener((tab) => {
  // This must be the first thing that happens, with nothing awaited before
  // it: Chrome opens a panel only in direct answer to a click.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
  // If the panel was open already, it needs telling that this tab is allowed now.
  chrome.runtime.sendMessage({ target: "panel", type: "tab-allowed", tabId: tab.id }).catch(() => {}); // not open yet: fine
});

// The content script is not listed in the manifest, because that would take
// access to every site at install time. It is registered here instead, for
// every site, and Chrome puts it only into pages of sites the user has allowed
// for good. When a site is allowed or taken away, Chrome follows by itself.
// Chrome remembers the registration until the extension is updated.
const CONTENT_SCRIPT = { id: "content", js: ["content.js"], matches: ["<all_urls>"], runAt: "document_idle" };

async function registerContentScript() {
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT.id] });
  if (registered.length === 0) await chrome.scripting.registerContentScripts([CONTENT_SCRIPT]);
}
// onInstalled also fires after an update, and when the extension is reloaded at chrome://extensions.
chrome.runtime.onInstalled.addListener(() => registerContentScript().catch(console.error));
chrome.runtime.onStartup.addListener(() => registerContentScript().catch(console.error));

// ---------- offscreen document (where Python runs) ----------

// The offscreen document is not always there: it closes itself when nobody
// has asked for Python for a few minutes, to give its memory back (see
// lib/memory.js). So every message to it goes through sendToOffscreen, which
// opens the document first if need be.

let creatingOffscreen = null;

async function ensureOffscreen() {
  let problem = null;
  // Up to 5 seconds. The document can exist a moment before its script is
  // listening, and a document that is closing still exists for a moment but
  // no longer answers. So: look, create it if there is none, and wait for a
  // reply to a ping, so that the real message is never sent into the void.
  for (let attempt = 0; attempt < 100; attempt++) {
    const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (existing.length === 0) {
      // Two callers at once must not both call createDocument (only one doc is allowed).
      creatingOffscreen ??= chrome.offscreen
        .createDocument({
          url: OFFSCREEN_URL,
          reasons: ["WORKERS"],
          justification: "Runs the Python (Pyodide/WebAssembly) runtime in a web worker.",
        })
        .catch((err) => (problem = err)) // tried again on the next round
        .finally(() => (creatingOffscreen = null));
      await creatingOffscreen;
    }
    const reply = await chrome.runtime.sendMessage({ target: "offscreen", type: "ping" }).catch(() => null);
    if (reply?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the Python runtime page did not start${problem ? ` (${problem.message})` : ""}.`);
}

async function sendToOffscreen(message) {
  await ensureOffscreen();
  const send = () => chrome.runtime.sendMessage({ ...message, target: "offscreen" });
  const reply = await send().catch(() => undefined);
  if (reply !== undefined) return reply;
  // No answer: the document closed itself between the ping and this message.
  // It did nothing with the message, so it is safe to send it again, to a new document.
  await ensureOffscreen();
  return send();
}

// ---------- talking to a tab ----------

async function sendToTab(tabId, message) {
  const payload = { ...message, target: "content" };
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    // No content script there. That is the normal case for "Run on this page":
    // the site is not one the user allowed for good, only this tab is, by a
    // click on the toolbar icon. (It also happens on an allowed site, in a tab
    // that was open before PyMonkey was installed.) Put the script in and try
    // once more, or say why that cannot be done.
    const access = pageAccess(await chrome.tabs.get(tabId).catch(() => undefined));
    if (access !== "ok") throw new Error(NO_ACCESS_REASONS[access]);
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
//   (and "stop-run", panel -> background -> offscreen, if the user presses Stop)
//
// The offscreen document remembers recent results, so step 3 recovers a
// "run-finished" that nobody heard, and reports a run that no longer exists
// as lost instead of leaving the panel waiting (see lib/run-client.js).
//
// Everything known about a run (its id, which script, which page) travels in
// the messages as `runId` and `meta` and is kept by the offscreen document.
// Nothing about it is stored here.

// `timeout` is the script's time limit in seconds (see lib/timeout.js).
// `scriptId` is the saved script the code belongs to, if any: it decides whose
// `page.store` the run reads and writes.
async function startRun({ tabId, scriptId, code, timeout, runId, meta = {} }) {
  try {
    return await sendToOffscreen({ type: "run", runId, tabId, scriptId, code, timeout, meta });
  } catch (err) {
    return { ok: false, error: `PyMonkey could not start the script: ${err.message}` };
  }
}

async function runFinished({ runId, meta, result }) {
  if (meta?.auto) {
    // Keep it as the script's last run, so it can be read in the panel later
    // (see "last runs and the toolbar badge" below).
    if (!result.ok) console.warn(`[PyMonkey] "${meta.name}" failed on ${meta.url}\n${result.error}`);
    await saveLastRun(meta.scriptId, makeLastRun(meta, result)).catch(console.error);
  }
  // Let the side panel show the result if it happens to be open.
  chrome.runtime
    .sendMessage({ target: "panel", type: "run-finished", runId, meta, result })
    .catch(() => {}); // nobody listening: fine
}

async function autoRun(tabId, url) {
  // Scripts start by themselves only on sites the user has allowed for good.
  // Chrome does not load content.js anywhere else, so "page-ready" normally
  // comes from such a site. The exception is a page where a script was just
  // run by hand, in a tab allowed by the toolbar icon (see sendToTab above):
  // being allowed to run one script there once is not being allowed to start others.
  const site = siteOf(url);
  if (!site || !(await hasAccess(site))) return;
  const scripts = await getScripts();
  for (const script of scripts) {
    if (!script.enabled || !script.match || !urlMatches(script.match, url)) continue;
    // Matching scripts are queued in this order; the offscreen document runs them one at a time.
    const runId = crypto.randomUUID();
    const meta = { auto: true, scriptId: script.id, name: script.name, url };
    const started = await startRun({ tabId, scriptId: script.id, code: script.code, timeout: script.timeout, runId, meta });
    if (!started?.ok) runFinished({ runId, meta, result: { ok: false, stdout: "", error: started?.error } });
  }
}

// ---------- last runs and the toolbar badge ----------
//
// Scripts auto-run while the panel is closed, so a failure must be visible
// somewhere else: the toolbar icon shows how many scripts failed on their last
// automatic run and have not been looked at in the panel since.
//
// The number is never kept here. It is counted from storage every time the
// stored data changes (a run was recorded, the panel marked one as seen, a
// script was deleted), which also wakes this worker up if it was stopped.

async function updateBadge() {
  const failed = countUnseenFailures(Object.values(await getLastRuns()));
  await chrome.action.setBadgeBackgroundColor({ color: "#b3261e" });
  await chrome.action.setBadgeText({ text: failed ? String(failed) : "" }); // "" hides the badge
  await chrome.action.setTitle({
    title: failed
      ? `PyMonkey: ${failed} ${failed === 1 ? "script" : "scripts"} failed on the last automatic run. Open to see why.`
      : "Open PyMonkey",
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  // Only last runs and the list of scripts matter here, not what scripts keep in page.store.
  const relevant = Object.keys(changes).some((key) => key === "scripts" || isLastRunKey(key));
  if (area === "local" && relevant) updateBadge().catch(console.error);
});
// The badge is not kept across a browser restart or an extension update.
chrome.runtime.onStartup.addListener(() => updateBadge().catch(console.error));
chrome.runtime.onInstalled.addListener(() => updateBadge().catch(console.error));

// ---------- the router ----------

const handlers = {
  // content script -> a page finished loading
  "page-ready": (msg, sender) => (sender.tab ? autoRun(sender.tab.id, msg.url) : undefined),

  // panel -> "Run on this page" (answers as soon as the run is queued)
  "run-in-tab": (msg) => startRun(msg),

  // panel -> the Stop button
  "stop-run": (msg) => sendToOffscreen({ type: "stop-run", runId: msg.runId }),

  // panel -> is this run queued, running, done or unknown?
  "run-status": (msg) => sendToOffscreen({ type: "run-status", runId: msg.runId }),

  // offscreen -> a run is over
  "run-finished": (msg) => runFinished(msg),

  // panel -> start loading Python now so the first run is fast
  warm: () => sendToOffscreen({ type: "warm" }),

  // offscreen -> Python wants to touch the page, or needs a snapshot of it
  dom: (msg) => sendToTab(msg.tabId, { type: "dom", op: msg.op, args: msg.args }),

  // offscreen -> Python wants to read or change what the script saved (page.store)
  store: (msg) => scriptStoreCall(msg.scriptId, msg.op, msg.args),
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
