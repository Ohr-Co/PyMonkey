import { test } from "node:test";
import assert from "node:assert/strict";
import { fileNameFor, formatScriptFile, importedScript, importNotice, parseScriptFile } from "../extension/lib/script-file.js";

const script = { name: "Price watcher", match: "https://example.com/shop/*", timeout: 120, code: 'print("hi")\n' };

// ---------- export ----------

test("an exported file is the code under a header with name, match pattern and time limit", () => {
  assert.equal(
    formatScriptFile(script),
    [
      "# ==PyMonkey==",
      "# @name     Price watcher",
      "# @match    https://example.com/shop/*",
      "# @timeout  120",
      "# ==/PyMonkey==",
      "",
      'print("hi")',
      "",
    ].join("\n"),
  );
});

test("a manual-only script is exported with an empty match line", () => {
  const lines = formatScriptFile({ ...script, match: "" }).split("\n");
  assert.equal(lines[2], "# @match");
});

test("a script saved before it had a time limit is exported with the default", () => {
  const { timeout, ...old } = script;
  assert.match(formatScriptFile(old), /^# @timeout  30$/m);
});

test("a name cannot break out of its header line", () => {
  const lines = formatScriptFile({ ...script, name: "two\nlines\t here" }).split("\n");
  assert.equal(lines[1], "# @name     two lines here");
  assert.equal(lines[4], "# ==/PyMonkey==");
});

// ---------- import ----------

test("what is exported is imported back unchanged", () => {
  const codes = ['print("hi")\n', "no newline at the end", "\n\nstarts with empty lines\n", "", "# ==PyMonkey==\n# a header of its own\n"];
  for (const code of codes) {
    for (const match of [script.match, ""]) {
      const original = { ...script, match, code };
      assert.deepEqual(parseScriptFile(formatScriptFile(original), "ignored.py"), original);
    }
  }
});

test("a file without a header is a manual-only script named after the file", () => {
  assert.deepEqual(parseScriptFile("import json\nprint(1)\n", "scrape prices.py"), {
    name: "scrape prices", match: "", timeout: 30, code: "import json\nprint(1)\n",
  });
  assert.equal(parseScriptFile("print(1)", "LOUD.PY").name, "LOUD");
  assert.equal(parseScriptFile("print(1)", "").name, "Untitled");
  assert.equal(parseScriptFile("", "empty.py").code, "");
});

test("a header typed by hand may differ in spacing, order and line endings", () => {
  const text = "﻿\r\n#==PyMonkey==\r\n#@match https://example.com/*  \r\n#\r\n# a note\r\n#   @name   My  script\r\n# ==/PyMonkey==\r\nprint(1)\r\nprint(2)\r\n";
  assert.deepEqual(parseScriptFile(text, "file.py"), {
    name: "My  script", match: "https://example.com/*", timeout: 30, code: "print(1)\nprint(2)\n",
  });
});

test("header lines that are missing or unknown get defaults", () => {
  const header = (...lines) => ["# ==PyMonkey==", ...lines, "# ==/PyMonkey==", "", "x = 1"].join("\n");
  assert.deepEqual(parseScriptFile(header("# @match https://a.example/*"), "from-file.py"), {
    name: "from-file", match: "https://a.example/*", timeout: 30, code: "x = 1",
  });
  assert.deepEqual(parseScriptFile(header("# @name"), "from-file.py").name, "from-file"); // empty name
  assert.equal(parseScriptFile(header("# @timeout 0"), "f.py").timeout, 0); // no limit
  assert.equal(parseScriptFile(header("# @timeout soon"), "f.py").timeout, 30);
  assert.equal(parseScriptFile(header("# @timeout -5"), "f.py").timeout, 30);
  // Keys from a newer PyMonkey, or from somewhere else entirely, are skipped.
  assert.deepEqual(parseScriptFile(header("# @name N", "# @grant none", "# @__proto__ x", "# @constructor y"), "f.py"), {
    name: "N", match: "", timeout: 30, code: "x = 1",
  });
});

test("only a header at the top of the file counts", () => {
  const text = "import os\n# ==PyMonkey==\n# @name Not me\n# ==/PyMonkey==\n";
  assert.deepEqual(parseScriptFile(text, "plain.py"), { name: "plain", match: "", timeout: 30, code: text });
});

test("a header that is never closed is code like the rest", () => {
  const unclosed = "# ==PyMonkey==\n# @name Half\nprint(1)\n# ==/PyMonkey==\n";
  assert.deepEqual(parseScriptFile(unclosed, "half.py"), { name: "half", match: "", timeout: 30, code: unclosed });
  const atEnd = "# ==PyMonkey==\n# @name Half";
  assert.equal(parseScriptFile(atEnd, "half.py").code, atEnd);
});

test("an imported script with a match pattern arrives switched off, one without stays on", () => {
  assert.equal(importedScript(formatScriptFile(script), "a.py").enabled, false);
  assert.equal(importedScript("print(1)", "a.py").enabled, true); // manual only: nothing to switch off
  assert.deepEqual(importedScript(formatScriptFile(script), "a.py"), { ...script, enabled: false });
});

test("a file that is not text is refused", () => {
  assert.throws(() => importedScript("PK\u0003\u0004\0\0binary", "archive.py"), /not a text file/);
});

test("the notice says whether the imported script runs on its own", () => {
  const off = importNotice(importedScript(formatScriptFile(script), "a.py"), "a.py");
  assert.match(off, /^Imported "Price watcher" from a\.py\./);
  assert.match(off, /switched off/);
  assert.match(off, /https:\/\/example\.com\/shop\/\*/);
  assert.match(off, /tick Enabled and press Save/);
  assert.equal(importNotice(importedScript("x = 1", "plain.py"), "plain.py"), 'Imported "plain" from plain.py. It runs only when you press Run.');
});

// ---------- file names ----------

test("a file is named after its script", () => {
  assert.equal(fileNameFor("Price watcher"), "Price watcher.py");
  assert.equal(fileNameFor("prices.py"), "prices.py"); // no second .py
  assert.equal(fileNameFor("Préços 価格"), "Préços 価格.py");
});

test("characters a file system refuses are replaced", () => {
  assert.equal(fileNameFor("a/b\\c: d*e?"), "a-b-c- d-e.py");
  assert.equal(fileNameFor("../../etc/passwd"), "etc-passwd.py");
  assert.equal(fileNameFor('say "hi" <now>|'), "say -hi- -now.py");
  assert.equal(fileNameFor("tab\tand\nnewline"), "tab-and-newline.py");
});

test("a name with nothing usable in it still gives a file name", () => {
  for (const name of ["", "   ", "...", "///", ".py", undefined]) assert.equal(fileNameFor(name), "script.py");
});
