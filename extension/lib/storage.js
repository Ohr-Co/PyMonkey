// Saved scripts live in chrome.storage.local under one key.
// A script: { id, name, match, code, enabled, timeout }
// (`timeout` is the time limit in seconds; scripts saved before it existed get the default.)

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

export async function deleteScript(id) {
  const scripts = await getScripts();
  await chrome.storage.local.set({ [KEY]: scripts.filter((s) => s.id !== id) });
}
