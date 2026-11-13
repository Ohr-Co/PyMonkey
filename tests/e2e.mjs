// End-to-end test: loads the real extension in Chrome and runs Python on a page.
//
//   npm run test:e2e
//
// Needs "Chrome for Testing" or Chromium (regular Chrome no longer accepts
// --load-extension). Point CHROME_PATH at the binary if it is not found.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
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

// Besides the test page, the servers have a few addresses for page.fetch to call.
// Note what is missing: CORS headers. A web page could not read these from another site.
function serve(req, res) {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/slow") return; // never answers
  if (path === "/login") {
    res.setHeader("Set-Cookie", "session=secret; Path=/");
    res.end("logged in");
  } else if (path === "/missing") {
    res.writeHead(404, "Not Found").end("nothing here");
  } else if (path === "/bytes") {
    res.end(Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  } else if (path === "/latin1") {
    res.setHeader("Content-Type", "text/plain; charset=ISO-8859-1");
    res.end(Buffer.from("café", "latin1"));
  } else if (path === "/echo") {
    // Report the request as JSON.
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          method: req.method,
          query: new URL(req.url, "http://localhost").search,
          cookie: req.headers.cookie ?? null,
          type: req.headers["content-type"] ?? null,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  } else {
    res.end(HTML);
  }
}

const server = http.createServer(serve).listen(0);
const pageUrl = `http://localhost:${server.address().port}/`;
// "Another site": same machine, but a different host name, so a different origin with its own cookies.
const otherServer = http.createServer(serve).listen(0);
const otherUrl = `http://127.0.0.1:${otherServer.address().port}`;

// The browser's profile folder is ours, so the browser can be closed and
// started again with everything the extension stored still in place.
const profilePath = mkdtempSync(join(tmpdir(), "pymonkey-e2e-"));
const launch = () =>
  puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    userDataDir: profilePath,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--no-sandbox"],
  });
let browser = await launch();
// Where this browser puts downloaded files (see the page.download check).
const downloadPath = mkdtempSync(join(tmpdir(), "pymonkey-e2e-downloads-"));

try {
  const isServiceWorker = (t) => t.type() === "service_worker";
  const swTarget = await browser.waitForTarget(isServiceWorker);
  const extensionId = new URL(swTarget.url()).host;

  const page = await browser.newPage();
  // Log in to both sites first, so the browser holds a cookie for each (see the page.fetch checks).
  await page.goto(otherUrl + "/login");
  await page.goto(pageUrl + "login");
  await page.goto(pageUrl);

  // Drive the extension the same way the side panel does: from an extension page.
  let panel = await browser.newPage();
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
  const run = async (code, options) => {
    await start(code, options);
    return finish();
  };

  // 1. Read: snapshot + BeautifulSoup
  let result = await run(`print(page.title)\nprint([a["href"] for a in page.select("a")])`);
  assert.deepEqual(result, { ok: true, stdout: "Test page\n['/one', '/two']\n", error: null });
  console.log("ok  read page with BeautifulSoup");

  // 2. Write: DOM primitives round-trip to the real page. This script is written
  //    the old way, with `await` in front of every write: it must keep working.
  result = await run(
    `await page.set_text("h1", "Changed by Python")\nawait page.fill("#q", "typed")\nawait page.click("#btn")\n` +
      `await page.refresh()\nprint(page.title)`,
  );
  assert.equal(result.error, null);
  assert.equal(result.stdout, "clicked\n");
  assert.equal(await page.$eval("h1", (el) => el.textContent), "Changed by Python");
  assert.equal(await page.$eval("#q", (el) => el.value), "typed");
  console.log("ok  edit page through DOM primitives");

  //    The same without `await`, through all ten write methods. Each call must
  //    have happened on the real page by the time it returns.
  result = await run(
    [
      `print(page.set_text("h1", "No await"))`,
      `page.fill("#q", "typed again")`,
      `page.set_attr("h1", "data-sync", "yes")`,
      `page.set_style("h1", "color: rgb(1, 2, 3)")`,
      `page.insert_html("body", "<p id='new'>new</p><i class='tmp'>1</i><i class='tmp'>2</i>")`,
      `page.wait_for("#new", timeout=2)`,
      `page.set_html("#new", "<b>bold</b>")`,
      `print(page.remove(".tmp"))`,
      `page.set_text("title", "not clicked yet")`,
      `page.click("#btn")`,
      `page.refresh()`,
      `print(page.title, page.select_one("#new b").text, len(page.select(".tmp")))`,
    ].join("\n"),
  );
  assert.deepEqual(result, { ok: true, stdout: "1\n2\nclicked bold 0\n", error: null });
  assert.deepEqual(
    await page.$eval("h1", (el) => [el.textContent, el.dataset.sync, el.style.color]),
    ["No await", "yes", "rgb(1, 2, 3)"],
  );
  assert.equal(await page.$eval("#q", (el) => el.value), "typed again");
  console.log("ok  writes work without await");

  //    An await the runtime cannot see through fails, and says what to do.
  result = await run(`p = page\nawait p.set_text("h1", "Indirect")`);
  assert.equal(result.ok, false);
  assert.match(result.error, /TypeError/);
  assert.match(result.error, /called without `await`/);
  console.log("ok  a leftover await fails with a clear message");

  //    page.store: values a script keeps between runs. `scriptId` is what the
  //    panel sends for a saved script; each one has its own store.
  result = await run(
    `page.store.set("seen", {"urls": ["/one"], "count": 1, "ok": True, "none": None})\nprint(page.store.keys())`,
    { scriptId: "store-a" },
  );
  assert.deepEqual(result, { ok: true, stdout: "['seen']\n", error: null });
  result = await run(`print(page.store.get("seen"))`, { scriptId: "store-a" });
  assert.equal(result.stdout, "{'urls': ['/one'], 'count': 1, 'ok': True, 'none': None}\n");
  result = await run(`print(page.store.get("seen", "nothing here"))`, { scriptId: "store-b" });
  assert.equal(result.stdout, "nothing here\n");
  //    A script that was never saved has no id, so nowhere to keep values.
  result = await run(`page.store.set("k", 1)`);
  assert.equal(result.ok, false);
  assert.match(result.error, /PageError: page\.store keeps values per saved script/);
  //    Extension storage is not endless (about 10 MB for everything). A value
  //    that does not fit is an error in the script, and what was saved stays.
  result = await run(`page.store.set("big", "x" * 11_000_000)`, { scriptId: "store-a" });
  assert.equal(result.ok, false);
  assert.match(result.error, /PageError: .*quota/i);
  result = await run(`print(page.store.keys())`, { scriptId: "store-a" });
  assert.equal(result.stdout, "['seen']\n");
  console.log("ok  page.store keeps values between runs, separately per script");

  //    page.fetch: HTTP requests from a script. The other site sends no CORS
  //    headers; the extension may read it all the same.
  result = await run(
    [
      `r = page.fetch("${otherUrl}/echo", params={"q": "two words"})`,
      `print(r.status, r.ok, r.headers["Content-Type"], r.json())`,
      `r = page.fetch("${otherUrl}/echo", json={"name": "é"})`,
      `print(r.json()["method"], r.json()["type"], r.json()["body"])`,
      `print(page.fetch("/one").soup.select_one("h1").text)`, // relative to the page
      `print(page.fetch("${otherUrl}/latin1").text)`,
      `print(page.fetch("${otherUrl}/bytes").content == bytes(range(256)))`,
    ].join("\n"),
  );
  assert.deepEqual(result, {
    ok: true,
    stdout:
      "200 True application/json {'method': 'GET', 'query': '?q=two+words', 'cookie': None, 'type': None, 'body': ''}\n" +
      `POST application/json {"name": "\\u00e9"}\n` +
      "Hello\ncafé\nTrue\n",
    error: null,
  });
  console.log("ok  page.fetch gets text, JSON and bytes, from the page's site and from another one");

  //    Cookies: the browser is logged in to both sites. A script's request is
  //    made as the logged-in user on the page's own site, and on another site
  //    only when the script asks for that.
  result = await run(
    [
      `print(page.fetch("/echo").json()["cookie"])`,
      `print(page.fetch("${otherUrl}/echo").json()["cookie"])`,
      `print(page.fetch("${otherUrl}/echo", cookies=True).json()["cookie"])`,
      `print(page.fetch("/echo", cookies=False).json()["cookie"])`,
    ].join("\n"),
  );
  assert.deepEqual(result, { ok: true, stdout: "session=secret\nNone\nsession=secret\nNone\n", error: null });
  console.log("ok  page.fetch sends cookies to the page's own site only, unless told otherwise");

  //    When there is no answer the script gets an ordinary exception: it can
  //    catch it, and if it does not, the traceback names it.
  const closed = http.createServer().listen(0);
  const deadUrl = `http://127.0.0.1:${closed.address().port}/`;
  await new Promise((resolve) => closed.close(resolve)); // nothing listens there any more
  result = await run(
    [
      `try:`,
      `    page.fetch("${deadUrl}")`,
      `except OSError as error:`,
      `    print("caught", type(error).__name__)`,
      `r = page.fetch("${otherUrl}/missing")`,
      `print(r.status, r.ok, r.text)`,
      `try:`,
      `    r.raise_for_status()`,
      `except OSError as error:`,
      `    print("caught", error)`,
      `page.fetch("${otherUrl}/slow", timeout=1)`,
    ].join("\n"),
  );
  assert.equal(result.ok, false);
  assert.equal(result.stdout, "caught ConnectionError\n404 False nothing here\ncaught HTTP Error 404: Not Found\n");
  assert.match(result.error, /line 11, in <module>\n[^]*\nTimeoutError: Could not fetch .*\/slow: no answer within 1 seconds/);
  result = await run(`page.fetch("${deadUrl}")`);
  assert.match(result.error, /ConnectionError: Could not fetch http:\/\/127\.0\.0\.1:\d+\/: the server cannot be reached/);
  console.log("ok  page.fetch failures are Python exceptions: no answer, too slow, error status");

  //    page.download: a script saves what it collected as files. Three in a
  //    row, the first with 10,000 rows.
  const cdp = await browser.target().createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath });
  result = await run(
    [
      `rows = [{"n": n, "title": f"Item {n}, café", "url": f"https://example.com/items/{n}"} for n in range(10_000)]`,
      `page.download("items.csv", rows)`,
      `page.download("items.json", rows[:2])`,
      `page.download("notes.txt", "just text")`,
      `print("saved")`,
    ].join("\n"),
  );
  assert.deepEqual(result, { ok: true, stdout: "saved\n", error: null });
  // A download takes a moment to arrive on disk.
  const downloadedFile = async (name) => {
    const path = join(downloadPath, name);
    for (let waited = 0; !existsSync(path); waited += 100) {
      assert.ok(waited < 10_000, `${name} was not downloaded`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return readFileSync(path, "utf8");
  };
  const csvLines = (await downloadedFile("items.csv")).split("\r\n");
  assert.equal(csvLines.length, 10_002); // header + 10,000 rows + the empty string after the last line break
  assert.equal(csvLines[0], "﻿n,title,url"); // starts with the marker Excel needs to read UTF-8
  assert.equal(csvLines[10_000], `9999,"Item 9999, café",https://example.com/items/9999`);
  assert.deepEqual(JSON.parse(await downloadedFile("items.json")), [
    { n: 0, title: "Item 0, café", url: "https://example.com/items/0" },
    { n: 1, title: "Item 1, café", url: "https://example.com/items/1" },
  ]);
  assert.equal(await downloadedFile("notes.txt"), "just text");
  console.log("ok  page.download saves CSV (10,000 rows), JSON and text files");

  // Packages: a bundled package is loaded when a script that imports it runs, not at startup
  const isLoaded = `import importlib.util\nprint([importlib.util.find_spec(m) is not None for m in ("bs4", "dateutil", "tzdata")])`;
  result = await run(isLoaded);
  assert.equal(result.stdout, "[True, False, False]\n"); // BeautifulSoup is preloaded, the others are not there yet
  result = await run(
    `def paris(text):\n    from dateutil import parser\n    from zoneinfo import ZoneInfo\n    return parser.parse(text).replace(tzinfo=ZoneInfo("Europe/Paris"))\n\nprint(paris("3 March 2024, 5pm").isoformat())`,
  );
  assert.equal(result.error, null);
  assert.equal(result.stdout, "2024-03-03T17:00:00+01:00\n");
  result = await run(isLoaded);
  assert.equal(result.stdout, "[True, True, True]\n"); // and they stay loaded for the next script
  console.log("ok  bundled packages load on first import");

  // A package that is not bundled: the error says how to add it
  result = await run(`print("before")\nimport sympy`);
  assert.equal(result.ok, false);
  assert.equal(result.stdout, "before\n");
  assert.match(
    result.error,
    /line 2, in <module>\nModuleNotFoundError: No module named 'sympy'\n\nPyMonkey does not come with the package "sympy", but it can be added:\n  1\. In scripts\/setup\.mjs, add "sympy" to BUNDLED_PACKAGES\.\n  2\. In the project folder, run `npm run setup`\.\n  3\. Reload PyMonkey at chrome:\/\/extensions\.\n$/,
  );
  result = await run(`import openpyxl`); // Pyodide has no such package
  assert.match(result.error, /No module named 'openpyxl'\n\nPython in PyMonkey has no module named "openpyxl", and none of the packages that can be added has one\./);
  // A script that copes with the missing package is left alone.
  result = await run(`try:\n    import sympy\nexcept ImportError:\n    print("doing without")`);
  assert.deepEqual([result.ok, result.stdout], [true, "doing without\n"]);
  console.log("ok  importing a package that is not bundled says how to add it");

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
  // The editor is CodeMirror, which can be asked for the editor that lives in an element.
  const editorText = () =>
    panel.evaluate(async () => {
      const { EditorView } = await import("/vendor/codemirror/codemirror.js");
      return EditorView.findFromDOM(document.getElementById("code")).state.doc.toString();
    });
  // Replace the editor's text the way an edit by the user does.
  const setEditorText = (text) =>
    panel.evaluate(async (text) => {
      const { EditorView } = await import("/vendor/codemirror/codemirror.js");
      const view = EditorView.findFromDOM(document.getElementById("code"));
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    }, text);
  // Put `code` in the editor (if given), press Run, and return at once.
  const pressRun = async (code) => {
    if (code !== undefined) await setEditorText(code);
    await panel.evaluate(() => {
      document.getElementById("output").textContent = "";
      document.getElementById("run").click();
    });
  };
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

  //    page.store from the panel: an unsaved script is told to save first.
  //    Once saved, each press of Run finds what the one before left.
  await pressRun(`runs = page.store.get("runs", 0) + 1\npage.store.set("runs", runs)\nprint("run", runs)`);
  shown = await panelOutput();
  assert.match(shown.text, /Save this script, then run it again/);
  assert.equal(shown.isError, true);
  await panel.click("#save");
  await panel.waitForFunction(() => document.getElementById("script-list").value !== "", { timeout: 5_000 });
  await pressRun();
  assert.deepEqual(await panelOutput(), { text: "run 1\n", isError: false });
  await pressRun();
  assert.deepEqual(await panelOutput(), { text: "run 2\n", isError: false });
  //    The Delete button takes the script's saved values with it: all that is
  //    left is what check 2 saved.
  const storeKeys = () =>
    panel.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("store:")));
  assert.equal((await storeKeys()).length, 2);
  await panel.click("#delete");
  await panel.waitForFunction(() => document.getElementById("script-list").options.length === 1, { timeout: 5_000 });
  assert.deepEqual(await storeKeys(), ["store:store-a"]);
  console.log("ok  panel: page.store needs a saved script, counts its runs, is deleted with it");

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

  // 8b. The code editor.
  const panelUrl = `chrome-extension://${extensionId}/panel/panel.html`;
  // The panel is ready once it has read the saved scripts and filled its fields.
  const panelReady = () => panel.waitForSelector("#script-list option", { timeout: 5_000 });
  const closeAndReopenPanel = async () => {
    await panel.close();
    panel = await browser.newPage();
    await panel.goto(panelUrl);
    await panelReady();
  };
  const pressWith = async (modifier, key) => {
    await panel.keyboard.down(modifier);
    await panel.keyboard.press(key);
    await panel.keyboard.up(modifier);
  };
  const selectAll = () => pressWith(process.platform === "darwin" ? "Meta" : "Control", "a");

  //     The reload above was a first test: the fields came back as they were left.
  await panelReady();
  assert.match(await editorText(), /slow but done/);
  assert.equal(await panel.$eval("#timeout", (el) => el.value), "0");

  //     Typing: Enter after a colon goes one level deeper, Shift+Tab comes back
  //     out, Tab moves to the next level wherever the cursor is.
  await panel.click("#code .cm-content");
  await selectAll();
  await panel.keyboard.press("Backspace");
  await panel.keyboard.type("def f(x):\nif x:\nreturn 1\n");
  await pressWith("Shift", "Tab");
  await panel.keyboard.type("y = 2");
  await panel.keyboard.press("Tab");
  await panel.keyboard.type("# end");
  const typed = "def f(x):\n    if x:\n        return 1\n    y = 2   # end";
  assert.equal(await editorText(), typed);
  //     With lines selected, Tab and Shift+Tab move them all.
  await selectAll();
  await panel.keyboard.press("Tab");
  assert.equal(await editorText(), typed.replace(/^/gm, "    "));
  await pressWith("Shift", "Tab");
  assert.equal(await editorText(), typed);
  console.log("ok  editor: Enter indents after a colon, Tab and Shift+Tab indent and dedent");

  //     Highlighting, in light and dark mode: keywords are bold, strings and
  //     comments have their own color, and all of it can be read (contrast of
  //     4.5 to 1 or better against the background).
  await setEditorText(`def f(x):\n    return "text"  # note\n`);
  const editorColors = () =>
    panel.evaluate(() => {
      const visible = (color) => color !== "transparent" && !/, 0\)$/.test(color);
      // The color behind an element: its own background, or the nearest one up the tree, or the page's.
      const backgroundOf = (el) => {
        for (; el; el = el.parentElement) {
          const color = getComputedStyle(el).backgroundColor;
          if (visible(color)) return color;
        }
        const probe = document.body.appendChild(document.createElement("div"));
        probe.style.backgroundColor = "Canvas";
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      };
      const piece = (selector, text) => {
        const el = [...document.querySelectorAll(`#code ${selector}`)].find((el) => el.textContent === text);
        const style = getComputedStyle(el);
        return { color: style.color, background: backgroundOf(el), weight: Number(style.fontWeight), italic: style.fontStyle === "italic" };
      };
      return {
        plain: piece("span", "x"),
        keyword: piece("span", "def"),
        name: piece("span", "f"),
        string: piece("span", '"text"'),
        comment: piece("span", "# note"),
        lineNumber: piece(".cm-gutterElement", "2"),
      };
    });
  const luminance = (color) => {
    const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map((part) => {
      const c = Number(part) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = ({ color, background }) => {
    const [dark, light] = [luminance(color), luminance(background)].sort((a, b) => a - b);
    return (light + 0.05) / (dark + 0.05);
  };
  for (const scheme of ["light", "dark"]) {
    await panel.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    const colors = await editorColors();
    assert.ok(colors.keyword.weight >= 600 && colors.name.weight >= 600 && colors.plain.weight === 400, scheme);
    assert.notEqual(colors.string.color, colors.plain.color, scheme);
    assert.notEqual(colors.comment.color, colors.plain.color, scheme);
    assert.notEqual(colors.comment.color, colors.string.color, scheme);
    assert.equal(colors.comment.italic, true, scheme);
    for (const [what, piece] of Object.entries(colors)) {
      assert.ok(contrast(piece) >= 4.5, `${scheme} mode: ${what} is ${piece.color} on ${piece.background}`);
    }
    //   Light mode is dark text on a light background, dark mode the reverse.
    const textIsDark = luminance(colors.plain.color) < luminance(colors.plain.background);
    assert.equal(textIsDark, scheme === "light", scheme);
  }
  await panel.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  console.log("ok  editor: Python is highlighted and readable in light and dark mode");

  //     The editor is part of the extension: the panel loads nothing from elsewhere.
  //     (Watch every request the panel makes while it loads again.)
  const loaded = [];
  const noteRequest = (request) => loaded.push(request.url());
  panel.on("request", noteRequest);
  await panel.reload();
  await panelReady();
  await panel.waitForSelector("#code .cm-content");
  panel.off("request", noteRequest);
  assert.ok(loaded.includes(`chrome-extension://${extensionId}/vendor/codemirror/codemirror.js`), loaded.join("\n"));
  assert.deepEqual(loaded.filter((url) => !url.startsWith(`chrome-extension://${extensionId}/`)), []);
  console.log("ok  editor: the library is loaded from inside the extension");

  //     Unsaved work survives closing the panel. First a script that was never saved...
  await setEditorText(`print("never saved")`);
  await panel.type("#name", "Draft");
  await panel.type("#match", "https://example.com/*");
  await panel.click("#enabled");
  await closeAndReopenPanel();
  const fields = () =>
    panel.evaluate(() => ({
      selected: document.getElementById("script-list").selectedOptions[0].textContent,
      name: document.getElementById("name").value,
      match: document.getElementById("match").value,
      enabled: document.getElementById("enabled").checked,
      timeout: document.getElementById("timeout").value,
    }));
  assert.equal(await editorText(), `print("never saved")`);
  assert.deepEqual(await fields(), {
    selected: "(unsaved script)", name: "Draft", match: "https://example.com/*", enabled: false, timeout: "0",
  });
  //     ...then a saved script with a change that was not saved: the change
  //     comes back in the panel, and the saved script is still the old one.
  await panel.click("#save");
  await panel.waitForFunction(() => document.getElementById("script-list").value !== "", { timeout: 5_000 });
  await panel.click("#code .cm-content");
  await selectAll();
  await panel.keyboard.type(`print("changed, not saved")`);
  await closeAndReopenPanel();
  assert.equal(await editorText(), `print("changed, not saved")`);
  assert.equal((await fields()).selected, "Draft");
  const savedCode = () => panel.evaluate(async () => (await chrome.storage.local.get("scripts")).scripts.map((s) => s.code));
  assert.deepEqual(await savedCode(), [`print("never saved")`]);
  //     Undo goes back over the typing, but not into another script's text.
  await panel.click("#save");
  await panel.waitForFunction(async () => (await chrome.storage.local.get("scripts")).scripts[0].code.includes("changed"));
  await panel.click("#new");
  await panel.click("#code .cm-content");
  await pressWith(process.platform === "darwin" ? "Meta" : "Control", "z");
  assert.match(await editorText(), /^# `page` is the page you are looking at/);
  //     A script without changes is shown as it is saved now, not as it was when the panel closed.
  await panel.select("#script-list", await panel.$eval("#script-list option:nth-child(2)", (o) => o.value));
  await panel.waitForFunction(() => document.getElementById("name").value === "Draft");
  await panel.evaluate(async () => {
    const { scripts } = await chrome.storage.local.get("scripts");
    await chrome.storage.local.set({ scripts: [{ ...scripts[0], code: `print("changed elsewhere")` }] });
  });
  await closeAndReopenPanel();
  assert.equal(await editorText(), `print("changed elsewhere")`);
  await panel.click("#delete");
  await panel.waitForFunction(() => document.getElementById("script-list").options.length === 1, { timeout: 5_000 });
  await closeAndReopenPanel();
  assert.match(await editorText(), /^# `page` is the page you are looking at/); // nothing left over from the deleted script
  console.log("ok  editor: unsaved text survives closing and reopening the panel");

  // 9. Auto-run: saved scripts with a matching URL pattern run on page load,
  //    one after the other. The first is cut off by its own 1-second time limit;
  //    the second also counts its runs in page.store; the third must see what
  //    the second one changed; the fourth prints a lot.
  //    The panel is closed first: auto-run must not depend on it.
  await panel.evaluate(async (match) => {
    const first = `await page.set_attr("body", "data-pymonkey", "ran")\npage.store.set("loads", page.store.get("loads", 0) + 1)`;
    const second = `first = page.select_one("body").get("data-pymonkey")\nawait page.set_attr("body", "data-second", f"saw-{first}")`;
    await chrome.storage.local.set({
      scripts: [
        { id: "t0", name: "stuck", enabled: true, match, timeout: 1, code: `while True: pass` },
        { id: "t1", name: "auto", enabled: true, match, code: first },
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
  //     An automatic run uses its script's page.store: "auto" has now counted two page loads.
  await panel2.waitForFunction(
    async () => (await chrome.storage.local.get("store:t1"))["store:t1"]?.loads === "2",
    { timeout: 10_000 },
  );
  await panel2.evaluate(async () => {
    const { deleteScript } = await import("/lib/storage.js");
    await deleteScript("t0");
  });
  await badgeIs("");
  assert.deepEqual(await panel2.evaluate(() => chrome.storage.local.get("lastRun:t0")), {});
  console.log("ok  badge returns on a new failure, a deleted script takes its last run along");
  console.log("ok  automatic runs keep their own page.store between page loads");

  // 11. page.store survives a browser restart: close the browser, start it
  //     again on the same profile, and read what check 2 saved.
  await browser.close();
  browser = await launch();
  const restarted = await browser.waitForTarget(isServiceWorker);
  assert.equal(new URL(restarted.url()).host, extensionId);
  await (await browser.newPage()).goto(pageUrl);
  panel = await browser.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel/panel.html`);
  result = await run(`print(page.store.get("seen")["urls"])`, { scriptId: "store-a" });
  assert.deepEqual(result, { ok: true, stdout: "['/one']\n", error: null });
  //     Deleting a script deletes what it saved.
  await panel.evaluate(async () => {
    const { deleteScript } = await import("/lib/storage.js");
    await deleteScript("store-a");
  });
  result = await run(`print(page.store.get("seen", "gone"))`, { scriptId: "store-a" });
  assert.equal(result.stdout, "gone\n");
  console.log("ok  page.store survives a browser restart, and goes when its script is deleted");

  console.log("\nAll end-to-end checks passed.");
} finally {
  await browser.close();
  server.close();
  otherServer.close();
  rmSync(downloadPath, { recursive: true, force: true });
  rmSync(profilePath, { recursive: true, force: true });
}
