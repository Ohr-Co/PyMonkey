// Site access: which sites PyMonkey may read and change.
//
// PyMonkey is installed with access to no site at all. Chrome gives it access
// in two ways, and both start with the user:
//
//   for one tab    Clicking the PyMonkey icon in the toolbar allows it on the
//                  page in that tab, until the tab goes to another site
//                  (Chrome calls this "activeTab"). Nothing is asked.
//                  This is what "Run on this page" lives on.
//   for good       chrome.permissions.request() makes Chrome ask the user
//                  "allow PyMonkey to read and change your data on
//                  example.com?". Once allowed, a site stays allowed.
//                  This is what running automatically needs, and what the
//                  panel asks for when a script with a URL pattern is saved.
//
// Access is given per site ("https://example.com/*"), never per page, so a
// script's pattern "https://example.com/shop/*" needs the whole of example.com.
//
// Apart from hasAccess at the bottom there are no chrome.* calls here, so the
// rest can be tested with plain Node.

import { patternSite } from "./match.js";

/** The sites a script's patterns (one per line) are about, each once. Invalid patterns are left out. */
export function sitesOf(patterns) {
  const sites = String(patterns ?? "")
    .split("\n")
    .map((pattern) => patternSite(pattern))
    .filter(Boolean);
  return [...new Set(sites)];
}

/** The sites a script must be allowed on to run automatically: none unless it is enabled and has a pattern. */
export function sitesNeeded(script) {
  return script?.enabled && script.match ? sitesOf(script.match) : [];
}

/** The site of an address, the way Chrome wants it named: "https://example.com/*". Null for anything but a web page or a file. */
export function siteOf(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === "file:") return "file:///*";
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return `${parsed.protocol}//${parsed.host}/*`; // host includes the port, if there is one
}

/** Sites in words, for a sentence in the panel. */
export function describeSites(sites) {
  return sites.map((site) => (site === "<all_urls>" ? "all sites" : site)).join(", ");
}

/**
 * Can scripts run on the page in this tab? `tab` is what chrome.tabs gives.
 *   "ok"           yes
 *   "no-access"    the user has not allowed PyMonkey there. Chrome then hides
 *                  the tab's address from the extension, which is how we know
 *   "unsupported"  a page of the browser itself (chrome://, another extension): never
 */
export function pageAccess(tab) {
  if (!tab || tab.url === undefined) return "no-access";
  return /^(https?|file):/.test(tab.url) ? "ok" : "unsupported";
}

/** Why a script cannot run on a page, to go after "PyMonkey could not run on this page: ". */
export const NO_ACCESS_REASONS = {
  "no-access":
    "no access to this site. Click the PyMonkey icon in the toolbar to allow it on this tab, then run the script again.",
  unsupported: "this kind of page does not allow extensions.",
};

/**
 * The address a script failed to fetch, read from its traceback (the text of
 * the ConnectionError that page.fetch raises, see pymonkey_runtime.py), or null.
 * One reason for that error is that PyMonkey has no access to the site; the
 * panel uses this to find out which site, and to offer to ask for it.
 */
export function failedFetchUrl(errorText) {
  const found = [...String(errorText ?? "").matchAll(/^ConnectionError: Could not fetch (\S+): /gm)];
  return found.length ? found.at(-1)[1] : null; // the last one is the one that ended the script
}

/** Those of `sites` that PyMonkey has not been allowed on. `allowed` answers for one site. */
export async function sitesWithoutAccess(sites, allowed = hasAccess) {
  const answers = await Promise.all(sites.map((site) => allowed(site)));
  return sites.filter((_, i) => !answers[i]);
}

/** Has the user allowed PyMonkey on this site for good? (An allowed tab does not count.) */
export function hasAccess(site) {
  return chrome.permissions.contains({ origins: [site] }).catch(() => false);
}
