# PyMonkey

[![CI](https://github.com/Ohr-Co/PyMonkey/actions/workflows/ci.yml/badge.svg)](https://github.com/Ohr-Co/PyMonkey/actions/workflows/ci.yml)

A browser extension that runs your Python scripts on the pages you visit: scrape data, change page views, automate clicks and input.

Python runs inside the browser through [Pyodide](https://pyodide.org) (CPython compiled to WebAssembly). Nothing to install besides the extension, and nothing leaves your machine.

```python
# Read the page with BeautifulSoup
for link in page.select("a[href]"):
    print(link.get_text(strip=True), "->", link["href"])

# Change the page
await page.set_style("h1", "background: yellow")
await page.click("button.load-more")
```

> **Status:** early skeleton. The full loop works (write a script, run it on a page, auto-run on matching URLs), but expect rough edges. Chrome/Chromium only for now.

## Quick start

Requires [Node.js](https://nodejs.org) 22+ (only to fetch Pyodide; the extension itself has no build step).

```bash
git clone https://github.com/Ohr-Co/PyMonkey.git
cd PyMonkey
npm install
npm run setup      # copies Pyodide + bundled Python packages into extension/vendor/
```

Then in Chrome:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick the `extension` folder.
3. Open any web page, click the PyMonkey toolbar icon, and press **Run on this page**.

After changing extension code, press the reload icon on the PyMonkey card in `chrome://extensions`.

## Writing scripts

Every script gets a `page` object. Reading is instant and local; writing talks to the real page, so it uses `await`.

| Read (works on a snapshot of the page) | |
|---|---|
| `page.url`, `page.title`, `page.html` | Basic page info |
| `page.soup` | BeautifulSoup tree of the page |
| `page.select(css)`, `page.select_one(css)` | Shortcuts for `page.soup.select(...)` |

| Write (each call changes the real page) | |
|---|---|
| `await page.click(sel)` | Click the first match |
| `await page.fill(sel, value)` | Type into an input |
| `await page.set_text(sel, text)` | Set text of every match |
| `await page.set_html(sel, html)` | Set inner HTML of every match |
| `await page.set_attr(sel, name, value)` | Set an attribute on every match |
| `await page.set_style(sel, css)` | Add inline CSS to every match |
| `await page.insert_html(sel, html, position="beforeend")` | Insert HTML next to the first match |
| `await page.remove(sel)` | Remove every match |
| `await page.wait_for(sel, timeout=10)` | Wait for an element to appear |
| `await page.refresh()` | Re-snapshot after the page changed |

`print()` output and tracebacks show up in the panel. To run a script automatically, save it with a URL pattern such as `https://example.com/*` ([match pattern syntax](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)). More scripts in [`examples/`](examples).

Available packages: the Python standard library and BeautifulSoup. To bundle more [Pyodide packages](https://pyodide.org/en/stable/usage/packages-in-pyodide.html), add them to `BUNDLED_PACKAGES` in `scripts/setup.mjs` and rerun `npm run setup`.

## How it works

An extension is several isolated contexts that can only pass messages to each other:

```
 web page                    extension
┌────────────────┐   ┌──────────────────┐   ┌───────────────────────────┐
│ content.js     │◄─►│ background.js    │◄─►│ offscreen document        │
│ touches the DOM│   │ message router,  │   │  └─ web worker: Pyodide   │
│ no Python      │   │ holds no state   │   │     runs your script      │
└────────────────┘   └──────────────────┘   └───────────────────────────┘
                              ▲
                     ┌────────┴─────────┐
                     │ side panel       │
                     │ script editor    │
                     └──────────────────┘
```

1. The content script snapshots the page's HTML.
2. The background worker forwards the snapshot and your code to the offscreen document, which keeps Pyodide loaded in a web worker.
3. Python reads the snapshot with BeautifulSoup. Each `await page.something()` travels back through the same chain to the content script, which performs it on the real page.

Pyodide lives in an offscreen document because Chrome shuts the background worker down after about 30 seconds of inactivity, which would throw away the loaded interpreter. It runs in a web worker so a script stuck in an infinite loop can be killed (after 30 seconds) without taking the extension down.

## Project layout

```
extension/
  manifest.json
  background.js              message router, offscreen lifecycle, auto-run matching
  content.js                 page snapshot + DOM primitives
  offscreen/                 hidden page that owns the Python worker
  worker/pyodide-worker.js   loads Pyodide, runs scripts
  python/pymonkey_runtime.py the `page` API and script runner (plain Python)
  panel/                     side panel editor
  lib/                       URL matching, script storage
  vendor/                    Pyodide files (created by `npm run setup`, not in git)
scripts/setup.mjs            fetches Pyodide and bundled packages
examples/                    sample scripts
tests/                       unit tests + end-to-end test
```

## Tests

```bash
npm test            # URL matcher (Node) + Python runtime (pytest, needs `pip install pytest beautifulsoup4`)
npm run test:e2e    # loads the extension in Chrome for Testing and runs real scripts
```

## License

[AGPL-3.0](LICENSE)
