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
