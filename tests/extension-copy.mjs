// A copy of the extension for tests to load.
//
// PyMonkey is installed with access to no site. The user allows sites one at
// a time: by clicking the toolbar icon, or by answering a question that Chrome
// asks in a window of its own (see extension/lib/site-access.js). A test can
// do neither: the toolbar is not part of the page, and a browser without a
// window never shows the question, so the request waits for ever.
//
// So the tests load a copy whose manifest says PyMonkey has been allowed on
// the test sites already, which is the state a user is in after saying yes.
// Everything else in the copy is the extension as it is.
//
// The copy holds real files. Links back to the originals would be cheaper, but
// Chrome does not inject a content script that is a link.

import { constants, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The two names of this machine that the tests serve their pages on, with any port. */
export const TEST_SITES = ["http://localhost/*", "http://127.0.0.1/*"];

/**
 * Copy the extension in `source` to a temporary folder and allow it on `sites`.
 * Returns the folder's path and a function that deletes it.
 */
export function copyExtension(source, sites = TEST_SITES) {
  const path = mkdtempSync(join(tmpdir(), "pymonkey-extension-"));
  // FICLONE: where the disk can do it (macOS, some Linux file systems) a copy
  // shares its data with the original, so it is made at once and takes no room.
  cpSync(source, path, { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE });
  const manifestPath = join(path, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), ...sites])];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}
