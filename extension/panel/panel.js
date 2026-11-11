// Side panel: the script editor. A plain textarea for v1.
// Talks only to the background service worker (target: "background").

import { startRun } from "../lib/run-client.js";
import { describeLastRun, isLastRunKey } from "../lib/last-run.js";
import { getScripts, getLastRuns, saveScript, deleteScript, markLastRunSeen } from "../lib/storage.js";
import { timeoutSeconds } from "../lib/timeout.js";

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"), list: $("script-list"), name: $("name"), match: $("match"),
  enabled: $("enabled"), timeout: $("timeout"), code: $("code"), output: $("output"),
  run: $("run"), stop: $("stop"), save: $("save"), del: $("delete"), newBtn: $("new"),
  lastRun: $("last-run"), lastRunSummary: $("last-run-summary"),
  lastRunUrl: $("last-run-url"), lastRunOutput: $("last-run-output"),
};

const STARTER = `# \`page\` is the page you are looking at.
#   read:   page.soup is a BeautifulSoup tree  (page.select("a") etc.)
#   write:  await page.set_style("h1", "color: tomato")

print(page.title)
for link in page.select("a[href]")[:10]:
    print(link.get_text(strip=True), "->", link["href"])
`;

let currentId = null; // id of the script being edited, or null for an unsaved one
let currentRun = null; // the run started with the Run button, while it is in flight
let shownLastRun = null; // which last run the panel is showing ("<script id>:<time>")

const toBackground = (message) => chrome.runtime.sendMessage({ ...message, target: "background" });

function showOutput(result) {
  const text = [result.stdout, result.error].filter(Boolean).join("\n");
  els.output.textContent = text || "(no output)";
  els.output.classList.toggle("error", !result.ok);
}

function loadIntoEditor(script) {
  currentId = script?.id ?? null;
  els.name.value = script?.name ?? "";
  els.match.value = script?.match ?? "";
  els.enabled.checked = script?.enabled ?? true;
  els.timeout.value = timeoutSeconds(script?.timeout);
  els.code.value = script?.code ?? STARTER;
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
  currentRun = startRun(tab.id, els.code.value, { timeout: timeoutSeconds(els.timeout.value) });
  // `result` always arrives, even if the run was stopped or lost (see lib/run-client.js).
  showOutput(await currentRun.result);
  currentRun = null;
  els.stop.hidden = true;
  els.run.hidden = false;
});

els.stop.addEventListener("click", () => currentRun?.stop());

els.save.addEventListener("click", async () => {
  const saved = await saveScript({
    id: currentId ?? undefined,
    name: els.name.value.trim() || "Untitled",
    match: els.match.value.trim(),
    enabled: els.enabled.checked,
    timeout: timeoutSeconds(els.timeout.value),
    code: els.code.value,
  });
  currentId = saved.id;
  await refreshList();
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
  const scripts = await getScripts();
  loadIntoEditor(scripts.find((s) => s.id === els.list.value) ?? null);
});

// Tab key indents instead of leaving the textarea (this is Python, after all).
els.code.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  e.preventDefault();
  els.code.setRangeText("    ", els.code.selectionStart, els.code.selectionEnd, "end");
});

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

loadIntoEditor(null);
refreshList();

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
