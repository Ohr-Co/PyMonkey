import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIndex, missingModuleHint, packagesFor, resolvePackages } from "../extension/lib/packages.js";

// A small stand-in for Pyodide's pyodide-lock.json. Keys are lower case, as in the real one.
const entry = (name, imports, depends = [], package_type = "package") => ({
  name,
  imports,
  depends,
  package_type,
  file_name: `${name}-1.0.whl`,
});
const lock = {
  packages: {
    beautifulsoup4: entry("beautifulsoup4", ["bs4"], ["soupsieve"]),
    soupsieve: entry("soupsieve", ["soupsieve"]),
    "python-dateutil": entry("python-dateutil", ["dateutil"], ["six"]),
    six: entry("six", ["six"]),
    tzdata: entry("tzdata", ["tzdata"]),
    numpy: entry("numpy", ["numpy"]),
    pandas: entry("pandas", ["pandas"], ["numpy", "python-dateutil"]),
    pillow: entry("Pillow", ["PIL"]),
    libopenblas: entry("libopenblas", [], [], "shared_library"),
  },
};

const index = buildIndex(resolvePackages(["beautifulsoup4", "python-dateutil", "tzdata"], lock), lock);
const names = (packages) => packages.map((pkg) => pkg.name);

// ---------- what `npm run setup` ships ----------

test("the packages asked for are shipped together with what they depend on", () => {
  assert.deepEqual(names(resolvePackages(["beautifulsoup4"], lock)), ["beautifulsoup4", "soupsieve"]);
  assert.deepEqual(names(resolvePackages(["pandas"], lock)), ["pandas", "numpy", "python-dateutil", "six"]);
});

test("a package needed twice is shipped once", () => {
  assert.deepEqual(names(resolvePackages(["python-dateutil", "pandas", "six"], lock)), [
    "python-dateutil",
    "six",
    "pandas",
    "numpy",
  ]);
});

test("a package may be named in any letter case", () => {
  assert.deepEqual(names(resolvePackages(["pillow"], lock)), ["Pillow"]);
  assert.deepEqual(names(resolvePackages(["Pillow"], lock)), ["Pillow"]);
});

test("asking for a package Pyodide does not have is an error that names it", () => {
  assert.throws(() => resolvePackages(["beautifulsoup4", "openpyxl"], lock), /"openpyxl" is not a Pyodide package/);
});

test("the index sorts every module into bundled or available", () => {
  assert.deepEqual(index, {
    bundled: {
      bs4: "beautifulsoup4",
      soupsieve: "soupsieve",
      dateutil: "python-dateutil",
      six: "six",
      tzdata: "tzdata",
      zoneinfo: "tzdata", // standard library, but empty without tzdata
    },
    available: { numpy: "numpy", pandas: "pandas", PIL: "Pillow" },
  });
});

test("zoneinfo asks for tzdata only when tzdata is shipped", () => {
  const without = buildIndex(resolvePackages(["beautifulsoup4"], lock), lock);
  assert.equal(without.bundled.zoneinfo, undefined);
  assert.equal(without.available.tzdata, "tzdata");
});

// ---------- what a script needs ----------

test("a script needs the bundled packages of the modules it imports", () => {
  assert.deepEqual(packagesFor(["json", "dateutil", "bs4"], index), ["python-dateutil", "beautifulsoup4"]);
});

test("the standard library, unknown modules and unbundled packages need nothing loaded", () => {
  assert.deepEqual(packagesFor(["json", "re", "nosuch", "numpy"], index), []);
  assert.deepEqual(packagesFor([], index), []);
});

test("two modules of one package ask for it once", () => {
  assert.deepEqual(packagesFor(["tzdata", "zoneinfo"], index), ["tzdata"]);
});

test("module names that are also names of built-in object properties need nothing", () => {
  assert.deepEqual(packagesFor(["constructor", "toString"], index), []);
});

// ---------- what to say about a failed import ----------

const failed = (module) =>
  `Traceback (most recent call last):\n  File "<pymonkey script>", line 1, in <module>\nModuleNotFoundError: No module named '${module}'\n`;

test("a package that can be bundled: the error says how to add it", () => {
  const hint = missingModuleHint(failed("numpy"), index);
  assert.match(hint, /does not come with the package "numpy"/);
  assert.match(hint, /add "numpy" to BUNDLED_PACKAGES/);
  assert.match(hint, /scripts\/setup\.mjs/);
  assert.match(hint, /npm run setup/);
  assert.match(hint, /chrome:\/\/extensions/);
});

test("the hint names the package, which is not always what the script imports", () => {
  const hint = missingModuleHint(failed("PIL"), index);
  assert.match(hint, /"PIL", which is part of the package "Pillow"/);
  assert.match(hint, /add "Pillow" to BUNDLED_PACKAGES/);
});

test("a module nobody provides: the error says it cannot be added", () => {
  const hint = missingModuleHint(failed("openpyxl"), index);
  assert.match(hint, /no module named "openpyxl"/);
  assert.match(hint, /none of the packages that can be added/);
  assert.match(hint, /pyodide\.org/);
  assert.doesNotMatch(hint, /BUNDLED_PACKAGES/);
});

test("a bundled package imported out of sight: the error asks for an import line", () => {
  const hint = missingModuleHint(failed("dateutil"), index);
  assert.match(hint, /`import dateutil`/);
  assert.doesNotMatch(hint, /BUNDLED_PACKAGES/);
});

test("other errors get no hint", () => {
  const traceback = (lastLine) => `Traceback (most recent call last):\n  File "<pymonkey script>", line 1, in <module>\n${lastLine}\n`;
  assert.equal(missingModuleHint(traceback("ZeroDivisionError: division by zero"), index), null);
  // A module missing from a package that is there is a mistake in the script.
  assert.equal(missingModuleHint(failed("bs4.nope"), index), null);
  assert.equal(missingModuleHint(traceback("ModuleNotFoundError: No module named 'os.nope'; 'os' is not a package"), index), null);
  // Only the error itself counts, not a script that printed or raised those words.
  assert.equal(missingModuleHint(traceback(`ValueError: ModuleNotFoundError: No module named 'numpy'`), index), null);
  assert.equal(missingModuleHint(`${failed("numpy")}\nduring handling of the above...\nKeyError: 'x'\n`, index), null);
  assert.equal(missingModuleHint(null, index), null);
  assert.equal(missingModuleHint("", index), null);
});
