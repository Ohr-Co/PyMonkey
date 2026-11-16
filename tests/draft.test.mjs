import { test } from "node:test";
import assert from "node:assert/strict";
import { formToRestore, hasChanges, loadTabs, saveTabs, scriptFields, tabsToRestore } from "../extension/lib/draft.js";

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

test("open tabs are read back as they were stored, each with whether it had changes", () => {
  const storage = fakeStorage();
  assert.equal(loadTabs(storage), null); // nothing stored yet
  const tabs = [{ ...form({ code: "print(2)\n" }), key: "a" }, { ...form(), key: "b" }, { ...form({ id: null }), key: "c" }];
  saveTabs({ active: "b", tabs }, [saved], storage);
  assert.deepEqual(loadTabs(storage), {
    active: "b",
    tabs: [{ ...tabs[0], changed: true }, { ...tabs[1], changed: false }, { ...tabs[2], changed: true }],
  });
});

test("the one draft of a panel from before tabs becomes a tab", () => {
  const storage = fakeStorage();
  storage.setItem("draft", JSON.stringify({ ...form(), changed: true }));
  assert.deepEqual(loadTabs(storage), { active: "restored", tabs: [{ ...form(), changed: true, key: "restored" }] });
});

test("tabs that cannot be read count as none", () => {
  const storage = fakeStorage();
  storage.setItem("tabs", "{not json");
  assert.equal(loadTabs(storage), null);
  storage.setItem("tabs", JSON.stringify({ active: "a", tabs: [{ key: "a", name: "no code" }, { code: "no key" }] }));
  assert.equal(loadTabs(storage), null);
});

test("storage that refuses to store does not break the panel", () => {
  const full = { setItem() { throw new Error("QuotaExceededError"); }, getItem() { throw new Error("SecurityError"); } };
  saveTabs({ active: "a", tabs: [{ ...form(), key: "a" }] }, [saved], full); // does not throw
  assert.equal(loadTabs(full), null);
});

test("restoring tabs: each comes back as it was left, the one in front stays in front", () => {
  const other = { ...saved, id: "s2", name: "Other" };
  const restored = tabsToRestore(
    {
      active: "b",
      tabs: [
        { ...form({ code: "print(2)\n" }), key: "a", changed: true },
        { ...form({ id: "s2", name: "Other" }), key: "b", changed: false },
        { ...form({ id: null, code: "x = 1" }), key: "c", changed: true },
      ],
    },
    [saved, { ...other, code: "print('newer')\n" }],
  );
  assert.deepEqual(restored, {
    active: "b",
    tabs: [
      { ...form({ code: "print(2)\n" }), key: "a" },
      { ...other, code: "print('newer')\n", key: "b" }, // no changes: as it is saved now
      { ...form({ id: null, code: "x = 1" }), key: "c" },
    ],
  });
});

test("restoring tabs: a deleted script's tab stays only if it had changes", () => {
  const restored = tabsToRestore(
    {
      active: "a",
      tabs: [
        { ...form(), key: "a", changed: false },
        { ...form({ code: "print(2)\n" }), key: "b", changed: true },
      ],
    },
    [],
  );
  // The tab in front is gone: the first one left comes to the front.
  assert.deepEqual(restored, { active: "b", tabs: [{ ...form({ id: null, code: "print(2)\n" }), key: "b" }] });
});

test("restoring tabs: nothing stored, or a script open twice", () => {
  assert.deepEqual(tabsToRestore(null, [saved]), { active: null, tabs: [] });
  const twice = tabsToRestore(
    { active: "b", tabs: [{ ...form(), key: "a", changed: false }, { ...form(), key: "b", changed: false }] },
    [saved],
  );
  assert.deepEqual(twice, { active: "a", tabs: [{ ...saved, key: "a" }] });
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
