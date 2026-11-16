// The panel's drafts: what is in each open tab, kept so that closing the
// side panel (or the browser) does not lose text that was not saved.
//
// It is kept in the panel's own `localStorage`, not in chrome.storage like
// everything else, because writing to localStorage is synchronous: the text is
// stored by the time the call returns, on every keystroke. A chrome.storage
// write is still on its way when a panel is closed right after typing.
// Nothing but the panel needs the draft, and it never leaves this browser.
//
// A "form" is the state of the panel's fields:
//   { id, name, match, enabled, timeout, code }     id is null for a script that was never saved
// A tab is a form plus `key`, which tells the tab apart even before its script has an id.
// What is stored is { active, tabs }: the key of the tab in front, and every
// tab with `changed`: whether it differs from its saved script.
//
// No chrome.* calls here, so it can be tested with plain Node (the tests pass
// their own stand-in for localStorage).

import { timeoutSeconds } from "./timeout.js";

const KEY = "tabs";
const OLD_KEY = "draft"; // before tabs: the one form the panel had

/** The fields of a form as they are saved: the name and pattern tidied up. */
export function scriptFields(form) {
  return {
    name: form.name.trim() || "Untitled",
    match: form.match.trim(),
    enabled: form.enabled,
    timeout: timeoutSeconds(form.timeout),
    code: form.code,
  };
}

/** Would saving this form change anything? `script` is the saved script, if there is one. */
export function hasChanges(form, script) {
  if (!script) return true; // never saved
  const fields = scriptFields(form);
  // (Tidied the same way, so that a script saved before a field existed counts as having its default.)
  const saved = scriptFields({ name: "", match: "", enabled: true, ...script });
  return Object.keys(fields).some((key) => fields[key] !== saved[key]);
}

/**
 * Remember the open tabs. `active` is the key of the tab in front, `scripts`
 * the saved scripts, to tell which tabs have changes.
 */
export function saveTabs({ active, tabs }, scripts, storage = localStorage) {
  const stored = tabs.map((tab) => ({ ...tab, changed: hasChanges(tab, scripts.find((s) => s.id === tab.id)) }));
  try {
    storage.setItem(KEY, JSON.stringify({ active, tabs: stored }));
  } catch {
    // Storage full or switched off: the drafts are a convenience, not worth an error.
  }
}

/** The remembered tabs, or null if there are none (or they cannot be read). */
export function loadTabs(storage = localStorage) {
  try {
    const saved = JSON.parse(storage.getItem(KEY));
    if (Array.isArray(saved?.tabs)) {
      const tabs = saved.tabs.filter((tab) => typeof tab?.code === "string" && typeof tab.key === "string");
      return tabs.length ? { active: saved.active, tabs } : null;
    }
    // A panel from before tabs left one draft: it becomes the one tab.
    const draft = JSON.parse(storage.getItem(OLD_KEY));
    return typeof draft?.code === "string" ? { active: "restored", tabs: [{ ...draft, key: "restored" }] } : null;
  } catch {
    return null;
  }
}

/**
 * What the panel should show when it opens: a form, or null for a new script.
 * `scripts` are the saved scripts as they are now, which may no longer be as
 * they were when the draft was stored.
 */
export function formToRestore(draft, scripts) {
  if (!draft) return null;
  const { changed, ...form } = draft;
  if (form.id == null) return { ...form, id: null }; // a script that was never saved
  const script = scripts.find((s) => s.id === form.id);
  // Deleted in the meantime: keep the text, as a script that is not saved.
  if (!script) return { ...form, id: null };
  // Without changes of its own, show the script as it is saved now.
  return changed ? form : script;
}

/**
 * The tabs to open the panel with: { active, tabs }, with no tabs if there is
 * nothing to restore. Each tab comes back as formToRestore says, except one
 * whose script was deleted without it having changes of its own: with nothing
 * of its own to keep, it is left closed. A script open in two tabs gets one.
 */
export function tabsToRestore(saved, scripts) {
  const tabs = [];
  for (const { key, ...draft } of saved?.tabs ?? []) {
    if (draft.id != null && !draft.changed && !scripts.some((s) => s.id === draft.id)) continue;
    const form = formToRestore(draft, scripts);
    if (form.id != null && tabs.some((tab) => tab.id === form.id)) continue;
    tabs.push({ ...form, key });
  }
  const active = tabs.some((tab) => tab.key === saved?.active) ? saved.active : (tabs[0]?.key ?? null);
  return { active, tabs };
}
