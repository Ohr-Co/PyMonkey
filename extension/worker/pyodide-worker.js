// Web worker that hosts Pyodide (CPython compiled to WebAssembly).
// Runs inside the offscreen document. Being a worker means a runaway script
// can be killed with worker.terminate() without freezing anything else.
//
// Everything is loaded from extension/vendor/pyodide (see `npm run setup`):
// Manifest V3 forbids loading code from a CDN at runtime.

import { loadPyodide } from "../vendor/pyodide/pyodide.mjs";

// Packages imported into every runtime. Keep this list short: each one costs
// startup time and memory. Must also be listed in scripts/setup.mjs.
const PRELOADED_PACKAGES = ["beautifulsoup4"];

const RUNTIME_MODULE = "pymonkey_runtime";

async function boot() {
  const pyodide = await loadPyodide({
    indexURL: new URL("../vendor/pyodide/", import.meta.url).href,
  });
  await pyodide.loadPackage(PRELOADED_PACKAGES);

  // Install our Python module into site-packages so it can be imported.
  const source = await (await fetch(new URL(`../python/${RUNTIME_MODULE}.py`, import.meta.url))).text();
  const sitePackages = pyodide.runPython("import site; site.getsitepackages()[0]");
  pyodide.FS.writeFile(`${sitePackages}/${RUNTIME_MODULE}.py`, source);

  return pyodide.pyimport(RUNTIME_MODULE);
}

// Start loading immediately; every request awaits this same promise.
const runtimeReady = boot();

// ---------- DOM bridge: Python -> (offscreen -> background -> content script) ----------

let nextCallId = 1;
const domPending = new Map(); // callId -> resolve

/** Build the `dom_call(op, args_json)` function handed to Python for one run. */
function makeDomCall(tabId) {
  return (op, argsJson) =>
    new Promise((resolve) => {
      const callId = nextCallId++;
      domPending.set(callId, resolve);
      self.postMessage({ type: "dom", callId, tabId, op, args: JSON.parse(argsJson) });
    });
}

// ---------- message handling ----------

async function handleRun({ id, tabId, code, page }) {
  let result;
  try {
    const runtime = await runtimeReady;
    self.postMessage({ type: "started", id });
    // runtime.run is `async def run(code, page_json, dom_call)` and returns JSON.
    result = JSON.parse(await runtime.run(code, JSON.stringify(page), makeDomCall(tabId)));
  } catch (err) {
    result = { ok: false, stdout: "", error: `PyMonkey runtime error: ${err?.message ?? err}` };
  }
  self.postMessage({ type: "result", id, result });
}

async function handleWarm({ id }) {
  let result;
  try {
    await runtimeReady;
    result = { ok: true };
  } catch (err) {
    result = { ok: false, error: `Python failed to load: ${err?.message ?? err}` };
  }
  self.postMessage({ type: "result", id, result });
}

self.onmessage = ({ data }) => {
  if (data.type === "run") handleRun(data);
  else if (data.type === "warm") handleWarm(data);
  else if (data.type === "dom-result") {
    domPending.get(data.callId)?.(JSON.stringify(data.result ?? { ok: false, error: "No reply from page" }));
    domPending.delete(data.callId);
  }
};
