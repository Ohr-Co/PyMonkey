# Memory

How much memory PyMonkey takes, how that was measured, and what the extension does to keep it low.

## In short

- Loaded and waiting, Python costs about **100 MB** on top of the 26 MB of an extension that does nothing: 126 MB in all.
- A run on an ordinary page adds a few MB while it lasts. A run on a very large page (6 MB of HTML, 40,000 table rows) adds about 145 MB while it lasts.
- When no script has run for **five minutes**, Python is shut down and the memory goes back to the computer. If the side panel is closed as well, PyMonkey then takes no memory at all.
- The next run loads Python again. That run starts about **two seconds** later than it otherwise would.

## The numbers

Memory of the extension's process in MB, the middle value of three rounds. "Before" is the extension as it was before issue #14, "after" is with the three measures described below.

| Stage | Before | After |
| --- | ---: | ---: |
| Browser just started, PyMonkey not used yet | 26 | 26 |
| Python loaded, side panel open | 126 | 126 |
| **Python loaded, idle (after warm-up)** | **126** | **125** |
| **During a run** on a small page (0.03 MB of HTML) | **133** | **132** |
| 5 seconds after that run | 129 | 129 |
| During a run on a large page (6.1 MB of HTML) | 272 | 269 |
| **5 seconds after the run on the large page** | **263** | **163** |
| Idle period over | 248 (Python still loaded) | 77 (Python shut down) |
| One minute later | 248 | 0 |
| 5 seconds after the next run | 249 | 111 (Python loaded again) |

From opening the small page to the script having read it took 0.4 s with Python loaded, and 2.2 s when Python had to be loaded again first.

What the table says:

- **Idle and small pages: no change.** About 100 MB is what a loaded Python costs, and nothing done here makes Python itself smaller.
- **After a large page: 100 MB less**, at once. Before, the 263 MB stayed for as long as the browser was open, even though the script was long over.
- **After the idle period: everything is given back.** The 77 MB is the moment in between: Python is gone, but Chrome has not stopped the extension's background worker yet. It does so 30 seconds later, and since nothing of the extension is left then, Chrome ends its process. With the side panel open the process stays, with the panel's own memory.
- **During a run nothing is saved.** A script that reads a 6 MB page needs the memory while it runs.

### Python's own memory

The process figures above include Chrome's share. Python's own memory can be read from inside (the size of its WebAssembly memory, see below):

| | Python's memory |
| --- | ---: |
| Just loaded, with BeautifulSoup | 31 MB |
| After a run on a page of 1 MB | 54 MB |
| After a run on the page of 6.1 MB | 163 MB |

These were read once each while working on #14, not by the script below. The number of Python objects went back to where it was after every run (about 26,000), so nothing was leaking: the memory was free *inside* Python, and still taken as far as the computer was concerned. The next section says why.

## Why Python does not give memory back

Pyodide is CPython compiled to WebAssembly. A WebAssembly program has one block of memory (its "heap"). The block grows when the program needs more, and **it can never shrink**. When a script is over and its objects are freed, the space is free for the next script to use, but the block stays as large as the largest script ever made it.

The only way to hand that memory back to the computer is to end the program: stop the web worker Python runs in, or close the offscreen document that owns the worker.

## What PyMonkey does

1. **The page snapshot is released after each run.** Each run gets the page's HTML as a string, and BeautifulSoup builds a tree from it, several times the size of the HTML. When the script ends, `run()` in `pymonkey_runtime.py` empties the `page` object and the script's variables and runs the garbage collector (a BeautifulSoup tree is full of circular references, which only the collector frees). This holds even if the script failed, or stored `page` somewhere that outlives the run. It takes about 7 ms.

   By itself this does not lower the numbers above, because of the previous section. What it does is keep Python's memory from growing run after run: the space is used again.

2. **Python is restarted after a run that made its memory grow a lot.** The worker reports the size of Python's memory with every result. If it has grown by more than 64 MB since Python was loaded, the offscreen document replaces the worker with a new one as soon as the run is over. The new one loads Python right away, so the next run does not wait. Scripts that were queued behind the large one are not affected: they run in the new worker.

   64 MB is a judgment: a 1 MB page grows Python by 23 MB and is left alone, the 6 MB page grows it by 132 MB and is not. Packages a script imported are loaded again when a later script imports them (a tenth of a second or so each).

3. **Python is shut down after five idle minutes.** The offscreen document counts down from the last time anything was asked of it. A run, a queued run or Python still loading stops the countdown, however long the run takes. At zero the document closes itself. The background worker opens a new one the next time something needs Python: a script that runs automatically, **Run** in the panel, or the panel being opened.

   The cost is the two seconds above, on the first run after a pause. The countdown does not care whether the panel is open: with the panel open and nothing run for five minutes, the next **Run** is the slow one.

The logic of 2 and 3 is in `extension/lib/memory.js`, where the two numbers can be changed.

## What is not done

- Nothing lowers the memory **during** a run.
- Nothing lowers the 100 MB of a loaded Python. A smaller Pyodide build, or not loading BeautifulSoup until a script uses it, might; neither was tried.
- 163 MB five seconds after the large run is still about 35 MB above a freshly loaded Python. Where those are was not looked into. They are gone with the rest after the idle period.

## How it was measured

```bash
npm run measure                    # one round, about two minutes
npm run measure -- --rounds 3      # the middle value of three rounds
npm run measure -- --extension ../other-copy/extension    # another copy of PyMonkey, to compare with
```

`scripts/measure-memory.mjs` starts Chrome for Testing with the extension, the same way the end-to-end test does, and uses it like a person would: it saves a script that runs automatically, then opens pages. The script selects every table row on the page, reads a number out of each, and then waits six seconds so there is time to measure while it still holds the rows. At each stage the measuring script finds the extension's process and asks the operating system how large it is.

Chrome runs everything an extension does (the background worker, the offscreen document with Python in it, the side panel) in one process of its own, so that one figure is the whole of PyMonkey. The content script is not in it: it lives in each page's process and holds no Python.

Two things differ from normal use, both to keep the measurement short. The idle period is 30 seconds instead of 300 (`--idle` changes it). And the side panel is opened as a tab, since a test cannot open the real panel.

The figures above are from Chrome for Testing 145.0.7632.6 on an Apple-silicon Mac (macOS 15.5), with Pyodide 314.0.7. They will differ on other machines; the differences between the rows should not.

### Which figure

The script prints two columns on a Mac and one elsewhere:

- **Footprint** is the memory that belongs to the process alone. It is what Activity Monitor and Chrome's own task manager show, and what the tables above use. It comes from the `footprint` tool, which only macOS has.
- **RSS** ("resident set size") comes from `ps`, so it is available on Linux too. It counts about 70 MB of Chrome's own code that all Chrome processes share, so it is higher: 345 MB where the footprint is 126 MB. On the Mac it also moved in ways the footprint did not (in one round it fell by 80 MB while nothing happened), which is why the tables do not use it.

The script has only been run on macOS. On Linux it should print the RSS column; that was not tried.
