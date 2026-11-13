// Saved scripts live in chrome.storage.local under one key.
// A script: { id, name, match, code, enabled, timeout }
// (`timeout` is the time limit in seconds; scripts saved before it existed get the default.)
//
// The last automatic run of each script is stored next to them, one key per
// script (see lib/last-run.js). One key each, rather than one shared object,
// so two scripts finishing at the same moment cannot overwrite each other.
//
// What a script saves with `page.store` is a third kind of entry, again one
// key per script (see lib/script-store.js).

import { lastRunKey } from "./last-run.js";
import { applyStoreOp, storeKey } from "./script-store.js";

const KEY = "scripts";

export async function getScripts() {
  const data = await chrome.storage.local.get(KEY);
  return data[KEY] ?? [];
}

/** Insert or update (by id). Returns the saved script. */
export async function saveScript(script) {
  const scripts = await getScripts();
  const saved = { enabled: true, match: "", ...script, id: script.id ?? crypto.randomUUID() };
  const i = scripts.findIndex((s) => s.id === saved.id);
  if (i === -1) scripts.push(saved);
  else scripts[i] = saved;
  await chrome.storage.local.set({ [KEY]: scripts });
  return saved;
}

/** Delete a script, its last run and the values it saved with `page.store`. */
export async function deleteScript(id) {
  const scripts = await getScripts();
  await chrome.storage.local.set({ [KEY]: scripts.filter((s) => s.id !== id) });
  await chrome.storage.local.remove([lastRunKey(id), storeKey(id)]);
}

// ---------- last runs ----------

/** The last run of every saved script that has one, as { scriptId: lastRun }. */
export async function getLastRuns() {
  const scripts = await getScripts();
  const data = await chrome.storage.local.get(scripts.map((s) => lastRunKey(s.id)));
  const lastRuns = {};
  for (const { id } of scripts) {
    if (data[lastRunKey(id)]) lastRuns[id] = data[lastRunKey(id)];
  }
  return lastRuns;
}

/** Store a script's last run, replacing the one before. Skipped if the script was deleted meanwhile. */
export async function saveLastRun(scriptId, lastRun) {
  const scripts = await getScripts();
  if (!scripts.some((s) => s.id === scriptId)) return;
  await chrome.storage.local.set({ [lastRunKey(scriptId)]: lastRun });
}

/** Record that the user has been shown this script's last run. */
export async function markLastRunSeen(scriptId) {
  const key = lastRunKey(scriptId);
  const lastRun = (await chrome.storage.local.get(key))[key];
  if (lastRun && !lastRun.seen) await chrome.storage.local.set({ [key]: { ...lastRun, seen: true } });
}

// ---------- page.store ----------

/**
 * Carry out one `page.store` operation for a script. Returns the reply for
 * Python: { ok: true, value } or { ok: false, error }.
 */
export async function scriptStoreCall(scriptId, op, args) {
  if (!scriptId) {
    return { ok: false, error: "page.store keeps values per saved script. Save this script, then run it again." };
  }
  const key = storeKey(scriptId);
  const values = (await chrome.storage.local.get(key))[key] ?? {};
  const { value, values: changed } = applyStoreOp(values, op, args);
  if (changed) await chrome.storage.local.set({ [key]: changed });
  return { ok: true, value };
}
