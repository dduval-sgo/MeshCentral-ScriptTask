/**
* @description ScriptTask code editor for plugin pages: loads the CodeMirror bundle on first use and wraps it as a
* Preact component, with a per-user code theme that is independent of the MeshCentral theme.
* Requires st-core.js.
* @license Apache-2.0
*/

"use strict";

(function () {
    var html = ST.html;
    var useState = preactHooks.useState, useEffect = preactHooks.useEffect, useRef = preactHooks.useRef;
    var BUNDLE = '/pluginadmin.ashx?pin=scripttask&include=1&path=vendor/st-codemirror.min.js';
    var THEME_KEY = 'scripttask.editorTheme';

    ST.editor = {};

    // Load the editor bundle once. Resolves window.STEditor.
    var loading = null;
    ST.editor.load = function () {
        if (window.STEditor) return Promise.resolve(window.STEditor);
        if (loading == null) {
            loading = new Promise(function (resolve, reject) {
                var s = document.createElement('script');
                s.src = BUNDLE + '&v=' + (window.ST_VERSION || '');
                s.onload = function () { resolve(window.STEditor); };
                s.onerror = function () { loading = null; reject(new Error('The code editor couldn\'t be loaded.')); };
                document.head.appendChild(s);
            });
        }
        return loading;
    };

    // The user's code theme ('auto' or a theme id), shared by every ScriptTask page in this browser
    var themeListeners = [];
    ST.editor.themePref = function () { try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { return 'auto'; } };
    ST.editor.setThemePref = function (id) {
        try { localStorage.setItem(THEME_KEY, id); } catch (e) { }
        themeListeners.slice().forEach(function (fn) { fn(id); });
    };
    // Other ScriptTask iframes change it through localStorage
    window.addEventListener('storage', function (e) { if (e.key == THEME_KEY) themeListeners.slice().forEach(function (fn) { fn(e.newValue || 'auto'); }); });
    function pageIsDark() { return document.documentElement.getAttribute('data-bs-theme') == 'dark'; }

    // Re-render when the code theme or the page's light/dark mode changes
    function useThemeState() {
        var s = useState({ pref: ST.editor.themePref(), dark: pageIsDark() }), st = s[0], set = s[1];
        useEffect(function () {
            var onPref = function (id) { set(function (o) { return { pref: id, dark: o.dark }; }); };
            themeListeners.push(onPref);
            var mo = new MutationObserver(function () { set(function (o) { return { pref: o.pref, dark: pageIsDark() }; }); });
            mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-bs-theme'] });
            return function () { themeListeners.splice(themeListeners.indexOf(onPref), 1); mo.disconnect(); };
        }, []);
        return st;
    }

    // props: value, filetype, readOnly, wrap, indent, onChange(text), onSave(), onCursor({line,col,lines}), isKnownVar(name), describeVar(name), class
    // The initial value is used when the editor is created; give the component a new key to load different content.
    ST.CodeEditor = function (props) {
        var host = useRef(null), inst = useRef(null), latest = useRef(props);
        var failed = useState(null);
        var theme = useThemeState();
        latest.current = props;
        useEffect(function () {
            var alive = true;
            ST.editor.load().then(function (E) {
                if (!alive || host.current == null) return;
                inst.current = E.create({
                    parent: host.current, doc: props.value, filetype: props.filetype, readOnly: props.readOnly, wrap: props.wrap, indent: props.indent,
                    theme: theme.pref, dark: theme.dark,
                    onChange: function (t) { if (latest.current.onChange) latest.current.onChange(t); },
                    onSave: function () { if (latest.current.onSave) latest.current.onSave(); },
                    onCursor: function (c) { if (latest.current.onCursor) latest.current.onCursor(c); },
                    isKnownVar: props.isKnownVar ? function (n) { return latest.current.isKnownVar(n); } : null,
                    describeVar: props.describeVar ? function (n) { return latest.current.describeVar(n); } : null
                });
                if (props.autofocus) inst.current.focus();
            }, function (e) { if (alive) failed[1](e.message); });
            return function () { alive = false; if (inst.current) { inst.current.destroy(); inst.current = null; } };
        }, []);
        useEffect(function () { if (inst.current) inst.current.setTheme(theme.pref, theme.dark); }, [theme.pref, theme.dark]);
        useEffect(function () { if (inst.current) inst.current.setFiletype(props.filetype); }, [props.filetype]);
        useEffect(function () { if (inst.current) inst.current.setIndent(props.indent); }, [props.indent]);
        useEffect(function () { if (inst.current) inst.current.setWrap(!!props.wrap); }, [props.wrap]);
        if (failed[0]) return html`<div class="alert alert-danger">${failed[0]}</div>`;
        return html`<div class=${'st-code-editor ' + (props.class || '')} ref=${host}></div>`;
    };

    // Code theme picker: Auto (follows MeshCentral's light/dark mode) or a named theme
    ST.EditorThemePicker = function (props) {
        var theme = useThemeState();
        var s = useState(window.STEditor ? window.STEditor.themes : null), themes = s[0];
        useEffect(function () { if (themes == null) ST.editor.load().then(function (E) { s[1](E.themes); }, function () { }); }, []);
        var auto = window.STEditor ? window.STEditor.resolveTheme('auto', theme.dark).label : '';
        return html`<select class=${'form-select form-select-sm w-auto ' + (props.class || '')} aria-label="Code theme" title="Code theme" value=${theme.pref} onChange=${function (e) { ST.editor.setThemePref(e.target.value); }}>
            <option value="auto">Auto${auto ? ' (' + auto + ')' : ''}</option>
            ${(themes || []).filter(function (t) { return !t.dark; }).length ? html`<optgroup label="Light">${themes.filter(function (t) { return !t.dark; }).map(function (t) { return html`<option value=${t.id}>${t.label}</option>`; })}</optgroup>` : null}
            ${(themes || []).filter(function (t) { return t.dark; }).length ? html`<optgroup label="Dark">${themes.filter(function (t) { return t.dark; }).map(function (t) { return html`<option value=${t.id}>${t.label}</option>`; })}</optgroup>` : null}
        </select>`;
    };
})();
