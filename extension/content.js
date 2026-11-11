// Content script: the ONLY part of PyMonkey that can touch the real page.
// It has no Python. It does three things when the background asks, all as "dom" operations:
//   1. snapshot the page (HTML string) so Python can read it with BeautifulSoup
//   2. run one DOM primitive (click, set_text, ...) on Python's behalf
//   3. save a file Python made to the Downloads folder (page.download)
//
// Each primitive here has a matching method on `Page` in python/pymonkey_runtime.py.

(() => {
  // Guard: the background may inject this file a second time (see background.js).
  if (window.__pymonkeyLoaded) return;
  window.__pymonkeyLoaded = true;

  const snapshot = () => ({
    url: location.href,
    title: document.title,
    html: document.documentElement.outerHTML,
  });

  const first = (selector) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`No element matches ${JSON.stringify(selector)}`);
    return el;
  };

  // Apply fn to every match, return how many there were.
  const each = (selector, fn) => {
    const els = document.querySelectorAll(selector);
    els.forEach(fn);
    return els.length;
  };

  const ops = {
    snapshot,

    click({ selector }) {
      first(selector).click();
      return true;
    },

    fill({ selector, value }) {
      const el = first(selector);
      el.focus();
      el.value = value;
      // Let the page's own JS (React etc.) notice the change.
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },

    set_text: ({ selector, text }) => each(selector, (el) => (el.textContent = text)),
    set_html: ({ selector, html }) => each(selector, (el) => (el.innerHTML = html)),
    set_attr: ({ selector, name, value }) => each(selector, (el) => el.setAttribute(name, value)),
    set_style: ({ selector, css }) => each(selector, (el) => (el.style.cssText += ";" + css)),
    remove: ({ selector }) => each(selector, (el) => el.remove()),

    insert_html({ selector, html, position }) {
      first(selector).insertAdjacentHTML(position, html);
      return true;
    },

    wait_for({ selector, timeout }) {
      return new Promise((resolve, reject) => {
        if (document.querySelector(selector)) return resolve(true);
        const observer = new MutationObserver(() => {
          if (document.querySelector(selector)) {
            observer.disconnect();
            clearTimeout(timer);
            resolve(true);
          }
        });
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`Timed out after ${timeout}s waiting for ${JSON.stringify(selector)}`));
        }, timeout * 1000);
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      });
    },

    // Save a file to the Downloads folder the way a download link on a page
    // does: make a link to the data, give it a file name, and click it.
    // The link is never added to the page, so the page does not notice.
    // (`base64` is the file's bytes as text: messages carry JSON, not bytes.)
    download({ filename, base64, type }) {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type }));
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      // Free the copy held under `url` once the browser has had time to save it.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return true;
    },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.target !== "content") return;

    if (msg.type === "dom") {
      const op = ops[msg.op];
      Promise.resolve()
        .then(() => {
          if (!op) throw new Error(`Unknown DOM operation: ${msg.op}`);
          return op(msg.args ?? {});
        })
        .then((value) => sendResponse({ ok: true, value }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
      return true; // keep the channel open: we answer asynchronously
    }
  });

  // Tell the background this page is ready, so it can auto-run matching scripts.
  chrome.runtime.sendMessage({ target: "background", type: "page-ready", url: location.href }).catch(() => {});
})();
