# PyMonkey

A browser extension that runs your Python scripts on the pages you visit: scrape data, change page views, automate clicks and input.

Python runs inside the browser through [Pyodide](https://pyodide.org) (CPython compiled to WebAssembly). Nothing to install besides the extension, and nothing leaves your machine.

```python
# Read the page with BeautifulSoup
for link in page.select("a[href]"):
    print(link.get_text(strip=True), "->", link["href"])

# Change the page
page.set_style("h1", "background: yellow")
page.click("button.load-more")
```

> **Status:** early skeleton. The full loop works (write a script, run it on a page, auto-run on matching URLs), but expect rough edges. Chrome/Chromium only for now.

## Quick start

Requires Chrome 137 or newer, and [Node.js](https://nodejs.org) 22+ (only to fetch Pyodide; the extension itself has no build step).

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

Every script gets a `page` object. Reading is instant and works on a local copy of the page; writing talks to the real page and returns when the page has done it. `page.store` remembers values from one run to the next, `page.fetch` gets other addresses, and `page.download` saves what you collected as a file.

| Read (works on a snapshot of the page) | |
|---|---|
| `page.url`, `page.title`, `page.html` | Basic page info |
| `page.soup` | BeautifulSoup tree of the page |
| `page.select(css)`, `page.select_one(css)` | Shortcuts for `page.soup.select(...)` |

| Write (each call changes the real page) | |
|---|---|
| `page.click(sel)` | Click the first match |
| `page.fill(sel, value)` | Type into an input |
| `page.set_text(sel, text)` | Set text of every match |
| `page.set_html(sel, html)` | Set inner HTML of every match |
| `page.set_attr(sel, name, value)` | Set an attribute on every match |
| `page.set_style(sel, css)` | Add inline CSS to every match |
| `page.insert_html(sel, html, position="beforeend")` | Insert HTML next to the first match |
| `page.remove(sel)` | Remove every match |
| `page.wait_for(sel, timeout=10)` | Wait for an element to appear |
| `page.refresh()` | Re-snapshot after the page changed |

| Remember (`page.store`, kept between runs) | |
|---|---|
| `page.store.get(key, default=None)` | The value saved under `key`, or `default` |
| `page.store.set(key, value)` | Save a value |
| `page.store.delete(key)` | Forget one key; `True` if it was there |
| `page.store.keys()` | The saved keys, in alphabetical order |
| `page.store.clear()` | Forget everything this script saved |

```python
seen = page.store.get("seen", [])
new = [a["href"] for a in page.select("a[href]") if a["href"] not in seen]
print(len(new), "links I have not seen before")
page.store.set("seen", seen + new)
```

Each saved script has its own store, which other scripts cannot read. It is kept in the browser's extension storage, so it is still there after Chrome restarts, and it is deleted together with the script. Keys are strings. Values can be anything JSON can hold (numbers, strings, booleans, `None`, lists, dicts) and come back the way `json.loads(json.dumps(value))` would return them, so a tuple comes back as a list. A script that has not been saved yet has no store: save it first. Chrome gives the extension about 10 MB for all scripts and everything they save; a value that does not fit raises `PageError` and what was saved before stays.

| Fetch (HTTP requests) | |
|---|---|
| `page.fetch(url)` | Request an address and return the response. `url` may be relative to the page |
| `response.status`, `response.ok`, `response.reason` | Status code, whether it is 200-299, and the status in words |
| `response.text`, `response.json()` | The body as a string, or parsed as JSON |
| `response.content`, `response.soup` | The body as bytes, or as a BeautifulSoup tree |
| `response.headers`, `response.url` | Response headers, and the address after redirects |
| `response.raise_for_status()` | Raise `urllib.error.HTTPError` if the status is 400 or above |

```python
for link in page.select("a.article")[:5]:
    article = page.fetch(link["href"]).soup          # follow a link on this site
    print(article.select_one("h1").get_text(strip=True))

rates = page.fetch("https://api.example.com/rates", params={"base": "EUR"}).json()
```

`page.fetch` also takes `method`, `params` (added to the address), `headers`, a body as `data` (text, bytes, or a dict of form fields) or `json`, `timeout` in seconds (30 by default), and `cookies`. A response with an error status such as 404 is returned like any other; check `response.ok`. If there is no answer at all, `page.fetch` raises `ConnectionError`, or `TimeoutError` when it took too long. Those two and `HTTPError` are all `OSError`s, so `except OSError` catches any of them.

**Requests and security.** A web page may only read answers from other sites that allow it (the browser's CORS rule). PyMonkey scripts are not held to that rule: the extension has permission for every site, so `page.fetch` can read any address. That is what makes combining data from several sites possible. It also means a script can read a site you are logged in to and send what it finds somewhere else, so there are two things to know:

- Cookies are what make a request count as you. `page.fetch` sends the browser's cookies only to the site the script is running on, so following links there works while you are logged in. Requests to any other site are made without cookies, as a stranger would make them, unless the script says `cookies=True`.
- That default prevents accidents; it does not fence a script in. A script is ordinary Python running inside the extension, and can reach the browser's own `fetch` through Pyodide's `js` module, cookies included. Treat a script like any program you install: read it before you run it, above all one that somebody else wrote.

| Save (a file in your Downloads folder) | |
|---|---|
| `page.download("rows.csv", rows)` | A list of dicts becomes a CSV file: one row each, the keys as header line |
| `page.download("data.json", value)` | Anything JSON can hold becomes a JSON file |
| `page.download("notes.txt", text)` | A string or bytes is saved as it is, under any name |

```python
rows = [{"text": a.get_text(strip=True), "href": a["href"]} for a in page.select("a[href]")]
page.download("links.csv", rows)
```

The file arrives like any other download. For CSV, the columns are the keys of the dicts in the order they first appear, and a row without a key gets an empty cell; a list of lists is written without a header line. The file is UTF-8 with a byte-order mark so that Excel shows accented letters correctly (in Python, read it back with `encoding="utf-8-sig"`). Cells are written as scraped: text starting with `=` is a formula to a spreadsheet, so be as careful with a file scraped from a site you do not trust as with any other spreadsheet from a stranger. A file can be up to 30 MB, far beyond 10,000 rows. When a script saves several files in a row, Chrome may ask once whether the site may download multiple files.

Write, store, fetch and download calls need no `await`. Scripts written for earlier versions, which say `await page.click(...)`, keep working. Top-level `await` is still there for things that really are asynchronous, such as `await asyncio.sleep(1)`.

`print()` output and tracebacks show up in the panel. While a script runs, the Run button becomes **Stop**, which ends it at once.

Each script has a **time limit**, 30 seconds unless you change it in the panel. A script that runs longer is stopped, so a runaway loop cannot hang around forever. Raise the limit for slow work such as a long scrape, or set it to 0 for no limit. The limit is saved with the script and also applies when it runs automatically. A stopped script's output so far is not kept.

To run a script automatically, save it with a URL pattern such as `https://example.com/*` ([match pattern syntax](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)). More scripts in [`examples/`](examples).

Automatic runs happen whether or not the panel is open. PyMonkey keeps each script's **last automatic run**: when it ran, on which URL, whether it succeeded, and what it printed (long output is cut to its last 20,000 characters). Select a script in the panel to see it. When an automatic run fails, the toolbar icon gets a red badge with the number of failed scripts and the script is marked "(failed)" in the panel's list. The badge goes away once you have looked at the failure in the panel, or the script is deleted.

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

1. The background worker forwards your code to the offscreen document, which keeps Pyodide loaded in a web worker and runs scripts one at a time, in the order they were started.
2. When a script's turn comes, the content script snapshots the page's HTML.
3. Python reads the snapshot with BeautifulSoup. Each write, such as `page.click(...)`, travels back through the same chain to the content script, which performs it on the real page. `page.store` calls take the same road as far as the background worker, which reads and writes the extension's storage. `page.fetch` requests need no road at all: the web worker makes them itself.
4. When the script ends, its output is sent to the panel as a new message.

Pyodide lives in an offscreen document because Chrome shuts the background worker down after about 30 seconds of inactivity, which would throw away the loaded interpreter. It runs in a web worker so a script stuck in an infinite loop can be killed (by the Stop button or its time limit) without taking the extension down. The next run starts a fresh worker.

For the same reason the panel never holds one request open for the length of a run: Chrome would drop the answer if it shut the background worker down in the meantime. Starting a run is answered at once, the result arrives later as its own message, and the panel checks on the run every few seconds. If a run is lost (for example the extension was reloaded while it ran), the panel says so instead of waiting.

## Project layout

```
extension/
  manifest.json
  background.js              message router, offscreen lifecycle, auto-run matching, storage
  content.js                 page snapshot, DOM primitives, saving downloads
  offscreen/                 hidden page that owns the Python worker
  worker/pyodide-worker.js   loads Pyodide, runs scripts
  python/pymonkey_runtime.py the `page` API and script runner (plain Python)
  panel/                     side panel editor
  lib/                       URL matching, storage (scripts, last runs, page.store), run queue and run client, time limit, HTTP requests
  vendor/                    Pyodide files (created by `npm run setup`, not in git)
scripts/setup.mjs            fetches Pyodide and bundled packages
examples/                    sample scripts
tests/                       unit tests + end-to-end test
```

## Tests

```bash
npm test            # JavaScript unit tests (Node) + Python runtime (pytest, needs `pip install pytest beautifulsoup4`)
npm run test:e2e    # loads the extension in Chrome for Testing and runs real scripts
```

## License

[AGPL-3.0](LICENSE)
