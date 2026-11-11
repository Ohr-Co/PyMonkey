// A script as a .py file, for export and import.
//
// The file is the script's code with a header comment on top that holds what
// is not code: the script's name, the pages it runs on, and its time limit.
//
//   # ==PyMonkey==
//   # @name     Price watcher
//   # @match    https://example.com/shop/*
//   # @timeout  30
//   # ==/PyMonkey==
//
//   for row in page.select("tr.item"):
//       ...
//
// To Python the header is only comments, so the file is still a valid script.
// A file without a header is imported too, as a script that runs by hand only.
//
// No chrome.* calls here, so it can be tested with plain Node.

import { timeoutSeconds } from "./timeout.js";

const OPEN = "# ==PyMonkey==";
const CLOSE = "# ==/PyMonkey==";
// The same lines as patterns, so that a header typed by hand may differ in its spaces.
const IS_OPEN = /^#\s*==PyMonkey==\s*$/;
const IS_CLOSE = /^#\s*==\/PyMonkey==\s*$/;
// "# @name  Price watcher" -> key "name", value "Price watcher" (the value may be missing).
const ENTRY = /^#\s*@(\w+)(?:\s+(.*))?$/;

// A file larger than this is not a script somebody wrote. (Bytes.)
export const MAX_FILE_BYTES = 1_000_000;

/** The text of the .py file for a script: the header, an empty line, the code. */
export function formatScriptFile({ name, match, timeout, code }) {
  const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  // padEnd lines the values up; trimEnd drops the padding when there is no value.
  const entry = (key, value) => (`# @${key}`.padEnd(12) + oneLine(value)).trimEnd();
  return [
    OPEN,
    entry("name", name),
    entry("match", match),
    entry("timeout", timeoutSeconds(timeout)),
    CLOSE,
    "",
    code,
  ].join("\n");
}

/**
 * Read a .py file: returns { name, match, timeout, code }.
 * The header must be the first thing in the file. Without one (or with one
 * that is never closed) the whole file is code, the name is the file's name
 * and `match` is blank, which means: runs by hand only.
 */
export function parseScriptFile(text, fileName = "") {
  // Files differ in how they end lines (Windows: \r\n), and some start with
  // an invisible marker character (﻿). Python minds neither; nor do we.
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const header = {};
  let codeLines = lines;

  const open = lines.findIndex((line) => line.trim() !== ""); // the first line that is not empty
  if (open !== -1 && IS_OPEN.test(lines[open])) {
    // The header is comment lines only, up to the closing line.
    let close = open + 1;
    while (close < lines.length && lines[close].startsWith("#") && !IS_CLOSE.test(lines[close])) close++;
    if (close < lines.length && IS_CLOSE.test(lines[close])) {
      for (const line of lines.slice(open + 1, close)) {
        const [, key, value = ""] = line.match(ENTRY) ?? [];
        if (key) header[key] = value.trim(); // keys we do not know are kept out of the way, not an error
      }
      codeLines = lines.slice(close + 1);
      if (codeLines[0] === "") codeLines.shift(); // the empty line between header and code
    }
  }

  return {
    name: header.name || fileName.replace(/\.py$/i, "") || "Untitled",
    match: header.match ?? "",
    timeout: timeoutSeconds(header.timeout),
    code: codeLines.join("\n"),
  };
}

/**
 * The script to save for an imported file.
 * A script that names pages to run on arrives switched off: it could be
 * somebody else's, and should not start running before it has been read.
 */
export function importedScript(text, fileName) {
  if (text.includes("\0")) throw new Error("it is not a text file"); // \0 never occurs in text
  const script = parseScriptFile(text, fileName);
  return { ...script, enabled: script.match === "" };
}

/** What to tell the user about a script that was just imported. */
export function importNotice(script, fileName) {
  const what = `Imported "${script.name}" from ${fileName}.`;
  if (script.match === "") return `${what} It runs only when you press Run.`;
  return (
    `${what} It is switched off. Read it first, above all if somebody else wrote it. ` +
    `To let it run automatically on ${script.match}, tick Enabled and press Save.`
  );
}

/**
 * A file name for a script's name: "Price watcher" -> "Price watcher.py".
 * Characters that file systems refuse (such as / and :) become a dash.
 */
export function fileNameFor(name) {
  const base = String(name ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\.py$/i, "")
    .replace(/^[\s.-]+|[\s.-]+$/g, ""); // no dots, dashes or spaces at either end
  return `${base || "script"}.py`;
}
