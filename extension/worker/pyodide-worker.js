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

// Python glue that only makes sense inside Pyodide, kept out of
// pymonkey_runtime.py so that file still runs under normal CPython.
//
// make_sync turns a JavaScript function that returns a promise into a Python
// function that waits for the promise and returns its value. This is what lets
// scripts write `page.click(...)` without `await`. `run_sync` pauses the Python
// call stack (not the worker: messages keep flowing) using JavaScript Promise
// Integration, which Chrome has from version 137, the manifest's minimum.
const MAKE_SYNC = `
from pyodide.ffi import run_sync

def make_sync(js_function):
    def call(*args):
        return run_sync(js_function(*args))
    return call

make_sync
`;

async function boot() {
  const pyodide = await loadPyodide({
    indexURL: new URL("../vendor/pyodide/", import.meta.url).href,
  });
  await pyodide.loadPackage(PRELOADED_PACKAGES);

  // Install our Python module into site-packages so it can be imported.
  const source = await (await fetch(new URL(`../python/${RUNTIME_MODULE}.py`, import.meta.url))).text();
  const sitePackages = pyodide.runPython("import site; site.getsitepackages()[0]");
  pyodide.FS.writeFile(`${sitePackages}/${RUNTIME_MODULE}.py`, source);

  return { runtime: pyodide.pyimport(RUNTIME_MODULE), makeSync: pyodide.runPython(MAKE_SYNC) };
}

// Start loading immediately; every request awaits this same promise.
const runtimeReady = boot();

// ---------- bridge: Python -> offscreen -> background (-> content script) ----------
//
// Python cannot touch the page or the extension's storage from in here, so it
// asks for it. `service` says who should do the work:
//   "dom"    the page's content script (page.click(...) and friends)
//   "store"  the script's saved values (page.store), kept by the background

let nextCallId = 1;
const callsPending = new Map(); // callId -> resolve

/**
 * Build the `host_call(service, op, args_json)` function for one run.
 * It returns a promise of the reply. `context` is sent along with every call:
 * the tab the script runs on and the id of the saved script, if it is one.
 */
function makeHostCall(context) {
  return (service, op, argsJson) =>
    new Promise((resolve) => {
      const callId = nextCallId++;
      callsPending.set(callId, resolve);
      self.postMessage({ type: "call", callId, service, ...context, op, args: JSON.parse(argsJson) });
    });
}

// ---------- message handling ----------

async function handleRun({ id, tabId, scriptId, code, page }) {
  let result;
  try {
    const { runtime, makeSync } = await runtimeReady;
    self.postMessage({ type: "started", id });
    // runtime.run is `async def run(code, page_json, host_call)` and returns JSON.
    // Python gets a host_call that waits for the reply instead of returning a promise.
    const hostCall = makeSync(makeHostCall({ tabId, scriptId }));
    try {
      result = JSON.parse(await runtime.run(code, JSON.stringify(page), hostCall));
    } finally {
      hostCall.destroy(); // release the Python function we were holding from JavaScript
    }
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
  else if (data.type === "call-result") {
    callsPending.get(data.callId)?.(JSON.stringify(data.result ?? { ok: false, error: "No reply from the extension" }));
    callsPending.delete(data.callId);
  }
};
