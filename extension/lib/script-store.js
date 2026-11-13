// `page.store`: the values a script keeps between runs.
//
// Each saved script has one object of { key: value } in chrome.storage.local,
// under its own storage key, so scripts cannot see each other's values.
// A value is JSON text, written and read by Python: chrome.storage sorts the
// keys of the objects it is given, and a Python dict should come back in order.
// Python asks for one operation at a time (see Store in pymonkey_runtime.py)
// and the background answers it with applyStoreOp below.
//
// This file has no chrome.* calls so it can be tested with plain Node.

/** The chrome.storage.local key of a script's saved values. */
export const storeKey = (scriptId) => `store:${scriptId}`;

/**
 * Apply one operation to a script's saved values.
 * Returns { value, values }: `value` is the answer for Python, `values` is the
 * new object to save, left out when the operation changed nothing.
 */
export function applyStoreOp(values, op, args = {}) {
  const has = Object.hasOwn(values, args.key);
  switch (op) {
    case "get":
      // "Nothing saved" and "None was saved" are different answers.
      return { value: has ? { exists: true, value: values[args.key] } : { exists: false } };
    case "set":
      return { value: null, values: { ...values, [args.key]: args.value } };
    case "delete": {
      if (!has) return { value: false };
      const { [args.key]: _removed, ...rest } = values;
      return { value: true, values: rest };
    }
    case "keys":
      // Sorted, because that is how chrome.storage hands the object back anyway.
      return { value: Object.keys(values).sort() };
    case "clear":
      return { value: null, values: {} };
    default:
      throw new Error(`Unknown page.store operation: ${op}`);
  }
}
