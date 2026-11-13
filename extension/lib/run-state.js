// How a run ended, as the panel's status line shows it: "done", "stopped" or "error".
//
// A result is { ok, stdout, error }. A run that was stopped (by the Stop
// button or by its time limit) is not ok, but it is not a broken script
// either, so the panel tells the two apart by the message. The messages are
// made here, so that the place that writes them (offscreen.js) and the place
// that recognizes them cannot drift apart.
//
// Pure logic: see tests/run-state.test.mjs.

export const STOPPED_BY_USER = "Stopped by user.";

const OVER_LIMIT = "Script stopped: it ran longer than ";
/** The error of a script that ran into its time limit of `seconds`. */
export const overTimeLimit = (seconds) => `${OVER_LIMIT}${seconds}s. Its time limit can be changed in the panel.`;

/** "done" (it ran to the end), "stopped" (ended from outside) or "error" (anything else). */
export function runState(result) {
  if (result?.ok) return "done";
  const error = result?.error ?? "";
  return error === STOPPED_BY_USER || error.startsWith(OVER_LIMIT) ? "stopped" : "error";
}
