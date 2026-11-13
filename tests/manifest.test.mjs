// The manifest's icons: every size Chrome asks for is there, and each file is
// a PNG of the size the manifest says it is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const extension = new URL("../extension/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", extension), "utf8"));

// A PNG file starts with 8 fixed bytes, then its first block ("IHDR"), which
// holds the width and the height as 4-byte numbers at bytes 16 and 20.
function pngSize(path) {
  const bytes = readFileSync(new URL(path, extension));
  assert.equal(bytes.subarray(0, 8).toString("latin1"), "\x89PNG\r\n\x1a\n", `${path} is not a PNG file`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("the extension has icons at 16, 32, 48 and 128 px", () => {
  assert.deepEqual(Object.keys(manifest.icons), ["16", "32", "48", "128"]);
  for (const [size, path] of Object.entries(manifest.icons)) {
    assert.deepEqual(pngSize(path), { width: Number(size), height: Number(size) }, path);
  }
});

test("the toolbar button uses the same icons", () => {
  assert.deepEqual(manifest.action.default_icon, manifest.icons);
});

test("icon files live in extension/icons/", () => {
  for (const path of Object.values(manifest.icons)) assert.match(path, /^icons\/icon\d+\.png$/);
});
