/**
* @description ScriptTask script editor: CodeMirror 6 with PowerShell, Bash and Batch highlighting, ScriptTask
* #variable# awareness and standard code themes. Built into includes/vendor/st-codemirror.min.js as window.STEditor.
* @license Apache-2.0
*/

import { basicSetup } from 'codemirror';
import { EditorView, keymap, hoverTooltip, Decoration, MatchDecorator, ViewPlugin } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { indentWithTab } from '@codemirror/commands';
import { indentUnit, StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { oneDark } from '@codemirror/theme-one-dark';
import { darcula } from '@uiw/codemirror-theme-darcula';
import { dracula } from '@uiw/codemirror-theme-dracula';
import { solarizedLight, solarizedDark } from '@uiw/codemirror-theme-solarized';
import { githubLight, githubDark } from '@uiw/codemirror-theme-github';
import { monokai } from '@uiw/codemirror-theme-monokai';
import { nord } from '@uiw/codemirror-theme-nord';
import { tokyoNight } from '@uiw/codemirror-theme-tokyo-night';
import { vscodeLight, vscodeDark } from '@uiw/codemirror-theme-vscode';
import { eclipse } from '@uiw/codemirror-theme-eclipse';

// ---- Themes ----

const THEMES = [
    { id: 'darcula', label: 'Darcula', dark: true, ext: darcula },
    { id: 'dracula', label: 'Dracula', dark: true, ext: dracula },
    { id: 'eclipse', label: 'Eclipse', dark: false, ext: eclipse },
    { id: 'github-light', label: 'GitHub Light', dark: false, ext: githubLight },
    { id: 'github-dark', label: 'GitHub Dark', dark: true, ext: githubDark },
    { id: 'monokai', label: 'Monokai', dark: true, ext: monokai },
    { id: 'nord', label: 'Nord', dark: true, ext: nord },
    { id: 'one-dark', label: 'One Dark', dark: true, ext: oneDark },
    { id: 'solarized-light', label: 'Solarized Light', dark: false, ext: solarizedLight },
    { id: 'solarized-dark', label: 'Solarized Dark', dark: true, ext: solarizedDark },
    { id: 'tokyo-night', label: 'Tokyo Night', dark: true, ext: tokyoNight },
    { id: 'vscode-light', label: 'VS Code Light', dark: false, ext: vscodeLight },
    { id: 'vscode-dark', label: 'VS Code Dark', dark: true, ext: vscodeDark }
];
const AUTO = { light: 'github-light', dark: 'darcula' };

// 'auto' picks a light or dark theme to match the page
function resolveTheme(id, pageIsDark) {
    if (id == null || id == 'auto') id = pageIsDark ? AUTO.dark : AUTO.light;
    return THEMES.find((t) => t.id == id) || THEMES.find((t) => t.id == AUTO.light);
}

// ---- Languages ----

const BATCH_KEYWORDS = new Set(['if', 'else', 'for', 'in', 'do', 'goto', 'call', 'set', 'setlocal', 'endlocal', 'echo', 'exit', 'not', 'exist', 'defined',
    'errorlevel', 'equ', 'neq', 'lss', 'leq', 'gtr', 'geq', 'shift', 'pause', 'start', 'cd', 'chdir', 'pushd', 'popd', 'title', 'cls', 'choice', 'timeout',
    'copy', 'del', 'erase', 'move', 'mkdir', 'md', 'rd', 'rmdir', 'type', 'ren', 'rename', 'xcopy', 'robocopy', 'reg', 'sc', 'net', 'findstr', 'find', 'off', 'on']);

// Windows batch files: REM and :: comments, :labels, %var%, %%i, !delayed! variables, keywords and redirection
const batch = {
    name: 'batch',
    startState: () => ({}),
    token(stream) {
        if (stream.sol()) {
            if (stream.match(/^\s*@?(rem\b|::)/i)) { stream.skipToEnd(); return 'comment'; }
            if (stream.match(/^\s*:[A-Za-z0-9_.\-]+/)) return 'typeName'; // :label (most themes don't style labelName)
        }
        if (stream.eatSpace()) return null;
        if (stream.match(/^%%~?[A-Za-z]/) || stream.match(/^%~[A-Za-z]*[0-9]/) || stream.match(/^%[0-9*]/) || stream.match(/^%[^%\s]+%/) || stream.match(/^![^!\s]+!/)) return 'variableName';
        if (stream.match(/^:[A-Za-z][A-Za-z0-9_.\-]*/)) return 'typeName'; // goto :label, call :label
        if (stream.match(/^"[^"]*"?/)) return 'string';
        if (stream.match(/^(>>|>|<|\|\||\||&&|&|==)/)) return 'operator';
        if (stream.match(/^@/)) return 'meta';
        if (stream.match(/^[0-9]+\b/)) return 'number';
        if (stream.match(/^[A-Za-z_][\w.\-]*/)) return BATCH_KEYWORDS.has(stream.current().toLowerCase()) ? 'keyword' : null;
        stream.next();
        return null;
    },
    languageData: { commentTokens: { line: 'REM' } }
};

// ScriptTask variables (#name#) are recognised before the language's own rules, so in PowerShell and Bash
// they aren't taken for the start of a # comment
const VAR_TOKEN = /^#[A-Za-z0-9_:.\-]+#/;
function withVariables(mode) {
    return Object.assign({}, mode, {
        token(stream, state) {
            if (stream.match(VAR_TOKEN)) return 'macroName';
            return mode.token(stream, state);
        }
    });
}
const LANGUAGES = {
    ps1: () => StreamLanguage.define(withVariables(powerShell)),
    bash: () => StreamLanguage.define(withVariables(shell)),
    bat: () => StreamLanguage.define(withVariables(batch))
};
function language(filetype) { return LANGUAGES[filetype] ? LANGUAGES[filetype]() : []; }

// ---- #variable# decorations and hover ----

function variableHighlighter(isKnown) {
    const matcher = new MatchDecorator({
        regexp: /#([A-Za-z0-9_:.\-]+)#/g,
        decoration: (m) => Decoration.mark({ class: (isKnown && !isKnown(m[1])) ? 'cm-st-var cm-st-var-unknown' : 'cm-st-var', attributes: { 'data-st-var': m[1] } })
    });
    return ViewPlugin.fromClass(class {
        constructor(view) { this.decorations = matcher.createDeco(view); }
        update(u) { this.decorations = matcher.updateDeco(u, this.decorations); }
    }, { decorations: (v) => v.decorations });
}

function variableTooltip(describe) {
    return hoverTooltip((view, pos) => {
        const line = view.state.doc.lineAt(pos), re = /#([A-Za-z0-9_:.\-]+)#/g;
        let m;
        while ((m = re.exec(line.text)) != null) {
            const from = line.from + m.index, to = from + m[0].length;
            if (pos < from || pos > to) continue;
            const rows = describe(m[1]);
            if (rows == null) return null;
            return {
                pos: from, end: to, above: true,
                create() {
                    const dom = document.createElement('div');
                    dom.className = 'cm-st-var-tip';
                    const title = document.createElement('div');
                    title.className = 'cm-st-var-tip-title';
                    title.textContent = m[0];
                    dom.appendChild(title);
                    rows.forEach((r) => { const d = document.createElement('div'); d.textContent = r; dom.appendChild(d); });
                    return { dom };
                }
            };
        }
        return null;
    }, { hoverTime: 250 });
}

const baseTheme = EditorView.baseTheme({
    '&': { height: '100%', fontSize: '13px' },
    '.cm-scroller': { fontFamily: 'SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace', lineHeight: '1.5' },
    '.cm-st-var': { borderRadius: '3px', outline: '1px solid rgba(127, 127, 127, 0.45)', backgroundColor: 'rgba(127, 127, 127, 0.12)' },
    '.cm-st-var-unknown': { textDecoration: 'underline wavy #e5a50a', textUnderlineOffset: '3px' },
    '.cm-st-var-tip': { padding: '4px 8px', fontSize: '12px', maxWidth: '28rem' },
    '.cm-st-var-tip-title': { fontWeight: '600', marginBottom: '2px' }
});

// ---- Editor ----

const INDENTS = { '2': '  ', '4': '    ', 'tab': '\t' };

/**
 * Create an editor.
 * opts: parent (element), doc (text), filetype ('ps1'|'bat'|'bash'|null), readOnly, theme ('auto' or a theme id), dark (page is dark),
 * indent ('2'|'4'|'tab'), wrap (bool), onChange(text), onSave(), onCursor({ line, col }), isKnownVar(name), describeVar(name) -> [lines] or null
 */
function create(opts) {
    const lang = new Compartment(), theme = new Compartment(), indent = new Compartment(), wrap = new Compartment(), editable = new Compartment();
    const extensions = [
        basicSetup,
        keymap.of([indentWithTab, { key: 'Mod-s', preventDefault: true, run: () => { if (opts.onSave) opts.onSave(); return true; } }]),
        lang.of(language(opts.filetype)),
        theme.of(resolveTheme(opts.theme, opts.dark).ext),
        indent.of([indentUnit.of(INDENTS[opts.indent] || INDENTS['4']), EditorState.tabSize.of(4)]),
        wrap.of(opts.wrap ? EditorView.lineWrapping : []),
        editable.of([EditorState.readOnly.of(!!opts.readOnly), EditorView.editable.of(!opts.readOnly)]),
        baseTheme,
        EditorView.updateListener.of((u) => {
            if (u.docChanged && opts.onChange) opts.onChange(u.state.doc.toString());
            if ((u.selectionSet || u.docChanged) && opts.onCursor) {
                const head = u.state.selection.main.head, line = u.state.doc.lineAt(head);
                opts.onCursor({ line: line.number, col: head - line.from + 1, lines: u.state.doc.lines });
            }
        })
    ];
    if (opts.filetype) {
        extensions.push(variableHighlighter(opts.isKnownVar));
        if (opts.describeVar) extensions.push(variableTooltip(opts.describeVar));
    }
    // CodeMirror keeps "\n" internally; callers choose the line endings to save with
    const view = new EditorView({ parent: opts.parent, state: EditorState.create({ doc: opts.doc || '', extensions }) });
    return {
        view,
        getValue: () => view.state.doc.toString(),
        setValue: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text || '' } }),
        setFiletype: (ft) => view.dispatch({ effects: lang.reconfigure(language(ft)) }),
        setTheme: (id, dark) => view.dispatch({ effects: theme.reconfigure(resolveTheme(id, dark).ext) }),
        setIndent: (v) => view.dispatch({ effects: indent.reconfigure([indentUnit.of(INDENTS[v] || INDENTS['4']), EditorState.tabSize.of(4)]) }),
        setWrap: (on) => view.dispatch({ effects: wrap.reconfigure(on ? EditorView.lineWrapping : []) }),
        focus: () => view.focus(),
        destroy: () => view.destroy()
    };
}

// Guess the indent a script uses: tabs, 2 or 4 spaces
function detectIndent(text, fallback) {
    const lines = (text || '').split('\n');
    let tabs = 0, two = 0, four = 0;
    for (const l of lines) {
        if (l.startsWith('\t')) tabs++;
        else { const m = /^( +)\S/.exec(l); if (m) { if (m[1].length % 4 == 0) four++; else if (m[1].length % 2 == 0) two++; } }
    }
    if (tabs > two + four) return 'tab';
    if (two > four) return '2';
    if (four > 0) return '4';
    return fallback || '4';
}

window.STEditor = {
    themes: THEMES.map((t) => ({ id: t.id, label: t.label, dark: t.dark })),
    autoThemes: AUTO,
    resolveTheme: (id, dark) => { const t = resolveTheme(id, dark); return { id: t.id, label: t.label, dark: t.dark }; },
    detectIndent,
    create
};
