import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IDLE_SECONDS,
  RESTART_AFTER_GROWTH_BYTES,
  createIdleTimer,
  grownTooLarge,
  idleSeconds,
} from "../extension/lib/memory.js";

// ---------- the idle period ----------

test("the idle period is five minutes unless the document's address says otherwise", () => {
  assert.equal(IDLE_SECONDS, 300);
  assert.equal(idleSeconds(""), IDLE_SECONDS);
  assert.equal(idleSeconds("?other=1"), IDLE_SECONDS);
  assert.equal(idleSeconds("?idle=2"), 2);
  assert.equal(idleSeconds("?idle=0.5"), 0.5);
});

test("an idle period that makes no sense is ignored", () => {
  for (const search of ["?idle=", "?idle=0", "?idle=-5", "?idle=soon", "?idle=Infinity"]) {
    assert.equal(idleSeconds(search), IDLE_SECONDS, search);
  }
});

// ---------- the countdown ----------

// A clock the test moves by hand. setTimer and clearTimer are what the idle
// timer uses in place of setTimeout and clearTimeout.
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map(); // id -> { at, fn }
  return {
    setTimer(fn, ms) {
      timers.set(nextId, { at: now + ms, fn });
      return nextId++;
    },
    clearTimer: (id) => timers.delete(id),
    advance(seconds) {
      now += seconds * 1000;
      for (const [id, { at, fn }] of [...timers]) {
        if (at > now) continue;
        timers.delete(id);
        fn();
      }
    },
    pending: () => timers.size,
  };
}

function makeTimer(seconds = 300) {
  const clock = fakeClock();
  let idle = 0;
  const timer = createIdleTimer({ seconds, onIdle: () => idle++, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { clock, timer, idleCalls: () => idle };
}

test("onIdle is called once nothing has happened for the whole period", () => {
  const { clock, timer, idleCalls } = makeTimer(300);
  timer.update(false);
  clock.advance(299);
  assert.equal(idleCalls(), 0);
  clock.advance(1);
  assert.equal(idleCalls(), 1);
  clock.advance(1000);
  assert.equal(idleCalls(), 1); // once, not every five minutes
});

test("nothing counts down before the first update", () => {
  const { clock, idleCalls } = makeTimer(300);
  clock.advance(1000);
  assert.equal(idleCalls(), 0);
});

test("the countdown is off while there is work, however long it takes", () => {
  const { clock, timer, idleCalls } = makeTimer(300);
  timer.update(false);
  clock.advance(200);
  timer.update(true); // a run starts
  clock.advance(3600);
  assert.equal(idleCalls(), 0);
  assert.equal(clock.pending(), 0);

  timer.update(false); // it is over: a full period from here
  clock.advance(299);
  assert.equal(idleCalls(), 0);
  clock.advance(1);
  assert.equal(idleCalls(), 1);
});

test("anything that happens starts the countdown from the top", () => {
  const { clock, timer, idleCalls } = makeTimer(300);
  timer.update(false);
  for (let i = 0; i < 10; i++) {
    clock.advance(200);
    timer.update(false); // e.g. the background asked whether the document is there
  }
  assert.equal(idleCalls(), 0);
  assert.equal(clock.pending(), 1); // and the old countdowns are gone, not piling up
  clock.advance(300);
  assert.equal(idleCalls(), 1);
});

// ---------- replacing a worker that grew ----------

const MB = 1024 * 1024;

test("a worker is replaced when Python's memory grew by more than the limit", () => {
  assert.equal(RESTART_AFTER_GROWTH_BYTES, 64 * MB);
  const fresh = 31 * MB;
  assert.equal(grownTooLarge({ bytes: fresh, freshBytes: fresh }), false);
  assert.equal(grownTooLarge({ bytes: fresh + 23 * MB, freshBytes: fresh }), false); // a page of 1 MB
  assert.equal(grownTooLarge({ bytes: fresh + 64 * MB, freshBytes: fresh }), false); // at the limit: not yet
  assert.equal(grownTooLarge({ bytes: fresh + 64 * MB + 1, freshBytes: fresh }), true);
  assert.equal(grownTooLarge({ bytes: fresh + 132 * MB, freshBytes: fresh }), true); // a page of 6 MB
});

test("a worker that cannot tell how large its memory is, is kept", () => {
  assert.equal(grownTooLarge(null), false);
  assert.equal(grownTooLarge(undefined), false);
  assert.equal(grownTooLarge({ bytes: 500 * MB, freshBytes: 0 }), false);
  assert.equal(grownTooLarge({ bytes: 500 * MB }), false);
  assert.equal(grownTooLarge({ freshBytes: 31 * MB }), false);
});
