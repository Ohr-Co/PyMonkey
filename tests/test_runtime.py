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


def run(code, replies=None):
    """Run a script against a fake page. Returns (result, list of DOM calls made)."""
    calls = []

    def fake_dom_call(op, args_json):
        calls.append((op, json.loads(args_json)))
        return json.dumps((replies or {}).get(op, {"ok": True, "value": 1}))

    result = asyncio.run(pymonkey_runtime.run(code, json.dumps(PAGE), fake_dom_call))
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
