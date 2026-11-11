// End-to-end test: loads the real extension in Chrome and runs Python on a page.
//
//   npm run test:e2e
//
// Needs "Chrome for Testing" or Chromium (regular Chrome no longer accepts
// --load-extension). Point CHROME_PATH at the binary if it is not found.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const extensionPath = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const chromePath =
  process.env.CHROME_PATH ??
  ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);

const HTML = `<!doctype html><title>Test page</title>
<h1>Hello</h1><a href="/one">One</a><a href="/two">Two</a>
<input id="q"><button id="btn" onclick="document.title='clicked'">Go</button>`;

const server = http.createServer((_req, res) => res.end(HTML)).listen(0);
const pageUrl = `http://localhost:${server.address().port}/`;

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-sandbox"],
});

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker");
  const extensionId = new URL(swTarget.url()).host;

  const page = await browser.newPage();
  await page.goto(pageUrl);

  // Drive the extension the same way the side panel does: from an extension page.
  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel/panel.html`);

  const run = (code) =>
    panel.evaluate(async (code, pageUrl) => {
      const [tab] = await chrome.tabs.query({ url: pageUrl });
      return chrome.runtime.sendMessage({ target: "background", type: "run-in-tab", tabId: tab.id, code });
    }, code, pageUrl);

  // 1. Read: snapshot + BeautifulSoup
  let result = await run(`print(page.title)\nprint([a["href"] for a in page.select("a")])`);
  assert.deepEqual(result, { ok: true, stdout: "Test page\n['/one', '/two']\n", error: null });
  console.log("ok  read page with BeautifulSoup");

  // 2. Write: DOM primitives round-trip to the real page
  result = await run(
    `await page.set_text("h1", "Changed by Python")\nawait page.fill("#q", "typed")\nawait page.click("#btn")\n` +
      `await page.refresh()\nprint(page.title)`,
  );
  assert.equal(result.error, null);
  assert.equal(result.stdout, "clicked\n");
  assert.equal(await page.$eval("h1", (el) => el.textContent), "Changed by Python");
  assert.equal(await page.$eval("#q", (el) => el.value), "typed");
  console.log("ok  edit page through DOM primitives");

  // 3. Errors come back as Python tracebacks
  result = await run(`await page.click("#missing")`);
  assert.equal(result.ok, false);
  assert.match(result.error, /PageError: No element matches/);
  console.log("ok  errors surface as tracebacks");

  // 4. A runaway script is killed and the runtime recovers
  if (process.env.E2E_TIMEOUT) {
    result = await run(`while True: pass`);
    assert.match(result.error, /ran longer than/);
    result = await run(`print("alive")`);
    assert.equal(result.stdout, "alive\n");
    console.log("ok  runaway script killed, runtime restarted");
  }

  // 5. Auto-run: a saved script with a matching URL pattern runs on page load
  await panel.evaluate(async (match) => {
    await chrome.storage.local.set({
      scripts: [{ id: "t1", name: "auto", enabled: true, match, code: `await page.set_attr("body", "data-pymonkey", "ran")` }],
    });
  }, pageUrl + "*");
  await page.reload();
  await page.waitForSelector("body[data-pymonkey=ran]", { timeout: 15_000 });
  console.log("ok  saved script auto-runs on matching URL");

  console.log("\nAll end-to-end checks passed.");
} finally {
  await browser.close();
  server.close();
}
