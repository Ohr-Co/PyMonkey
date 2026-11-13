// The time limit of a script, in seconds. Each script has its own (the
// "Time limit" field in the panel); a script without one gets the default.
//
// Pure logic: see tests/timeout.test.mjs.

export const DEFAULT_TIMEOUT_S = 30;

// setTimeout cannot count further than about 24 days. A day is plenty.
export const MAX_TIMEOUT_S = 24 * 60 * 60;

/**
 * Turn whatever was typed or stored into a number of seconds.
 * 0 means "no limit". Anything that is not a number >= 0 becomes the default.
 */
export function timeoutSeconds(value) {
  if (value === "" || value === null || value === undefined) return DEFAULT_TIMEOUT_S;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_TIMEOUT_S;
  return Math.min(seconds, MAX_TIMEOUT_S);
}
