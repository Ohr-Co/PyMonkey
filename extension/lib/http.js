// `page.fetch`: one HTTP request for a script.
//
// The request is made by the Pyodide worker itself (see pyodide-worker.js).
// A worker of an extension page may call any site the extension has host
// permission for, and the site's CORS rules do not apply to it. That is what
// lets a script read a page or an API on another site.
//
// Bodies travel as base64 text in both directions, because the bridge between
// JavaScript and Python carries JSON and a body may be binary (an image, a zip).
//
// No chrome.* calls here, so it can be tested with plain Node (Node has `fetch` too).

/** Bytes (Uint8Array) -> base64 text. In pieces: one huge call would overflow the stack. */
export function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** base64 text -> bytes (Uint8Array). */
export const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/**
 * Make the request Python asked for (see _build_request in pymonkey_runtime.py):
 *   { url, method, headers: {name: value}, body: base64 or null, timeout: seconds (0 = none), cookies: bool }
 *
 * Always resolves, with the reply for Python:
 *   { ok: true, value: { url, status, reason, headers: [[name, value], ...], body: base64 } }
 *   { ok: false, error, timeout: bool }   no answer at all: unreachable, connection lost, too slow
 *
 * A 404 or 500 is an answer, so it is `ok: true` here; Python decides what to make of the status.
 */
export async function httpFetch({ url, method, headers, body, timeout, cookies }, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body: body == null ? undefined : fromBase64(body),
      // "include" sends the user's cookies for that site, so the request is
      // made as the logged-in user. "omit" sends none and stores none.
      credentials: cookies ? "include" : "omit",
      // Gives up (rejects with a "TimeoutError") when the whole answer, body
      // included, has not arrived in time.
      signal: timeout ? AbortSignal.timeout(timeout * 1000) : undefined,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      ok: true,
      value: {
        url: response.url, // where the answer came from, after redirects
        status: response.status,
        reason: response.statusText,
        headers: [...response.headers],
        body: toBase64(bytes),
      },
    };
  } catch (err) {
    if (err?.name === "TimeoutError") {
      return { ok: false, timeout: true, error: `no answer within ${timeout} seconds` };
    }
    // Chrome does not say why a request failed: its message is just "Failed
    // to fetch". Say what that usually means. Other messages speak for
    // themselves (e.g. a header name that is not allowed).
    const message = err?.message ?? String(err);
    const hint = "the server cannot be reached, the address is wrong, or the connection was lost";
    return { ok: false, timeout: false, error: message === "Failed to fetch" ? hint : message };
  }
}
