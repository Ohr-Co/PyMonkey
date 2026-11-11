// Measures how much memory PyMonkey takes at each stage of its life, and
// prints a table. The numbers in docs/memory.md were made with it.
//
//   npm run measure
//   npm run measure -- --rounds 3                        the middle value of three rounds
//   npm run measure -- --extension ../other/extension    another copy, to compare with
//
// Needs "Chrome for Testing" or Chromium, like the end-to-end test: point
// CHROME_PATH at the binary if it is not found. Works on macOS and Linux.
//
// What is measured: Chrome runs everything an extension does (the background
// service worker, the offscreen document with the Python worker, the side
// panel) in one process of its own. The script finds that process and asks the
// operating system how large it is:
//
//   footprint  memory that belongs to this process alone. It is the figure
//              shown by Activity Monitor and by Chrome's own task manager.
//              macOS only (it comes from the `footprint` tool).
//   RSS        memory the process has in use right now, including what it
//              shares with other Chrome processes (about 70 MB of Chrome's
//              own code). From `ps`, so it works everywhere.
//
// The measured browser is driven like a user would: a saved script that runs
// automatically, and pages that are opened. Nothing of the extension is kept
// open or kept awake by the measuring itself.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import puppeteer from "puppeteer-core";
import { copyExtension } from "../tests/extension-copy.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: options } = parseArgs({
  options: {
    extension: { type: "string", default: join(root, "extension") },
    rounds: { type: "string", default: "1" },
    idle: { type: "string", default: "30" }, // seconds; the extension's own period is 300
  },
});
const extensionPath = resolve(options.extension);
const rounds = Number(options.rounds);
const idleSeconds = Number(options.idle);
const chromePath =
  process.env.CHROME_PATH ??
  ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const MB = 1024 * 1024;

// ---------- the pages ----------

// A table of `count` rows: about 150 bytes of HTML and six elements per row.
const table = (count) =>
  Array.from(
    { length: count },
    (_, i) =>
      `<tr class="item" data-id="${i}"><td>Item ${i}</td><td class="price">${(i * 1.07).toFixed(2)}</td>` +
      `<td><a href="/item/${i}">details about item number ${i}</a></td></tr>`,
  ).join("\n");
const PAGES = {
  "/small": `<!doctype html><title>Small</title><table>${table(200)}</table>`,
  "/large": `<!doctype html><title>Large</title><table>${table(40_000)}</table>`,
  "/empty": `<!doctype html><title>Empty</title>`, // no script runs here
};
const megabytes = (path) => (PAGES[path].length / 1e6).toFixed(PAGES[path].length < 1e6 ? 2 : 1);

const server = http
  .createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(PAGES[new URL(req.url, "http://localhost").pathname] ?? PAGES["/empty"]);
  })
  .listen(0);
const site = `http://localhost:${server.address().port}`;

// What a scraping script does: parse the page and pick out its rows. It then
// tells the page how far it is (so this script can see it from outside) and
// waits, to leave time for measuring while it holds on to the rows.
const SCRIPT = `import asyncio
rows = page.select("tr.item")
prices = [float(row.select_one(".price").text) for row in rows]
page.set_attr("html", "data-measure", "parsed")
await asyncio.sleep(6)
page.set_attr("html", "data-measure", f"done: {len(rows)} rows")
`;

// ---------- reading the memory of the extension's process ----------

const command = (file, args) => execFileSync(file, args, { encoding: "utf8", maxBuffer: 64 * MB });

// The extension's processes: the browser starts them with --extension-process.
function extensionProcesses(browser) {
  return command("ps", ["-axo", "pid=,ppid=,rss=,command="])
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((found) => found && Number(found[2]) === browser.process().pid && found[4].includes("--extension-process"))
    .map(([, pid, , rssKilobytes]) => ({ pid, rss: Number(rssKilobytes) * 1024 }));
}

// { footprint, rss } in bytes, both 0 when the extension has no process at all.
// footprint is null where it cannot be measured.
function extensionMemory(browser) {
  let footprint = process.platform === "darwin" ? 0 : null;
  let rss = 0;
  for (const proc of extensionProcesses(browser)) {
    rss += proc.rss;
    if (footprint === null) continue;
    const found = /Footprint: (\d+) B/.exec(command("footprint", ["-f", "bytes", "--noCategories", "-p", proc.pid]));
    if (found) footprint += Number(found[1]);
  }
  return { footprint, rss };
}

// ---------- one round ----------

async function measureRound() {
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [`--disable-extensions-except=${loaded.path}`, `--load-extension=${loaded.path}`, "--no-sandbox"],
  });
  const stages = [];
  const record = (name) => {
    stages.push({ name, ...extensionMemory(browser) });
    process.stderr.write(".");
  };
  const targetUrls = () => browser.targets().map((target) => target.url());
  const runtimeIsLoaded = () => targetUrls().some((url) => url.endsWith("/worker/pyodide-worker.js"));
  const until = async (condition, seconds) => {
    for (const deadline = Date.now() + seconds * 1000; Date.now() < deadline; await sleep(0.25)) {
      if (await condition()) return true;
    }
    return false;
  };

  try {
    const page = await browser.newPage();
    await page.goto(site + "/empty");
    await sleep(3);
    record("Browser just started, PyMonkey not used yet");

    // Set up through the side panel's page: save the script, and open the
    // runtime page with a short idle period so that the wait further down is
    // not five minutes. (A copy of the extension without that feature ignores it.)
    const extensionId = new URL(targetUrls().find((url) => url.startsWith("chrome-extension://"))).host;
    const panel = await browser.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel/panel.html`);
    await panel.waitForFunction(() => document.getElementById("status").dataset.state === "ready", { timeout: 60_000 });
    await panel.evaluate(
      async (script, idleSeconds) => {
        const { saveScript } = await import("/lib/storage.js");
        await saveScript(script);
        await chrome.offscreen.closeDocument();
        await chrome.offscreen.createDocument({
          url: `offscreen/offscreen.html?idle=${idleSeconds}`,
          reasons: ["WORKERS"],
          justification: "The runtime page, with a short idle period for the measurement.",
        });
        await chrome.runtime.sendMessage({ target: "background", type: "warm" }); // wait for Python to load in it
      },
      { name: "Measure", match: `${site}/small\n${site}/large`, timeout: 0, code: SCRIPT },
      idleSeconds,
    );
    await sleep(3);
    record("Python loaded, side panel open");
    await panel.close();
    await sleep(3);
    record("Python loaded, idle (after warm-up)");

    // A run starts by itself when a page that matches the script has loaded.
    // Returns how long it took from opening the page to the script having read it, in seconds.
    const runOn = async (path, label) => {
      const openedAt = Date.now();
      await page.goto(site + path);
      await page.waitForSelector("html[data-measure=parsed]", { timeout: 120_000 });
      const seconds = (Date.now() - openedAt) / 1000;
      await sleep(2);
      if (label) record(`During a run on ${label} (${megabytes(path)} MB of HTML)`);
      await page.waitForSelector("html[data-measure^=done]", { timeout: 60_000 });
      return seconds;
    };
    const warmStart = await runOn("/small", "a small page");
    await sleep(5);
    record("5 seconds after that run");
    await runOn("/large", "a large page");
    await sleep(5);
    record("5 seconds after that run");
    await page.goto(site + "/empty");

    const closed = await until(() => !runtimeIsLoaded(), idleSeconds + 15);
    await sleep(3);
    record(closed ? "Idle period over: Python shut down" : "Idle period over: Python is still loaded");
    // Chrome stops an idle service worker after 30 seconds, and ends the
    // extension's process when nothing is left in it.
    await until(() => extensionProcesses(browser).length === 0, 60);
    record("One minute later");

    // On demand: a page that matches the script is opened.
    const coldStart = await runOn("/small");
    await sleep(5);
    record(closed ? "Loaded again by the next run, 5 seconds after it" : "5 seconds after one more run");
    return { stages, warmStart, coldStart };
  } finally {
    await browser.close();
  }
}

// ---------- all rounds, and the table ----------

if (!chromePath) {
  console.error("Chrome for Testing not found. Set CHROME_PATH to its binary (see the README, under Tests).");
  process.exit(1);
}
if (!existsSync(join(extensionPath, "vendor", "pyodide", "pyodide.asm.wasm"))) {
  console.error(`No Python runtime in ${extensionPath}. Run \`npm run setup\` first.`);
  process.exit(1);
}

// The browser loads a copy of the extension that has been allowed on this
// machine's own pages, which is where the measuring happens. As installed,
// PyMonkey is allowed nowhere until the user says so (see tests/extension-copy.mjs).
const loaded = copyExtension(extensionPath);
const all = [];
try {
  for (let round = 0; round < rounds; round++) all.push(await measureRound());
} finally {
  server.close();
  loaded.remove();
}
process.stderr.write("\n");

// The middle value of the rounds (with two rounds, the lower one).
const median = (numbers) => [...numbers].sort((a, b) => a - b)[Math.floor((numbers.length - 1) / 2)];
const inMB = (bytes) => (bytes === 0 ? "0" : String(Math.round(bytes / MB)));
const hasFootprint = all[0].stages[0].footprint !== null;

const manifest = JSON.parse(readFileSync(join(extensionPath, "manifest.json"), "utf8"));
const browserVersion = command(chromePath, ["--version"]).trim();
console.log(`PyMonkey ${manifest.version} in ${extensionPath}`);
console.log(`${browserVersion}, ${process.platform} ${process.arch}, ${rounds === 1 ? "one round" : `middle value of ${rounds} rounds`}`);
console.log(`Idle period shortened to ${idleSeconds} seconds for the measurement.\n`);
console.log(hasFootprint ? "| Stage | Footprint (MB) | RSS (MB) |" : "| Stage | RSS (MB) |");
console.log(hasFootprint ? "| --- | ---: | ---: |" : "| --- | ---: |");
all[0].stages.forEach((stage, i) => {
  const rss = inMB(median(all.map((round) => round.stages[i].rss)));
  const footprint = hasFootprint ? ` ${inMB(median(all.map((round) => round.stages[i].footprint)))} |` : "";
  console.log(`| ${stage.name} |${footprint} ${rss} |`);
});
const seconds = (pick) => median(all.map(pick)).toFixed(1);
console.log(`\nFrom opening the small page to the script having read it: ${seconds((round) => round.warmStart)} s the first time,`);
console.log(`${seconds((round) => round.coldStart)} s the last time.`);
