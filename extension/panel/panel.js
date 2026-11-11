// Side panel: the script editor. A plain textarea for v1.
// Talks only to the background service worker (target: "background").

import { getScripts, saveScript, deleteScript } from "../lib/storage.js";

const $ = (id) => document.getElementById(id);
const els = {
  status: $("status"), list: $("script-list"), name: $("name"), match: $("match"),
  enabled: $("enabled"), code: $("code"), output: $("output"),
  run: $("run"), save: $("save"), del: $("delete"), newBtn: $("new"),
};

const STARTER = `# \`page\` is the page you are looking at.
#   read:   page.soup is a BeautifulSoup tree  (page.select("a") etc.)
#   write:  page.set_style("h1", "color: tomato")

print(page.title)
for link in page.select("a[href]")[:10]:
    print(link.get_text(strip=True), "->", link["href"])
`;

let currentId = null; // id of the script being edited, or null for an unsaved one

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
  els.code.value = script?.code ?? STARTER;
}

async function refreshList(selectId = currentId) {
  const scripts = await getScripts();
  els.list.replaceChildren(
    new Option("(unsaved script)", ""),
    ...scripts.map((s) => new Option(s.name || "Untitled", s.id)),
  );
  els.list.value = selectId ?? "";
  return scripts;
}

// ---------- buttons ----------

els.run.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return showOutput({ ok: false, error: "No active tab found." });
  els.run.disabled = true;
  els.output.classList.remove("error");
  els.output.textContent = "Running…";
  try {
    showOutput(await toBackground({ type: "run-in-tab", tabId: tab.id, code: els.code.value }));
  } catch (err) {
    showOutput({ ok: false, error: String(err?.message ?? err) });
  } finally {
    els.run.disabled = false;
  }
});

els.save.addEventListener("click", async () => {
  const saved = await saveScript({
    id: currentId ?? undefined,
    name: els.name.value.trim() || "Untitled",
    match: els.match.value.trim(),
    enabled: els.enabled.checked,
    code: els.code.value,
  });
  currentId = saved.id;
  await refreshList();
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
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "panel" || msg.type !== "run-finished") return;
  showOutput({ ...msg.result, stdout: `[auto-run: ${msg.name}]\n${msg.result.stdout}` });
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
