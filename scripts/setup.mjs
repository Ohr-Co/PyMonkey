// Puts the third-party code PyMonkey needs into extension/vendor. Run with: npm run setup
//   1. copies the Pyodide runtime into extension/vendor/pyodide and downloads
//      the Python packages PyMonkey bundles
//   2. bundles the CodeMirror code editor into extension/vendor/codemirror
//
// Why: Manifest V3 extensions may not load code from the network at runtime,
// so Pyodide, every package wheel and the editor must ship inside the
// extension folder. The folder is gitignored (it is ~15 MB, mostly binaries).
//
// It also writes packages.json, which tells the extension which `import`
// needs which bundled package (so it can be loaded the first time a script
// imports it) and which packages could be bundled but are not (so the error
// for a missing one can say how to add it). See extension/lib/packages.js.

import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
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

// The files in a zip archive (a wheel is one) whose names pass `wanted`.
// Just enough of the format for that: the directory at the end of the
// archive lists each file and where its data starts.
function unzip(zip, wanted) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("Not a zip file");
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const found = [];
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) continue;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    found.push({ name, data: method === 8 ? inflateRawSync(raw) : raw });
  }
  return found;
}

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

// The licenses of what was copied in, passed on with it as they ask:
// Pyodide (MPL-2.0) and CPython (PSF) from their repositories, each package
// from the license files inside its wheel. Downloads are kept in the folder,
// named by version, so a second run works offline.
const fetchText = async (file, url) => {
  const target = join(dest, file);
  if (await exists(target)) return readFile(target, "utf8");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const text = await res.text();
  await writeFile(target, text);
  return text;
};
const section = (title, text) => `\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}\n\n${text.trim()}\n`;
let pyLicenses = "This folder holds Pyodide, the Python standard library, and the packages below.\n";
pyLicenses += section(
  `Pyodide ${version} (pyodide.mjs, pyodide.asm.mjs, pyodide.asm.wasm)`,
  await fetchText(`LICENSE-pyodide-${version}.txt`, `https://raw.githubusercontent.com/pyodide/pyodide/${version}/LICENSE`),
);
pyLicenses += section(
  `Python ${lock.info.python} (inside pyodide.asm.wasm, and python_stdlib.zip)`,
  await fetchText(`LICENSE-python-${lock.info.python}.txt`, `https://raw.githubusercontent.com/python/cpython/v${lock.info.python}/LICENSE`),
);
for (const pkg of [...wanted].sort((a, b) => a.name.localeCompare(b.name))) {
  const files = unzip(await readFile(join(dest, pkg.file_name)), (name) =>
    /\.dist-info\/(licenses\/.+|(LICEN[CS]E|COPYING|NOTICE|AUTHORS)[^/]*)$/i.test(name),
  );
  if (files.length === 0) throw new Error(`No license file in ${pkg.file_name}`);
  for (const { name, data } of files) {
    pyLicenses += section(`${pkg.name} ${pkg.version} (${pkg.file_name}): ${name.split(".dist-info/")[1]}`, data.toString("utf8"));
  }
}
await writeFile(join(dest, "LICENSES.txt"), pyLicenses);
console.log("  wrote     LICENSES.txt");

// ---------- the code editor ----------
//
// This is the one place where PyMonkey uses a bundler, and only for
// third-party code: see scripts/codemirror-entry.mjs for why. PyMonkey's own
// files are loaded by Chrome exactly as they are in the repository.
const { build } = await import("esbuild");
const editorDest = join(root, "extension", "vendor", "codemirror");
const bundle = await build({
  entryPoints: [join(root, "scripts", "codemirror-entry.mjs")],
  outfile: join(editorDest, "codemirror.js"),
  bundle: true, // follow the imports and put everything in one file
  format: "esm", // ...that is itself a module the panel can `import`
  minify: true,
  legalComments: "none", // the licenses are written out in full below
  metafile: true, // report which files went in
});

// The licenses of what was bundled (all MIT) ask to be passed on with it.
// A bundled file's path looks like node_modules/@codemirror/view/dist/index.js;
// its package folder is the part up to and including the package's name.
const packageFolders = new Set(
  Object.keys(bundle.metafile.inputs)
    .map((file) => file.match(/^node_modules\/(@[^/]+\/)?[^/]+/)?.[0])
    .filter(Boolean),
);
let licenses = "codemirror.js in this folder contains the following packages.\n";
for (const folder of [...packageFolders].sort()) {
  const { name, version } = JSON.parse(await readFile(join(root, folder, "package.json"), "utf8"));
  const license = await readFile(join(root, folder, "LICENSE"), "utf8");
  licenses += `\n${"=".repeat(70)}\n${name} ${version}\n${"=".repeat(70)}\n\n${license.trim()}\n`;
}
await writeFile(join(editorDest, "LICENSES.txt"), licenses);
const { bytes } = Object.values(bundle.metafile.outputs)[0];
console.log(`CodeMirror bundled into extension/vendor/codemirror (${Math.round(bytes / 1000)} KB, ${packageFolders.size} packages)`);

console.log("Done. Load the `extension` folder at chrome://extensions (Developer mode -> Load unpacked).");
