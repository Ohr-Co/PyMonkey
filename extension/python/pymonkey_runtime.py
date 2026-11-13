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
  * STORE: `page.store` keeps values between runs, one store per saved script.
  * FETCH: `page.fetch(url)` makes an HTTP request to any address.
"""

import ast
import base64
import inspect
import json
import traceback
from urllib.parse import urlencode, urljoin, urlsplit, urlunsplit

SCRIPT_FILENAME = "<pymonkey script>"

# The methods of `page` that change the real page.
WRITE_METHODS = frozenset(
    ["click", "fill", "set_text", "set_html", "set_attr", "set_style", "insert_html", "remove", "wait_for", "refresh"]
)

AWAIT_HINT = (
    "\nNote: page.click(), page.fetch(), page.store.get() and the other `page` calls finish before they return,\n"
    "so they are called without `await` and cannot be passed to asyncio.gather() and the like.\n"
)


class PageError(Exception):
    """Something asked of the page or the extension failed (e.g. selector not found)."""


def _ask(host_call, service, op, args):
    """One round trip to the extension. Returns the reply's value or raises PageError."""
    reply = json.loads(host_call(service, op, json.dumps(args, allow_nan=False)))
    if not reply.get("ok"):
        raise PageError(reply.get("error", f"{op} failed"))
    return reply.get("value")


class Store:
    """`page.store`: values a script keeps between runs.

    Every saved script has its own store. It lives in the browser's extension
    storage, so it is still there after the browser is restarted. Keys are
    strings; values can be anything JSON can hold (numbers, strings, booleans,
    None, lists, dicts).

    A value is saved as JSON text, written and read here. The browser's storage
    would otherwise sort the keys of a dict and round large integers; this way
    a value comes back exactly as `json.loads(json.dumps(value))` would give it.
    """

    def __init__(self, host_call):
        self._host_call = host_call

    def _ask(self, op, **args):
        if "key" in args and not isinstance(args["key"], str):
            raise TypeError(f"page.store keys must be strings, not {type(args['key']).__name__}")
        return _ask(self._host_call, "store", op, args)

    def get(self, key, default=None):
        """The value saved under `key`, or `default` if nothing was saved."""
        found = self._ask("get", key=key)
        return json.loads(found["value"]) if found["exists"] else default

    def set(self, key, value):
        """Save `value` under `key`, replacing what was there."""
        self._ask("set", key=key, value=json.dumps(value, allow_nan=False))

    def delete(self, key):
        """Forget `key`. Returns True if there was something to forget."""
        return self._ask("delete", key=key)

    def keys(self):
        """All keys this script has saved, in alphabetical order."""
        return self._ask("keys")

    def clear(self):
        """Forget everything this script has saved."""
        self._ask("clear")


class Response:
    """What `page.fetch` returns: the server's answer.

    status   -- the HTTP status code, e.g. 200 or 404
    ok       -- True when the status is 200-299
    reason   -- the status in words, e.g. "Not Found"
    url      -- the address the answer came from (differs from the one asked for after a redirect)
    headers  -- the response headers; names are matched whatever their case
    content  -- the body as bytes
    """

    def __init__(self, url, status, reason, headers, content):
        self.url = url
        self.status = status
        self.reason = reason
        self.headers = _Headers(headers)
        self.content = content
        self._text = None

    def __repr__(self):
        return f"<Response [{self.status}]>"

    @property
    def ok(self):
        return 200 <= self.status < 300

    @property
    def text(self):
        """The body as a string, decoded the way the Content-Type header says (UTF-8 if it does not)."""
        if self._text is None:
            try:
                self._text = self.content.decode(self._charset(), errors="replace")
            except LookupError:  # an encoding Python has never heard of
                self._text = self.content.decode("utf-8", errors="replace")
        return self._text

    def _charset(self):
        # "text/html; charset=ISO-8859-1" -> "iso-8859-1"
        from email.message import Message

        header = Message()
        header["content-type"] = self.headers.get("content-type", "")
        return header.get_content_charset() or "utf-8"

    def json(self):
        """The body parsed as JSON. Raises ValueError if it is not JSON."""
        return json.loads(self.content)

    @property
    def soup(self):
        """BeautifulSoup tree of the body, for a response that is an HTML page."""
        from bs4 import BeautifulSoup

        return BeautifulSoup(self.text, "html.parser")

    def raise_for_status(self):
        """Raise urllib.error.HTTPError (an OSError) if the server answered with an error status (400-599)."""
        if self.status >= 400:
            from http import HTTPStatus
            from urllib.error import HTTPError

            reason = self.reason
            if not reason:  # HTTP/2 answers carry no words: look them up
                try:
                    reason = HTTPStatus(self.status).phrase
                except ValueError:
                    reason = "Error"
            raise HTTPError(self.url, self.status, reason, self.headers, None)


class _Headers(dict):
    """Response headers: a dict whose keys are found whatever their case."""

    def __init__(self, pairs):
        super().__init__((name.lower(), value) for name, value in pairs)

    def __getitem__(self, name):
        return super().__getitem__(name.lower())

    def __contains__(self, name):
        return isinstance(name, str) and super().__contains__(name.lower())

    def get(self, name, default=None):
        return super().get(name.lower(), default)


def _origin(url):
    """(scheme, host, port) of a URL: two URLs with the same origin are on the same site."""
    parts = urlsplit(url)
    return parts.scheme, parts.hostname, parts.port or {"http": 80, "https": 443}.get(parts.scheme)


def _build_request(page_url, url, method, params, headers, data, json_value, timeout, cookies):
    """Check the arguments of `page.fetch` and turn them into the request sent to JavaScript.

    Returns {url, method, headers, body, timeout, cookies}; see httpFetch in lib/http.js.
    """
    # A relative address is relative to the page, so page.fetch(link["href"]) works.
    parts = urlsplit(urljoin(page_url, str(url)))
    if parts.scheme not in ("http", "https"):
        raise ValueError(f"page.fetch needs an http:// or https:// address, not {url!r}")
    query = "&".join(filter(None, [parts.query, urlencode(params, doseq=True) if params else ""]))
    url = urlunsplit(parts._replace(query=query, fragment=""))

    headers = {str(name): str(value) for name, value in (headers or {}).items()}
    content_type = None
    if json_value is not None:
        if data is not None:
            raise TypeError("page.fetch takes `data` or `json`, not both")
        body, content_type = json.dumps(json_value).encode(), "application/json"
    elif isinstance(data, dict):  # form fields, sent the way an HTML form sends them
        body, content_type = urlencode(data, doseq=True).encode(), "application/x-www-form-urlencoded"
    elif isinstance(data, str):
        body, content_type = data.encode(), "text/plain; charset=utf-8"
    elif isinstance(data, (bytes, bytearray)):
        body = bytes(data)
    elif data is None:
        body = None
    else:
        raise TypeError(f"page.fetch `data` must be a str, bytes or dict, not {type(data).__name__}")
    if content_type and not any(name.lower() == "content-type" for name in headers):
        headers["Content-Type"] = content_type

    method = str(method or ("GET" if body is None else "POST")).upper()
    if body is not None and method in ("GET", "HEAD"):
        raise ValueError(f"A {method} request cannot send `data` or `json`; use method='POST'")

    if timeout is None:
        timeout = 0
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 <= timeout < float("inf"):
        raise ValueError(f"page.fetch `timeout` must be a number of seconds or None, not {timeout!r}")

    # Cookies make the request as the logged-in user. Unless the script says
    # otherwise they go only to the site the script is running on.
    if cookies is None:
        cookies = _origin(url) == _origin(page_url)

    return {
        "url": url,
        "method": method,
        "headers": headers,
        "body": None if body is None else base64.b64encode(body).decode("ascii"),
        "timeout": timeout,
        "cookies": bool(cookies),
    }


def _send(host_call, request):
    """Hand a request to JavaScript and turn its reply into a Response or an exception."""
    reply = json.loads(host_call("http", "fetch", json.dumps(request)))
    if not reply.get("ok"):
        # Both are OSErrors, like the errors of urllib and requests.
        error = TimeoutError if reply.get("timeout") else ConnectionError
        raise error(f"Could not fetch {request['url']}: {reply.get('error', 'no answer')}")
    answer = reply["value"]
    return Response(
        answer["url"], answer["status"], answer["reason"], answer["headers"], base64.b64decode(answer["body"])
    )


class Page:
    """The `page` object available to every script."""

    def __init__(self, info, host_call):
        self.url = info.get("url", "")
        self.title = info.get("title", "")
        self.html = info.get("html", "")
        self.store = Store(host_call)
        self._host_call = host_call
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
        return _ask(self._host_call, "dom", op, args)

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

    # ---- fetching (HTTP requests to other addresses) ----

    def fetch(self, url, *, method=None, params=None, headers=None, data=None, json=None, timeout=30, cookies=None):
        """Make an HTTP request and return the Response (see above) when the answer is in.

        url      -- absolute, or relative to the page ("/api/items", "next.html")
        method   -- "GET" unless a body is sent, then "POST"
        params   -- dict added to the address as ?name=value
        headers  -- dict of request headers
        data     -- the body: a str, bytes, or a dict of form fields
        json     -- the body: any value, sent as JSON
        timeout  -- seconds to wait for the whole answer; None waits as long as the script may run
        cookies  -- True sends the browser's cookies for that site along (the
                    request is then made as the logged-in user), False sends
                    none. By default they are sent only to the site this
                    script is running on.

        An answer with an error status (404, 500) is still an answer: check
        `response.ok` or call `response.raise_for_status()`. No answer at all
        raises ConnectionError, or TimeoutError when it took too long. Both are
        OSErrors, and so is the HTTPError of raise_for_status().
        """
        # (`json` the argument hides `json` the module in here, so the work is done outside.)
        request = _build_request(self.url, url, method, params, headers, data, json, timeout, cookies)
        return _send(self._host_call, request)


class _DropAwaitOnPageCalls(ast.NodeTransformer):
    """Rewrite `await page.click(...)` to `page.click(...)`.

    The write methods used to be coroutines, so older scripts put `await` in
    front of them. Nothing on `page` is a coroutine now and `await` on a
    result would be a TypeError; dropping it keeps those scripts working.
    Only the direct form is recognized: `await page.<...>(...)`, which
    includes `await page.store.get(...)`.
    """

    def visit_Await(self, node):
        self.generic_visit(node)  # rewrite anything nested inside first
        call = node.value
        if not isinstance(call, ast.Call):
            return node
        # Walk `page.store.get` back to its first name: get -> store -> page.
        target = call.func
        while isinstance(target, ast.Attribute):
            target = target.value
        is_page_call = isinstance(target, ast.Name) and target.id == "page" and target is not call.func
        return call if is_page_call else node


async def run(code, page_json, host_call):
    """Run one user script. Returns a JSON string: {ok, stdout, error}.

    code       -- the script source
    page_json  -- JSON string {url, title, html}
    host_call  -- callable (service: str, op: str, args_json: str) -> JSON string
                  {ok, value} or {ok, error}. `service` says who should do it:
                  "dom" is the page, "store" is the script's saved values,
                  "http" makes a request. It blocks until the answer is there
                  (see makeSync in pyodide-worker.js).
    """
    output = []

    def script_print(*args, sep=" ", end="\n", **_ignored):
        output.append(sep.join(str(a) for a in args) + end)

    # Each run gets a fresh namespace, so scripts can't see each other's globals.
    namespace = {
        "__name__": "__main__",
        "page": Page(json.loads(page_json), host_call),
        "print": script_print,
    }

    error = None
    try:
        tree = _DropAwaitOnPageCalls().visit(ast.parse(code, SCRIPT_FILENAME, "exec"))
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
