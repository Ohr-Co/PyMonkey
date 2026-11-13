// Copies the Pyodide runtime into extension/vendor/pyodide and downloads the
// Python packages PyMonkey bundles. Run with: npm run setup
//
// Why: Manifest V3 extensions may not load code from the network at runtime,
// so Pyodide and every package wheel must ship inside the extension folder.
// The folder is gitignored (it is ~15 MB of binaries).
//
// It also writes packages.json, which tells the extension which `import`
// needs which bundled package (so it can be loaded the first time a script
// imports it) and which packages could be bundled but are not (so the error
// for a missing one can say how to add it). See extension/lib/packages.js.

import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, resolvePackages } from "../extension/lib/packages.js";

// Packages to bundle (their dependencies are added automatically).
// Must be in Pyodide's package list: https://pyodide.org/en/stable/usage/packages-in-pyodide.html
//
// Bundling a package costs size only: it is loaded the first time a script
// imports it. The exception is PRELOADED_PACKAGES in
// extension/worker/pyodide-worker.js, loaded at startup, which must be listed here too.
// Sizes, load times and the reasoning behind this list: "Packages" in README.md.
const BUNDLED_PACKAGES = [
  "beautifulsoup4", // preloaded: page.soup
  "python-dateutil", // reads dates the way pages write them: "3 March 2024, 5pm"
  "tzdata", // time zones for the standard library's zoneinfo, which has none without it
];
// Left out on purpose: "requests". Inside an extension it sends the user's
// cookies to every site and cannot be told not to; page.fetch is the careful way.

const CORE_FILES = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pyodide");
const dest = join(root, "extension", "vendor", "pyodide");

const exists = (p) => access(p).then(() => true, () => false);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

if (!(await exists(src))) {
  console.error("node_modules/pyodide not found. Run `npm install` first.");
  process.exit(1);
}

await mkdir(dest, { recursive: true });
for (const file of CORE_FILES) await copyFile(join(src, file), join(dest, file));

const { version } = JSON.parse(await readFile(join(src, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(src, "pyodide-lock.json"), "utf8"));
console.log(`Pyodide ${version} (Python ${lock.info.python}) copied to extension/vendor/pyodide`);

// BUNDLED_PACKAGES plus everything they depend on.
const wanted = resolvePackages(BUNDLED_PACKAGES, lock);

for (const pkg of wanted) {
  const target = join(dest, pkg.file_name);
  if ((await exists(target)) && sha256(await readFile(target)) === pkg.sha256) {
    console.log(`  ok        ${pkg.file_name}`);
    continue;
  }
  const url = `https://cdn.jsdelivr.net/pyodide/v${version}/full/${pkg.file_name}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (sha256(data) !== pkg.sha256) throw new Error(`Checksum mismatch for ${pkg.file_name}`);
  await writeFile(target, data);
  console.log(`  fetched   ${pkg.file_name}`);
}

// Wheels left over from a package that is no longer in the list would still
// be shipped with the extension. (Wheels are Python's package files, *.whl.)
const wheels = new Set(wanted.map((pkg) => pkg.file_name));
for (const file of await readdir(dest)) {
  if (!file.endsWith(".whl") || wheels.has(file)) continue;
  await rm(join(dest, file));
  console.log(`  removed   ${file}`);
}

await writeFile(join(dest, "packages.json"), JSON.stringify(buildIndex(wanted, lock), null, 1));
console.log(`  wrote     packages.json (${wanted.length} packages bundled)`);

console.log("Done. Load the `extension` folder at chrome://extensions (Developer mode -> Load unpacked).");
