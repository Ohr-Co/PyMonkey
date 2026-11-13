// The code editor in the side panel: CodeMirror, set up for Python.
//
// CodeMirror is a library that turns a <div> into a code editor. It is built
// from "extensions": each item in the list below switches one feature on.
// The library itself is the single file vendor/codemirror/codemirror.js,
// which `npm run setup` puts together (see scripts/codemirror-entry.mjs).
//
// How the editor looks (colors in light and dark mode, fonts) is ordinary CSS,
// in panel.css.

import {
  EditorSelection, EditorState, EditorView, keymap, lineNumbers,
  defaultKeymap, history, historyKeymap, indentLess, indentMore,
  bracketMatching, indentOnInput, indentUnit, syntaxHighlighting,
  python, classHighlighter,
} from "../vendor/codemirror/codemirror.js";

const INDENT = 4; // spaces per level, as PEP 8 has it

// The Tab key. With text selected, indent the selected lines one level.
// Otherwise add spaces up to the next level, wherever the cursor is.
// (A "command" gets the editor, called a view, and returns true when it handled the key.)
function tab(view) {
  const { state } = view;
  if (state.selection.ranges.some((range) => !range.empty)) return indentMore(view);
  const change = state.changeByRange((range) => {
    const column = range.head - state.doc.lineAt(range.head).from;
    const spaces = " ".repeat(INDENT - (column % INDENT));
    return {
      changes: { from: range.head, insert: spaces },
      range: EditorSelection.cursor(range.head + spaces.length),
    };
  });
  view.dispatch(state.update(change, { scrollIntoView: true, userEvent: "input" }));
  return true;
}

/**
 * Put an editor inside `parent` (an empty element).
 * `onChange` is called whenever the user changes the text.
 * Returns { getText(), setText(text), focus() }.
 */
export function createEditor({ parent, onChange }) {
  const extensions = [
    lineNumbers(), // tracebacks say "line 12"
    history(), // undo and redo
    python(), // knows Python's grammar: needed for the colors and for indenting
    syntaxHighlighting(classHighlighter), // marks keywords, strings... with CSS classes (tok-keyword, tok-string...)
    indentUnit.of(" ".repeat(INDENT)),
    EditorState.tabSize.of(INDENT),
    indentOnInput(), // typing `else:` or `except:` moves the line back to where it belongs
    bracketMatching(), // shows which bracket belongs to the one next to the cursor
    // Keys. Enter (in defaultKeymap) starts the new line at the right depth:
    // one level deeper after a line that ends in a colon.
    keymap.of([{ key: "Tab", run: tab, shift: indentLess }, ...defaultKeymap, ...historyKeymap]),
    // For screen readers. Because Tab indents here, CodeMirror lets the
    // keyboard leave the editor another way: Escape, then Tab.
    EditorView.contentAttributes.of({ "aria-label": "Python code. To leave the editor, press Escape, then Tab." }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange?.();
    }),
  ];
  const view = new EditorView({ parent, extensions });

  return {
    getText: () => view.state.doc.toString(),
    // A fresh state, not an edit: another script is being shown, and Undo
    // must not bring the previous one back. (onChange is not called.)
    setText: (text) => view.setState(EditorState.create({ doc: text, extensions })),
    focus: () => view.focus(),
  };
}
