// The parts of CodeMirror (https://codemirror.net, the code editor in the side
// panel) that PyMonkey uses. They are put to work in extension/panel/editor.js.
//
// CodeMirror comes as a dozen npm packages that import each other by name
// (`from "@codemirror/state"`). A browser cannot follow such imports, and an
// extension may not load code from a CDN. So `npm run setup` has esbuild join
// this file and everything it imports into the single file
// extension/vendor/codemirror/codemirror.js, which is all the panel loads.
// Only what is exported here ends up in that file.

export { EditorSelection, EditorState } from "@codemirror/state";
export { EditorView, keymap, lineNumbers } from "@codemirror/view";
export { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
export { bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
export { python } from "@codemirror/lang-python";
export { classHighlighter } from "@lezer/highlight";
