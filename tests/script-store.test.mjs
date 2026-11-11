import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStoreOp, storeKey } from "../extension/lib/script-store.js";

// Apply a list of [op, args] to an empty store, the way the background does:
// keep the new values whenever an operation returns some. Returns the answers.
function play(steps, values = {}) {
  const answers = [];
  for (const [op, args] of steps) {
    const { value, values: changed } = applyStoreOp(values, op, args);
    if (changed) values = changed;
    answers.push(value);
  }
  return { answers, values };
}

test("a saved value is read back", () => {
  const { answers } = play([
    ["set", { key: "price", value: 12.5 }],
    ["get", { key: "price" }],
  ]);
  assert.deepEqual(answers, [null, { exists: true, value: 12.5 }]);
});

test("a key that was never saved is reported as missing, a saved None is not", () => {
  const { answers } = play([
    ["get", { key: "nope" }],
    ["set", { key: "empty", value: null }],
    ["get", { key: "empty" }],
  ]);
  assert.deepEqual(answers, [{ exists: false }, null, { exists: true, value: null }]);
});

test("values can be any JSON type", () => {
  const value = { seen: ["a", "b"], count: 2, done: false, note: null, nested: { x: [1, { y: "z" }] } };
  const { answers } = play([["set", { key: "state", value }], ["get", { key: "state" }]]);
  assert.deepEqual(answers[1], { exists: true, value });
});

test("set replaces, delete forgets, keys lists in alphabetical order", () => {
  const { answers, values } = play([
    ["set", { key: "b", value: 1 }],
    ["set", { key: "a", value: 2 }],
    ["set", { key: "b", value: 3 }],
    ["keys"],
    ["get", { key: "b" }],
    ["delete", { key: "a" }],
    ["delete", { key: "a" }],
    ["keys"],
  ]);
  assert.deepEqual(answers, [null, null, null, ["a", "b"], { exists: true, value: 3 }, true, false, ["b"]]);
  assert.deepEqual(values, { b: 3 });
});

test("clear forgets everything", () => {
  const { answers, values } = play([["set", { key: "a", value: 1 }], ["clear"], ["keys"]]);
  assert.deepEqual(answers, [null, null, []]);
  assert.deepEqual(values, {});
});

test("reading does not ask for anything to be saved, and nothing is changed in place", () => {
  const values = Object.freeze({ a: 1 });
  assert.equal(applyStoreOp(values, "get", { key: "a" }).values, undefined);
  assert.equal(applyStoreOp(values, "keys").values, undefined);
  assert.equal(applyStoreOp(values, "delete", { key: "nope" }).values, undefined);
  assert.deepEqual(applyStoreOp(values, "set", { key: "b", value: 2 }).values, { a: 1, b: 2 });
  assert.deepEqual(values, { a: 1 });
});

test("names of built-in object properties are ordinary keys", () => {
  const { answers } = play([
    ["get", { key: "toString" }],
    ["set", { key: "constructor", value: 1 }],
    ["get", { key: "constructor" }],
  ]);
  assert.deepEqual(answers, [{ exists: false }, null, { exists: true, value: 1 }]);
});

test("an unknown operation is an error", () => {
  assert.throws(() => applyStoreOp({}, "explode", {}), /Unknown page.store operation: explode/);
});

test("each script has its own storage key", () => {
  assert.equal(storeKey("s1"), "store:s1");
  assert.notEqual(storeKey("s1"), storeKey("s2"));
});
