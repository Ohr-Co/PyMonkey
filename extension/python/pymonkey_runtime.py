"""PyMonkey's Python side.

This module is loaded once into Pyodide (see worker/pyodide-worker.js) and
`run()` is called for every script execution. It has no Pyodide-specific
imports, so it also runs under normal CPython -- see tests/test_runtime.py.

How a script sees the page:
  * READ:  the page's HTML is snapshotted once and handed to Python.
           `page.soup` is a BeautifulSoup tree of that snapshot.
  * WRITE: a small set of primitives (`page.click(...)`) that round-trip to
           the real page through the extension. Each call returns when the
           page has done it, so no `await` is needed.
"""

import ast
import inspect
import json
import traceback

SCRIPT_FILENAME = "<pymonkey script>"

# The methods of `page` that change the real page.
WRITE_METHODS = frozenset(
    ["click", "fill", "set_text", "set_html", "set_attr", "set_style", "insert_html", "remove", "wait_for", "refresh"]
)

AWAIT_HINT = (
    "\nNote: page.click() and the other `page` methods that change the page finish before they return,\n"
    "so they are called without `await` and cannot be passed to asyncio.gather() and the like.\n"
)


class PageError(Exception):
    """A DOM operation failed on the real page (e.g. selector not found)."""


class Page:
    """The `page` object available to every script."""

    def __init__(self, info, dom_call):
        self.url = info.get("url", "")
        self.title = info.get("title", "")
        self.html = info.get("html", "")
        self._dom_call = dom_call
        self._soup = None

    # ---- reading (local, synchronous, works on the snapshot) ----

    @property
    def soup(self):
        """BeautifulSoup tree of the page snapshot (parsed on first use)."""
        if self._soup is None:
            from bs4 import BeautifulSoup

            self._soup = BeautifulSoup(self.html, "html.parser")
        return self._soup

    def select(self, css):
        """Shortcut for page.soup.select(css)."""
        return self.soup.select(css)

    def select_one(self, css):
        """Shortcut for page.soup.select_one(css)."""
        return self.soup.select_one(css)

    # ---- writing (each call is one round trip to the real page) ----

    def _dom(self, op, **args):
        reply = json.loads(self._dom_call(op, json.dumps(args)))
        if not reply.get("ok"):
            raise PageError(reply.get("error", f"{op} failed"))
        return reply.get("value")

    def click(self, selector):
        """Click the first element matching `selector`."""
        return self._dom("click", selector=selector)

    def fill(self, selector, value):
        """Type `value` into the first matching input/textarea/select."""
        return self._dom("fill", selector=selector, value=value)

    def set_text(self, selector, text):
        """Set the text of every matching element. Returns how many changed."""
        return self._dom("set_text", selector=selector, text=text)

    def set_html(self, selector, html):
        """Replace the inner HTML of every matching element."""
        return self._dom("set_html", selector=selector, html=html)

    def set_attr(self, selector, name, value):
        """Set an attribute on every matching element."""
        return self._dom("set_attr", selector=selector, name=name, value=value)

    def set_style(self, selector, css):
        """Add inline CSS (e.g. "background: yellow") to every matching element."""
        return self._dom("set_style", selector=selector, css=css)

    def insert_html(self, selector, html, position="beforeend"):
        """Insert HTML relative to the first match.

        position: beforebegin | afterbegin | beforeend | afterend
        """
        return self._dom("insert_html", selector=selector, html=html, position=position)

    def remove(self, selector):
        """Remove every matching element. Returns how many were removed."""
        return self._dom("remove", selector=selector)

    def wait_for(self, selector, timeout=10.0):
        """Wait until an element matching `selector` exists on the real page."""
        return self._dom("wait_for", selector=selector, timeout=timeout)

    def refresh(self):
        """Re-snapshot the page (call after the page changed and you want to re-read it)."""
        info = self._dom("snapshot")
        self.url, self.title, self.html = info["url"], info["title"], info["html"]
        self._soup = None


class _DropAwaitOnWrites(ast.NodeTransformer):
    """Rewrite `await page.click(...)` to `page.click(...)`.

    The write methods used to be coroutines, so older scripts put `await` in
    front of them. They are plain methods now and `await` on their result
    would be a TypeError; dropping it keeps those scripts working.
    Only the direct form is recognized: `await page.<write method>(...)`.
    """

    def visit_Await(self, node):
        self.generic_visit(node)  # rewrite anything nested inside first
        call = node.value
        is_page_write = (
            isinstance(call, ast.Call)
            and isinstance(call.func, ast.Attribute)
            and call.func.attr in WRITE_METHODS
            and isinstance(call.func.value, ast.Name)
            and call.func.value.id == "page"
        )
        return call if is_page_write else node


async def run(code, page_json, dom_call):
    """Run one user script. Returns a JSON string: {ok, stdout, error}.

    code       -- the script source
    page_json  -- JSON string {url, title, html}
    dom_call   -- callable (op: str, args_json: str) -> JSON string. It blocks
                  until the page has answered (see makeSync in pyodide-worker.js).
    """
    output = []

    def script_print(*args, sep=" ", end="\n", **_ignored):
        output.append(sep.join(str(a) for a in args) + end)

    # Each run gets a fresh namespace, so scripts can't see each other's globals.
    namespace = {
        "__name__": "__main__",
        "page": Page(json.loads(page_json), dom_call),
        "print": script_print,
    }

    error = None
    try:
        tree = _DropAwaitOnWrites().visit(ast.parse(code, SCRIPT_FILENAME, "exec"))
        # PyCF_ALLOW_TOP_LEVEL_AWAIT lets scripts write `await asyncio.sleep(1)`
        # at the top level, without wrapping everything in `async def main()`.
        compiled = compile(tree, SCRIPT_FILENAME, "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        result = eval(compiled, namespace)
        if inspect.isawaitable(result):
            await result
    except BaseException as exc:  # includes SystemExit etc. -- a script must never kill the runtime
        error = _format_error()
        # Python's own message for awaiting a finished write ("'int' object can't
        # be awaited") does not say what to do about it.
        if isinstance(exc, TypeError) and "await" in str(exc):
            error += AWAIT_HINT

    return json.dumps({"ok": error is None, "stdout": "".join(output), "error": error})


def _format_error():
    """Traceback with PyMonkey's own frames stripped, so users see only their script."""
    lines = traceback.format_exc().splitlines(keepends=True)
    for i, line in enumerate(lines):
        if SCRIPT_FILENAME in line:
            return lines[0] + "".join(lines[i:])
    return "".join(lines)
