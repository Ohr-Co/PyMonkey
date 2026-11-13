import { test } from "node:test";
import assert from "node:assert/strict";
import { formToRestore, hasChanges, loadDraft, saveDraft, scriptFields } from "../extension/lib/draft.js";

// A stand-in for the browser's localStorage, which Node does not have.
const fakeStorage = () => {
  const items = new Map();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, String(value)) };
};

// The panel's fields. The time limit is text, as typed.
const form = (changes = {}) => ({
  id: "s1", name: "Prices", match: "https://example.com/*", enabled: true, timeout: "30", code: "print(1)\n", ...changes,
});
const saved = { id: "s1", name: "Prices", match: "https://example.com/*", enabled: true, timeout: 30, code: "print(1)\n" };

test("a form is tidied before it is saved", () => {
  assert.deepEqual(scriptFields(form({ name: "  ", match: " https://a.example/* ", timeout: "abc" })), {
    name: "Untitled", match: "https://a.example/*", enabled: true, timeout: 30, code: "print(1)\n",
  });
});

test("a form that matches its saved script has no changes", () => {
  assert.equal(hasChanges(form(), saved), false);
  assert.equal(hasChanges(form({ name: " Prices ", timeout: "30.0" }), saved), false); // same once tidied
});

test("a difference in any field is a change", () => {
  assert.equal(hasChanges(form({ code: "print(2)\n" }), saved), true);
  assert.equal(hasChanges(form({ name: "Costs" }), saved), true);
  assert.equal(hasChanges(form({ match: "" }), saved), true);
  assert.equal(hasChanges(form({ enabled: false }), saved), true);
  assert.equal(hasChanges(form({ timeout: "0" }), saved), true);
});

test("a script that was never saved always has changes", () => {
  assert.equal(hasChanges(form({ id: null }), undefined), true);
});

test("a script saved before it had a time limit counts as having the default", () => {
  const { timeout, ...old } = saved;
  assert.equal(hasChanges(form(), old), false);
  assert.equal(hasChanges(form({ timeout: "5" }), old), true);
});

test("a draft is read back as it was stored, with whether it had changes", () => {
  const storage = fakeStorage();
  assert.equal(loadDraft(storage), null); // nothing stored yet
  saveDraft(form({ code: "print(2)\n" }), saved, storage);
  assert.deepEqual(loadDraft(storage), { ...form({ code: "print(2)\n" }), changed: true });
  saveDraft(form(), saved, storage);
  assert.deepEqual(loadDraft(storage), { ...form(), changed: false });
});

test("a draft that cannot be read counts as no draft", () => {
  const storage = fakeStorage();
  storage.setItem("draft", "{not json");
  assert.equal(loadDraft(storage), null);
  storage.setItem("draft", JSON.stringify({ name: "no code" }));
  assert.equal(loadDraft(storage), null);
});

test("storage that refuses to store does not break the panel", () => {
  const full = { setItem() { throw new Error("QuotaExceededError"); }, getItem() { throw new Error("SecurityError"); } };
  saveDraft(form(), saved, full); // does not throw
  assert.equal(loadDraft(full), null);
});

test("no draft: the panel opens with a new script", () => {
  assert.equal(formToRestore(null, [saved]), null);
});

test("a never-saved draft comes back as it was", () => {
  const draft = { ...form({ id: null, code: "x = 1" }), changed: true };
  assert.deepEqual(formToRestore(draft, [saved]), form({ id: null, code: "x = 1" }));
});

test("a saved script with unsaved changes comes back with the changes", () => {
  const draft = { ...form({ code: "print(2)\n" }), changed: true };
  assert.deepEqual(formToRestore(draft, [saved]), form({ code: "print(2)\n" }));
});

test("a saved script without changes comes back as it is saved now", () => {
  const draft = { ...form(), changed: false };
  const editedElsewhere = { ...saved, code: "print('newer')\n" };
  assert.deepEqual(formToRestore(draft, [editedElsewhere]), editedElsewhere);
});

test("a draft of a script that was deleted meanwhile comes back as a script that is not saved", () => {
  const draft = { ...form({ code: "print(2)\n" }), changed: true };
  assert.deepEqual(formToRestore(draft, []), form({ id: null, code: "print(2)\n" }));
  assert.deepEqual(formToRestore({ ...form(), changed: false }, []), form({ id: null }));
});
