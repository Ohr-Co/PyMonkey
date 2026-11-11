"""Tests for the Python runtime, run under normal CPython with a fake page.

    python -m pytest tests/
"""

import asyncio
import json
import sys
from pathlib import Path

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

    async def fake_dom_call(op, args_json):
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


def test_top_level_await_dom_call():
    result, calls = run("n = await page.set_text('h1', 'Bye')\nprint(n)")
    assert result["ok"] and result["stdout"] == "1\n"
    assert calls == [("set_text", {"selector": "h1", "text": "Bye"})]


def test_dom_failure_raises_page_error():
    result, _ = run("await page.click('#nope')", {"click": {"ok": False, "error": "No element matches"}})
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
        "await page.refresh()\nprint(page.title, page.select_one('p').text)",
        {"snapshot": {"ok": True, "value": new}},
    )
    assert result["stdout"] == "Two new\n"
