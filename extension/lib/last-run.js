// What PyMonkey remembers about a saved script's last automatic run, so a
// script that broke while nobody was watching can be found later.
//
// A last run: { time, url, ok, stdout, error, seen }
//   time  when it finished, in milliseconds since 1970 (what Date.now() returns)
//   seen  whether the panel has shown it to the user; a failed run that has not
//         been seen is counted on the toolbar icon's badge
//
// Each script has exactly one, stored under its own key (see lib/storage.js),
// and its text is cut to MAX_OUTPUT_CHARS, so the space used cannot grow
// without bound.
//
// This file has no chrome.* calls so it can be tested with plain Node.

export const MAX_OUTPUT_CHARS = 20_000;

/** The chrome.storage.local key of a script's last run. */
export const lastRunKey = (scriptId) => `lastRun:${scriptId}`;
export const isLastRunKey = (key) => key.startsWith("lastRun:");

/** Keep the end of `text` (the newest output, or the last lines of a traceback). */
export function capText(text, max = MAX_OUTPUT_CHARS) {
  if (!text || text.length <= max) return text ?? "";
  const dropped = text.length - max;
  return `[… ${dropped} earlier characters not kept]\n${text.slice(-max)}`;
}

/** Build the record to store from a run's result. `now` is passed in for tests. */
export function makeLastRun({ url }, result, now = Date.now()) {
  return {
    time: now,
    url: url ?? "",
    ok: Boolean(result?.ok),
    stdout: capText(result?.stdout),
    error: result?.ok ? null : capText(result?.error) || "The script failed without an error message.",
    seen: false,
  };
}

/** How many of these last runs failed and have not been looked at yet. */
export function countUnseenFailures(lastRuns) {
  return lastRuns.filter((lastRun) => lastRun && !lastRun.ok && !lastRun.seen).length;
}

/** One line for the panel: "Last automatic run failed · 11/11/2026, 12:03:10". */
export function describeLastRun(lastRun) {
  const when = new Date(lastRun.time).toLocaleString();
  return `Last automatic run ${lastRun.ok ? "succeeded" : "failed"} · ${when}`;
}
