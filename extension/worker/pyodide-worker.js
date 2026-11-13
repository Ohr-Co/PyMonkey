// Web worker that hosts Pyodide (CPython compiled to WebAssembly).
// Runs inside the offscreen document. Being a worker means a runaway script
// can be killed with worker.terminate() without freezing anything else.
//
// Everything is loaded from extension/vendor/pyodide (see `npm run setup`):
// Manifest V3 forbids loading code from a CDN at runtime.

import { httpFetch } from "../lib/http.js";
import { missingModuleHint, packagesFor } from "../lib/packages.js";
import { loadPyodide } from "../vendor/pyodide/pyodide.mjs";

// Packages loaded into every runtime at startup. Keep this list short: each
// one costs startup time and memory whether or not a script uses it. Every
// other package in BUNDLED_PACKAGES (scripts/setup.mjs, where these must be
// listed too) is loaded when a script that imports it is about to run.
//
// A parser for BeautifulSoup (lxml, html5lib) has to be preloaded to be found:
// BeautifulSoup looks for parsers once, when it is first imported, and a
// script that says BeautifulSoup(html, "lxml") never imports lxml itself.
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

const SETUP_HINT = "In the project folder run `npm run setup`, then reload the extension at chrome://extensions.";

// The size of Python's memory in bytes: one block (the WebAssembly "heap")
// that grows when Python needs more and never shrinks. Pyodide has no official
// way to ask for it, so this looks inside (`_module` is the compiled Python
// itself) and gives 0 if a later Pyodide has moved things.
const heapBytes = (pyodide) => pyodide._module?.HEAPU8?.length ?? 0;

async function boot() {
  const vendor = new URL("../vendor/pyodide/", import.meta.url);
  const pyodide = await loadPyodide({ indexURL: vendor.href });
  await pyodide.loadPackage(PRELOADED_PACKAGES);

  // Which import needs which package (see lib/packages.js).
  const index = await fetch(new URL("packages.json", vendor)).then(
    (response) => response.json(),
    () => {
      throw new Error(`extension/vendor/pyodide/packages.json is missing. ${SETUP_HINT}`);
    },
  );

  // Install our Python module into site-packages so it can be imported.
  const source = await (await fetch(new URL(`../python/${RUNTIME_MODULE}.py`, import.meta.url))).text();
  const sitePackages = pyodide.runPython("import site; site.getsitepackages()[0]");
  pyodide.FS.writeFile(`${sitePackages}/${RUNTIME_MODULE}.py`, source);

  return {
    pyodide,
    index,
    freshBytes: heapBytes(pyodide),
    runtime: pyodide.pyimport(RUNTIME_MODULE),
    makeSync: pyodide.runPython(MAKE_SYNC),
    // find_imports(code) lists the modules a script imports, by reading it
    // (nothing is run). A script with a syntax error gets an empty list.
    findImports: pyodide.pyimport("pyodide.code").find_imports,
  };
}

// Start loading immediately; every request awaits this same promise.
const runtimeReady = boot();

// ---------- bridge: Python -> offscreen -> background (-> content script) ----------
//
// Python cannot touch the page or the extension's storage from in here, so it
// asks for it. `service` says who should do the work:
//   "dom"    the page's content script (page.click(...) and friends)
//   "store"  the script's saved values (page.store), kept by the background
//   "http"   an HTTP request (page.fetch). This one goes nowhere: a worker can
//            make requests itself, with the same rights as the background.

let nextCallId = 1;
const callsPending = new Map(); // callId -> resolve

/**
 * Build the `host_call(service, op, args_json)` function for one run.
 * It returns a promise of the reply. `context` is sent along with every call:
 * the tab the script runs on and the id of the saved script, if it is one.
 */
function makeHostCall(context) {
  return (service, op, argsJson) => {
    const args = JSON.parse(argsJson);
    if (service === "http") return httpFetch(args).then(JSON.stringify);
    return new Promise((resolve) => {
      const callId = nextCallId++;
      callsPending.set(callId, resolve);
      self.postMessage({ type: "call", callId, service, ...context, op, args });
    });
  };
}

// ---------- packages ----------

const loadedPackages = new Set(PRELOADED_PACKAGES);

/**
 * Load the bundled packages this script imports that are not loaded yet.
 * It takes a moment (a tenth of a second or so per package) the first time;
 * after that the package stays loaded for as long as this worker lives.
 */
async function loadPackagesFor(code, { pyodide, index, findImports }) {
  const imports = findImports(code); // a Python list: copy it to a JavaScript array, then let go of it
  const modules = imports.toJs();
  imports.destroy();
  const names = packagesFor(modules, index).filter((name) => !loadedPackages.has(name));
  if (names.length === 0) return;
  // Unlike Python's `import`, loadPackage reports a failure through this
  // callback instead of raising it.
  const problems = [];
  await pyodide.loadPackage(names, { errorCallback: (message) => problems.push(message) });
  if (problems.length > 0) throw new Error(`${problems.join(" ")}. ${SETUP_HINT}`); // a package file is missing
  names.forEach((name) => loadedPackages.add(name));
}

// ---------- message handling ----------

async function handleRun({ id, tabId, scriptId, code, page }) {
  let result;
  let heap = null; // how large Python's memory is after this run (see lib/memory.js)
  try {
    const ready = await runtimeReady;
    const { runtime, makeSync, index } = ready;
    await loadPackagesFor(code, ready); // before "started": not counted in the script's time limit
    self.postMessage({ type: "started", id });
    // runtime.run is `async def run(code, page_json, host_call)` and returns JSON.
    // Python gets a host_call that waits for the reply instead of returning a promise.
    const hostCall = makeSync(makeHostCall({ tabId, scriptId }));
    try {
      result = JSON.parse(await runtime.run(code, JSON.stringify(page), hostCall));
    } finally {
      hostCall.destroy(); // release the Python function we were holding from JavaScript
    }
    // Python has let go of the page by now (see run() in pymonkey_runtime.py),
    // and `page`, JavaScript's copy, is dropped when this function returns.
    heap = { bytes: heapBytes(ready.pyodide), freshBytes: ready.freshBytes };
    // An import that failed: say how to get the package.
    const hint = missingModuleHint(result.error, index);
    if (hint) result.error = `${result.error.trimEnd()}\n\n${hint}\n`;
  } catch (err) {
    result = { ok: false, stdout: "", error: `PyMonkey runtime error: ${err?.message ?? err}` };
  }
  self.postMessage({ type: "result", id, result, heap });
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
