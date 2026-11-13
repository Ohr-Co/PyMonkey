// Giving memory back. Python is the heavy part of PyMonkey (see docs/memory.md
// for the numbers), and it gives memory back to the computer in one way only:
// by being shut down. The offscreen document does that in two cases, and this
// file decides when:
//
//   * nothing has asked for Python for a while  -> the offscreen document closes
//     itself, and the background opens a new one when Python is next needed
//   * a run made Python's memory grow a lot     -> the worker is replaced by a new one
//
// Pure logic, no chrome.* calls: see tests/memory.test.mjs.

/** How long Python is kept loaded with nothing to do, in seconds. */
export const IDLE_SECONDS = 300;

/**
 * The idle period for an offscreen document, given the part of its address
 * from the "?" on (`location.search`). "offscreen.html?idle=2" asks for two
 * seconds, which is how the tests avoid waiting five minutes; the background
 * never asks, and gets IDLE_SECONDS.
 */
export function idleSeconds(search) {
  const asked = new URLSearchParams(search).get("idle");
  const seconds = Number(asked);
  return asked !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : IDLE_SECONDS;
}

/**
 * A countdown that calls onIdle() once nothing has happened for `seconds`.
 *
 * Call update(busy) whenever something happens: with true while there is work
 * (the countdown is off), with false when there is none (it starts again from
 * the top). setTimer and clearTimer are only passed in by the tests.
 */
export function createIdleTimer({ seconds, onIdle, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  return {
    update(busy) {
      clearTimer(timer);
      timer = busy ? null : setTimer(onIdle, seconds * 1000);
    },
  };
}

/** How much Python's memory may grow before its worker is replaced. */
export const RESTART_AFTER_GROWTH_BYTES = 64 * 1024 * 1024;

/**
 * Should the worker be replaced now that a run is over?
 *
 * Python's memory (the WebAssembly "heap") can grow but never shrink. After a
 * run that needed a lot, Python can use the space again itself, but the
 * computer only gets it back when the worker ends. `heap` is what the worker
 * reports with each result: its heap's size now and when Python had just
 * loaded, in bytes; null if it could not tell.
 */
export function grownTooLarge(heap) {
  if (!heap || !(heap.freshBytes > 0)) return false;
  return heap.bytes - heap.freshBytes > RESTART_AFTER_GROWTH_BYTES;
}
