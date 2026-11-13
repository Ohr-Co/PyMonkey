// The documents people read first: the links between them must lead somewhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (name) => readFileSync(new URL(name, root), "utf8");

// The targets of the Markdown links in a text: [words](target).
const linkTargets = (text) => [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]);

// A heading as GitHub turns it into a link target: "## How it works" -> "how-it-works".
const anchors = (text) =>
  [...text.matchAll(/^#+ (.+)$/gm)].map((match) =>
    match[1].toLowerCase().replace(/[^\w\- ]/g, "").replaceAll(" ", "-"),
  );

for (const name of ["README.md", "CONTRIBUTING.md", "CLA.md", "SECURITY.md"]) {
  test(`${name}: links to files and headings in this repository lead somewhere`, () => {
    for (const target of linkTargets(read(name))) {
      if (/^[a-z]+:/.test(target)) continue; // a web address: not ours to check
      const [file, anchor] = target.split("#");
      const linked = file || name; // "#heading" alone points into the same file
      assert.ok(existsSync(new URL(linked, root)), `${name} links to ${target}, which does not exist`);
      if (anchor && linked.endsWith(".md")) {
        assert.ok(anchors(read(linked)).includes(anchor), `${name} links to ${target}, but ${linked} has no such heading`);
      }
    }
  });
}

test("the README links to the contributing guide and to the CLA", () => {
  const targets = linkTargets(read("README.md"));
  assert.ok(targets.includes("CONTRIBUTING.md"));
  assert.ok(targets.includes("CLA.md"));
});

test("the contributing guide covers setup, tests and proposing changes, and links to the CLA", () => {
  const guide = read("CONTRIBUTING.md");
  for (const heading of ["## Setup", "## Tests", "## Proposing a change"]) assert.ok(guide.includes(`\n${heading}\n`), heading);
  for (const command of ["npm install", "npm run setup", "npm test", "npm run test:e2e"]) assert.ok(guide.includes(command), command);
  assert.ok(linkTargets(guide).includes("CLA.md"));
});
