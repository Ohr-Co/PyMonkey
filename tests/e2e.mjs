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
  const isServiceWorker = (t) => t.type() === "service_worker";
  const swTarget = await browser.waitForTarget(isServiceWorker);
  const extensionId = new URL(swTarget.url()).host;

  const page = await browser.newPage();
  await page.goto(pageUrl);

  // Drive the extension the same way the side panel does: from an extension page.
  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel/panel.html`);

  // Start a script with the same module the panel uses. The run is left on
  // `window.__run` so a test can interfere while it is in flight.
  const start = (code) =>
    panel.evaluate(async (code, pageUrl) => {
      const { startRun } = await import("/lib/run-client.js");
      const [tab] = await chrome.tabs.query({ url: pageUrl });
      window.__run = startRun(tab.id, code);
      return window.__run.started;
    }, code, pageUrl);
  const finish = () => panel.evaluate(() => window.__run.result);
  const run = async (code) => {
    await start(code);
    return finish();
  };

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

  // 5. Chrome shuts the background service worker down in the middle of a run:
  //    the script keeps going, can still reach the page, and its output arrives.
  assert.equal(
    await start(`import asyncio\nawait asyncio.sleep(2)\nawait page.set_attr("h1", "data-late", "yes")\nprint("survived")`),
    true,
  );
  const oldWorker = await browser.waitForTarget(isServiceWorker);
  const stopped = new Promise((resolve) => browser.on("targetdestroyed", (t) => t === oldWorker && resolve()));
  await (await oldWorker.worker()).close();
  await stopped;
  result = await finish();
  assert.deepEqual(result, { ok: true, stdout: "survived\n", error: null });
  assert.equal(await page.$eval("h1", (el) => el.dataset.late), "yes");
  // The result was passed on by a new worker, started by the script's own messages.
  await browser.waitForTarget((t) => isServiceWorker(t) && t !== oldWorker, { timeout: 5_000 });
  console.log("ok  result survives a background worker shutdown");

  // 6. The run itself is lost (here: the whole runtime page goes away).
  //    The panel must be told, not left waiting.
  assert.equal(await start(`import asyncio\nawait asyncio.sleep(60)`), true);
  await panel.evaluate(() => chrome.offscreen.closeDocument());
  result = await finish();
  assert.equal(result.ok, false);
  assert.match(result.error, /result of this run was lost/);
  result = await run(`print("alive")`);
  assert.equal(result.stdout, "alive\n");
  console.log("ok  a lost run is reported, runtime recovers");

  // 7. The panel's own Run button, end to end.
  const pressRun = (code) =>
    panel.evaluate((code) => {
      if (code !== undefined) document.getElementById("code").value = code;
      document.getElementById("output").textContent = "";
      document.getElementById("run").click();
    }, code);
  // Wait for the run to be over and return what the output pane shows.
  const panelOutput = async () => {
    await panel.waitForFunction(
      () => !["", "Running…"].includes(document.getElementById("output").textContent),
      { timeout: 15_000 },
    );
    return panel.$eval("#output", (el) => ({ text: el.textContent, isError: el.classList.contains("error") }));
  };

  //    The panel runs on "the active tab", which in this test is the panel
  //    itself: an extension page, where scripts are not allowed.
  await pressRun();
  const shown = await panelOutput();
  assert.match(shown.text, /PyMonkey could not run on this page/);
  assert.equal(shown.isError, true);
  console.log("ok  panel reports a page it cannot run on");

  //    Then point it at the test page.
  await panel.evaluate(async (pageUrl) => {
    const [tab] = await chrome.tabs.query({ url: pageUrl });
    chrome.tabs.query = async () => [tab];
  }, pageUrl);
  await pressRun(`print("from the panel:", page.title)`);
  assert.deepEqual(await panelOutput(), { text: "from the panel: clicked\n", isError: false });
  await panel.reload(); // drop the chrome.tabs.query stand-in
  console.log("ok  panel Run button shows the script's output");

  // 8. Auto-run: saved scripts with a matching URL pattern run on page load,
  //    one after the other. The second one must see what the first one changed.
  await panel.evaluate(async (match) => {
    const second = `first = page.select_one("body").get("data-pymonkey")\nawait page.set_attr("body", "data-second", f"saw-{first}")`;
    await chrome.storage.local.set({
      scripts: [
        { id: "t1", name: "auto", enabled: true, match, code: `await page.set_attr("body", "data-pymonkey", "ran")` },
        { id: "t2", name: "auto 2", enabled: true, match, code: second },
      ],
    });
  }, pageUrl + "*");
  await page.reload();
  await page.waitForSelector("body[data-pymonkey=ran][data-second=saw-ran]", { timeout: 15_000 });
  console.log("ok  saved scripts auto-run in order on matching URL");

  console.log("\nAll end-to-end checks passed.");
} finally {
  await browser.close();
  server.close();
}
