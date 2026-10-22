/**
* @description ScriptTask page (My Server > Plugins > ScriptTask): the script library with a code editor, each script's
* schedules, history and variables across devices, and plugin settings. For ScriptTask managers.
* Requires st-core.js, st-dialogs.js, st-editor.js and st-shared.js.
* @license Apache-2.0
*/

"use strict";

(function () {
    var html = ST.html;
    var useState = preactHooks.useState, useEffect = preactHooks.useEffect, useMemo = preactHooks.useMemo, useRef = preactHooks.useRef, useCallback = preactHooks.useCallback;
    var host = ST.host;
    var S = ST.shared, store = S.store, nodeName = S.nodeName, meshName = S.meshName;
    var TYPES = [['ps1', 'PowerShell'], ['bat', 'Batch'], ['bash', 'Bash']];
    var BUILT_INS = { 'GBL:meshId': 'The device\'s group id', 'GBL:nodeId': 'The device\'s id', 'GBL:runBy': 'The user (or schedule owner) who started the run' };

    // ---- Routing: #/library, #/library/<scriptOrFolderId>, #/settings ----

    function parseRoute() {
        var m = /^#\/(library|settings)(?:\/([^/?#]+))?/.exec(location.hash);
        return m ? { section: m[1], id: m[2] ? decodeURIComponent(m[2]) : null } : { section: 'library', id: null };
    }
    function routeHash(r) { return '#/' + r.section + (r.id ? '/' + encodeURIComponent(r.id) : ''); }

    // Script names referenced in a script as #name#
    function referencedVars(content) {
        var seen = {}, out = [], re = /#([A-Za-z0-9_:.\-]+)#/g, m;
        while ((m = re.exec(content || '')) != null) { if (!seen[m[1]]) { seen[m[1]] = true; out.push(m[1]); } }
        return out;
    }
    // Where a variable is defined, for the editor's hover and the Variables tab
    function varSummary(vars, name, scriptId) {
        var mine = vars.filter(function (v) { return v.name == name; });
        return {
            global: mine.find(function (v) { return v.scope == 'global'; }) || null,
            script: mine.find(function (v) { return v.scope == 'script' && v.scopeTarget == scriptId; }) || null,
            mesh: mine.filter(function (v) { return v.scope == 'mesh'; }).length,
            node: mine.filter(function (v) { return v.scope == 'node'; }).length,
            otherScripts: mine.filter(function (v) { return v.scope == 'script' && v.scopeTarget != scriptId; }).length
        };
    }
    function plural(n, word) { return n + ' ' + word + (n == 1 ? '' : 's'); }

    // ---- Script workspace ----

    function ScriptWorkspace(props) {
        var item = props.item, a = props.actions;
        var tab = useState(store('serverTab') || 'editor');
        var loaded = useState(null), script = loaded[0]; // { content, filetype } as saved
        var text = useState(''), filetype = useState(item.filetype), eol = useState('lf'), indent = useState('4');
        var cursor = useState({ line: 1, col: 1, lines: 1 });
        var busy = useState(false);
        var data = useState(null); // { history, schedules } across devices
        var editorKey = useState(0); // Bumped to reload the editor's content (Revert)

        var loadData = useCallback(function () { ST.rpc('scriptData', { scriptId: item._id }).then(data[1], function () { data[1]({ history: [], schedules: [] }); }); }, [item._id]);
        useEffect(function () {
            ST.rpc('getScript', { id: item._id }).then(function (sc) {
                var content = sc.content || '';
                var crlf = content.indexOf('\r\n') >= 0;
                var lf = content.replace(/\r\n?/g, '\n');
                eol[1](sc.filetype == 'bash' ? 'lf' : (crlf || content.length == 0) ? 'crlf' : 'lf');
                text[1](lf); filetype[1](sc.filetype); cursor[1]({ line: 1, col: 1, lines: lf.split('\n').length });
                loaded[1]({ content: lf, filetype: sc.filetype, eol: (sc.filetype == 'bash') ? 'lf' : (crlf || content.length == 0) ? 'crlf' : 'lf' });
                ST.editor.load().then(function (E) { indent[1](E.detectIndent(lf, sc.filetype == 'bash' ? '2' : '4')); }, function () { });
            }, function (e) { ST.ui.toast(e.message, 'error'); });
            loadData();
        }, [item._id]);
        // Reload this script's runs and schedules when the server says they changed
        useEffect(function () { return ST.onInvalidate(function (m) { if (m.scriptIds && m.scriptIds.indexOf(item._id) >= 0) loadData(); }); }, [item._id]);

        var dirty = script != null && (text[0] != script.content || filetype[0] != script.filetype || eol[0] != script.eol);
        useEffect(function () { props.onDirty(dirty); }, [dirty]);
        // Mark unsaved changes as soon as the text changes, not after the next render, so a quick click elsewhere is still guarded
        var onText = function (t) { text[1](t); if (script != null && t != script.content) props.onDirty(true); };
        useEffect(function () { return function () { props.onDirty(false); }; }, []);

        var save = function () {
            if (!dirty || busy[0]) return;
            busy[1](true);
            var out = (eol[0] == 'crlf' && filetype[0] != 'bash') ? text[0].replace(/\n/g, '\r\n') : text[0];
            ST.rpc('saveScript', { id: item._id, name: item.name, filetype: filetype[0], content: out }).then(function () {
                busy[1](false);
                loaded[1]({ content: text[0], filetype: filetype[0], eol: filetype[0] == 'bash' ? 'lf' : eol[0] });
                if (filetype[0] == 'bash') eol[1]('lf');
                ST.ui.toast(item.name + ' saved.');
            }, function (e) { busy[1](false); ST.ui.toast(e.message, 'error'); });
        };
        var revert = function () {
            ST.ui.confirm({ title: 'Revert changes?', body: 'Your unsaved changes to ' + item.name + ' will be lost.', confirmText: 'Revert', danger: true }).then(function (ok) {
                if (!ok) return;
                text[1](script.content); filetype[1](script.filetype); eol[1](script.eol); editorKey[1](editorKey[0] + 1);
            });
        };
        var setTab = function (t) { tab[1](t); store('serverTab', t); };

        var vars = props.vars || [];
        var isKnownVar = function (n) { return BUILT_INS[n] != null || vars.some(function (v) { return v.name == n; }); };
        var describeVar = function (n) {
            if (BUILT_INS[n]) return ['Built in: ' + BUILT_INS[n] + '.'];
            var s = varSummary(vars, n, item._id), rows = [];
            if (s.script) rows.push('This script: ' + s.script.value);
            if (s.global) rows.push('Global: ' + s.global.value);
            if (s.mesh) rows.push('Overridden in ' + plural(s.mesh, 'device group'));
            if (s.node) rows.push('Overridden on ' + plural(s.node, 'device'));
            if (rows.length == 0) rows.push('Not defined anywhere. It runs as VAR_NOT_FOUND unless a value is added.');
            return rows;
        };

        var refs = useMemo(function () { return referencedVars(text[0]); }, [text[0]]);
        var scriptVars = vars.filter(function (v) { return v.scope == 'script' && v.scopeTarget == item._id; });
        var counts = { schedules: data[0] ? data[0].schedules.length : null, history: data[0] ? data[0].history.filter(function (j) { return j.completeTime != null; }).length : null };
        var tabs = [['editor', 'Editor', null], ['schedules', 'Schedules', counts.schedules], ['history', 'History', counts.history], ['variables', 'Variables', refs.length + scriptVars.length]];

        return html`<div class="st-workspace">
            <div class="st-workspace-head">
                <div class="st-script-head">
                    <span class="st-script-name">${item.name}</span>
                    <span class="st-type" title=${ST.fmt.filetype(filetype[0])}>${filetype[0]}</span>
                    <span class="st-script-path">${item.path}</span>
                    ${dirty ? html`<span class="badge text-bg-warning">Unsaved</span>` : null}
                </div>
                <div class="st-actions-row">
                    <button class="btn btn-sm st-btn-quiet" onClick=${function () { a.runMany(item); }}><${ST.Icon} name="send" class="me-1" />Run on devices…</button>
                    <button class="btn btn-sm st-btn-quiet" onClick=${function () { a.download(item); }}><${ST.Icon} name="download" class="me-1" />Download</button>
                    <button class="btn btn-sm st-btn-quiet" onClick=${function () { a.rename(item); }}>Rename</button>
                    <button class="btn btn-sm btn-outline-danger" onClick=${function () { a.remove(item); }}><${ST.Icon} name="trash3" class="me-1" />Delete</button>
                </div>
            </div>
            <ul class="nav nav-tabs st-tabs" role="tablist">
                ${tabs.map(function (t) { return html`<li class="nav-item" role="presentation"><button type="button" role="tab" aria-selected=${tab[0] == t[0]} class=${'nav-link' + (tab[0] == t[0] ? ' active' : '')} onClick=${function () { setTab(t[0]); }}>${t[1]}${t[2] != null ? html` <span class="badge rounded-pill text-bg-secondary">${t[2]}</span>` : null}</button></li>`; })}
            </ul>
            <div class=${'st-tab-body' + (tab[0] == 'editor' ? ' st-tab-editor' : '')}>
                ${tab[0] == 'editor' ? (script == null ? html`<div class="text-center py-5"><${ST.Spinner} /></div>` : html`
                    <div class="st-editor-toolbar">
                        <select class="form-select form-select-sm w-auto" aria-label="Script type" value=${filetype[0]} onChange=${function (e) { filetype[1](e.target.value); if (e.target.value == 'bash') eol[1]('lf'); }}>
                            ${TYPES.map(function (t) { return html`<option value=${t[0]}>${t[1]}</option>`; })}
                        </select>
                        <${ST.EditorThemePicker} />
                        <span class="ms-auto"></span>
                        <button class="btn btn-sm st-btn-quiet" disabled=${!dirty} onClick=${revert}>Revert</button>
                        <button class="btn btn-sm btn-primary" disabled=${!dirty || busy[0]} onClick=${save} title="Save (Ctrl+S)">${busy[0] ? html`<${ST.Spinner} class="me-1" />` : null}Save</button>
                    </div>
                    <div class="st-editor-frame">
                        <${ST.CodeEditor} key=${item._id + ':' + editorKey[0]} value=${text[0]} filetype=${filetype[0]} indent=${indent[0]} autofocus=${false}
                            onChange=${onText} onSave=${save} onCursor=${cursor[1]} isKnownVar=${isKnownVar} describeVar=${describeVar} />
                    </div>
                    <div class="st-statusbar">
                        <span>Ln ${cursor[0].line}, Col ${cursor[0].col}</span>
                        <span>${plural(cursor[0].lines, 'line')}</span>
                        <label class="ms-auto">Indent
                            <select class="st-status-select" value=${indent[0]} onChange=${function (e) { indent[1](e.target.value); }}>
                                <option value="2">2 spaces</option><option value="4">4 spaces</option><option value="tab">Tabs</option>
                            </select></label>
                        <label title=${filetype[0] == 'bash' ? 'Bash scripts are always saved with LF line endings' : 'Line endings used when saving'}>Line endings
                            <select class="st-status-select" value=${filetype[0] == 'bash' ? 'lf' : eol[0]} disabled=${filetype[0] == 'bash'} onChange=${function (e) { eol[1](e.target.value); }}>
                                <option value="crlf">CRLF (Windows)</option><option value="lf">LF</option>
                            </select></label>
                        <span>${ST.fmt.filetype(filetype[0])}</span>
                    </div>`) : null}
                ${tab[0] == 'schedules' ? (data[0] == null ? html`<${ST.Spinner} />` : html`
                    <${S.ScheduleTable} schedules=${data[0].schedules} showDevice=${true} canChange=${function () { return true; }} actions=${props.scheduleActions} empty="This script isn't scheduled on any device." />`) : null}
                ${tab[0] == 'history' ? (data[0] == null ? html`<${ST.Spinner} />` : html`
                    <${S.HistoryTable} jobs=${data[0].history.filter(function (j) { return j.completeTime != null; })} showDevice=${true} empty="This script hasn't run anywhere yet."
                        onOpen=${function (j) { a.openOutput(j); }} />`) : null}
                ${tab[0] == 'variables' ? html`<${VariablesTab} item=${item} vars=${vars} refs=${refs} scriptVars=${scriptVars} actions=${a} />` : null}
            </div>
        </div>`;
    }

    function VariablesTab(props) {
        var a = props.actions, item = props.item;
        return html`<div>
            <div class="st-section-title">Used in this script</div>
            ${props.refs.length == 0 ? html`<${ST.Empty}>This script doesn't use any #variables#.</${ST.Empty}>` : html`
            <div class="table-responsive"><table class="table table-sm st-table">
                <thead><tr><th>Variable</th><th>This script</th><th>Global</th><th>Overrides</th></tr></thead>
                <tbody>${props.refs.map(function (n) {
                    if (BUILT_INS[n]) return html`<tr key=${n}><td><code>#${n}#</code></td><td colspan="3" class="text-body-secondary">Built in: ${BUILT_INS[n]}</td></tr>`;
                    var s = varSummary(props.vars, n, item._id), undefinedVar = !s.script && !s.global && !s.mesh && !s.node;
                    return html`<tr key=${n}>
                        <td><code>#${n}#</code>${undefinedVar ? html`<div class="small text-warning-emphasis"><${ST.Icon} name="exclamation-triangle-fill" class="me-1" />Not defined. Runs as VAR_NOT_FOUND.</div>` : null}</td>
                        <td>${s.script ? html`<div class="st-output-preview">${s.script.value}</div>` : html`<span class="text-body-tertiary">—</span>`}</td>
                        <td>${s.global ? html`<div class="st-output-preview">${s.global.value}</div>` : html`<span class="text-body-tertiary">—</span>`}</td>
                        <td class="small">${[s.mesh ? plural(s.mesh, 'device group') : '', s.node ? plural(s.node, 'device') : ''].filter(Boolean).join(', ') || html`<span class="text-body-tertiary">None</span>`}</td>
                    </tr>`; })}</tbody>
            </table></div>
            <div class="form-text">Device group and device values are set from a device's ScriptTask tab. The most specific value wins: device, then group, then script, then global.</div>`}
            <div class="st-section-title d-flex align-items-center">Script variables
                <button class="btn btn-sm st-btn-quiet ms-auto" onClick=${function () { a.editVar(null, item); }}><${ST.Icon} name="plus-lg" class="me-1" />New variable</button></div>
            ${props.scriptVars.length == 0 ? html`<${ST.Empty}>No variables are set for this script only.</${ST.Empty}>` : html`
            <div class="table-responsive"><table class="table table-sm st-table">
                <thead><tr><th>Name</th><th>Value</th><th class="st-col-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
                <tbody>${props.scriptVars.map(function (v) { return html`<tr key=${v._id}>
                    <td><code>#${v.name}#</code></td><td><div class="st-output-preview">${v.value}</div></td>
                    <td class="st-col-actions">
                        <button class="btn btn-sm st-btn-quiet me-1" title="Edit" onClick=${function () { a.editVar(v, item); }}><${ST.Icon} name="pencil" /><span class="visually-hidden">Edit</span></button>
                        <button class="btn btn-sm btn-outline-danger" title="Delete" onClick=${function () { a.deleteVar(v); }}><${ST.Icon} name="trash3" /><span class="visually-hidden">Delete</span></button>
                    </td></tr>`; })}</tbody>
            </table></div>`}
        </div>`;
    }

    function FolderPanel(props) {
        var item = props.item, a = props.actions, isRoot = item.path == 'Shared';
        var inside = props.items.filter(function (i) { return i._id != item._id && (i.path == item.path || i.path.indexOf(item.path + '/') == 0); });
        var scripts = inside.filter(function (i) { return i.type == 'script'; }).length, folders = inside.filter(function (i) { return i.type == 'folder'; }).length;
        return html`<div class="st-workspace">
            <div class="st-workspace-head">
                <div class="st-script-head"><${ST.Icon} name="folder2-open" class="st-folder-icon" /><span class="st-script-name">${item.name}</span><span class="st-script-path">${item.path}</span></div>
                <div class="st-actions-row">
                    ${!isRoot ? html`<button class="btn btn-sm st-btn-quiet" onClick=${function () { a.rename(item); }}>Rename</button>
                    <button class="btn btn-sm btn-outline-danger" onClick=${function () { a.remove(item); }}><${ST.Icon} name="trash3" class="me-1" />Delete</button>` : null}
                </div>
            </div>
            <div class="st-tab-body">
                <p class="text-body-secondary">${plural(scripts, 'script')} and ${plural(folders, 'folder')} in this folder, including subfolders.</p>
                <div class="d-flex gap-2 flex-wrap">
                    <button class="btn btn-primary" onClick=${a.newScript}><${ST.Icon} name="file-earmark-plus" class="me-1" />New script here</button>
                    <button class="btn st-btn-quiet" onClick=${a.newFolder}><${ST.Icon} name="folder-plus" class="me-1" />New folder here</button>
                    <button class="btn st-btn-quiet" onClick=${a.pickUpload}><${ST.Icon} name="upload" class="me-1" />Upload scripts here</button>
                </div>
                <div class="form-text mt-3">You can also drop .ps1, .bat and .sh files onto the library, and drag scripts and folders onto a folder to move them.</div>
            </div>
        </div>`;
    }

    // ---- App ----

    function App() {
        var st = useState({ init: null, error: null, items: null, vars: null }), state = st[0], setState = st[1];
        var patch = useCallback(function (p) { setState(function (o) { return Object.assign({}, o, p); }); }, []);
        var route = useState(parseRoute());
        var col = useState(store('collapsed') || []), collapsed = col[0];
        var dlg = useState(null), dialog = dlg[0], setDialog = dlg[1];
        var dirty = useRef(false);
        var fileInput = useRef(null);
        var close = function () { setDialog(null); };

        var loadTree = function () { return ST.rpc('tree').then(function (items) { patch({ items: items }); }); };
        var loadVars = function () { return ST.rpc('variables').then(function (v) { patch({ vars: v }); }); };

        useEffect(function () {
            // The device tab can ask to open a particular script
            var wanted = store('openRoute');
            if (wanted) { store('openRoute', ''); history.replaceState(null, '', wanted); route[1](parseRoute()); }
            ST.rpc('init', {}).then(function (init) {
                patch({ init: init });
                if (!init.caps.manage) return;
                return Promise.all([loadTree(), loadVars()]);
            }).catch(function (e) { patch({ error: e.message }); });
            var onHash = function () { route[1](parseRoute()); };
            window.addEventListener('hashchange', onHash);
            var onLeave = function (e) { if (dirty.current) { e.preventDefault(); e.returnValue = ''; } };
            window.addEventListener('beforeunload', onLeave);
            return function () { window.removeEventListener('hashchange', onHash); window.removeEventListener('beforeunload', onLeave); };
        }, []);
        useEffect(function () {
            var timer = null, due = {};
            return ST.onInvalidate(function (m) {
                if (m.library) due.library = true;
                if (m.variables) due.vars = true;
                if (timer == null) timer = setTimeout(function () { timer = null; if (due.library) loadTree().catch(function () { }); if (due.vars) loadVars().catch(function () { }); due = {}; }, 250);
            });
        }, []);
        useEffect(function () { if (state.init || state.error) document.body.classList.remove('st-loading'); }, [state.init, state.error]);

        // Navigate, asking first if the editor has unsaved changes
        var go = function (r) {
            var next = routeHash(r);
            if (next == location.hash) return;
            var proceed = dirty.current ? ST.ui.confirm({ title: 'Discard unsaved changes?', body: 'The script you are editing has unsaved changes.', confirmText: 'Discard', danger: true }) : Promise.resolve(true);
            proceed.then(function (ok) { if (ok) { dirty.current = false; location.hash = next; } });
        };
        var items = state.items || [];
        var selected = (route[0].section == 'library' && route[0].id) ? items.find(function (i) { return i._id == route[0].id; }) || null : null;
        var select = function (item) { go({ section: 'library', id: item._id }); };
        var toggleFolder = function (path) {
            var next = (collapsed.indexOf(path) >= 0) ? collapsed.filter(function (p) { return p != path; }) : collapsed.concat([path]);
            col[1](next); store('collapsed', next);
        };
        var folderOf = function (item) { return item == null ? 'Shared' : item.path; };
        var scriptName = function (id) { var s = items.find(function (i) { return i._id == id; }); return s ? s.name : '(deleted script)'; };

        var actions = {
            newScript: function () {
                setDialog(html`<${S.NewScriptDialog} folder=${folderOf(selected)} onClose=${close} onSubmit=${function (f) {
                    ST.ui.attempt(ST.rpc('addScript', { name: f.name, filetype: f.filetype, content: '', folderId: selected ? selected._id : null })).then(function (r) {
                        if (r == null) return;
                        close(); store('serverTab', 'editor');
                        loadTree().then(function () { go({ section: 'library', id: r.id }); });
                    });
                }} />`);
            },
            newFolder: function () {
                ST.ui.prompt({ title: 'New folder', label: 'Folder name (in ' + folderOf(selected) + ')', confirmText: 'Create' }).then(function (name) {
                    if (name) ST.ui.attempt(ST.rpc('newFolder', { name: name, parentId: selected ? selected._id : null }), 'Folder created.');
                });
            },
            pickUpload: function () { fileInput.current.click(); },
            upload: function (files, folderId) {
                Array.from(files).forEach(function (file) {
                    file.text().then(function (content) {
                        var type = S.detectType(file.name, content);
                        if (type == null) { ST.ui.toast(file.name + ' wasn\'t added. Only .ps1, .bat and Bash scripts are supported.', 'error'); return; }
                        ST.ui.attempt(ST.rpc('addScript', { name: file.name, content: content, filetype: type, folderId: folderId }), file.name + ' added.');
                    });
                });
            },
            move: function (id, folderId) { ST.ui.attempt(ST.rpc('move', { id: id, toId: folderId })); },
            rename: function (item) {
                ST.ui.prompt({ title: 'Rename', label: 'New name', value: item.name, confirmText: 'Rename' }).then(function (name) {
                    if (name && name != item.name) ST.ui.attempt(ST.rpc('rename', { id: item._id, name: name }));
                });
            },
            download: function (item) { window.location = '/pluginadmin.ashx?pin=scripttask&user=1&dl=' + encodeURIComponent(item._id); },
            remove: function (item) {
                var body = (item.type == 'folder')
                    ? html`<p class="mb-0">${item.name} and everything in it will be deleted, along with the schedules for those scripts.</p>`
                    : html`<p class="mb-0">${item.name} will be deleted from the library, along with its schedules on every device. Past runs stay in history.</p>`;
                ST.ui.confirm({ title: 'Delete ' + item.name + '?', body: body, confirmText: 'Delete', danger: true }).then(function (ok) {
                    if (!ok) return;
                    ST.ui.attempt(ST.rpc('deleteItem', { id: item._id }), item.name + ' deleted.').then(function (r) { if (r) { dirty.current = false; location.hash = '#/library'; } });
                });
            },
            runMany: function (item) {
                var nodes = (host.nodes || []).filter(function (n) { return n.mtype == 2; }).map(function (n) { return { _id: n._id, name: n.name, meshid: n.meshid, tags: n.tags, meshName: meshName(n.meshid) }; }).sort(function (x, y) { return x.name.localeCompare(y.name); });
                setDialog(html`<${ST.dialogs.DevicePicker} nodes=${nodes} initial=${[]} scriptName=${item.name} onClose=${close}
                    onSchedule=${function (ids) {
                        setDialog(html`<${ST.dialogs.Schedule} title=${'Schedule ' + item.name} subtitle=${'On ' + plural(ids.length, 'device')} settings=${state.init.settings} onClose=${close} onSubmit=${function (sc) {
                            return ST.rpc('addSchedule', { scriptId: item._id, nodeIds: ids, schedule: sc }).then(function (r) {
                                close(); ST.ui.toast('Scheduled on ' + plural(r.accepted, 'device') + (r.refused.length ? '. Skipped ' + r.refused.length + ' you can\'t run scripts on.' : '.'));
                            });
                        }} />`);
                    }}
                    onRun=${function (ids) {
                        ST.ui.attempt(ST.rpc('runScript', { scriptId: item._id, nodeIds: ids })).then(function (r) {
                            if (r == null) return;
                            close(); ST.ui.toast('Queued on ' + plural(r.accepted, 'device') + (r.refused.length ? '. Skipped ' + r.refused.length + ' you can\'t run scripts on.' : '.'));
                        });
                    }} />`);
            },
            openOutput: function (j) { setDialog(html`<${ST.dialogs.Output} job=${j} scriptName=${j.scriptName} deviceName=${nodeName(j.node)} onClose=${close} />`); },
            editVar: function (v, item) {
                setDialog(html`<${ST.dialogs.Variable} variable=${v ? Object.assign({}, v, { scopeTargetName: v.scope == 'script' ? 'Script: ' + scriptName(v.scopeTarget) : null }) : null}
                    scope=${v ? null : 'script'} scopes=${['global', 'script']} targets=${{ script: { id: item._id, name: 'Script: ' + item.name } }} onClose=${close} />`);
            },
            deleteVar: function (v) {
                ST.ui.confirm({ title: 'Delete #' + v.name + '#?', body: html`<p class="mb-0">Scripts that use it will get the next most specific value, or VAR_NOT_FOUND.</p>`, confirmText: 'Delete', danger: true })
                .then(function (ok) { if (ok) ST.ui.attempt(ST.rpc('deleteVar', { id: v._id }), 'Variable deleted.'); });
            }
        };
        var scheduleActions = S.scheduleActions({ setDialog: setDialog, close: close, settings: function () { return state.init.settings; }, deviceName: function (s) { return nodeName(s.node); }, scriptName: scriptName });

        if (document.documentElement.getAttribute('data-st-classic') == '1') {
            return html`<div class="alert alert-info st-classic-notice"><strong>ScriptTask needs the Modern UI.</strong> Switch to it from your account menu.</div>`;
        }
        if (state.error) return html`<div class="alert alert-danger m-3"><${ST.Icon} name="exclamation-triangle-fill" class="me-1" />${state.error}</div>`;
        if (state.init == null) return null;
        if (!state.init.caps.manage) return html`<div class="alert alert-warning m-3"><${ST.Icon} name="lock" class="me-1" />The ScriptTask page is for ScriptTask managers. You can run library scripts from a device's ScriptTask tab.</div>`;

        var section = route[0].section;
        var nav = [['library', 'Library', 'folder2-open'], ['settings', 'Settings', 'gear']];
        return html`<div class="st-shell">
            <nav class="st-sidenav" aria-label="ScriptTask">
                <div class="st-brand"><${ST.Icon} name="file-earmark-code" class="me-2" />ScriptTask</div>
                <ul class="nav nav-pills flex-md-column">
                    ${nav.map(function (n) { return html`<li class="nav-item"><a href=${'#/' + n[0]} class=${'nav-link' + (section == n[0] ? ' active' : '')} aria-current=${section == n[0] ? 'page' : null}
                        onClick=${function (e) { e.preventDefault(); go({ section: n[0], id: null }); }}><${ST.Icon} name=${n[2]} class="me-2" />${n[1]}</a></li>`; })}
                </ul>
                <div class="st-sidenav-foot">Version ${state.init.version}</div>
            </nav>
            <main class="st-main">
                ${section == 'library' ? html`<div class="st-library">
                    <div class="st-lib-tree">
                        <${S.Library} items=${items} selId=${route[0].id} onSelect=${select} collapsed=${collapsed} onToggle=${toggleFolder} manage=${true} actions=${actions} />
                        <input type="file" class="d-none" multiple accept=".ps1,.bat,.cmd,.sh,.bash" ref=${fileInput} onChange=${function (e) { actions.upload(e.target.files, selected ? selected._id : null); e.target.value = ''; }} />
                    </div>
                    <div class="st-lib-detail card">
                        ${state.items == null ? html`<div class="text-center py-5"><${ST.Spinner} /></div>`
                        : selected == null ? html`<div class="st-tab-body"><${ST.Empty} icon="file-earmark-code">Choose a script or folder in the library, or create one.
                            <div class="mt-3"><button class="btn btn-primary" onClick=${actions.newScript}><${ST.Icon} name="file-earmark-plus" class="me-1" />New script</button></div></${ST.Empty}></div>`
                        : selected.type == 'folder' ? html`<${FolderPanel} key=${selected._id} item=${selected} items=${items} actions=${actions} />`
                        : html`<${ScriptWorkspace} key=${selected._id} item=${selected} vars=${state.vars} actions=${actions} scheduleActions=${scheduleActions} onDirty=${function (d) { dirty.current = d; }} />`}
                    </div>
                </div>` : null}
                ${section == 'settings' ? html`<div class="st-settings-page">
                    <h2 class="h4 mb-3">Settings</h2>
                    <div class="card"><div class="card-body">
                        <${ST.SettingsForm} settings=${state.init.settings} onSaved=${function (saved) { patch({ init: Object.assign({}, state.init, { settings: saved }) }); }} />
                    </div></div>
                    <div class="st-section-title mt-4">Script editor</div>
                    <div class="card"><div class="card-body d-flex align-items-center gap-3 flex-wrap">
                        <span class="form-label mb-0">Code theme</span><${ST.EditorThemePicker} />
                        <span class="form-text mt-0">Your choice, saved in this browser. Auto uses a light or dark theme to match MeshCentral.</span>
                    </div></div>
                </div>` : null}
            </main>
            ${dialog}
        </div>`;
    }

    preact.render(html`<${App} />`, document.getElementById('app'));
})();
