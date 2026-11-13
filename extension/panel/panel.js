// Side panel: the script editor.
// Talks only to the background service worker (target: "background").

import { createEditor } from "./editor.js";
import { formToRestore, hasChanges, loadDraft, saveDraft, scriptFields } from "../lib/draft.js";
import { MAX_FILE_BYTES, fileNameFor, formatScriptFile, importedScript, importNotice } from "../lib/script-file.js";
import { startRun } from "../lib/run-client.js";
import { describeLastRun, isLastRunKey } from "../lib/last-run.js";
import { getScripts, getLastRuns, saveScript, deleteScript, markLastRunSeen } from "../lib/storage.js";
import { timeoutSeconds } from "../lib/timeout.js";

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"), list: $("script-list"), name: $("name"), match: $("match"),
  enabled: $("enabled"), timeout: $("timeout"), output: $("output"),
  run: $("run"), stop: $("stop"), save: $("save"), del: $("delete"), newBtn: $("new"),
  importBtn: $("import"), importFile: $("import-file"), exportBtn: $("export"),
  lastRun: $("last-run"), lastRunSummary: $("last-run-summary"),
  lastRunUrl: $("last-run-url"), lastRunOutput: $("last-run-output"),
};

const STARTER = `# \`page\` is the page you are looking at.
#   read:   page.soup is a BeautifulSoup tree  (page.select("a") etc.)
#   write:  page.set_style("h1", "color: tomato")

print(page.title)
for link in page.select("a[href]")[:10]:
    print(link.get_text(strip=True), "->", link["href"])
`;

let currentId = null; // id of the script being edited, or null for an unsaved one
let currentRun = null; // the run started with the Run button, while it is in flight
let shownLastRun = null; // which last run the panel is showing ("<script id>:<time>")
let savedScripts = []; // the saved scripts, as of the last refreshList()

const editor = createEditor({ parent: $("code"), onChange: rememberDraft });

const toBackground = (message) => chrome.runtime.sendMessage({ ...message, target: "background" });

function showOutput(result) {
  const text = [result.stdout, result.error].filter(Boolean).join("\n");
  els.output.textContent = text || "(no output)";
  els.output.classList.toggle("error", !result.ok);
}

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

// Is there anything in the fields that showing another script would lose?
function hasUnsavedWork() {
  const form = readForm();
  if (currentId) return hasChanges(form, savedScripts.find((s) => s.id === currentId));
  // A new script counts once something was typed into it.
  return form.code !== STARTER || form.name.trim() !== "" || form.match.trim() !== "";
}

// Keep a copy of the fields, so that they are still there when the panel is
// closed and opened again (see lib/draft.js). Called on every change.
function rememberDraft() {
  saveDraft(readForm(), savedScripts.find((s) => s.id === currentId));
}

// Show a script (or a restored draft, or with null a new script) in the fields.
function loadIntoEditor(script) {
  currentId = script?.id ?? null;
  els.name.value = script?.name ?? "";
  els.match.value = script?.match ?? "";
  els.enabled.checked = script?.enabled ?? true;
  els.timeout.value = timeoutSeconds(script?.timeout);
  editor.setText(script?.code ?? STARTER);
  rememberDraft();
  showLastRun();
}

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

async function refreshList(selectId = currentId) {
  const scripts = await getScripts();
  const lastRuns = await getLastRuns();
  savedScripts = scripts;
  // A script whose last automatic run failed is marked in the list.
  const label = (s) => (s.name || "Untitled") + (lastRuns[s.id]?.ok === false ? " (failed)" : "");
  els.list.replaceChildren(
    new Option("(unsaved script)", ""),
    ...scripts.map((s) => new Option(label(s), s.id)),
  );
  els.list.value = selectId ?? "";
  return scripts;
}

// ---------- buttons ----------

els.run.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return showOutput({ ok: false, error: "No active tab found." });
  // While the script runs, the Run button is replaced by Stop.
  els.run.hidden = true;
  els.stop.hidden = false;
  els.output.classList.remove("error");
  els.output.textContent = "Running…";
  currentRun = startRun(tab.id, editor.getText(), {
    timeout: timeoutSeconds(els.timeout.value),
    scriptId: currentId, // null for an unsaved script, which has no page.store
  });
  // `result` always arrives, even if the run was stopped or lost (see lib/run-client.js).
  showOutput(await currentRun.result);
  currentRun = null;
  els.stop.hidden = true;
  els.run.hidden = false;
});

els.stop.addEventListener("click", () => currentRun?.stop());

els.save.addEventListener("click", async () => {
  const saved = await saveScript({ id: currentId ?? undefined, ...scriptFields(readForm()) });
  currentId = saved.id;
  await refreshList();
  rememberDraft(); // the draft now belongs to a saved script, and has no changes
  await showLastRun();
});

els.del.addEventListener("click", async () => {
  if (currentId) await deleteScript(currentId);
  loadIntoEditor(null);
  await refreshList();
});

els.newBtn.addEventListener("click", () => {
  loadIntoEditor(null);
  els.list.value = "";
});

els.list.addEventListener("change", async () => {
  savedScripts = await getScripts();
  loadIntoEditor(savedScripts.find((s) => s.id === els.list.value) ?? null);
});

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
  let last = null; // the last script that was imported
  for (const file of els.importFile.files) {
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error("it is too large to be a script");
      const script = importedScript(await file.text(), file.name);
      last = await saveScript(script);
      notices.push(importNotice(script, file.name));
    } catch (error) {
      failed = true;
      notices.push(`Could not import ${file.name}: ${error.message}.`);
    }
  }
  els.importFile.value = ""; // so that choosing the same file again counts as a change
  if (last && hasUnsavedWork()) {
    // Do not put the imported script in place of work that would be lost.
    await refreshList();
    notices.push("The editor still shows what you were working on, which is not saved. Pick an imported script from the list to see it.");
  } else if (last) {
    await refreshList(last.id);
    loadIntoEditor(last);
  }
  els.output.textContent = notices.join("\n");
  els.output.classList.toggle("error", failed);
});

// Typing in any field changes the draft. (The editor reports its own changes: see createEditor above.)
for (const field of [els.name, els.match, els.enabled, els.timeout]) field.addEventListener("input", rememberDraft);

// Results of scripts that auto-ran while the panel is open.
// (Runs started with the Run button are handled by startRun above.)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "panel" || msg.type !== "run-finished" || !msg.meta?.auto) return;
  showOutput({ ...msg.result, stdout: `[auto-run: ${msg.meta.name}]\n${msg.result.stdout}` });
});

// A script auto-ran (its last run was stored), or one was marked as seen.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !Object.keys(changes).some(isLastRunKey)) return;
  refreshList();
  showLastRun();
});

// ---------- startup ----------

// Open the way the panel was left: with the script that was being edited,
// including text that was never saved.
refreshList(null).then((scripts) => {
  loadIntoEditor(formToRestore(loadDraft(), scripts));
  els.list.value = currentId ?? "";
});

// Warm start: begin loading Python as soon as the panel opens, so the cost is
// already paid by the time the user clicks Run.
toBackground({ type: "warm" })
  .then((res) => {
    els.status.textContent = res?.ok ? "Python ready" : "Python failed to load";
    els.status.classList.add(res?.ok ? "ready" : "error");
    if (!res?.ok) showOutput({ ok: false, error: res?.error ?? "Unknown error. Did you run `npm run setup`?" });
  })
  .catch((err) => {
    els.status.textContent = "Python failed to load";
    els.status.classList.add("error");
    showOutput({ ok: false, error: String(err?.message ?? err) });
  });
