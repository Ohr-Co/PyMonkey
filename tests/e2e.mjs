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
  const start = (code, options = {}) =>
    panel.evaluate(async (code, pageUrl, options) => {
      const { startRun } = await import("/lib/run-client.js");
      const [tab] = await chrome.tabs.query({ url: pageUrl });
      window.__run = startRun(tab.id, code, options);
      return window.__run.started;
    }, code, pageUrl, options);
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

  //    Optional, takes six minutes (E2E_LONG=1): a script with no time limit
  //    that runs past the 5 minutes Chrome allows the background worker for
  //    any single request, touching the page along the way.
  if (process.env.E2E_LONG) {
    const slow = `import asyncio\nfor step in range(11):\n    await asyncio.sleep(30)\n    await page.set_attr("h1", "data-step", str(step))\nprint("finished after 330 seconds")`;
    assert.equal(await start(slow, { timeout: 0 }), true);
    // Ask every few seconds rather than hold one six-minute request open to the
    // browser: puppeteer gives up on any single request after three minutes.
    await panel.evaluate(() => {
      window.__run.result.then((r) => (window.__longResult = r));
    });
    const deadline = Date.now() + 400_000;
    let longResult = null;
    while (!longResult) {
      assert.ok(Date.now() < deadline, "the six-minute script never reported a result");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      longResult = await panel.evaluate(() => window.__longResult ?? null);
    }
    assert.deepEqual(longResult, { ok: true, stdout: "finished after 330 seconds\n", error: null });
    assert.equal(await page.$eval("h1", (el) => el.dataset.step), "10");
    console.log("ok  a script running for 5.5 minutes returns its output");
  }

  // 7. Stopping a run that is still waiting its turn leaves the running one alone.
  const both = await panel.evaluate(async (pageUrl) => {
    const { startRun } = await import("/lib/run-client.js");
    const [tab] = await chrome.tabs.query({ url: pageUrl });
    const first = startRun(tab.id, `import asyncio\nawait asyncio.sleep(1)\nprint("first")`);
    await first.started;
    const second = startRun(tab.id, `print("second")`);
    await second.started;
    await second.stop();
    return { first: await first.result, second: await second.result };
  }, pageUrl);
  assert.equal(both.first.stdout, "first\n");
  assert.deepEqual(both.second, { ok: false, stdout: "", error: "Stopped by user." });
  console.log("ok  a queued run can be stopped");

  // 8. The panel itself: its buttons, fields and output pane.
  // Put `code` in the editor (if given), press Run, and return at once.
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
  const visible = (id) => panel.$eval(`#${id}`, (el) => !el.hidden);

  //    The panel runs on "the active tab", which in this test is the panel
  //    itself: an extension page, where scripts are not allowed.
  await pressRun();
  let shown = await panelOutput();
  assert.match(shown.text, /PyMonkey could not run on this page/);
  assert.equal(shown.isError, true);
  console.log("ok  panel reports a page it cannot run on");

  //    From here on, point it at the test page.
  await panel.evaluate(async (pageUrl) => {
    const [tab] = await chrome.tabs.query({ url: pageUrl });
    chrome.tabs.query = async () => [tab];
  }, pageUrl);
  await pressRun(`print("from the panel:", page.title)`);
  assert.deepEqual(await panelOutput(), { text: "from the panel: clicked\n", isError: false });
  console.log("ok  panel Run button shows the script's output");

  //    Stop: the button appears while a script runs and ends it within a second,
  //    even a script that never gives control back.
  assert.deepEqual([await visible("run"), await visible("stop")], [true, false]);
  await pressRun(`while True: pass`);
  await panel.waitForFunction(() => !document.getElementById("stop").hidden, { timeout: 5_000 });
  assert.equal(await visible("run"), false);
  await new Promise((resolve) => setTimeout(resolve, 1_000)); // let the loop really spin
  const stopClicked = Date.now();
  await panel.click("#stop");
  shown = await panelOutput();
  const stopTook = Date.now() - stopClicked;
  assert.deepEqual(shown, { text: "Stopped by user.", isError: true });
  assert.ok(stopTook < 1_000, `Stop took ${stopTook} ms`);
  assert.deepEqual([await visible("run"), await visible("stop")], [true, false]);
  //    ...and the next run works without reloading anything.
  await pressRun(`print("alive")`);
  assert.deepEqual(await panelOutput(), { text: "alive\n", isError: false });
  console.log(`ok  Stop button ends a busy script (${stopTook} ms), next run works`);

  //    Time limit: the field in the panel decides when a script is cut off.
  assert.equal(await panel.$eval("#timeout", (el) => el.value), "30");
  await panel.$eval("#timeout", (el) => (el.value = "1"));
  await pressRun(`while True: pass`);
  shown = await panelOutput();
  assert.match(shown.text, /ran longer than 1s/);
  await panel.$eval("#timeout", (el) => (el.value = "0")); // no limit: a slow script may finish
  await pressRun(`import asyncio\nawait asyncio.sleep(2)\nprint("slow but done")`);
  assert.deepEqual(await panelOutput(), { text: "slow but done\n", isError: false });
  await panel.reload(); // drop the chrome.tabs.query stand-in
  console.log("ok  time limit follows the panel's field");

  // 9. Auto-run: saved scripts with a matching URL pattern run on page load,
  //    one after the other. The first is cut off by its own 1-second time limit;
  //    the third must see what the second one changed; the fourth prints a lot.
  //    The panel is closed first: auto-run must not depend on it.
  await panel.evaluate(async (match) => {
    const second = `first = page.select_one("body").get("data-pymonkey")\nawait page.set_attr("body", "data-second", f"saw-{first}")`;
    await chrome.storage.local.set({
      scripts: [
        { id: "t0", name: "stuck", enabled: true, match, timeout: 1, code: `while True: pass` },
        { id: "t1", name: "auto", enabled: true, match, code: `await page.set_attr("body", "data-pymonkey", "ran")` },
        { id: "t2", name: "auto 2", enabled: true, match, code: second },
        { id: "t3", name: "chatty", enabled: true, match, code: `print("x" * 300_000)\nprint("the end")` },
      ],
    });
  }, pageUrl + "*");
  await panel.close();
  const reloadedAt = Date.now();
  await page.reload();
  await page.waitForSelector("body[data-pymonkey=ran][data-second=saw-ran]", { timeout: 15_000 });
  console.log("ok  saved scripts auto-run in order on matching URL");

  // 10. Each script's last automatic run was kept while the panel was closed.
  const panel2 = await browser.newPage();
  await panel2.goto(`chrome-extension://${extensionId}/panel/panel.html`);
  const keys = ["t0", "t1", "t2", "t3"].map((id) => `lastRun:${id}`);
  await panel2.waitForFunction(
    async (keys) => Object.keys(await chrome.storage.local.get(keys)).length === keys.length,
    { timeout: 15_000 },
    keys,
  );
  const lastRuns = await panel2.evaluate((keys) => chrome.storage.local.get(keys), keys);
  const stuck = lastRuns["lastRun:t0"];
  assert.equal(stuck.ok, false);
  assert.match(stuck.error, /ran longer than 1s/);
  assert.equal(stuck.url, pageUrl);
  assert.ok(stuck.time >= reloadedAt && stuck.time <= Date.now(), `odd time ${stuck.time}`);
  assert.deepEqual(
    { ...lastRuns["lastRun:t1"], time: 0 },
    { time: 0, url: pageUrl, ok: true, stdout: "", error: null, seen: false },
  );
  //     Stored output is capped: the 300,000 characters were cut to the last 20,000.
  const chatty = lastRuns["lastRun:t3"].stdout;
  assert.ok(chatty.length < 21_000, `stored ${chatty.length} characters`);
  assert.match(chatty, /^\[… \d+ earlier characters not kept\]\nx+\nthe end\n$/);
  console.log("ok  last automatic runs are stored, output capped");

  //     The failure shows on the toolbar icon, without the panel or developer tools...
  const badgeIs = (text) =>
    panel2.waitForFunction(async (text) => (await chrome.action.getBadgeText({})) === text, { timeout: 5_000 }, text);
  await badgeIs("1");
  assert.match(await panel2.evaluate(() => chrome.action.getTitle({})), /1 script failed/);
  //     ...the list in the panel says which script it was...
  const names = await panel2.$$eval("#script-list option", (options) => options.map((o) => o.textContent));
  assert.deepEqual(names, ["(unsaved script)", "stuck (failed)", "auto", "auto 2", "chatty"]);
  assert.equal(await panel2.$eval("#last-run", (el) => el.hidden), true); // nothing selected yet
  //     ...and selecting it shows the run. Having been seen, it leaves the badge.
  const lastRunShown = async (scriptId) => {
    await panel2.select("#script-list", scriptId);
    await panel2.waitForFunction(
      (name) => document.getElementById("name").value === name && !document.getElementById("last-run").hidden,
      { timeout: 5_000 },
      await panel2.$eval(`#script-list option[value=${scriptId}]`, (o) => o.textContent.replace(" (failed)", "")),
    );
    return panel2.evaluate(() => ({
      summary: document.getElementById("last-run-summary").textContent,
      url: document.getElementById("last-run-url").textContent,
      output: document.getElementById("last-run-output").textContent,
      open: document.getElementById("last-run").open,
    }));
  };
  let lastRun = await lastRunShown("t0");
  assert.equal(lastRun.summary, `Last automatic run failed · ${new Date(stuck.time).toLocaleString()}`);
  assert.equal(lastRun.url, pageUrl);
  assert.match(lastRun.output, /ran longer than 1s/);
  assert.equal(lastRun.open, true);
  await badgeIs("");
  lastRun = await lastRunShown("t3");
  assert.match(lastRun.summary, /^Last automatic run succeeded · /);
  assert.match(lastRun.output, /the end\n$/);
  assert.equal(lastRun.open, false);
  console.log("ok  failed auto-run: badge on the toolbar icon, details in the panel");

  //     A new failure brings the badge back; deleting the script removes its last run.
  await page.reload();
  await badgeIs("1");
  await panel2.select("#script-list", "t1");
  await panel2.waitForFunction(() => document.getElementById("name").value === "auto");
  await badgeIs("1"); // looking at another script does not clear it
  await panel2.evaluate(async () => {
    const { deleteScript } = await import("/lib/storage.js");
    await deleteScript("t0");
  });
  await badgeIs("");
  assert.deepEqual(await panel2.evaluate(() => chrome.storage.local.get("lastRun:t0")), {});
  console.log("ok  badge returns on a new failure, a deleted script takes its last run along");

  console.log("\nAll end-to-end checks passed.");
} finally {
  await browser.close();
  server.close();
}
