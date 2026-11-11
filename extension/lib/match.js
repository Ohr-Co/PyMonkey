// URL matching for scripts. Uses Chrome's match-pattern syntax:
//   <all_urls>
//   *://*.example.com/*
//   https://news.ycombinator.com/item*
// Docs: https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns

const escapeRegex = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** Turn one match pattern into a RegExp, or return null if it is invalid. */
export function patternToRegExp(pattern) {
  pattern = pattern.trim();
  if (pattern === "<all_urls>") return /^(https?|file):\/\/.*/;

  const parts = /^(\*|https?|file):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!parts) return null;
  const [, scheme, host, path] = parts;

  const schemeRe = scheme === "*" ? "https?" : scheme;

  let hostRe;
  if (host === "*") hostRe = "[^/]*";
  else if (host.startsWith("*.")) hostRe = "([^/]+\\.)?" + escapeRegex(host.slice(2));
  else if (host.includes("*")) return null; // "*" is only allowed as a leading "*."
  else hostRe = escapeRegex(host);

  const pathRe = path.split("*").map(escapeRegex).join(".*");

  return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`);
}

/** True if `url` matches the pattern (or any pattern, one per line). */
export function urlMatches(patterns, url) {
  // Fragments (#...) are never part of a match.
  const target = url.split("#")[0];
  return String(patterns)
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean)
    .some((p) => patternToRegExp(p)?.test(target));
}
