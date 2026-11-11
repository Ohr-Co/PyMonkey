import { test } from "node:test";
import assert from "node:assert/strict";
import { urlMatches, patternToRegExp } from "../extension/lib/match.js";

test("<all_urls> matches http and https", () => {
  assert.ok(urlMatches("<all_urls>", "https://example.com/a?b=1"));
  assert.ok(urlMatches("<all_urls>", "http://localhost:8000/"));
  assert.ok(!urlMatches("<all_urls>", "chrome://extensions/"));
});

test("scheme and host wildcards", () => {
  assert.ok(urlMatches("*://*.example.com/*", "https://www.example.com/x"));
  assert.ok(urlMatches("*://*.example.com/*", "http://example.com/"));
  assert.ok(!urlMatches("*://*.example.com/*", "https://badexample.com/"));
  assert.ok(!urlMatches("https://example.com/*", "http://example.com/"));
});

test("path wildcards, query strings and fragments", () => {
  assert.ok(urlMatches("https://news.ycombinator.com/item*", "https://news.ycombinator.com/item?id=1#top"));
  assert.ok(!urlMatches("https://news.ycombinator.com/item*", "https://news.ycombinator.com/news"));
  assert.ok(!urlMatches("https://example.com/", "https://example.com/other"));
});

test("several patterns, one per line", () => {
  const patterns = "https://a.com/*\nhttps://b.com/*";
  assert.ok(urlMatches(patterns, "https://b.com/x"));
  assert.ok(!urlMatches(patterns, "https://c.com/x"));
});

test("invalid patterns never match", () => {
  assert.equal(patternToRegExp("example.com"), null);
  assert.equal(patternToRegExp("https://exa*mple.com/*"), null);
  assert.ok(!urlMatches("", "https://example.com/"));
});
