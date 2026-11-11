"""Tests for the Python runtime, run under normal CPython with a fake page.

    python -m pytest tests/
"""

import asyncio
import json
import sys
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


def run(code, replies=None, store=None):
    """Run a script against a fake page. Returns (result, list of DOM calls made).

    `replies` overrides the answer to a DOM operation. `store` is the dict
    behind `page.store` (each value as JSON text); pass the same one to several
    runs to see what a script finds on its next run, or None for a script that
    was never saved.
    """
    calls = []

    def fake_host_call(service, op, args_json):
        args = json.loads(args_json)
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
