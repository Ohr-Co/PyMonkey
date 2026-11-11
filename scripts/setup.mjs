// Copies the Pyodide runtime into extension/vendor/pyodide and downloads the
// Python packages PyMonkey bundles. Run with: npm run setup
//
// Why: Manifest V3 extensions may not load code from the network at runtime,
// so Pyodide and every package wheel must ship inside the extension folder.
// The folder is gitignored (it is ~15 MB of binaries).

import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Packages to bundle (their dependencies are added automatically).
// Must be in Pyodide's package list: https://pyodide.org/en/stable/usage/packages-in-pyodide.html
// Keep in sync with PRELOADED_PACKAGES in extension/worker/pyodide-worker.js.
const BUNDLED_PACKAGES = ["beautifulsoup4"];

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

// Resolve BUNDLED_PACKAGES plus everything they depend on.
const wanted = new Map();
const visit = (name) => {
  const pkg = lock.packages[name.toLowerCase()];
  if (!pkg) throw new Error(`"${name}" is not a Pyodide package`);
  if (wanted.has(pkg.name)) return;
  wanted.set(pkg.name, pkg);
  pkg.depends.forEach(visit);
};
BUNDLED_PACKAGES.forEach(visit);

for (const pkg of wanted.values()) {
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

console.log("Done. Load the `extension` folder at chrome://extensions (Developer mode -> Load unpacked).");
