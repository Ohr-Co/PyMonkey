# Contributing to PyMonkey

Thanks for wanting to help. This file covers how to set the project up, how to run its tests, and how to propose a change.

Before a pull request from someone outside the project can be merged, its author has to agree to the [contributor license agreement](CLA.md). The [last section](#the-contributor-license-agreement) says why.

Security problems are reported privately, not in an issue: see [SECURITY.md](SECURITY.md).

## Setup

You need Chrome, [Node.js](https://nodejs.org) 22+ and Python 3 (the tests are run with Python 3.12). The README's [Quick start](README.md#quick-start) has the details.

```bash
git clone https://github.com/Ohr-Co/PyMonkey.git
cd PyMonkey
npm install
npm run setup                          # fetches Pyodide into extension/vendor/ (not in git)
pip install pytest beautifulsoup4      # for the Python tests
```

Load the extension in Chrome: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `extension` folder. After changing extension code, press the reload icon on the PyMonkey card.

`npm run setup` is the only setup command. There is no build step for PyMonkey's own files: Chrome runs the JavaScript in `extension/` as it is written.

## Tests

```bash
npm test            # JavaScript unit tests (Node's built-in test runner) and the Python runtime (pytest)
npm run test:e2e    # loads the extension in a real browser and runs scripts on a test page
```

The end-to-end test needs "Chrome for Testing" (regular Chrome no longer accepts `--load-extension`). If the test cannot find it:

```bash
npx @puppeteer/browsers install chrome@stable
export CHROME_PATH=/path/to/the/binary/that/command/printed
```

Every change comes with tests. Which kind depends on what the change touches:

| The change is in | Test it with |
|---|---|
| Python behavior (`extension/python/pymonkey_runtime.py`) | pytest, in `tests/test_runtime.py` |
| JavaScript logic that needs no browser (`extension/lib/`) | a `node:test` file, `tests/<name>.test.mjs` |
| Anything that crosses the extension boundary: messages, the page, storage, the panel | a check in `tests/e2e.mjs` |

Do not weaken or delete a test to make a change pass. If a test is wrong, say so in the pull request and fix the test in a commit of its own.

## How the code is organized

The README's [How it works](README.md#how-it-works) and [Project layout](README.md#project-layout) sections are the map. A few rules hold the design together; a change that breaks one needs a discussion first.

- **Messages go `content.js` ↔ `background.js` ↔ offscreen document ↔ web worker (Pyodide).** Every message has a `target` field that names who it is for.
- **The background service worker is a stateless router.** Chrome shuts it down when it is idle, so nothing may be kept in its global variables.
- **No remote code.** Manifest V3 forbids it, and so does the Chrome Web Store. Every library, font and other asset is bundled in the extension; nothing is loaded from a CDN at runtime.
- **`extension/python/pymonkey_runtime.py` imports nothing that only exists in Pyodide**, so it can be tested with plain pytest.
- **No build step unless a change truly needs one.** If you add one, justify it in the pull request and keep `npm run setup` as the single setup command.
- **Comments are written for a reader who is fluent in Python and new to JavaScript and browser extensions.** Say why the code does what it does, and explain browser concepts where they first appear. Match the level of the comments around your change.

## Proposing a change

1. **Start from an issue.** For a bug, describe what you did, what you expected and what happened. For a feature, describe who needs it and why. For anything larger than a small fix, wait for a maintainer's answer before writing code: it saves you from building something that cannot be merged.
2. **One issue per branch and per pull request.** Branch from an up-to-date `main` and name the branch `issue-<number>-<short-name>`, for example `issue-12-icons`.
3. **Write the change and its tests.** Update `README.md` whenever user-facing behavior or the `page` API changes.
4. **Run the full suite** (`npm test` and `npm run test:e2e`) and paste the result in the pull request.
5. **Open the pull request** against `main`. Put `Closes #<number>` in its description, and say what you verified and what you could not. If the issue has acceptance criteria, go through them one by one.
6. **Agree to the CLA** when asked (see below). A maintainer then reviews and merges; contributors do not merge their own pull requests.

Ask before you add a runtime dependency (everything in the extension is downloaded by every user), ask for more permissions in the manifest, or change how messages flow.

## The contributor license agreement

PyMonkey is licensed under the [AGPL-3.0](LICENSE). Offering it under any other terms later (a commercial license next to the open-source one, for example) needs permission from everyone who holds copyright in it. The [CLA](CLA.md) is that permission, given once and in advance: you keep the copyright in what you contribute, and you give the project owner the right to license it under other terms as well.

The CLA is still a draft; its first lines say what is open. Once it is final, you will be asked to agree to it on your first pull request, and contributions from outside the project are merged after that. It covers that contribution and your later ones. If you contribute on behalf of your employer, check that you are allowed to: the CLA asks you to confirm it.
