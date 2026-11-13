"""Tests for the Python runtime, run under normal CPython with a fake page.

    python -m pytest tests/
"""

import asyncio
import base64
import csv
import gc
import io
import json
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "extension" / "python"))

import pymonkey_runtime  # noqa: E402

PAGE = {
    "url": "https://example.com/",
    "title": "Example",
    "html": "<html><body><h1>Hi</h1><a href='/a'>A</a><a href='/b'>B</a></body></html>",
}


def fake_store(saved, op, args):
    """What the extension answers to a `page.store` operation (see lib/script-store.js)."""
    key = args.get("key")
    if op == "get":
        return {"exists": True, "value": saved[key]} if key in saved else {"exists": False}
    if op == "set":
        saved[key] = args["value"]
    elif op == "delete":
        return saved.pop(key, MISSING) is not MISSING
    elif op == "keys":
        return sorted(saved)
    elif op == "clear":
        saved.clear()
    return None


MISSING = object()


def run(code, replies=None, store=None, http=None):
    """Run a script against a fake page. Returns (result, list of DOM calls made).

    `replies` overrides the answer to a DOM operation. `store` is the dict
    behind `page.store` (each value as JSON text); pass the same one to several
    runs to see what a script finds on its next run, or None for a script that
    was never saved. `http` answers `page.fetch`: a function from the request
    to the reply (see the page.fetch tests below).
    """
    calls = []

    def fake_host_call(service, op, args_json):
        args = json.loads(args_json)
        if service == "http":
            assert op == "fetch"
            return json.dumps(http(args))
        if service == "store":
            if store is None:
                return json.dumps({"ok": False, "error": "Save this script, then run it again."})
            return json.dumps({"ok": True, "value": fake_store(store, op, args)})
        assert service == "dom"
        calls.append((op, args))
        return json.dumps((replies or {}).get(op, {"ok": True, "value": 1}))

    result = asyncio.run(pymonkey_runtime.run(code, json.dumps(PAGE), fake_host_call))
    return json.loads(result), calls


def test_print_is_captured():
    result, _ = run("print('hello', 1, sep='-')")
    assert result == {"ok": True, "stdout": "hello-1\n", "error": None}


def test_page_info_and_soup():
    result, calls = run("print(page.title, page.url)\nprint([a['href'] for a in page.select('a')])")
    assert result["stdout"] == "Example https://example.com/\n['/a', '/b']\n"
    assert calls == []  # reading never touches the real page


def test_write_needs_no_await():
    result, calls = run("n = page.set_text('h1', 'Bye')\nprint(n)")
    assert result["ok"] and result["stdout"] == "1\n"
    assert calls == [("set_text", {"selector": "h1", "text": "Bye"})]


# Every write method, as a call and the DOM operation it must send.
WRITES = [
    ("click('#a')", ("click", {"selector": "#a"})),
    ("fill('#a', 'hi')", ("fill", {"selector": "#a", "value": "hi"})),
    ("set_text('#a', 'hi')", ("set_text", {"selector": "#a", "text": "hi"})),
    ("set_html('#a', '<b>hi</b>')", ("set_html", {"selector": "#a", "html": "<b>hi</b>"})),
    ("set_attr('#a', 'title', 'hi')", ("set_attr", {"selector": "#a", "name": "title", "value": "hi"})),
    ("set_style('#a', 'color: red')", ("set_style", {"selector": "#a", "css": "color: red"})),
    ("insert_html('#a', '<i>x</i>')", ("insert_html", {"selector": "#a", "html": "<i>x</i>", "position": "beforeend"})),
    ("remove('#a')", ("remove", {"selector": "#a"})),
    ("wait_for('#a', timeout=2)", ("wait_for", {"selector": "#a", "timeout": 2})),
    ("refresh()", ("snapshot", {})),
]
SNAPSHOT = {"snapshot": {"ok": True, "value": PAGE}}


def test_every_write_method_is_listed():
    assert {call.split("(")[0] for call, _ in WRITES} == pymonkey_runtime.WRITE_METHODS


@pytest.mark.parametrize("call, expected", WRITES)
def test_each_write_works_without_await(call, expected):
    result, calls = run(f"page.{call}\nprint('done')", SNAPSHOT)
    assert result == {"ok": True, "stdout": "done\n", "error": None}
    assert calls == [expected]


@pytest.mark.parametrize("call, expected", WRITES)
def test_each_write_still_works_with_await(call, expected):
    """Scripts written when writes were coroutines say `await page.click(...)`."""
    result, calls = run(f"await page.{call}\nprint('done')", SNAPSHOT)
    assert result == {"ok": True, "stdout": "done\n", "error": None}
    assert calls == [expected]


def test_await_on_a_write_keeps_its_value_and_works_inside_functions():
    code = (
        "async def change():\n"
        "    return await page.set_text('h1', 'Bye')\n"
        "print(await change())\n"
        "print([await page.remove('a'), await page.remove('b')])\n"
    )
    result, calls = run(code, {"remove": {"ok": True, "value": 2}})
    assert result["stdout"] == "1\n[2, 2]\n"
    assert [op for op, _ in calls] == ["set_text", "remove", "remove"]


def test_real_awaits_are_left_alone():
    result, calls = run("import asyncio\nawait asyncio.sleep(0)\npage.click('#a')\nprint('done')")
    assert result == {"ok": True, "stdout": "done\n", "error": None}
    assert calls == [("click", {"selector": "#a"})]


def test_indirect_await_on_a_write_fails_with_a_clear_message():
    result, calls = run("p = page\nawait p.click('#a')")
    assert not result["ok"]
    assert "TypeError" in result["error"] and "line 2" in result["error"]
    assert "called without `await`" in result["error"]
    assert calls == [("click", {"selector": "#a"})]  # the click itself still happened


def test_gather_on_writes_fails_with_a_clear_message():
    result, _ = run("import asyncio\nawait asyncio.gather(page.click('#a'), page.click('#b'))")
    assert not result["ok"]
    assert "TypeError" in result["error"]
    assert "called without `await`" in result["error"]


def test_other_errors_get_no_await_note():
    result, _ = run("len(5)")
    assert "TypeError" in result["error"]
    assert "await" not in result["error"]


def test_error_line_numbers_survive_the_await_rewrite():
    result, _ = run("await page.click('#a')\nawait page.click('#b')\nraise ValueError('boom')")
    assert "line 3" in result["error"] and "ValueError: boom" in result["error"]


def test_dom_failure_raises_page_error():
    result, _ = run("page.click('#nope')", {"click": {"ok": False, "error": "No element matches"}})
    assert not result["ok"]
    assert "PageError: No element matches" in result["error"]


def test_script_error_shows_user_traceback_only():
    result, _ = run("x = 1\nraise ValueError('boom')")
    assert not result["ok"]
    assert "ValueError: boom" in result["error"]
    assert "line 2" in result["error"]
    assert "pymonkey_runtime.py" not in result["error"]


def test_syntax_error_is_reported():
    result, _ = run("def broken(:")
    assert not result["ok"] and "SyntaxError" in result["error"]


def test_runs_do_not_share_globals():
    run("secret = 42")
    result, _ = run("print(secret)")
    assert "NameError" in result["error"]


def test_refresh_replaces_snapshot():
    new = {"url": "https://example.com/2", "title": "Two", "html": "<p>new</p>"}
    result, _ = run(
        "page.refresh()\nprint(page.title, page.select_one('p').text)",
        {"snapshot": {"ok": True, "value": new}},
    )
    assert result["stdout"] == "Two new\n"


# ---------- page.store ----------


def test_store_remembers_values_between_runs():
    store = {}
    result, calls = run("page.store.set('visits', 1)", store=store)
    assert result["ok"] and calls == []  # the store is not the page: no DOM calls
    result, _ = run("n = page.store.get('visits')\npage.store.set('visits', n + 1)\nprint(n)", store=store)
    assert result["stdout"] == "1\n"
    assert store == {"visits": "2"}  # kept as JSON text


def test_store_get_default():
    result, _ = run(
        "print(page.store.get('nope'), page.store.get('nope', 0), page.store.get('nope', default=[]))", store={}
    )
    assert result["stdout"] == "None 0 []\n"


def test_store_distinguishes_a_saved_none_from_nothing_saved():
    result, _ = run("page.store.set('k', None)\nprint(page.store.get('k', 'default'))", store={})
    assert result["stdout"] == "None\n"


def test_store_values_can_be_any_json_type():
    code = (
        "value = {'seen': ['a', 'b'], 'count': 2, 'ratio': 0.5, 'done': False, 'note': None, 'nested': {'x': [1, {'y': 'z'}]}}\n"
        "page.store.set('state', value)\n"
        "print(page.store.get('state') == value)\n"
        "for simple in ['text', 7, 1.5, True, None, [1, 2], {}]:\n"
        "    page.store.set('simple', simple)\n"
        "    assert page.store.get('simple') == simple, simple\n"
    )
    result, _ = run(code, store={})
    assert result == {"ok": True, "stdout": "True\n", "error": None}


def test_store_values_come_back_exactly():
    # Browser storage on its own would sort the dict's keys and round the big number.
    code = (
        "page.store.set('k', {'zebra': 1, 'apple': 2, 'big': 2**70})\n"
        "value = page.store.get('k')\n"
        "print(list(value), value['big'] == 2**70)\n"
    )
    result, _ = run(code, store={})
    assert result["stdout"] == "['zebra', 'apple', 'big'] True\n"


def test_store_delete_keys_and_clear():
    code = (
        "page.store.set('b', 1)\npage.store.set('a', 2)\n"
        "print(page.store.keys())\n"
        "print(page.store.delete('a'), page.store.delete('a'), page.store.keys())\n"
        "page.store.clear()\nprint(page.store.keys())\n"
    )
    store = {}
    result, _ = run(code, store=store)
    assert result["stdout"] == "['a', 'b']\nTrue False ['b']\n[]\n"
    assert store == {}


def test_store_rejects_values_json_cannot_hold():
    result, _ = run("page.store.set('k', {1, 2})", store={})
    assert "TypeError" in result["error"] and "not JSON serializable" in result["error"]
    result, _ = run("page.store.set('k', float('nan'))", store={})
    assert "ValueError" in result["error"]


def test_store_keys_must_be_strings():
    store = {}
    result, _ = run("page.store.set(1, 'x')", store=store)
    assert "TypeError: page.store keys must be strings, not int" in result["error"]
    assert store == {}


def test_store_failure_raises_page_error():
    result, _ = run("page.store.get('k')")  # a script that was never saved has no store
    assert not result["ok"]
    assert "PageError: Save this script, then run it again." in result["error"]


def test_store_calls_may_be_written_with_await():
    result, _ = run("await page.store.set('k', 5)\nprint(await page.store.get('k', 0))", store={})
    assert result == {"ok": True, "stdout": "5\n", "error": None}


# ---------- page.fetch ----------


def answer(body=b"", status=200, reason="OK", headers=None, url=None):
    """A fake of httpFetch in lib/http.js: answers every request the same way and keeps the requests."""
    if isinstance(body, str):
        body = body.encode()

    def http(request):
        http.requests.append(request)
        value = {
            "url": url or request["url"],
            "status": status,
            "reason": reason,
            "headers": [[name.lower(), value] for name, value in (headers or {}).items()],
            "body": base64.b64encode(body).decode(),
        }
        return {"ok": True, "value": value}

    http.requests = []
    return http


def sent_body(request):
    return base64.b64decode(request["body"]).decode()


def test_fetch_returns_text_and_status():
    http = answer("hello", headers={"Content-Type": "text/plain"})
    result, calls = run(
        "r = page.fetch('https://api.test/hello')\n"
        "print(r, r.status, r.ok, r.reason, r.url, r.text, r.content, r.headers['Content-Type'])",
        http=http,
    )
    assert result["stdout"] == "<Response [200]> 200 True OK https://api.test/hello hello b'hello' text/plain\n"
    assert calls == []  # a fetch does not go through the page
    assert http.requests == [
        {"url": "https://api.test/hello", "method": "GET", "headers": {}, "body": None, "timeout": 30, "cookies": False}
    ]


def test_fetch_json():
    http = answer('{"items": [1, 2], "next": null}', headers={"Content-Type": "application/json"})
    result, _ = run("print(page.fetch('https://api.test/items').json())", http=http)
    assert result["stdout"] == "{'items': [1, 2], 'next': None}\n"


def test_fetch_json_on_a_body_that_is_not_json_is_a_value_error():
    result, _ = run(
        "try:\n    page.fetch('https://api.test/').json()\nexcept ValueError as e:\n    print('not JSON')",
        http=answer("<html>"),
    )
    assert result["stdout"] == "not JSON\n"


def test_fetch_soup_parses_an_html_answer():
    http = answer("<ul><li>a</li><li>b</li></ul>", headers={"Content-Type": "text/html"})
    result, _ = run("print([li.text for li in page.fetch('/list').soup.select('li')])", http=http)
    assert result["stdout"] == "['a', 'b']\n"


def test_fetch_relative_address_is_relative_to_the_page():
    http = answer()
    result, _ = run(
        "page.fetch('/a?x=1#top')\npage.fetch('b/c')\npage.fetch('//other.test/d')\nprint('ok')", http=http
    )
    assert result["stdout"] == "ok\n", result["error"]
    assert [r["url"] for r in http.requests] == [
        "https://example.com/a?x=1",
        "https://example.com/b/c",
        "https://other.test/d",
    ]


def test_fetch_params_are_added_to_the_address():
    http = answer()
    run("page.fetch('https://api.test/s?a=1', params={'q': 'two words', 'tag': ['x', 'y']})", http=http)
    assert http.requests[0]["url"] == "https://api.test/s?a=1&q=two+words&tag=x&tag=y"


def test_fetch_sends_cookies_only_to_the_site_of_the_page_unless_told():
    http = answer()
    run(
        "page.fetch('/same')\n"
        "page.fetch('https://example.com:443/same-too')\n"
        "page.fetch('http://example.com/other-scheme')\n"
        "page.fetch('https://sub.example.com/other-host')\n"
        "page.fetch('https://other.test/with', cookies=True)\n"
        "page.fetch('/without', cookies=False)\n",
        http=http,
    )
    assert [(r["url"].split("/")[-1], r["cookies"]) for r in http.requests] == [
        ("same", True),
        ("same-too", True),
        ("other-scheme", False),
        ("other-host", False),
        ("with", True),
        ("without", False),
    ]


def test_fetch_post_json():
    http = answer()
    result, _ = run("page.fetch('https://api.test/', json={'name': 'é', 'n': 1})", http=http)
    assert result["ok"], result["error"]
    request = http.requests[0]
    assert request["method"] == "POST"
    assert request["headers"] == {"Content-Type": "application/json"}
    assert json.loads(sent_body(request)) == {"name": "é", "n": 1}


def test_fetch_post_form_text_and_bytes():
    http = answer()
    result, _ = run(
        "page.fetch('https://api.test/', data={'q': 'a b', 'n': 2})\n"
        "page.fetch('https://api.test/', data='plain é', method='put')\n"
        "page.fetch('https://api.test/', data=bytes([0, 255]), headers={'content-type': 'image/png'})\n",
        http=http,
    )
    assert result["ok"], result["error"]
    form, text, binary = http.requests
    assert (form["method"], form["headers"], sent_body(form)) == (
        "POST",
        {"Content-Type": "application/x-www-form-urlencoded"},
        "q=a+b&n=2",
    )
    assert (text["method"], text["headers"], sent_body(text)) == (
        "PUT",
        {"Content-Type": "text/plain; charset=utf-8"},
        "plain é",
    )
    assert binary["headers"] == {"content-type": "image/png"}  # the script's own header is kept
    assert base64.b64decode(binary["body"]) == bytes([0, 255])


def test_fetch_method_headers_and_timeout_are_passed_on():
    http = answer()
    run("page.fetch('https://api.test/', method='delete', headers={'X-Key': 5}, timeout=2.5)", http=http)
    run("page.fetch('https://api.test/', timeout=None)", http=http)
    first, second = http.requests
    assert (first["method"], first["headers"], first["timeout"]) == ("DELETE", {"X-Key": "5"}, 2.5)
    assert second["timeout"] == 0  # no limit


@pytest.mark.parametrize(
    "call, expected",
    [
        ("page.fetch('ftp://files.test/x')", "ValueError: page.fetch needs an http:// or https:// address"),
        ("page.fetch('javascript:alert(1)')", "ValueError: page.fetch needs an http:// or https:// address"),
        ("page.fetch('/x', data='a', json=[1])", "TypeError: page.fetch takes `data` or `json`, not both"),
        ("page.fetch('/x', data=5)", "TypeError: page.fetch `data` must be a str, bytes or dict, not int"),
        ("page.fetch('/x', method='GET', data='a')", "ValueError: A GET request cannot send `data` or `json`"),
        ("page.fetch('/x', timeout=-1)", "ValueError: page.fetch `timeout` must be a number of seconds or None"),
        ("page.fetch('/x', timeout='5')", "ValueError: page.fetch `timeout` must be a number of seconds or None"),
    ],
)
def test_fetch_rejects_bad_arguments_before_asking(call, expected):
    http = answer()
    result, _ = run(call, http=http)
    assert expected in result["error"]
    assert http.requests == []


def test_fetch_text_follows_the_charset_of_the_answer():
    latin = answer("café".encode("latin-1"), headers={"Content-Type": "text/html; charset=ISO-8859-1"})
    assert run("print(page.fetch('/x').text)", http=latin)[0]["stdout"] == "café\n"
    utf8 = answer("café".encode(), headers={"Content-Type": "text/html"})
    assert run("print(page.fetch('/x').text)", http=utf8)[0]["stdout"] == "café\n"
    no_header = answer("café".encode())
    assert run("print(page.fetch('/x').text)", http=no_header)[0]["stdout"] == "café\n"
    made_up = answer(b"abc", headers={"Content-Type": "text/html; charset=klingon"})
    assert run("print(page.fetch('/x').text)", http=made_up)[0]["stdout"] == "abc\n"
    # Bytes that are not text do not raise: they come out as replacement characters.
    binary = answer(bytes([0xFF, 0xFE]))
    assert run("print(len(page.fetch('/x').text), page.fetch('/x').content)", http=binary)[0]["stdout"] == (
        "2 b'\\xff\\xfe'\n"
    )


def test_fetch_headers_ignore_case():
    http = answer(headers={"X-Rate-Limit": "9"})
    result, _ = run(
        "h = page.fetch('/x').headers\n"
        "print(h['x-rate-limit'], h['X-RATE-LIMIT'], h.get('X-Rate-Limit'), h.get('nope', 'none'), 'X-Rate-Limit' in h, 'nope' in h)",
        http=http,
    )
    assert result["stdout"] == "9 9 9 none True False\n"


def test_fetch_error_status_is_returned_not_raised():
    http = answer("gone", status=404, reason="Not Found")
    result, _ = run("r = page.fetch('/x')\nprint(r.status, r.ok, r.text)", http=http)
    assert result["stdout"] == "404 False gone\n"


def test_raise_for_status():
    result, _ = run("page.fetch('/x').raise_for_status()\nprint('fine')", http=answer())
    assert result["stdout"] == "fine\n"
    result, _ = run("page.fetch('/x').raise_for_status()", http=answer(status=404, reason="Not Found"))
    assert "urllib.error.HTTPError: HTTP Error 404: Not Found" in result["error"]
    # HTTP/2 answers have no reason text: the standard one is filled in.
    result, _ = run("page.fetch('/x').raise_for_status()", http=answer(status=503, reason=""))
    assert "HTTP Error 503: Service Unavailable" in result["error"]
    code = (
        "from urllib.error import HTTPError\n"
        "try:\n    page.fetch('/x').raise_for_status()\n"
        "except HTTPError as e:\n    print(e.code, e.url, isinstance(e, OSError))"
    )
    result, _ = run(code, http=answer(status=500, reason="Internal Server Error"))
    assert result["stdout"] == "500 https://example.com/x True\n"


def test_fetch_reports_the_address_after_a_redirect():
    result, _ = run("print(page.fetch('/old').url)", http=answer(url="https://example.com/new"))
    assert result["stdout"] == "https://example.com/new\n"


def test_network_failure_raises_connection_error():
    def unreachable(request):
        return {"ok": False, "timeout": False, "error": "the server cannot be reached"}

    result, _ = run("page.fetch('https://down.test/')", http=unreachable)
    assert not result["ok"]
    assert "ConnectionError: Could not fetch https://down.test/: the server cannot be reached" in result["error"]
    assert "line 1" in result["error"]
    # ...and it is an ordinary exception a script can catch.
    code = "try:\n    page.fetch('https://down.test/')\nexcept OSError as e:\n    print('caught', type(e).__name__)"
    result, _ = run(code, http=unreachable)
    assert result == {"ok": True, "stdout": "caught ConnectionError\n", "error": None}


def test_slow_answer_raises_timeout_error():
    def slow(request):
        return {"ok": False, "timeout": True, "error": f"no answer within {request['timeout']} seconds"}

    result, _ = run("page.fetch('https://slow.test/', timeout=3)", http=slow)
    assert "TimeoutError: Could not fetch https://slow.test/: no answer within 3 seconds" in result["error"]
    code = "try:\n    page.fetch('https://slow.test/')\nexcept OSError as e:\n    print('caught', type(e).__name__)"
    assert run(code, http=slow)[0]["stdout"] == "caught TimeoutError\n"


def test_fetch_may_be_written_with_await():
    result, _ = run("r = await page.fetch('/x')\nprint(r.text)", http=answer("old habit"))
    assert result == {"ok": True, "stdout": "old habit\n", "error": None}


# ---------- page.download ----------


def downloaded(code):
    """Run a script that downloads one file. Returns (result, file name, file bytes, MIME type)."""
    result, calls = run(code)
    if not calls:
        return result, None, None, None
    [(op, args)] = calls
    assert op == "download"
    return result, args["filename"], base64.b64decode(args["base64"]), args["type"]


def read_csv(content):
    """Parse a downloaded CSV the way a spreadsheet would: as UTF-8 with a marker at the start."""
    assert content.startswith(b"\xef\xbb\xbf")  # the marker that makes Excel read it as UTF-8
    return list(csv.reader(io.StringIO(content.decode("utf-8-sig"), newline="")))


def test_download_list_of_dicts_as_csv_with_headers():
    result, name, content, mime = downloaded(
        "rows = [{'text': 'One', 'href': '/one'}, {'text': 'Two, \"quoted\"', 'href': '/two'}]\n"
        "print(page.download('links.csv', rows))"
    )
    assert result == {"ok": True, "stdout": "None\n", "error": None}
    assert (name, mime) == ("links.csv", "text/csv;charset=utf-8")
    assert read_csv(content) == [["text", "href"], ["One", "/one"], ['Two, "quoted"', "/two"]]


def test_download_csv_columns_are_the_keys_in_order_of_first_appearance():
    _, _, content, _ = downloaded(
        "page.download('x.csv', [{'b': 1, 'a': 2}, {'a': 3, 'c': None}, {}, {'b': 'é\\nline two', 'd': [1, 2]}])"
    )
    assert read_csv(content) == [
        ["b", "a", "c", "d"],
        ["1", "2", "", ""],
        ["", "3", "", ""],  # None and missing keys are empty cells
        ["", "", "", ""],
        ["é\nline two", "", "", "[1, 2]"],
    ]


def test_download_csv_from_lists_has_no_header_and_a_generator_works():
    _, _, content, _ = downloaded("page.download('x.CSV', [[1, 'a'], (2, 'b')])")
    assert read_csv(content) == [["1", "a"], ["2", "b"]]
    _, _, content, _ = downloaded("page.download('x.csv', ({'n': n} for n in range(3)))")
    assert read_csv(content) == [["n"], ["0"], ["1"], ["2"]]
    _, _, content, _ = downloaded("page.download('x.csv', [])")
    assert read_csv(content) == []


def test_download_ten_thousand_rows():
    code = (
        "rows = [{'n': n, 'title': f'Item {n}, with a comma', 'url': f'https://example.com/items/{n}'} for n in range(10_000)]\n"
        "page.download('items.csv', rows)\n"
    )
    result, _, content, _ = downloaded(code)
    assert result["ok"], result["error"]
    rows = read_csv(content)
    assert len(rows) == 10_001
    assert rows[0] == ["n", "title", "url"]
    assert rows[10_000] == ["9999", "Item 9999, with a comma", "https://example.com/items/9999"]


def test_download_any_json_value_as_json():
    value = {"items": [1, 2.5, "é", None, True], "nested": {"a": []}}
    result, name, content, mime = downloaded(f"page.download('data.json', {value!r})")
    assert result["ok"], result["error"]
    assert (name, mime) == ("data.json", "application/json")
    assert json.loads(content) == value
    assert "é" in content.decode("utf-8")  # readable, not é
    for simple in ["[1, 2]", "5", "None", "[{'a': 1}]"]:
        _, _, content, _ = downloaded(f"page.download('x.json', {simple})")
        assert json.loads(content) == eval(simple)


def test_download_text_and_bytes_are_saved_as_they_are():
    _, name, content, mime = downloaded("page.download('notes.txt', 'héllo\\n')")
    assert (name, content, mime) == ("notes.txt", "héllo\n".encode(), "text/plain;charset=utf-8")
    _, _, content, mime = downloaded("page.download('logo.png', bytes([137, 80, 0, 255]))")
    assert (content, mime) == (bytes([137, 80, 0, 255]), "application/octet-stream")
    # A string is never converted, whatever the file is called.
    _, _, content, _ = downloaded("page.download('ready.csv', 'a,b\\n1,2\\n')")
    assert content == b"a,b\n1,2\n"
    _, _, content, _ = downloaded("""page.download('ready.json', '{"a": 1}')""")
    assert content == b'{"a": 1}'


@pytest.mark.parametrize(
    "call, expected",
    [
        ("page.download('x.csv', {'a': 1})", "TypeError: For a .csv file, pass a list of dicts (one per row) or a list of lists"),
        ("page.download('x.csv', [1, 2])", "TypeError: For a .csv file, pass a list of dicts"),
        ("page.download('x.csv', [{'a': 1}, [2]])", "TypeError: For a .csv file, pass a list of dicts"),
        ("page.download('x.csv', 5)", "TypeError: For a .csv file, pass a list of dicts"),
        ("page.download('x.json', {1, 2})", "is not JSON serializable"),
        ("page.download('x.json', float('nan'))", "ValueError"),
        ("page.download('x.txt', [1, 2])", "For 'x.txt', pass the content as a string or bytes"),
        ("page.download('noextension', {'a': 1})", "pass the content as a string or bytes"),
        ("page.download('', 'x')", "ValueError: page.download needs a file name such as 'links.csv'"),
        ("page.download(5, 'x')", "ValueError: page.download needs a file name"),
        ("page.download('../x.csv', [])", "give a file name, not a path"),
        ("page.download('a\\\\b.csv', [])", "give a file name, not a path"),
    ],
)
def test_download_rejects_what_it_cannot_save(call, expected):
    result, calls = run(call)
    assert expected in result["error"]
    assert calls == []  # nothing was sent to the page


def test_download_refuses_a_file_too_large_to_send():
    size = pymonkey_runtime.MAX_DOWNLOAD_BYTES + 1
    result, calls = run(f"page.download('big.bin', bytes({size}))")
    assert "ValueError: big.bin would be 30 MB; page.download saves files up to 30 MB" in result["error"]
    assert calls == []


def test_download_failure_raises_page_error():
    result, _ = run("page.download('x.txt', 'x')", replies={"download": {"ok": False, "error": "no page"}})
    assert "PageError: no page" in result["error"]


def test_download_may_be_written_with_await():
    result, name, _, _ = downloaded("await page.download('links.csv', [{'a': 1}])")  # as in the issue's example
    assert result["ok"] and name == "links.csv"


# ---------- letting go of the snapshot when a run is over ----------


@pytest.fixture
def probe():
    """A module that a script can import to hand things to the test.

    The script leaves weak references in it: a weak reference does not keep its
    object alive, and gives None once the object has been freed.
    """
    module = types.ModuleType("pymonkey_probe")
    sys.modules["pymonkey_probe"] = module
    # Python's own garbage collector runs whenever it likes; with it switched
    # off, anything freed during the test was freed by run() itself.
    gc.collect()
    gc.disable()
    yield module
    gc.enable()
    del sys.modules["pymonkey_probe"]


# What a script typically does with the page, and what makes it hard to free:
# the tree's elements point at each other in circles, and so do a function and
# the globals it was defined in.
USE_THE_PAGE = """
import weakref, pymonkey_probe
links = page.select("a")
def first_link():
    return links[0]
pymonkey_probe.page = weakref.ref(page)
pymonkey_probe.soup = weakref.ref(page.soup)
pymonkey_probe.link = weakref.ref(first_link())
pymonkey_probe.function = weakref.ref(first_link)
"""


def test_snapshot_is_released_when_the_script_ends(probe):
    result, _ = run(USE_THE_PAGE + "print(len(links))")
    assert result == {"ok": True, "stdout": "2\n", "error": None}
    assert probe.page() is None
    assert probe.soup() is None
    assert probe.link() is None
    assert probe.function() is None


def test_snapshot_is_released_when_the_script_fails(probe):
    result, _ = run(USE_THE_PAGE + "1 / 0")
    assert not result["ok"] and "ZeroDivisionError" in result["error"]
    assert probe.page() is None
    assert probe.soup() is None
    assert probe.link() is None


def test_snapshot_is_released_when_an_async_script_ends(probe):
    result, _ = run(USE_THE_PAGE + "import asyncio\nawait asyncio.sleep(0)\nprint(first_link().text)")
    assert result == {"ok": True, "stdout": "A\n", "error": None}
    assert probe.page() is None
    assert probe.soup() is None


def test_snapshot_is_released_even_if_the_script_keeps_hold_of_the_page(probe):
    # A function kept somewhere that outlives the run (here: the probe module)
    # keeps the script's globals alive with it, and `page` is one of them.
    run(USE_THE_PAGE + "pymonkey_probe.kept = page, first_link")
    page, first_link = probe.kept
    assert probe.soup() is None
    assert probe.link() is None
    assert page.html == ""
    assert first_link.__globals__ == {}


def test_a_page_read_again_with_refresh_is_released_too(probe):
    fresh = {"url": PAGE["url"], "title": "Later", "html": "<html><body><p>new</p></body></html>"}
    code = "page.refresh()\nimport weakref, pymonkey_probe\npymonkey_probe.soup = weakref.ref(page.soup)\nprint(page.select_one('p').text)"
    result, _ = run(code, replies={"snapshot": {"ok": True, "value": fresh}})
    assert result == {"ok": True, "stdout": "new\n", "error": None}
    assert probe.soup() is None
