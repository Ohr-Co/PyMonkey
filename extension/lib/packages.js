// Python packages: which ones a script needs, and what to say when one is missing.
//
// Only a few packages are shipped inside the extension, and all but the
// preloaded ones are loaded the first time a script imports them, so that
// scripts which do not use a package do not pay for it.
//
// A module is the name after `import`; a package is what gets installed. The
// two often differ: `import dateutil` comes from the package "python-dateutil".
// The package index says which is which. `npm run setup` builds it and saves it
// as extension/vendor/pyodide/packages.json (the first half of this file); the
// Pyodide worker reads it (the second half). It has two parts, both { module: package }:
//   bundled    { "dateutil": "python-dateutil", ... }   shipped in the extension
//   available  { "numpy": "numpy", ... }                 offered by Pyodide, not shipped
//
// No chrome.* or Pyodide calls here, so it can be tested with plain Node.

const PACKAGE_LIST = "https://pyodide.org/en/stable/usage/packages-in-pyodide.html";

// Modules of the standard library that are of no use without a package they
// never import by name: { module: package }.
const STDLIB_NEEDS = { zoneinfo: "tzdata" };

// ---------- used by `npm run setup` ----------
//
// `lock` is Pyodide's own list of packages, pyodide-lock.json:
//   { packages: { "python-dateutil": { name, file_name, sha256, depends: ["six"], imports: ["dateutil"], ... } } }

/**
 * The packages to ship: the ones named, plus everything they depend on.
 * Returns their entries from the lock, each package once.
 */
export function resolvePackages(names, lock) {
  const wanted = new Map(); // name -> entry
  const visit = (name) => {
    const pkg = lock.packages[name.toLowerCase()];
    if (!pkg) throw new Error(`"${name}" is not a Pyodide package. The list: ${PACKAGE_LIST}`);
    if (wanted.has(pkg.name)) return;
    wanted.set(pkg.name, pkg);
    pkg.depends.forEach(visit);
  };
  names.forEach(visit);
  return [...wanted.values()];
}

/** Build the package index, given the packages that are shipped (from resolvePackages). */
export function buildIndex(shipped, lock) {
  const shippedNames = new Set(shipped.map((pkg) => pkg.name));
  const bundled = {};
  const available = {};
  for (const pkg of Object.values(lock.packages)) {
    if (pkg.package_type !== "package") continue; // the rest are C libraries, which Python cannot import
    for (const module of pkg.imports) (shippedNames.has(pkg.name) ? bundled : available)[module] = pkg.name;
  }
  for (const [module, name] of Object.entries(STDLIB_NEEDS)) {
    if (shippedNames.has(name)) bundled[module] = name;
  }
  return { bundled, available };
}

// ---------- used by the Pyodide worker ----------

/**
 * The bundled packages needed for the modules a script imports.
 *   packagesFor(["json", "dateutil", "bs4"], index) -> ["python-dateutil", "beautifulsoup4"]
 * Modules of the standard library, and modules nothing provides, need no package.
 */
export function packagesFor(modules, index) {
  const names = modules.filter((module) => Object.hasOwn(index.bundled, module)).map((module) => index.bundled[module]);
  return [...new Set(names)]; // a Set drops the duplicates
}

/**
 * Advice to add below a script's error, or null when there is none to give.
 * `error` is the traceback text. Python's own last line for a failed import,
 *   ModuleNotFoundError: No module named 'numpy'
 * says what is wrong but not what to do about it.
 */
export function missingModuleHint(error, index) {
  const lastLine = (error ?? "").trimEnd().split("\n").pop();
  // A dotted name ('bs4.nope') is a module missing from a package that is
  // there, which is an ordinary mistake. [^'.] means "no quote and no dot".
  const module = lastLine.match(/^ModuleNotFoundError: No module named '([^'.]+)'$/)?.[1];
  if (!module) return null;

  if (Object.hasOwn(index.bundled, module)) {
    // Bundled, yet not loaded: the script imported it in a way that cannot be
    // seen by reading it, e.g. importlib.import_module("dateutil").
    return (
      `PyMonkey has "${module}", but loads it only for a script that contains the line \`import ${module}\`. ` +
      "Add that line at the top of the script."
    );
  }
  if (Object.hasOwn(index.available, module)) {
    const name = index.available[module];
    const what = name === module ? `the package "${name}"` : `"${module}", which is part of the package "${name}"`;
    return (
      `PyMonkey does not come with ${what}, but it can be added:\n` +
      `  1. In scripts/setup.mjs, add "${name}" to BUNDLED_PACKAGES.\n` +
      "  2. In the project folder, run `npm run setup`.\n" +
      "  3. Reload PyMonkey at chrome://extensions."
    );
  }
  return (
    `Python in PyMonkey has no module named "${module}", and none of the packages that can be added has one. ` +
    `Check the spelling. The packages that can be added are listed at ${PACKAGE_LIST}`
  );
}
