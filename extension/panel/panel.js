// Side panel: the script editor.
// Talks only to the background service worker (target: "background").

import { createEditor } from "./editor.js";
import { hasChanges, loadTabs, saveTabs, scriptFields, tabsToRestore } from "../lib/draft.js";
import { MAX_FILE_BYTES, fileNameFor, formatScriptFile, importedScript, importNotice } from "../lib/script-file.js";
import { startRun } from "../lib/run-client.js";
import { runState } from "../lib/run-state.js";
import { describeLastRun, isLastRunKey } from "../lib/last-run.js";
import { describeSites, failedFetchUrl, hasAccess, pageAccess, siteOf, sitesNeeded, sitesWithoutAccess } from "../lib/site-access.js";
import { getScripts, getLastRuns, saveScript, deleteScript, markLastRunSeen } from "../lib/storage.js";
import { timeoutSeconds } from "../lib/timeout.js";

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"), tabs: $("tabs"), list: $("script-list"), name: $("name"), match: $("match"),
  enabled: $("enabled"), timeout: $("timeout"), output: $("output"),
  run: $("run"), stop: $("stop"), save: $("save"), del: $("delete"), newBtn: $("new"),
  menuBtn: $("menu"), menu: $("menu-list"), menuSettings: $("menu-settings"),
  settings: $("settings"), settingsDone: $("settings-done"), rules: $("rules"),
  importBtn: $("import"), importFile: $("import-file"), exportBtn: $("export"), saveState: $("save-state"),
  lastRun: $("last-run"), lastRunSummary: $("last-run-summary"),
  lastRunUrl: $("last-run-url"), lastRunOutput: $("last-run-output"),
  matchAccess: $("match-access"), tabAccess: $("tab-access"), fetchAccess: $("fetch-access"),
};

const STARTER = `# \`page\` is the page you are looking at.
#   read:   page.soup is a BeautifulSoup tree  (page.select("a") etc.)
#   write:  page.set_style("h1", "color: tomato")

print(page.title)
for link in page.select("a[href]")[:10]:
    print(link.get_text(strip=True), "->", link["href"])
`;

// The open tabs. Each is a form (see lib/draft.js) plus a `key` of its own:
// { key, id, name, match, enabled, timeout, code }, id null for a script that
// was never saved. The fields show the tab in front, and every change in them
// is copied into its entry here (see rememberDraft).
let tabs = [];
let activeKey = null; // the key of the tab in front
const editorStates = new Map(); // the editor's state (text, cursor, undo) of each tab not in front
const activeTab = () => tabs.find((tab) => tab.key === activeKey);
let currentId = null; // id of the script in front, or null for an unsaved one
let running = false; // true from the moment Run is pressed until its result is shown
let currentRun = null; // that run, once it has been started (it has the stop() to end it)
let shownLastRun = null; // which last run the panel is showing ("<script id>:<time>")
let savedScripts = []; // the saved scripts, as of the last refreshList()
let failedIds = new Set(); // the scripts whose last automatic run failed, as of the last refreshList()
let discardWarned = null; // the key of the tab the user was told would lose unsaved work if closed

const editor = createEditor({ parent: $("code"), onChange: rememberDraft });

const toBackground = (message) => chrome.runtime.sendMessage({ ...message, target: "background" });

// The status line in the header. `state` is one of loading, ready, running,
// stopped, error; panel.css draws the dot that goes with each.
function setStatus(state, text) {
  els.status.dataset.state = state; // data-state="..." in the HTML
  els.status.textContent = text;
}

// Show a result ({ ok, stdout, error }) in the output pane.
function showOutput(result) {
  const text = [result.stdout, result.error].filter(Boolean).join("\n");
  els.output.textContent = text || "(no output)";
  els.output.classList.toggle("error", !result.ok);
  els.output.dataset.state = runState(result); // done, stopped or error
  showFetchAccess(result);
}

// ---------- site access ----------
//
// PyMonkey may only touch sites the user has allowed (see lib/site-access.js).
// Three lines in the panel say when that is in the way, and what to do:
//   under the URL pattern   the script cannot run automatically: its site is not allowed
//   under the Run button    the page in this tab is not allowed
//   under that              the last run asked for an address on a site that is not allowed

let sitesToAllow = []; // the sites the script in the fields needs and does not have
let fetchSite = null; // the site the last run could not fetch from, if PyMonkey is not allowed on it

// Show a notice with these words, or hide it if there are none.
function showNotice(el, text) {
  el.hidden = !text;
  el.querySelector("span").textContent = text ?? "";
}

// Ask Chrome to allow PyMonkey on these sites for good. Chrome puts the
// question to the user, and only in answer to a click or a key press, so this
// must be called first thing in the handler of one. For sites that are
// allowed already nothing is shown. Resolves to true if all are allowed now.
function askFor(sites) {
  if (sites.length === 0) return Promise.resolve(true);
  return chrome.permissions.request({ origins: sites }).catch((err) => {
    // Chrome refused to even ask, e.g. for a site it gives to no extension.
    showOutput({ ok: false, stdout: "", error: `Chrome cannot give access to ${describeSites(sites)}: ${err.message}` });
    return false;
  });
}

async function showMatchAccess() {
  const sites = sitesNeeded(readForm());
  const lacking = await sitesWithoutAccess(sites);
  if (String(sites) !== String(sitesNeeded(readForm()))) return; // the fields changed while we were asking
  sitesToAllow = lacking;
  showNotice(
    els.matchAccess,
    lacking.length ? `No access to ${describeSites(lacking)} yet, so this script will not run there by itself.` : null,
  );
}

const TAB_NOTICES = {
  "no-access": "PyMonkey has not been allowed on the page in this tab. Click the PyMonkey icon in the toolbar to allow it.",
  unsupported: "Scripts cannot run on the kind of page that is in this tab.",
};

async function showTabAccess() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  showNotice(els.tabAccess, TAB_NOTICES[pageAccess(tab)] ?? null);
}

// With a result: look whether the run failed on an address it could not
// fetch. Without: look again at the one found last time.
async function showFetchAccess(result) {
  if (result) {
    const url = result.ok ? null : failedFetchUrl(result.error);
    fetchSite = url ? siteOf(url) : null;
  }
  const site = fetchSite;
  const allowed = site ? await hasAccess(site) : true;
  if (site !== fetchSite) return; // another run ended while we were asking
  if (allowed) fetchSite = null;
  showNotice(
    els.fetchAccess,
    fetchSite ? `The script asked for an address on ${fetchSite}, where PyMonkey has not been allowed. Allow it, then run again.` : null,
  );
}

// Something about access changed (or may have): look at everything again.
function refreshAccess() {
  showMatchAccess();
  showTabAccess();
  showFetchAccess();
  refreshList();
}

els.matchAccess.querySelector("button").addEventListener("click", () => askFor(sitesToAllow).then(refreshAccess));
els.fetchAccess.querySelector("button").addEventListener("click", () => askFor([fetchSite]).then(refreshAccess));

// The user allowed a site or took one away, here or in Chrome's settings.
chrome.permissions.onAdded.addListener(refreshAccess);
chrome.permissions.onRemoved.addListener(refreshAccess);
// Another tab came to the front, or the page in a tab changed.
chrome.tabs.onActivated.addListener(showTabAccess);
chrome.tabs.onUpdated.addListener(showTabAccess);
// The toolbar icon was clicked while the panel was open: that tab is allowed now (see background.js).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target === "panel" && msg.type === "tab-allowed") showTabAccess();
});

// The state of the panel's fields: the script as it is being edited.
function readForm() {
  return {
    id: currentId,
    name: els.name.value,
    match: els.match.value,
    enabled: els.enabled.checked,
    timeout: els.timeout.value,
    code: editor.getText(),
  };
}

// Does this tab hold anything that closing it would lose?
function hasUnsavedWork(tab = activeTab()) {
  if (tab.id) return hasChanges(tab, savedScripts.find((s) => s.id === tab.id));
  // A new script counts once something was typed into it.
  return tab.code !== STARTER || tab.name.trim() !== "" || tab.match.trim() !== "";
}

// Copy the fields into the tab in front, and keep a copy of every tab, so
// that they are still there when the panel is closed and opened again (see
// lib/draft.js). Called on every change.
function rememberDraft() {
  const tab = activeTab();
  if (!tab) return;
  Object.assign(tab, readForm());
  saveTabs({ active: activeKey, tabs }, savedScripts);
  renderTabs();
  showSaveState();
  showRules();
  if (discardWarned === activeKey) discardWarned = null; // the work changed: warn again before it is dropped
}

// Say whether what is in the fields is saved.
function showSaveState() {
  const unsaved = hasUnsavedWork();
  if (currentId) els.saveState.textContent = unsaved ? "Unsaved changes" : "Saved";
  else els.saveState.textContent = unsaved ? "Not saved" : ""; // a new script nobody typed in yet: nothing to say
}

// What a script runs on, in a few words.
function describeRules(script) {
  const match = script.match.trim();
  if (!match) return "Runs when you press Run";
  return script.enabled ? `Runs on ${match}` : `Switched off · ${match}`;
}

function showRules() {
  els.rules.textContent = describeRules(readForm());
}

// ---------- tabs ----------

const blankScript = () => ({ id: null, name: "", match: "", enabled: true, timeout: 30, code: STARTER });

// Draw the tab bar from `tabs`. Each tab is a button that brings it to the
// front and one that closes it. Only the tab in front can be reached with
// Tab; the arrow keys move between tabs (the usual way with a tab list).
function renderTabs() {
  els.tabs.replaceChildren(
    ...tabs.map((tab) => {
      const active = tab.key === activeKey;
      const name = tab.name.trim() || "Untitled";
      const dirty = hasUnsavedWork(tab);
      const failed = tab.id != null && failedIds.has(tab.id);
      const el = document.createElement("div");
      el.className = "tab";
      el.classList.toggle("active", active);
      el.classList.toggle("dirty", dirty);
      el.classList.toggle("failed", failed);
      el.dataset.key = tab.key;
      el.setAttribute("role", "presentation");
      const label = document.createElement("button");
      label.className = "tab-label";
      label.setAttribute("role", "tab");
      label.setAttribute("aria-selected", String(active));
      label.setAttribute("aria-controls", "code");
      label.tabIndex = active ? 0 : -1;
      label.textContent = name;
      label.title = name + (dirty ? " (not saved)" : "") + (failed ? " (last automatic run failed)" : "");
      const close = document.createElement("button");
      close.className = "tab-close";
      close.tabIndex = active ? 0 : -1;
      close.setAttribute("aria-label", `Close ${name}`);
      close.title = dirty ? "Not saved. Close" : "Close";
      el.append(label, close);
      return el;
    }),
  );
}

// Bring the tab with this key to the front.
function showTab(key) {
  const leaving = activeTab();
  if (leaving && leaving.key !== key) {
    Object.assign(leaving, readForm());
    editorStates.set(leaving.key, editor.getState());
  }
  activeKey = key;
  const tab = activeTab();
  currentId = tab.id ?? null;
  els.name.value = tab.name ?? "";
  els.match.value = tab.match ?? "";
  els.enabled.checked = tab.enabled ?? true;
  els.timeout.value = timeoutSeconds(tab.timeout);
  if (editorStates.has(key)) editor.setState(editorStates.get(key));
  else editor.setText(tab.code ?? STARTER);
  editorStates.delete(key); // the editor holds it now
  rememberDraft();
  els.tabs.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  refreshListMarks();
  showLastRun();
  showMatchAccess();
}

// Open a script (or with null a new one) in a tab of its own and bring it to
// the front. A saved script that is open already just comes to the front.
function openTab(script) {
  const open = script?.id != null && tabs.find((tab) => tab.id === script.id);
  if (open) return showTab(open.key);
  const { id = null, ...fields } = script ?? blankScript();
  const tab = { ...blankScript(), ...fields, id, timeout: timeoutSeconds(fields.timeout), key: crypto.randomUUID() };
  // Next to the tab in front, as a code editor does.
  tabs.splice(tabs.indexOf(activeTab()) + 1, 0, tab);
  showTab(tab.key);
}

// Close a tab. One with unsaved work is not closed at once: the first time
// the panel says what would be lost, asked again it goes ahead. With `force`
// it goes at once (it has been deleted). There is always a tab: closing the
// last one opens a new script.
function closeTab(key, { force = false } = {}) {
  const index = tabs.findIndex((tab) => tab.key === key);
  if (index < 0) return;
  const tab = key === activeKey ? { ...tabs[index], ...readForm() } : tabs[index];
  if (!force && hasUnsavedWork(tab) && discardWarned !== key) {
    discardWarned = key;
    const name = tab.name.trim() || "Untitled";
    els.output.textContent = `${name} is not saved. Save it first, or close it again to drop it.`;
    els.output.classList.remove("error");
    els.output.dataset.state = "done";
    return;
  }
  if (discardWarned === key) discardWarned = null;
  tabs.splice(index, 1);
  editorStates.delete(key);
  if (key !== activeKey) {
    saveTabs({ active: activeKey, tabs }, savedScripts);
    renderTabs();
    return;
  }
  activeKey = null; // nothing to save from the tab that is going
  if (tabs.length === 0) openTab(null);
  else showTab(tabs[Math.min(index, tabs.length - 1)].key);
}

els.tabs.addEventListener("click", (event) => {
  const key = event.target.closest(".tab")?.dataset.key;
  if (!key) return;
  if (event.target.closest(".tab-close")) closeTab(key);
  else if (key !== activeKey) showTab(key);
});
// The middle mouse button closes a tab, as in a browser.
els.tabs.addEventListener("auxclick", (event) => {
  const key = event.target.closest(".tab")?.dataset.key;
  if (key && event.button === 1) closeTab(key);
});
// A double click on a tab opens the run settings, at the name.
els.tabs.addEventListener("dblclick", (event) => {
  if (event.target.closest(".tab-label")) showSettings(true, els.name);
});
// Arrow keys, Home and End move between tabs and bring the one reached to the front.
els.tabs.addEventListener("keydown", (event) => {
  if (!event.target.closest(".tab-label")) return;
  const index = tabs.findIndex((tab) => tab.key === activeKey);
  const to = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: tabs.length - 1 }[event.key];
  if (to === undefined) return;
  event.preventDefault();
  const tab = tabs[(to + tabs.length) % tabs.length];
  showTab(tab.key);
  els.tabs.querySelector(".tab.active .tab-label").focus();
});

// ---------- the run settings ----------

// Open (or close) the run settings. `focus` is the field to put the keyboard in.
function showSettings(open, focus) {
  els.settings.hidden = !open;
  els.rules.setAttribute("aria-expanded", String(open));
  if (open) focus?.focus();
}

els.rules.addEventListener("click", () => showSettings(els.settings.hidden, els.name));
els.settingsDone.addEventListener("click", () => {
  showSettings(false);
  els.rules.focus();
});

// ---------- the menu ----------

const menuItems = () => [...els.menu.querySelectorAll("[role=menuitem]")];

function openMenu({ focusFirst = false } = {}) {
  els.menu.hidden = false;
  els.menuBtn.setAttribute("aria-expanded", "true");
  if (focusFirst) menuItems()[0].focus();
}

function closeMenu({ returnFocus = false } = {}) {
  if (els.menu.hidden) return;
  els.menu.hidden = true;
  els.menuBtn.setAttribute("aria-expanded", "false");
  if (returnFocus) els.menuBtn.focus();
}

// A click opens it; opened from the keyboard, the keyboard goes into it.
els.menuBtn.addEventListener("click", (event) => {
  if (els.menu.hidden) openMenu({ focusFirst: event.detail === 0 });
  else closeMenu();
});
// Up and Down go through the items, Escape closes, Tab leaves.
els.menu.addEventListener("keydown", (event) => {
  const items = menuItems();
  const at = items.indexOf(document.activeElement);
  const to = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
  if (to !== undefined) {
    event.preventDefault();
    items[(to + items.length) % items.length].focus();
  } else if (event.key === "Escape") {
    closeMenu({ returnFocus: true });
  } else if (event.key === "Tab") {
    closeMenu();
  }
});
// Choosing an item closes the menu.
els.menu.addEventListener("click", (event) => {
  if (event.target.closest("[role=menuitem]")) closeMenu();
});
// A click anywhere else closes it too.
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest(".menu")) closeMenu();
});

els.menuSettings.addEventListener("click", () => showSettings(true, els.name));

// A saved script picked from the list opens in a tab.
els.list.addEventListener("click", (event) => {
  const id = event.target.closest("[data-id]")?.dataset.id;
  const script = savedScripts.find((s) => s.id === id);
  if (script) openTab(script);
});

// Show the last automatic run of the script being edited, if it has one.
// Scripts auto-run whether or not the panel is open; this is where to find out how it went.
async function showLastRun() {
  const id = currentId;
  const lastRun = id ? (await getLastRuns())[id] : null;
  if (id !== currentId) return; // another script was picked while we were reading
  els.lastRun.hidden = !lastRun;
  if (!lastRun) return;
  els.lastRunSummary.textContent = describeLastRun(lastRun);
  els.lastRunUrl.textContent = lastRun.url;
  els.lastRunOutput.textContent = [lastRun.stdout, lastRun.error].filter(Boolean).join("\n") || "(no output)";
  els.lastRun.classList.toggle("error", !lastRun.ok);
  // A run we were not showing yet: unfold it if it failed, so it cannot be missed.
  // (Only then, so that folding it by hand sticks.)
  if (shownLastRun !== `${id}:${lastRun.time}`) els.lastRun.open = !lastRun.ok;
  shownLastRun = `${id}:${lastRun.time}`;
  // The user has now seen this failure: the toolbar badge can stop counting it.
  if (!lastRun.ok) await markLastRunSeen(id);
}

// Read the saved scripts again, and fill the menu's list with them: each
// with what it runs on, and marked if its last automatic run failed or if it
// cannot run automatically because its site is not allowed.
async function refreshList() {
  const scripts = await getScripts();
  const lastRuns = await getLastRuns();
  savedScripts = scripts;
  failedIds = new Set(scripts.filter((s) => lastRuns[s.id]?.ok === false).map((s) => s.id));
  const lacking = await Promise.all(scripts.map((s) => sitesWithoutAccess(sitesNeeded(s))));
  const noAccess = new Set(scripts.filter((_, i) => lacking[i].length > 0).map((s) => s.id));
  const label = (s) =>
    (s.name || "Untitled") + (failedIds.has(s.id) ? " (failed)" : "") + (noAccess.has(s.id) ? " (no access)" : "");
  const items = scripts.map((s) => {
    const item = document.createElement("button");
    item.setAttribute("role", "menuitem");
    item.dataset.id = s.id;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = label(s);
    const detail = document.createElement("span");
    detail.className = "detail";
    detail.textContent = describeRules({ match: "", enabled: true, ...s });
    item.append(name, detail);
    return item;
  });
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No saved scripts yet.";
    items.push(empty);
  }
  els.list.replaceChildren(...items);
  refreshListMarks();
  if (activeTab()) renderTabs(); // which tabs are saved, or failed, may have changed
  return scripts;
}

// In the menu's list, mark the script that is in front.
function refreshListMarks() {
  for (const item of els.list.querySelectorAll("[data-id]")) {
    item.setAttribute("aria-current", String(item.dataset.id === currentId));
  }
}

// ---------- buttons ----------

// While a script runs, the Run button is replaced by Stop. If the keyboard
// was on the button that goes away, it moves to the one that takes its place.
function swapRunButton(showStop) {
  const [from, to] = showStop ? [els.run, els.stop] : [els.stop, els.run];
  const hadFocus = document.activeElement === from;
  from.hidden = true;
  to.hidden = false;
  if (hadFocus) to.focus();
}

// Run the code in the editor on the page the user is looking at.
async function run() {
  if (running) return; // one at a time
  running = true;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  let result = { ok: false, stdout: "", error: "No active tab found." };
  if (tab) {
    // The run is started before Stop is shown, so that Stop always has a run to stop.
    currentRun = startRun(tab.id, editor.getText(), {
      timeout: timeoutSeconds(els.timeout.value),
      scriptId: currentId, // null for an unsaved script, which has no page.store
    });
    swapRunButton(true);
    setStatus("running", "Running…");
    els.output.classList.remove("error");
    els.output.dataset.state = "running";
    els.output.textContent = "Running…";
    // `result` always arrives, even if the run was stopped or lost (see lib/run-client.js).
    result = await currentRun.result;
    currentRun = null;
  }

  showOutput(result);
  const state = runState(result);
  if (state === "done") setStatus("ready", "Ready");
  else if (state === "stopped") setStatus("stopped", "Stopped");
  else setStatus("error", "Script failed");
  if (els.run.hidden) swapRunButton(false);
  running = false;
  showTabAccess(); // if the run failed for want of access, say so where it stays in view
}

async function save() {
  const form = readForm();
  // A script that is to run automatically needs its site allowed. Chrome asks
  // the user now, unless the site is allowed already (see askFor: it has to be
  // the first thing done). The script is saved whatever the answer, and
  // without waiting for it.
  const asked = askFor(sitesNeeded(form));
  const tab = activeTab();
  const saved = await saveScript({ id: currentId ?? undefined, ...scriptFields(form) });
  tab.id = saved.id;
  if (tab === activeTab()) currentId = saved.id;
  await refreshList();
  rememberDraft(); // the draft now belongs to a saved script, and has no changes
  await showLastRun();
  asked.then(refreshAccess);
}

els.run.addEventListener("click", run);
els.stop.addEventListener("click", () => currentRun?.stop());
els.save.addEventListener("click", save);

// Keyboard shortcuts, wherever in the panel the keyboard is: Ctrl+Enter runs
// and Ctrl+S saves (Cmd instead of Ctrl on a Mac, though either works).
// The `true` at the end asks to hear about a key before the element that has
// the focus does. The editor has its own use for Ctrl+Enter, and Chrome for
// Ctrl+S ("save this page"); preventDefault and stopPropagation keep both from happening.
window.addEventListener(
  "keydown",
  (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    const action = event.key === "Enter" ? run : event.key.toLowerCase() === "s" ? save : null;
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) action(); // a key held down counts once
  },
  true,
);

// Show the shortcuts on the buttons, in the words of the keyboard at hand.
const mod = /Mac/.test(navigator.platform) ? "⌘" : "Ctrl+";
els.run.querySelector("kbd").textContent = `${mod}↵`;
els.save.querySelector("kbd").textContent = `${mod}S`;
els.run.title = `Run the script on the page in this tab (${mod}Enter)`;
els.save.title = `Save the script (${mod}S)`;

// Delete the script in front, and close its tab. (One that was never saved is just closed.)
els.del.addEventListener("click", async () => {
  const key = activeKey;
  if (currentId) await deleteScript(currentId);
  closeTab(key, { force: true });
  await refreshList();
});

els.newBtn.addEventListener("click", () => openTab(null));

// Export: the script as it is in the fields now, saved as a .py file. The
// header comment on top of the file is described in lib/script-file.js.
els.exportBtn.addEventListener("click", () => {
  const script = scriptFields(readForm());
  // The way to make a browser save text as a file: wrap it in a Blob (a file
  // in memory), give that an address, and click a download link to it.
  const url = URL.createObjectURL(new Blob([formatScriptFile(script)], { type: "text/x-python" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileNameFor(script.name);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); // free the memory once the download has started
});

// Import: every chosen .py file becomes a saved script.
els.importBtn.addEventListener("click", () => els.importFile.click());
els.importFile.addEventListener("change", async () => {
  const notices = [];
  let failed = false;
  const imported = [];
  for (const file of els.importFile.files) {
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error("it is too large to be a script");
      const script = importedScript(await file.text(), file.name);
      imported.push(await saveScript(script));
      notices.push(importNotice(script, file.name));
    } catch (error) {
      failed = true;
      notices.push(`Could not import ${file.name}: ${error.message}.`);
    }
  }
  els.importFile.value = ""; // so that choosing the same file again counts as a change
  // Each imported script opens in a tab of its own, ready to be read; the last one is in front.
  await refreshList();
  for (const script of imported) openTab(script);
  els.output.textContent = notices.join("\n");
  els.output.classList.toggle("error", failed);
  els.output.dataset.state = failed ? "error" : "done";
});

// Typing in any field changes the draft. (The editor reports its own changes: see createEditor above.)
for (const field of [els.name, els.match, els.enabled, els.timeout]) field.addEventListener("input", rememberDraft);
for (const field of [els.match, els.enabled]) field.addEventListener("input", showMatchAccess);

// Results of scripts that auto-ran while the panel is open.
// (Runs started with the Run button are handled by startRun above.)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "panel" || msg.type !== "run-finished" || !msg.meta?.auto) return;
  showOutput({ ...msg.result, stdout: `[auto-run: ${msg.meta.name}]\n${msg.result.stdout}` });
});

// A script auto-ran (its last run was stored), or one was marked as seen.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const keys = Object.keys(changes);
  if (keys.includes("scripts")) refreshList(); // saved or deleted, here or by another panel
  if (!keys.some(isLastRunKey)) return;
  refreshList();
  showLastRun();
});

// ---------- startup ----------

// Open the way the panel was left: with the tabs that were open, including
// text that was never saved, and the same one in front.
refreshList().then((scripts) => {
  const restored = tabsToRestore(loadTabs(), scripts);
  tabs = restored.tabs.map((tab) => ({ ...blankScript(), ...tab })); // a script saved before a field existed gets its default
  if (tabs.length === 0) openTab(null);
  else showTab(restored.active);
});

showTabAccess();

// Warm start: begin loading Python as soon as the panel opens, so the cost is
// already paid by the time the user clicks Run.
toBackground({ type: "warm" })
  .then((res) => {
    if (res?.ok) {
      // (A run that was started in the meantime has put its own status up.)
      if (els.status.dataset.state === "loading") setStatus("ready", "Ready");
      return;
    }
    setStatus("error", "Python failed to load");
    showOutput({ ok: false, error: res?.error ?? "Unknown error. Did you run `npm run setup`?" });
  })
  .catch((err) => {
    setStatus("error", "Python failed to load");
    showOutput({ ok: false, error: String(err?.message ?? err) });
  });
