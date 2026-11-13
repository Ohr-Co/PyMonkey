// The panel's draft: what is in the editing form, kept so that closing the
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
// The stored draft is a form plus `changed`: whether it differs from the saved script.
//
// No chrome.* calls here, so it can be tested with plain Node (the tests pass
// their own stand-in for localStorage).

import { timeoutSeconds } from "./timeout.js";

const KEY = "draft";

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

/** Remember the form. `script` is the saved script it belongs to, if any. */
export function saveDraft(form, script, storage = localStorage) {
  try {
    storage.setItem(KEY, JSON.stringify({ ...form, changed: hasChanges(form, script) }));
  } catch {
    // Storage full or switched off: the draft is a convenience, not worth an error.
  }
}

/** The remembered draft, or null if there is none (or it cannot be read). */
export function loadDraft(storage = localStorage) {
  try {
    const draft = JSON.parse(storage.getItem(KEY));
    return typeof draft?.code === "string" ? draft : null;
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
