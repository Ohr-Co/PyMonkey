import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { patternSite } from "../extension/lib/match.js";
import {
  NO_ACCESS_REASONS, describeSites, failedFetchUrl, pageAccess, siteOf, sitesNeeded, sitesOf, sitesWithoutAccess,
} from "../extension/lib/site-access.js";

test("the manifest asks for no site at install time", () => {
  const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined); // a content script with fixed sites would need access to them
  assert.deepEqual(manifest.optional_host_permissions, ["<all_urls>"]); // what may be asked for later, site by site
  assert.deepEqual(manifest.permissions, ["storage", "offscreen", "sidePanel", "scripting", "activeTab"]);
});

test("a pattern's site is its scheme and host with any path", () => {
  assert.equal(patternSite("https://example.com/shop/*"), "https://example.com/*");
  assert.equal(patternSite("https://news.ycombinator.com/item*"), "https://news.ycombinator.com/*");
  assert.equal(patternSite("  https://example.com/  "), "https://example.com/*");
  assert.equal(patternSite("*://*.example.com/*"), "*://*.example.com/*");
  assert.equal(patternSite("http://localhost:8000/app/*"), "http://localhost:8000/*");
  assert.equal(patternSite("file:///Users/me/*.html"), "file:///*");
  assert.equal(patternSite("<all_urls>"), "<all_urls>");
});

test("an invalid pattern has no site", () => {
  assert.equal(patternSite("example.com"), null);
  assert.equal(patternSite("https://exa*mple.com/*"), null);
  assert.equal(patternSite("ftp://example.com/*"), null);
  assert.equal(patternSite(""), null);
});

test("the sites of several patterns, each once, invalid ones left out", () => {
  assert.deepEqual(sitesOf("https://a.com/x/*\nhttps://a.com/y/*\n\nnonsense\n*://b.com/*"), ["https://a.com/*", "*://b.com/*"]);
  assert.deepEqual(sitesOf(""), []);
  assert.deepEqual(sitesOf(undefined), []);
});

test("only an enabled script with a pattern needs a site", () => {
  assert.deepEqual(sitesNeeded({ enabled: true, match: "https://a.com/*" }), ["https://a.com/*"]);
  assert.deepEqual(sitesNeeded({ enabled: false, match: "https://a.com/*" }), []); // switched off: it does not run by itself
  assert.deepEqual(sitesNeeded({ enabled: true, match: "" }), []); // runs only when Run is pressed
  assert.deepEqual(sitesNeeded(null), []);
});

test("the site of an address", () => {
  assert.equal(siteOf("https://example.com/shop/item?id=1#top"), "https://example.com/*");
  assert.equal(siteOf("http://localhost:8000/"), "http://localhost:8000/*");
  assert.equal(siteOf("http://[::1]:8000/x"), "http://[::1]:8000/*");
  assert.equal(siteOf("file:///Users/me/page.html"), "file:///*");
  assert.equal(siteOf("chrome://extensions/"), null);
  assert.equal(siteOf("not an address"), null);
});

test("sites in words", () => {
  assert.equal(describeSites(["https://a.com/*", "*://b.com/*"]), "https://a.com/*, *://b.com/*");
  assert.equal(describeSites(["<all_urls>"]), "all sites");
});

test("a tab whose address is hidden is one PyMonkey was not allowed on", () => {
  assert.equal(pageAccess({ id: 1 }), "no-access");
  assert.equal(pageAccess(undefined), "no-access");
  assert.equal(pageAccess({ id: 1, url: "https://example.com/" }), "ok");
  assert.equal(pageAccess({ id: 1, url: "file:///Users/me/page.html" }), "ok");
  assert.equal(pageAccess({ id: 1, url: "chrome://extensions/" }), "unsupported");
  assert.equal(pageAccess({ id: 1, url: "chrome-extension://abc/panel/panel.html" }), "unsupported");
  // Every answer but "ok" comes with a reason, and the one for no access says what to do.
  assert.deepEqual(Object.keys(NO_ACCESS_REASONS), ["no-access", "unsupported"]);
  assert.match(NO_ACCESS_REASONS["no-access"], /Click the PyMonkey icon in the toolbar/);
});

test("the address a script could not fetch is read from its traceback", () => {
  const traceback = [
    "Traceback (most recent call last):",
    '  File "<script>", line 3, in <module>',
    "ConnectionError: Could not fetch https://api.example.com/rates?base=EUR: the server cannot be reached",
  ].join("\n");
  assert.equal(failedFetchUrl(traceback), "https://api.example.com/rates?base=EUR");
  // With several, the last one is the error that ended the script.
  assert.equal(failedFetchUrl(`ConnectionError: Could not fetch https://a.com/: x\n\n${traceback}`), "https://api.example.com/rates?base=EUR");
  assert.equal(failedFetchUrl("TimeoutError: Could not fetch https://slow.test/: no answer within 3 seconds"), null); // the site answered too slowly: access is not the trouble
  assert.equal(failedFetchUrl('print("ConnectionError: Could not fetch")'), null);
  assert.equal(failedFetchUrl(null), null);
});

test("which sites still lack access", async () => {
  const allowed = async (site) => site === "https://a.com/*";
  assert.deepEqual(await sitesWithoutAccess(["https://a.com/*", "https://b.com/*", "<all_urls>"], allowed), ["https://b.com/*", "<all_urls>"]);
  assert.deepEqual(await sitesWithoutAccess([], allowed), []);
});
