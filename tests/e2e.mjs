// End-to-end test: loads the real extension in Chrome and runs Python on a page.
//
//   npm run test:e2e
//
// Needs "Chrome for Testing" or Chromium (regular Chrome no longer accepts
// --load-extension). Point CHROME_PATH at the binary if it is not found.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { copyExtension } from "./extension-copy.mjs";

// The browser loads a copy of the extension that has been allowed on the test
// sites, as if the user had said yes to each (extension-copy.mjs says why).
const realExtensionPath = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const extension = copyExtension(realExtensionPath);
const extensionPath = extension.path;
const chromePath =
  process.env.CHROME_PATH ??
  ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);

const HTML = `<!doctype html><title>Test page</title>
<h1>Hello</h1><a href="/one">One</a><a href="/two">Two</a>
<input id="q"><button id="btn" onclick="document.title='clicked'">Go</button>`;

// Besides the test page, the servers have a few addresses for page.fetch to call.
// Note what is missing: CORS headers. A web page could not read these from
// another site, and neither can PyMonkey from a site it has not been allowed on.
function serve(req, res) {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/slow") return; // never answers
  if (path === "/cors") {
    // The exception: this address says that any site may read it.
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.end("for everyone");
  }
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
// A third site, which PyMonkey has NOT been allowed on: the first server under
// another name (to Chrome, every name that ends in .localhost is this machine).
const blockedUrl = `http://not-allowed.localhost:${server.address().port}/`;
const blockedSite = blockedUrl + "*"; // the site as Chrome names it when asked for access

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

  // The line at the top of the panel says what Python is doing. Opening the
  // panel starts loading it, which takes a few seconds the first time.
  const status = () => panel.$eval("#status", (el) => ({ state: el.dataset.state, text: el.textContent }));
  assert.deepEqual(await status(), { state: "loading", text: "Loading Python…" });
  await panel.waitForFunction(() => document.getElementById("status").dataset.state !== "loading", { timeout: 60_000 });
  assert.deepEqual(await status(), { state: "ready", text: "Ready" });
  console.log("ok  panel status: Loading Python… when it opens, then Ready");

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

  // 0. The icons. Chrome picks a size by where it shows the icon: 16 or 32 px
  //    on the toolbar, 48 on the extensions page, 128 in the Web Store.
  //    Each one must load from inside the extension, and show up on a light
  //    toolbar and on a dark one: at least a tenth of it stands out from
  //    Chrome's white toolbar, and a tenth from its dark gray one (a contrast
  //    of 3 to 1 or more, the usual measure for shapes).
  const icons = await panel.evaluate(async () => {
    const { icons, action } = chrome.runtime.getManifest();
    const seen = { sameOnToolbar: JSON.stringify(action.default_icon) === JSON.stringify(icons) };
    for (const [size, path] of Object.entries(icons)) {
      const image = new Image();
      image.src = chrome.runtime.getURL(path);
      await image.decode(); // fails if the file is missing or not a picture
      // Draw it on a canvas to get at its pixels: 4 numbers each (red, green, blue, opacity).
      const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      // How bright a color looks, from 0 (black) to 1 (white), and the contrast between two such values.
      const luminance = (r, g, b) => {
        const [R, G, B] = [r, g, b].map((c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4));
        return 0.2126 * R + 0.7152 * G + 0.0722 * B;
      };
      const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const lightToolbar = luminance(255, 255, 255);
      const darkToolbar = luminance(0x35, 0x36, 0x3a);
      let onLight = 0;
      let onDark = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] < 200) continue; // see-through: the toolbar shows here
        const pixel = luminance(pixels[i], pixels[i + 1], pixels[i + 2]);
        if (contrast(pixel, lightToolbar) >= 3) onLight++;
        if (contrast(pixel, darkToolbar) >= 3) onDark++;
      }
      const area = canvas.width * canvas.height;
      seen[size] = { width: image.naturalWidth, height: image.naturalHeight, onLight: onLight / area, onDark: onDark / area };
    }
    return seen;
  });
  assert.equal(icons.sameOnToolbar, true);
  for (const size of [16, 32, 48, 128]) {
    const icon = icons[size];
    assert.deepEqual({ width: icon.width, height: icon.height }, { width: size, height: size });
    assert.ok(icon.onLight >= 0.1 && icon.onDark >= 0.1, `${size} px: ${JSON.stringify(icon)}`);
  }
  console.log("ok  icons load at 16, 32, 48 and 128 px and stand out from a light and a dark toolbar");

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

  // 6b. Memory. Python stays loaded from one run to the next (a value left in
  //     the `builtins` module is still there), but the page it was given does not.
  const KEEP_SOUP = `import builtins, weakref
builtins.pymonkey_soup = weakref.ref(page.soup)
print(builtins.pymonkey_soup() is None)`;
  result = await run(KEEP_SOUP); // a weak reference: it does not keep the tree alive, it only tells whether it still is
  assert.deepEqual(result, { ok: true, stdout: "False\n", error: null });
  const SAME_PYTHON = `import builtins
print(hasattr(builtins, "pymonkey_soup"))`;
  result = await run(`${SAME_PYTHON}
print(builtins.pymonkey_soup() is None)`);
  assert.deepEqual(result, { ok: true, stdout: "True\nTrue\n", error: null });
  console.log("ok  the page snapshot is released when the run is over");

  //     A run that makes Python's memory grow by more than 64 MB: Python is
  //     started afresh behind it, which is the only way to give that back.
  result = await run(`big = bytearray(100 * 1024 * 1024)
print(len(big))`);
  assert.deepEqual(result, { ok: true, stdout: "104857600\n", error: null });
  result = await run(SAME_PYTHON);
  assert.deepEqual(result, { ok: true, stdout: "False\n", error: null });
  console.log("ok  Python is restarted after a run that needed a lot of memory");

  //     With nothing to do, the runtime page closes itself: after five minutes,
  //     or after the two seconds this one is opened with.
  const runtimePages = () =>
    panel.evaluate(async () => {
      const pages = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      return pages.map((context) => new URL(context.documentUrl).pathname + new URL(context.documentUrl).search);
    });
  const pythonWorkers = () => browser.targets().filter((t) => t.url().endsWith("/worker/pyodide-worker.js")).length;
  assert.deepEqual(await runtimePages(), ["/offscreen/offscreen.html"]);
  await panel.evaluate(async () => {
    await chrome.offscreen.closeDocument();
    await chrome.offscreen.createDocument({
      url: "offscreen/offscreen.html?idle=2",
      reasons: ["WORKERS"],
      justification: "The runtime page, with a short idle period for the test.",
    });
  });
  //     A run is not "nothing to do", however long it takes.
  result = await run(`import asyncio
await asyncio.sleep(4)
print("not interrupted")`);
  assert.deepEqual(result, { ok: true, stdout: "not interrupted\n", error: null });
  const finishedAt = Date.now();
  assert.deepEqual(await runtimePages(), ["/offscreen/offscreen.html?idle=2"]);
  assert.equal(pythonWorkers(), 1);
  while ((await runtimePages()).length > 0) {
    assert.ok(Date.now() - finishedAt < 10_000, "the runtime page is still open 10 seconds after its last run");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(Date.now() - finishedAt >= 1_500, "the runtime page closed before its idle period was over");
  assert.equal(pythonWorkers(), 0);
  console.log("ok  the runtime shuts down when it has had nothing to do for a while");

  //     The next run opens a new one (with the ordinary idle period) and loads Python again.
  result = await run(`print(len(page.select("a")))`);
  assert.deepEqual(result, { ok: true, stdout: "2\n", error: null });
  assert.deepEqual(await runtimePages(), ["/offscreen/offscreen.html"]);
  assert.equal(pythonWorkers(), 1);
  console.log("ok  the runtime is loaded again when a script needs it");

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
  // The output pane's own state: running, done, stopped or error.
  const outputState = () => panel.$eval("#output", (el) => el.dataset.state);

  //    The panel runs on "the active tab", which in this test is the panel
  //    itself: an extension page, where scripts are not allowed.
  await pressRun();
  let shown = await panelOutput();
  assert.match(shown.text, /PyMonkey could not run on this page/);
  assert.equal(shown.isError, true);
  assert.deepEqual(await status(), { state: "error", text: "Script failed" });
  console.log("ok  panel reports a page it cannot run on");

  //    From here on, point it at the test page.
  await panel.evaluate(async (pageUrl) => {
    const [tab] = await chrome.tabs.query({ url: pageUrl });
    chrome.tabs.query = async () => [tab];
  }, pageUrl);
  await pressRun(`print("from the panel:", page.title)`);
  assert.deepEqual(await panelOutput(), { text: "from the panel: clicked\n", isError: false });
  assert.deepEqual(await status(), { state: "ready", text: "Ready" }); // the error above is over
  assert.equal(await outputState(), "done");
  console.log("ok  panel Run button shows the script's output");

  //    A script that goes wrong: what it printed, then the traceback, marked as an error.
  await pressRun(`print("before")\n1 / 0`);
  shown = await panelOutput();
  assert.match(shown.text, /^before\n[\s\S]*ZeroDivisionError/);
  assert.equal(shown.isError, true);
  assert.deepEqual(await status(), { state: "error", text: "Script failed" });
  assert.equal(await outputState(), "error");
  console.log("ok  panel shows a failed script as an error, in the output and in the status");

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
  assert.deepEqual(await status(), { state: "running", text: "Running…" });
  assert.equal(await outputState(), "running");
  await new Promise((resolve) => setTimeout(resolve, 1_000)); // let the loop really spin
  const stopClicked = Date.now();
  await panel.click("#stop");
  shown = await panelOutput();
  const stopTook = Date.now() - stopClicked;
  assert.deepEqual(shown, { text: "Stopped by user.", isError: true });
  assert.ok(stopTook < 1_000, `Stop took ${stopTook} ms`);
  assert.deepEqual([await visible("run"), await visible("stop")], [true, false]);
  //    Stopped is a state of its own: the script did not fail, the user ended it.
  assert.deepEqual(await status(), { state: "stopped", text: "Stopped" });
  assert.equal(await outputState(), "stopped");
  //    ...and the next run works without reloading anything.
  await pressRun(`print("alive")`);
  assert.deepEqual(await panelOutput(), { text: "alive\n", isError: false });
  assert.deepEqual(await status(), { state: "ready", text: "Ready" });
  console.log(`ok  Stop button ends a busy script (${stopTook} ms), next run works`);

  //    Time limit: the field in the panel decides when a script is cut off.
  assert.equal(await panel.$eval("#timeout", (el) => el.value), "30");
  await panel.$eval("#timeout", (el) => (el.value = "1"));
  await pressRun(`while True: pass`);
  shown = await panelOutput();
  assert.match(shown.text, /ran longer than 1s/);
  assert.deepEqual(await status(), { state: "stopped", text: "Stopped" }); // cut off, which is not a failure of the script either
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
  //     How parts of the panel look. Each item names an element by its CSS
  //     selector, and by its text where several match; `part` picks a piece
  //     of it that is not an element of its own, such as "::placeholder".
  const looks = (items) =>
    panel.evaluate((items) => {
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
      return Object.fromEntries(
        items.map(({ what, selector, text, part }) => {
          const el = [...document.querySelectorAll(selector)].find((el) => text === undefined || el.textContent === text);
          const style = getComputedStyle(el, part);
          const look = {
            color: style.color,
            background: backgroundOf(el),
            border: style.borderTopColor,
            around: backgroundOf(el.parentElement), // what the border is seen against
            weight: Number(style.fontWeight),
            italic: style.fontStyle === "italic",
          };
          return [what, look];
        }),
      );
    }, items);
  const editorColors = () =>
    looks([
      { what: "plain", selector: "#code span", text: "x" },
      { what: "keyword", selector: "#code span", text: "def" },
      { what: "name", selector: "#code span", text: "f" },
      { what: "string", selector: "#code span", text: '"text"' },
      { what: "comment", selector: "#code span", text: "# note" },
      { what: "lineNumber", selector: "#code .cm-gutterElement", text: "2" },
    ]);
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

  // 8c. Scripts as .py files. Export saves the script in the fields, with a
  //     header comment that holds its name, match pattern and time limit.
  const storedScripts = () =>
    panel.evaluate(async () => (await chrome.storage.local.get("scripts")).scripts.map(({ id, ...rest }) => rest));
  const outputText = () => panel.$eval("#output", (el) => el.textContent);
  await panel.type("#name", "Shop: prices");
  await panel.type("#match", "https://example.com/shop/*");
  await panel.$eval("#timeout", (el) => el.select()); // select what is there, so that typing replaces it
  await panel.type("#timeout", "45");
  await setEditorText(`print("exported")\n`);
  await panel.click("#export");
  const exported = await downloadedFile("Shop- prices.py"); // a file name cannot hold a colon
  assert.equal(
    exported,
    [
      "# ==PyMonkey==",
      "# @name     Shop: prices",
      "# @match    https://example.com/shop/*",
      "# @timeout  45",
      "# ==/PyMonkey==",
      "",
      `print("exported")`,
      "",
    ].join("\n"),
  );
  assert.deepEqual(await storedScripts(), []); // exporting does not save
  console.log("ok  export downloads a .py file with a header holding name and match pattern");

  //     Import three files at once: the exported one, a plain .py file without
  //     a header, and one that is not text. The first two become scripts.
  const plainPath = join(downloadPath, "plain script.py");
  const binaryPath = join(downloadPath, "picture.py");
  writeFileSync(plainPath, `print("plain")\r\n`);
  writeFileSync(binaryPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13]));
  const chooseFiles = async (...paths) => (await panel.$("#import-file")).uploadFile(...paths);
  await chooseFiles(join(downloadPath, "Shop- prices.py"), plainPath, binaryPath);
  await panel.waitForFunction(() => document.getElementById("output").textContent.includes("picture.py"), { timeout: 5_000 });
  assert.deepEqual(await storedScripts(), [
    //   Read from the header. Switched off: it must not start running on its own before it was read.
    { name: "Shop: prices", match: "https://example.com/shop/*", enabled: false, timeout: 45, code: `print("exported")\n` },
    //   No header: named after the file, runs by hand only.
    { name: "plain script", match: "", enabled: true, timeout: 30, code: `print("plain")\n` },
  ]);
  const notices = (await outputText()).split("\n");
  assert.match(notices[0], /^Imported "Shop: prices" from Shop- prices\.py\. It is switched off\./);
  assert.equal(notices[1], `Imported "plain script" from plain script.py. It runs only when you press Run.`);
  assert.equal(notices[2], "Could not import picture.py: it is not a text file.");
  //     The fields held a script that was not saved, so they were left alone.
  assert.match(notices[3], /^The editor still shows what you were working on/);
  assert.equal(await editorText(), `print("exported")\n`);
  assert.deepEqual(await panel.$$eval("#script-list option", (options) => options.map((o) => o.textContent)), [
    "(unsaved script)", "Shop: prices", "plain script",
  ]);
  assert.equal((await fields()).selected, "(unsaved script)");
  //     With nothing to lose, the imported script is shown, ready to be read.
  await panel.click("#new");
  await chooseFiles(join(downloadPath, "Shop- prices.py"));
  await panel.waitForFunction(() => document.getElementById("name").value === "Shop: prices", { timeout: 5_000 });
  assert.equal(await editorText(), `print("exported")\n`);
  assert.deepEqual(await fields(), {
    selected: "Shop: prices", name: "Shop: prices", match: "https://example.com/shop/*", enabled: false, timeout: "45",
  });
  assert.equal((await storedScripts()).length, 3); // importing a file again makes another script
  assert.equal((await outputText()).split("\n").length, 1);
  await panel.click("#new");
  console.log("ok  import creates scripts from .py files, with or without a header");

  // 8d. The panel's keys and looks.
  //     Ctrl+Enter runs and Ctrl+S saves, wherever in the panel the keyboard
  //     is. (On a Mac the Cmd key is the usual one; the panel takes either.)
  await panel.evaluate(async (pageUrl) => {
    const [tab] = await chrome.tabs.query({ url: pageUrl });
    chrome.tabs.query = async () => [tab]; // "the active tab" is the test page again
  }, pageUrl);
  const clearOutput = () => panel.$eval("#output", (el) => (el.textContent = ""));
  const saveState = () => panel.$eval("#save-state", (el) => el.textContent);
  assert.equal(await saveState(), ""); // a new script that nobody typed in
  await setEditorText(`print("by keyboard")`);
  assert.equal(await saveState(), "Not saved");
  //     From inside the editor, where Ctrl+Enter would otherwise start a new line.
  await panel.click("#code .cm-content");
  await clearOutput();
  await pressWith("Control", "Enter");
  assert.deepEqual(await panelOutput(), { text: "by keyboard\n", isError: false });
  assert.equal(await editorText(), `print("by keyboard")`);
  //     From a field, with the other key.
  await panel.type("#name", "Keys");
  await clearOutput();
  await pressWith("Meta", "Enter");
  assert.deepEqual(await panelOutput(), { text: "by keyboard\n", isError: false });
  await pressWith("Meta", "s");
  await panel.waitForFunction(() => document.getElementById("script-list").selectedOptions[0].textContent === "Keys", { timeout: 5_000 });
  assert.equal(await saveState(), "Saved");
  //     A change made after saving is pointed out, until it is saved too.
  await panel.click("#code .cm-content");
  await selectAll();
  await panel.keyboard.type(`print("saved by keyboard")`);
  assert.equal(await saveState(), "Unsaved changes");
  await pressWith("Control", "s");
  await panel.waitForFunction(() => document.getElementById("save-state").textContent === "Saved", { timeout: 5_000 });
  assert.equal(await editorText(), `print("saved by keyboard")`); // the keys themselves typed nothing
  assert.equal((await storedScripts()).find((s) => s.name === "Keys").code, `print("saved by keyboard")`);
  console.log("ok  keyboard: Ctrl/Cmd+Enter runs and Ctrl/Cmd+S saves, also from inside the editor");

  //     While a script runs, Stop takes the place of Run. A keyboard that was
  //     on Run is on Stop then, and back on Run when the script has ended.
  await setEditorText(`while True: pass`);
  await panel.focus("#run");
  await panel.keyboard.press("Enter");
  await panel.waitForFunction(() => document.activeElement.id === "stop", { timeout: 5_000 });
  await panel.keyboard.press("Enter");
  await panel.waitForFunction(() => document.activeElement.id === "run", { timeout: 5_000 });
  assert.deepEqual(await status(), { state: "stopped", text: "Stopped" });
  console.log("ok  keyboard: the focus goes from Run to Stop and back");

  //     Looks. At 320 px, the narrowest the panel is made for, nothing sticks
  //     out and the panel does not scroll sideways. (With the longest note on
  //     whether the script is saved, which shares a line with three buttons.)
  //     And with the three notices about site access showing (see 8e), each
  //     with an address in it, which is one long word.
  const showNotices = () =>
    panel.evaluate(() => {
      for (const notice of document.querySelectorAll(".notice")) {
        notice.hidden = false;
        notice.querySelector("span").textContent =
          "No access to https://a-rather-long-name.of-a-site.example.com/* yet, so this script will not run there by itself.";
      }
    });
  await panel.setViewport({ width: 320, height: 640 });
  assert.equal(await saveState(), "Unsaved changes");
  await showNotices();
  const misfits = await panel.evaluate(() => {
    const found = [];
    if (document.documentElement.scrollWidth > innerWidth) found.push("the panel scrolls sideways");
    for (const el of document.querySelectorAll("h1, #status, #save-state, button, input, select, label, #code, pre, .notice")) {
      const box = el.getBoundingClientRect();
      if (box.width === 0) continue; // not shown
      if (box.left < 0 || box.right > innerWidth) found.push(`${el.id || el.textContent.trim()} sticks out`);
    }
    return found;
  });
  assert.deepEqual(misfits, []);
  console.log("ok  looks: everything fits in a panel 320 px wide");

  //     Colors, in light and dark mode. All text can be read (4.5 to 1 against
  //     what is behind it), the outlines of fields and buttons can be seen
  //     (3 to 1), and so can the ring around whatever has the keyboard's focus.
  //     Everything is black, white or gray, except an error.
  const texts = [
    { what: "status", selector: "#status" },
    { what: "output", selector: "#output" },
    { what: "last run", selector: "#last-run-summary" },
    { what: "last run output", selector: "#last-run-output" },
    { what: "last run address", selector: "#last-run-url" },
    { what: "title", selector: "h1" },
    { what: "label Name", selector: "label:has(#name)" },
    { what: "label Run automatically on", selector: "label[for=match]" },
    { what: "label Enabled", selector: "label:has(#enabled)" },
    { what: "label Time limit", selector: "label:has(#timeout)" },
    { what: "list of scripts", selector: "#script-list" },
    { what: "name", selector: "#name" },
    { what: "example in an empty Name", selector: "#name", part: "::placeholder" },
    { what: "example in an empty pattern", selector: "#match", part: "::placeholder" },
    { what: "time limit", selector: "#timeout" },
    ...["new", "import", "export", "delete", "run", "stop", "save"].map((id) => ({ what: `button ${id}`, selector: `#${id}` })),
    { what: "shortcut on Run", selector: "#run kbd" },
    { what: "shortcut on Save", selector: "#save kbd" },
    { what: "saved or not", selector: "#save-state" },
    ...["match-access", "tab-access", "fetch-access"].map((id) => ({ what: `notice ${id}`, selector: `#${id} span` })),
    { what: "button Allow", selector: "#match-access button" },
  ];
  const outlined = ["#script-list", "#new", "#name", "#match", "#timeout", "#code", "#save", "#match-access button"];
  //     The checks in 8 saw real runs put the panel in each of its states.
  //     Here each state is put on by hand, to look at its colors.
  const dressAs = async (state) => {
    await panel.evaluate((state) => {
      document.getElementById("status").dataset.state = state;
      const output = document.getElementById("output");
      output.textContent = "some output";
      output.dataset.state = state;
      output.classList.toggle("error", state === "error" || state === "stopped");
      document.getElementById("last-run").classList.toggle("error", state === "error");
    }, state);
    await showNotices(); // a notice is not an error: it must stay gray in every state
  };
  const isGray = (color) => new Set(color.match(/[\d.]+/g).slice(0, 3)).size === 1;
  //     Which element shows the focus: the one that has it, or for the editor its frame.
  const focusRing = () =>
    panel.evaluate(() => {
      const el = document.activeElement.closest("#code") ?? document.activeElement;
      const style = getComputedStyle(el);
      return { on: el.id, style: style.outlineStyle, width: parseFloat(style.outlineWidth), color: style.outlineColor };
    });
  for (const scheme of ["light", "dark"]) {
    await panel.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
    for (const state of ["loading", "ready", "running", "stopped", "error"]) {
      await dressAs(state);
      const seen = await looks(texts);
      for (const [what, piece] of Object.entries(seen)) {
        assert.ok(contrast(piece) >= 4.5, `${scheme} mode, ${state}: ${what} is ${piece.color} on ${piece.background}`);
      }
      const colored = Object.keys(seen).filter((what) => !isGray(seen[what].color) || !isGray(seen[what].background));
      assert.deepEqual(colored, state === "error" ? ["status", "output", "last run", "last run output"] : [], `${scheme} mode, ${state}`);
    }
    //   The words in an output pane that has nothing to show yet.
    await clearOutput();
    const { hint } = await looks([{ what: "hint", selector: "#output", part: "::before" }]);
    assert.ok(contrast(hint) >= 4.5, `${scheme} mode: the empty output pane's hint is ${hint.color} on ${hint.background}`);
    //   An example in an empty field is told apart from text that was typed.
    const { name, ["example in an empty Name"]: example } = await looks(texts);
    assert.notEqual(example.color, name.color, scheme);

    for (const [selector, frame] of Object.entries(await looks(outlined.map((selector) => ({ what: selector, selector }))))) {
      const outline = contrast({ color: frame.border, background: frame.around });
      assert.ok(outline >= 3, `${scheme} mode: the outline of ${selector} is ${frame.border} on ${frame.around}`);
    }

    await panel.focus("#name");
    await pressWith("Shift", "Tab"); // one step back: the button before the Name field
    let ring = await focusRing();
    assert.deepEqual({ on: ring.on, style: ring.style }, { on: "delete", style: "solid" });
    assert.ok(ring.width >= 2 && contrast({ color: ring.color, background: name.around }) >= 3, `${scheme} mode: ring ${ring.color}`);
    await panel.click("#code .cm-content");
    ring = await focusRing();
    assert.deepEqual({ on: ring.on, style: ring.style }, { on: "code", style: "solid" });
    assert.ok(ring.width >= 2 && contrast({ color: ring.color, background: name.around }) >= 3, `${scheme} mode: ring ${ring.color}`);
  }
  await panel.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  console.log("ok  looks: readable text, visible outlines and focus ring in light and dark mode; color only for errors");

  //     Every button and field has a name that a screen reader can say: its
  //     own words, a label, or an aria-label.
  const nameless = await panel.evaluate(() =>
    [...document.querySelectorAll("button, select, input:not([type=file]), [role=textbox], [role=region]")]
      .filter((el) => !(el.labels?.length || el.getAttribute("aria-label") || (el.tagName === "BUTTON" && el.textContent.trim())))
      .map((el) => el.id || el.className),
  );
  assert.deepEqual(nameless, []);
  console.log("ok  every button and field has a name for screen readers");
  await panel.setViewport({ width: 800, height: 600 });
  await panel.reload(); // back to its real state, and drop the chrome.tabs.query stand-in
  await panelReady();
  await panel.click("#new");

  // 8e. Site access. PyMonkey is installed with access to no site, and the
  //     user allows sites one at a time. The copy under test has been allowed
  //     on the two test sites and nowhere else.
  assert.deepEqual((await panel.evaluate(() => chrome.permissions.getAll())).origins.sort(), [
    "http://127.0.0.1/*",
    "http://localhost/*",
  ]);
  //     What a notice says, or null while it is not shown.
  const notice = (id) => panel.$eval(`#${id}`, (el) => (el.hidden ? null : el.querySelector("span").textContent));
  const noticeIs = (id, shown) =>
    panel.waitForFunction((id, shown) => document.getElementById(id).hidden !== shown, { timeout: 5_000 }, id, shown);
  const listed = () => panel.$$eval("#script-list option", (options) => options.map((o) => o.textContent));
  const saved = () => panel.waitForFunction(() => document.getElementById("save-state").textContent === "Saved", { timeout: 5_000 });
  const tabIds = () => panel.evaluate(async () => (await chrome.tabs.query({})).map((tab) => tab.id));
  //     Make `tabId` the panel's "active tab".
  const pointPanelAt = (tabId) =>
    panel.evaluate((tabId) => {
      const get = chrome.tabs.get.bind(chrome.tabs);
      chrome.tabs.query = async () => [await get(tabId)];
    }, tabId);
  const pageTabId = await panel.evaluate(async (pageUrl) => (await chrome.tabs.query({ url: pageUrl }))[0].id, pageUrl);

  //     A page on a site that is not allowed. Chrome does not even tell the
  //     extension its address. Run says why it cannot run there and what to
  //     do, and the panel keeps saying it under the Run button.
  const tabsBefore = await tabIds();
  const blocked = await browser.newPage();
  await blocked.goto(blockedUrl);
  const [blockedTabId] = (await tabIds()).filter((id) => !tabsBefore.includes(id));
  assert.equal(await panel.evaluate(async (id) => (await chrome.tabs.get(id)).url ?? null, blockedTabId), null);
  await panel.bringToFront();
  await pointPanelAt(blockedTabId);
  await pressRun(`print(page.title)`);
  assert.deepEqual(await panelOutput(), {
    text:
      "PyMonkey could not run on this page: no access to this site. " +
      "Click the PyMonkey icon in the toolbar to allow it on this tab, then run the script again.",
    isError: true,
  });
  await noticeIs("tab-access", true);
  assert.match(await notice("tab-access"), /has not been allowed on the page in this tab\. Click the PyMonkey icon/);
  //     On a page that is allowed there is nothing to say.
  await pointPanelAt(pageTabId);
  await pressRun(`print(page.title)`);
  assert.deepEqual(await panelOutput(), { text: "clicked\n", isError: false });
  await noticeIs("tab-access", false);
  console.log("ok  site access: a page that is not allowed is left alone, and the panel says what to do");

  //     Saving a script that is to run automatically asks for its site. For a
  //     site that is allowed already Chrome has nothing to ask the user, so
  //     this goes through the real request.
  const marker = `page.set_attr("body", "data-site-access", "ran")`;
  await panel.click("#new");
  await panel.type("#name", "Allowed");
  await panel.type("#match", pageUrl + "*");
  await setEditorText(marker);
  await panel.click("#save");
  await saved();
  assert.equal(await notice("match-access"), null);
  assert.ok((await listed()).includes("Allowed"), String(await listed()));

  //     For a site that is not allowed, Chrome asks the user in a window of
  //     its own, which this browser cannot show. A stand-in takes the place
  //     of Chrome's function: it notes what was asked for, and says no.
  await panel.evaluate(() => {
    window.__asked = [];
    chrome.permissions.request = async ({ origins }) => {
      window.__asked.push(origins);
      return false;
    };
  });
  const asked = () => panel.evaluate(() => window.__asked);
  await panel.click("#new");
  await panel.type("#name", "Blocked");
  //     The notice is there as soon as the pattern is: before saving, and without asking.
  await panel.type("#match", blockedUrl + "*");
  await noticeIs("match-access", true);
  assert.equal(await notice("match-access"), `No access to ${blockedSite} yet, so this script will not run there by itself.`);
  assert.deepEqual(await asked(), []);
  //     Switched off, the script runs nowhere by itself and needs no site.
  await panel.click("#enabled");
  await noticeIs("match-access", false);
  await panel.click("#enabled");
  await noticeIs("match-access", true);
  await setEditorText(marker);
  await panel.click("#save");
  await saved();
  assert.deepEqual(await asked(), [[blockedSite]]); // asked for that one site, and for the whole of it
  //     The answer was no. The script is saved all the same, and marked.
  assert.ok((await listed()).includes("Blocked (no access)"), String(await listed()));
  assert.equal(await notice("match-access"), `No access to ${blockedSite} yet, so this script will not run there by itself.`);
  //     The button in the notice asks again.
  await panel.click("#match-access button");
  assert.deepEqual(await asked(), [[blockedSite], [blockedSite]]);
  console.log("ok  site access: saving a script asks for its site, once; a script without access is marked");

  //     Automatic runs: the allowed page gets its script, the other page is left alone.
  await blocked.reload();
  await page.reload();
  await page.waitForSelector("body[data-site-access=ran]", { timeout: 15_000 });
  const autoRan = () =>
    panel.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      return all.scripts.filter((script) => all[`lastRun:${script.id}`]).map((script) => script.name);
    });
  await panel.waitForFunction(
    async () => Object.keys(await chrome.storage.local.get(null)).some((key) => key.startsWith("lastRun:")),
    { timeout: 10_000 },
  );
  assert.deepEqual(await autoRan(), ["Allowed"]);
  assert.equal(await blocked.$eval("body", (el) => el.dataset.siteAccess ?? null), null);
  console.log("ok  site access: scripts run automatically on allowed sites only");

  //     page.fetch: on a site that is not allowed PyMonkey can read what any
  //     web page could (an address that lets every site read it) and no more.
  //     When a script fails on that, the panel offers to ask for the site.
  await pressRun(`print(page.fetch("${blockedUrl}cors").text)\npage.fetch("${blockedUrl}echo")`);
  shown = await panelOutput();
  assert.match(shown.text, /^for everyone\n/);
  assert.match(
    shown.text,
    /ConnectionError: Could not fetch http:\/\/not-allowed\.localhost:\d+\/echo: .* or PyMonkey has not been allowed on that site\n$/,
  );
  await noticeIs("fetch-access", true);
  assert.equal(
    await notice("fetch-access"),
    `The script asked for an address on ${blockedSite}, where PyMonkey has not been allowed. Allow it, then run again.`,
  );
  await panel.click("#fetch-access button");
  assert.deepEqual((await asked()).at(-1), [blockedSite]);
  assert.equal((await asked()).length, 3);
  //     An address that fails for another reason gets no such offer: the site is allowed.
  await pressRun(`page.fetch("${deadUrl}")`);
  assert.match((await panelOutput()).text, /ConnectionError: Could not fetch/);
  await noticeIs("fetch-access", false);
  console.log("ok  site access: page.fetch reads other sites as a web page would, and the panel offers to ask for more");

  //     Put things back: no scripts of this check, the real "active tab".
  await panel.evaluate(async () => {
    const { deleteScript } = await import("/lib/storage.js");
    const { scripts } = await chrome.storage.local.get("scripts");
    for (const script of scripts.filter((s) => ["Allowed", "Blocked"].includes(s.name))) await deleteScript(script.id);
  });
  await blocked.close();
  await panel.reload();
  await panelReady();
  await panel.click("#new");

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

  // 12. The toolbar icon. This check uses the extension as it is installed,
  //     allowed on no site, and the real side panel. A click on PyMonkey's
  //     icon opens the panel and allows PyMonkey on the page in that tab.
  //     It needs a browser that lets a test click the icon: Chrome 157 does,
  //     Chrome for Testing 145 does not. TOOLBAR_CHROME_PATH names the browser
  //     to use, if it is not the one the rest of the test runs in.
  const toolbarProfile = mkdtempSync(join(tmpdir(), "pymonkey-e2e-toolbar-"));
  let toolbarBrowser = null;
  let skipped = 0;
  try {
    toolbarBrowser = await puppeteer.launch({
      executablePath: process.env.TOOLBAR_CHROME_PATH ?? chromePath,
      headless: true,
      userDataDir: toolbarProfile,
      // These two let a test load an extension, and click its icon, by
      // commands to the browser. (Regular Chrome no longer takes --load-extension.)
      pipe: true,
      enableExtensions: true,
      args: ["--no-sandbox"],
    });
    let tab = null;
    let toolbarId = null;
    // (Two of puppeteer's internals: it has no public way to send this command yet.)
    const clickIcon = () => toolbarBrowser._connection.send("Extensions.triggerAction", { id: toolbarId, targetId: tab._tabId });
    let canClick = true;
    try {
      toolbarId = await toolbarBrowser.installExtension(realExtensionPath);
      // A click that comes before the background worker has started and is
      // listening for it is lost, so wait until it is.
      const isBackground = (t) => isServiceWorker(t) && t.url().startsWith(`chrome-extension://${toolbarId}/`);
      const background = await (await toolbarBrowser.waitForTarget(isBackground, { timeout: 10_000 })).worker();
      const deadline = Date.now() + 10_000;
      while (!(await background.evaluate(() => chrome.action.onClicked.hasListeners()))) {
        assert.ok(Date.now() < deadline, "the background worker never started listening for clicks on the icon");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      tab = await toolbarBrowser.newPage();
      await tab.goto(pageUrl + "login"); // logged in, as in the checks of page.fetch
      await tab.goto(pageUrl);
      await clickIcon();
    } catch (err) {
      // A browser that does not know one of the two commands says so in these words.
      if (!/Method not available|wasn't found/.test(err.message)) throw err;
      canClick = false;
    }
    if (!canClick) {
      skipped += 1;
      console.log("SKIPPED  toolbar icon: this browser cannot click it from a test (see TOOLBAR_CHROME_PATH in the README)");
    } else {
      //   The click opened the side panel...
      const isPanel = (t) => t.url() === `chrome-extension://${toolbarId}/panel/panel.html`;
      panel = await (await toolbarBrowser.waitForTarget(isPanel, { timeout: 10_000 })).asPage();
      await panel.waitForFunction(() => document.getElementById("status").dataset.state !== "loading", { timeout: 60_000 });
      //   ...and allowed PyMonkey on the page in the tab: Run works, with one click.
      //   Nothing was allowed for good.
      assert.equal(await notice("tab-access"), null);
      await pressRun(`print(page.title, page.fetch("/echo").json()["cookie"])`);
      assert.deepEqual(await panelOutput(), { text: "Test page session=secret\n", isError: false });
      assert.deepEqual((await panel.evaluate(() => chrome.permissions.getAll())).origins, []);
      //   The other site is still out of reach.
      await pressRun(`page.fetch("${otherUrl}/echo")`);
      assert.match((await panelOutput()).text, /or PyMonkey has not been allowed on that site\n$/);
      await noticeIs("fetch-access", true);

      //   A tab allowed by the icon is for running by hand. A script that is to
      //   run automatically on this site still needs the site allowed for good:
      //   it is marked in the list, and does not start. (Chrome's question to
      //   the user gets a stand-in again, which says no.)
      await panel.evaluate(() => (chrome.permissions.request = async () => false));
      await panel.type("#name", "Auto");
      await panel.type("#match", pageUrl + "*");
      await setEditorText(`page.set_attr("body", "data-site-access", "ran")`);
      await panel.click("#save");
      await saved();
      assert.deepEqual(await listed(), ["(unsaved script)", "Auto (no access)"]);
      await tab.reload(); // the same site: the tab stays allowed
      await panel.click("#new");
      await pressRun(`print("by hand")`);
      assert.deepEqual(await panelOutput(), { text: "by hand\n", isError: false });
      await pressRun(`print(page.select_one("body").get("data-site-access"))`); // runs after anything the first run set off
      assert.deepEqual(await panelOutput(), { text: "None\n", isError: false });
      assert.deepEqual(
        await panel.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((key) => key.startsWith("lastRun:"))),
        [],
      );

      //   Going to another site ends it. The panel says so without being asked...
      await tab.goto(otherUrl + "/");
      await noticeIs("tab-access", true);
      await pressRun(`print(page.title)`);
      assert.match((await panelOutput()).text, /^PyMonkey could not run on this page: no access to this site\. Click the PyMonkey icon/);
      //   ...and one more click on the icon allows this page. The panel stays as it is.
      await clickIcon();
      await noticeIs("tab-access", false);
      assert.equal(toolbarBrowser.targets().filter(isPanel).length, 1);
      await pressRun(`print(page.title)`);
      assert.deepEqual(await panelOutput(), { text: "Test page\n", isError: false });
      //   Coming back to the first site does not bring its permission back.
      await tab.goto(pageUrl);
      await noticeIs("tab-access", true);
      console.log("ok  toolbar icon: opens the side panel and allows the page in the tab, until the tab goes to another site");
    }
  } finally {
    await toolbarBrowser?.close();
    rmSync(toolbarProfile, { recursive: true, force: true });
  }

  console.log(skipped ? `\nAll end-to-end checks passed, except ${skipped} that could not run in this browser.` : "\nAll end-to-end checks passed.");
} finally {
  await browser.close();
  server.close();
  otherServer.close();
  rmSync(downloadPath, { recursive: true, force: true });
  rmSync(profilePath, { recursive: true, force: true });
  extension.remove();
}
