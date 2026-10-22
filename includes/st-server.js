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

    // ---- Routing: #/<section>[/<id>][?filters], e.g. #/library/<scriptId> or #/history?status=error&page=2 ----

    var SECTIONS = ['library', 'queue', 'schedules', 'history', 'settings'];
    function parseRoute() {
        var m = /^#\/([a-z]+)(?:\/([^/?#]+))?(?:\?(.*))?$/.exec(location.hash);
        if (m == null || SECTIONS.indexOf(m[1]) === -1) return { section: 'library', id: null, query: {} };
        var query = {};
        if (m[3]) new URLSearchParams(m[3]).forEach(function (v, k) { query[k] = v; });
        return { section: m[1], id: m[2] ? decodeURIComponent(m[2]) : null, query: query };
    }
    function routeHash(r) {
        var q = new URLSearchParams();
        Object.keys(r.query || {}).forEach(function (k) { if (r.query[k] != null && r.query[k] !== '') q.set(k, r.query[k]); });
        var qs = q.toString();
        return '#/' + r.section + (r.id ? '/' + encodeURIComponent(r.id) : '') + (qs ? '?' + qs : '');
    }

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

    // ---- Queue, Schedules and History ----

    var PAGE_SIZE = 50;
    var STATUS_OPTIONS = {
        queue: [['', 'Any status'], ['queued', 'Queued'], ['waiting', 'Waiting for device'], ['scheduled', 'Scheduled'], ['dispatched', 'Running'], ['stale', 'No result yet'], ['missed', 'Missed']],
        schedules: [['', 'Active and paused'], ['active', 'Active'], ['paused', 'Paused']],
        history: [['', 'Any result'], ['complete', 'Completed'], ['error', 'Error'], ['missed', 'Missed'], ['cancelled', 'Cancelled']]
    };
    function dateInput(t) { if (!t) return ''; var d = new Date(t * 1000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    function agentNodes() { return (host.nodes || []).filter(function (n) { return n.mtype == 2; }); }
    function nodeOnline(id) { var n = (host.nodes || []).find(function (x) { return x._id == id; }); return n != null && (n.conn & 1) != 0; }

    // Turn the address's filters into the server's filter object
    function serverFilters(query) {
        var f = {};
        if (query.script) f.scriptId = query.script;
        if (query.device) f.nodeIds = [query.device];
        else if (query.group) f.nodeIds = agentNodes().filter(function (n) { return n.meshid == query.group; }).map(function (n) { return n._id; }).concat(['none']);
        ['status', 'source', 'runBy', 'q'].forEach(function (k) { if (query[k]) f[k] = query[k]; });
        if (query.from) f.from = Math.floor(new Date(query.from + 'T00:00').getTime() / 1000);
        if (query.to) f.to = Math.floor(new Date(query.to + 'T23:59:59').getTime() / 1000);
        return f;
    }

    function FilterBar(props) {
        var q = props.query, kind = props.kind;
        var text = useState({ runBy: q.runBy || '', q: q.q || '' });
        var timer = useRef(null);
        var set = function (k, v) { var n = Object.assign({}, q); n[k] = v; delete n.page; if (k == 'group') delete n.device; props.onChange(n); };
        // Typing waits briefly before searching
        var typed = function (k, v) { text[1](Object.assign({}, text[0], (function () { var o = {}; o[k] = v; return o; })())); clearTimeout(timer.current); timer.current = setTimeout(function () { set(k, v.trim()); }, 400); };
        var scripts = props.items.filter(function (i) { return i.type == 'script'; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
        var nodes = agentNodes().filter(function (n) { return !q.group || n.meshid == q.group; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
        var groups = Object.keys(host.meshes || {}).map(function (k) { return host.meshes[k]; }).filter(function (m) { return m.mtype == 2; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
        var active = Object.keys(q).filter(function (k) { return k != 'page'; }).length > 0;
        return html`<div class="st-filters">
            <select class="form-select form-select-sm" aria-label="Script" value=${q.script || ''} onChange=${function (e) { set('script', e.target.value); }}>
                <option value="">All scripts</option>${scripts.map(function (sc) { return html`<option value=${sc._id}>${sc.name}</option>`; })}
            </select>
            <select class="form-select form-select-sm" aria-label="Device group" value=${q.group || ''} onChange=${function (e) { set('group', e.target.value); }}>
                <option value="">All device groups</option>${groups.map(function (m) { return html`<option value=${m._id}>${m.name}</option>`; })}
            </select>
            <select class="form-select form-select-sm" aria-label="Device" value=${q.device || ''} onChange=${function (e) { set('device', e.target.value); }}>
                <option value="">All devices</option>${nodes.map(function (n) { return html`<option value=${n._id}>${n.name}</option>`; })}
            </select>
            <select class="form-select form-select-sm" aria-label="Status" value=${q.status || ''} onChange=${function (e) { set('status', e.target.value); }}>
                ${STATUS_OPTIONS[kind].map(function (o) { return html`<option value=${o[0]}>${o[1]}</option>`; })}
            </select>
            ${kind != 'schedules' ? html`<select class="form-select form-select-sm" aria-label="Source" value=${q.source || ''} onChange=${function (e) { set('source', e.target.value); }}>
                <option value="">Manual and scheduled</option><option value="manual">Manual runs</option><option value="schedule">Scheduled runs</option>
            </select>` : null}
            <input type="search" class="form-control form-control-sm" placeholder=${kind == 'schedules' ? 'Created by' : 'Run by'} aria-label=${kind == 'schedules' ? 'Created by' : 'Run by'} value=${text[0].runBy} onInput=${function (e) { typed('runBy', e.target.value); }} />
            ${kind == 'history' ? html`
                <input type="search" class="form-control form-control-sm st-filter-wide" placeholder="Search output" aria-label="Search output" value=${text[0].q} onInput=${function (e) { typed('q', e.target.value); }} />
                <label class="st-filter-date">From <input type="date" class="form-control form-control-sm" value=${q.from || ''} onChange=${function (e) { set('from', e.target.value); }} /></label>
                <label class="st-filter-date">To <input type="date" class="form-control form-control-sm" value=${q.to || ''} onChange=${function (e) { set('to', e.target.value); }} /></label>` : null}
            ${active ? html`<button class="btn btn-sm btn-link" onClick=${function () { text[1]({ runBy: '', q: '' }); props.onChange({}); }}>Clear filters</button>` : null}
        </div>`;
    }

    function Pager(props) {
        var page = props.page, pages = Math.max(1, Math.ceil(props.total / PAGE_SIZE));
        if (props.total == 0) return null;
        var from = (page - 1) * PAGE_SIZE + 1, to = Math.min(props.total, page * PAGE_SIZE);
        return html`<div class="st-pager">
            <span>${from}–${to} of ${props.total}</span>
            ${pages > 1 ? html`<div class="btn-group btn-group-sm">
                <button class="btn st-btn-quiet" disabled=${page <= 1} onClick=${function () { props.onPage(page - 1); }} aria-label="Previous page">‹ Previous</button>
                <button class="btn st-btn-quiet" disabled=${page >= pages} onClick=${function () { props.onPage(page + 1); }} aria-label="Next page">Next ›</button>
            </div>` : null}
        </div>`;
    }

    function DeviceCell(props) {
        var n = (host.nodes || []).find(function (x) { return x._id == props.id; });
        return html`<span class="st-device-cell">
            <span class=${'st-dot ' + (nodeOnline(props.id) ? 'st-dot-on' : 'st-dot-off')} title=${nodeOnline(props.id) ? 'Online' : 'Offline'}></span>
            <a href="#" onClick=${function (e) { e.preventDefault(); if (typeof host.gotoDevice == 'function') host.gotoDevice(props.id, 19); }} title="Open this device's page">${nodeName(props.id)}</a>
            ${n ? html`<span class="st-script-path">${meshName(n.meshid)}</span>` : null}
        </span>`;
    }

    // Loads one page of a server-wide list, and reloads it when the server reports changes
    function useServerList(method, query) {
        var st = useState({ loading: true, error: null, total: 0, rows: [] }), state = st[0], set = st[1];
        var page = Math.max(1, Number(query.page) || 1);
        var key = JSON.stringify(query);
        var load = useCallback(function () {
            return ST.rpc(method, { filters: serverFilters(query), skip: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }).then(function (r) {
                set({ loading: false, error: null, total: r.total, rows: r.jobs || r.schedules || [], extra: r });
            }, function (e) { set({ loading: false, error: e.message, total: 0, rows: [] }); });
        }, [method, key]);
        useEffect(function () { set(function (o) { return Object.assign({}, o, { loading: true }); }); load(); }, [load]);
        useEffect(function () {
            var timer = null;
            return ST.onInvalidate(function (m) {
                if (!(m.nodeIds && m.nodeIds.length) && !(m.scriptIds && m.scriptIds.length)) return;
                clearTimeout(timer); timer = setTimeout(load, 600);
            });
        }, [load]);
        return { state: state, page: page, reload: load };
    }

    // Selection of rows by id, kept to rows still on the page
    function useSelection(rows) {
        var sel = useState(new Set()), selected = sel[0];
        var ids = rows.map(function (r) { return r._id; });
        var present = new Set(Array.from(selected).filter(function (id) { return ids.indexOf(id) >= 0; }));
        return {
            ids: present,
            has: function (id) { return present.has(id); },
            toggle: function (id) { var n = new Set(present); if (n.has(id)) n.delete(id); else n.add(id); sel[1](n); },
            all: ids.length > 0 && ids.every(function (id) { return present.has(id); }),
            toggleAll: function () { sel[1](ids.every(function (id) { return present.has(id); }) ? new Set() : new Set(ids)); },
            clear: function () { sel[1](new Set()); }
        };
    }

    function ListFrame(props) {
        return html`<div class="st-list-page">
            <div class="st-list-head"><h2 class="h4 mb-0">${props.title}</h2><span class="text-body-secondary small">${props.subtitle}</span></div>
            <${FilterBar} kind=${props.kind} query=${props.query} items=${props.items} onChange=${props.onQuery} />
            ${props.bulk}
            <div class="card"><div class="card-body p-0">
                ${props.state.error ? html`<div class="alert alert-danger m-3">${props.state.error}</div>`
                : props.state.loading && props.state.rows.length == 0 ? html`<div class="text-center py-5"><${ST.Spinner} /></div>`
                : props.state.rows.length == 0 ? html`<${ST.Empty} icon=${props.emptyIcon}>${props.empty}</${ST.Empty}>`
                : props.children}
            </div></div>
            <${Pager} total=${props.state.total} page=${props.page} onPage=${function (pg) { props.onQuery(Object.assign({}, props.query, { page: pg })); }} />
        </div>`;
    }

    function BulkBar(props) {
        if (props.count == 0) return null;
        return html`<div class="st-bulk" role="region" aria-label="Selected items">
            <strong>${props.count} selected</strong>
            ${props.children}
            <button class="btn btn-sm btn-link" onClick=${props.onClear}>Clear selection</button>
        </div>`;
    }
    function bulkResult(r, verb) {
        ST.ui.toast(verb + ' ' + plural(r.done, 'item') + (r.skipped ? '. Skipped ' + r.skipped + ' that had changed or that you can\'t see.' : '.'));
    }

    function QueueSection(props) {
        var list = useServerList('queue', props.query), state = list.state;
        var sel = useSelection(state.rows);
        var stale = state.extra ? state.extra.staleSeconds : 1800;
        var rows = state.rows;
        var runnable = rows.filter(function (j) { return sel.has(j._id) && j.dispatchTime == null; }).length;
        var cancel = function (ids) {
            ST.ui.confirm({ title: 'Cancel ' + plural(ids.length, 'run') + '?', body: 'They won\'t run. Runs from schedules skip this occurrence; the schedules carry on. Runs already sent to a device may still finish there.', confirmText: 'Cancel runs', danger: true })
            .then(function (ok) { if (ok) ST.ui.attempt(ST.rpc('cancelJobs', { jobIds: ids })).then(function (r) { if (r) { bulkResult(r, 'Cancelled'); sel.clear(); list.reload(); } }); });
        };
        var runNow = function (ids) { ST.ui.attempt(ST.rpc('runJobsNow', { jobIds: ids })).then(function (r) { if (r) { bulkResult(r, 'Started'); sel.clear(); list.reload(); } }); };
        return html`<${ListFrame} kind="queue" title="Queue" subtitle="Runs waiting, scheduled or in progress on every device you can see" query=${props.query} items=${props.items} onQuery=${props.onQuery}
            state=${state} page=${list.page} empty="Nothing is queued." emptyIcon="list-task"
            bulk=${html`<${BulkBar} count=${sel.ids.size} onClear=${sel.clear}>
                <button class="btn btn-sm btn-primary" disabled=${runnable == 0} onClick=${function () { runNow(Array.from(sel.ids)); }}><${ST.Icon} name="play-fill" class="me-1" />Run now</button>
                <button class="btn btn-sm btn-outline-danger" onClick=${function () { cancel(Array.from(sel.ids)); }}><${ST.Icon} name="x-lg" class="me-1" />Cancel</button>
            </${BulkBar}>`}>
            <div class="table-responsive"><table class="table table-sm table-hover st-table mb-0">
                <thead><tr>
                    <th class="st-col-check"><input class="form-check-input" type="checkbox" aria-label="Select all on this page" checked=${sel.all} onChange=${sel.toggleAll} /></th>
                    <th>Script</th><th>Device</th><th>Status</th><th>When</th><th>Run by</th><th class="st-col-actions"><span class="visually-hidden">Actions</span></th>
                </tr></thead>
                <tbody>${rows.map(function (j) {
                    var status = j.state == 'stale' ? 'stale' : j.state;
                    return html`<tr key=${j._id} class=${sel.has(j._id) ? 'table-active' : ''}>
                        <td class="st-col-check"><input class="form-check-input" type="checkbox" aria-label=${'Select ' + j.scriptName} checked=${sel.has(j._id)} onChange=${function () { sel.toggle(j._id); }} /></td>
                        <td>${j.scriptName}</td>
                        <td><${DeviceCell} id=${j.node} /></td>
                        <td><${ST.StatusBadge} status=${status} title=${status == 'stale' ? 'Sent over ' + ST.fmt.span(stale) + ' ago without a result. The device may have restarted, or the script is still running.' : null} /></td>
                        <td class="text-nowrap">${j.dispatchTime ? html`Sent <${ST.Time} t=${j.dispatchTime} />`
                            : (j.dontQueueUntil > ST.now()) ? html`Due <${ST.Time} t=${j.dontQueueUntil} />` : html`Queued <${ST.Time} t=${j.queueTime} />`}
                            ${(j.expiresAt != null && j.dispatchTime == null && j.expiresAt > ST.now()) ? html`<div class="text-body-secondary small">Skipped if not sent by ${ST.fmt.time(j.expiresAt)}</div>` : null}</td>
                        <td>${j.runBy}${j.jobSchedule ? html` <span class="text-body-secondary small">(schedule)</span>` : null}</td>
                        <td class="st-col-actions"><div class="btn-group btn-group-sm">
                            ${j.dispatchTime == null ? html`<button class="btn st-btn-quiet" title="Run now" onClick=${function () { runNow([j._id]); }}><${ST.Icon} name="play-fill" /><span class="visually-hidden">Run now</span></button>` : null}
                            <button class="btn btn-outline-danger" title="Cancel this run" onClick=${function () { cancel([j._id]); }}><${ST.Icon} name="x-lg" /><span class="visually-hidden">Cancel</span></button>
                        </div></td>
                    </tr>`; })}</tbody>
            </table></div>
        </${ListFrame}>`;
    }

    function SchedulesSection(props) {
        var list = useServerList('schedules', props.query), state = list.state;
        var sel = useSelection(state.rows);
        var a = props.scheduleActions;
        var bulk = function (action) {
            var ids = Array.from(sel.ids);
            var go = function () { ST.ui.attempt(ST.rpc('scheduleAction', { scheduleIds: ids, action: action })).then(function (r) { if (r) { bulkResult(r, action == 'delete' ? 'Deleted' : action == 'pause' ? 'Paused' : 'Resumed'); sel.clear(); list.reload(); } }); };
            if (action != 'delete') { go(); return; }
            ST.ui.confirm({ title: 'Delete ' + plural(ids.length, 'schedule') + '?', body: 'They stop running, and their pending runs are cancelled. Past runs stay in history.', confirmText: 'Delete schedules', danger: true }).then(function (ok) { if (ok) go(); });
        };
        var runNow = function (s) { ST.ui.attempt(ST.rpc('runScript', { scriptId: s.scriptId, nodeIds: [s.node] }), props.scriptName(s.scriptId) + ' queued on ' + nodeName(s.node) + '. The schedule is unchanged.'); };
        return html`<${ListFrame} kind="schedules" title="Schedules" subtitle="Every schedule on the devices you can see, soonest first" query=${props.query} items=${props.items} onQuery=${props.onQuery}
            state=${state} page=${list.page} empty="No schedules." emptyIcon="clock"
            bulk=${html`<${BulkBar} count=${sel.ids.size} onClear=${sel.clear}>
                <button class="btn btn-sm st-btn-quiet" onClick=${function () { bulk('pause'); }}><${ST.Icon} name="pause-fill" class="me-1" />Pause</button>
                <button class="btn btn-sm st-btn-quiet" onClick=${function () { bulk('resume'); }}><${ST.Icon} name="play-fill" class="me-1" />Resume</button>
                <button class="btn btn-sm btn-outline-danger" onClick=${function () { bulk('delete'); }}><${ST.Icon} name="trash3" class="me-1" />Delete</button>
            </${BulkBar}>`}>
            <div class="table-responsive"><table class="table table-sm table-hover st-table mb-0">
                <thead><tr>
                    <th class="st-col-check"><input class="form-check-input" type="checkbox" aria-label="Select all on this page" checked=${sel.all} onChange=${sel.toggleAll} /></th>
                    <th>Script</th><th>Device</th><th>Repeat</th><th>Next run</th><th>Last run</th><th>Created by</th><th class="st-col-actions"><span class="visually-hidden">Actions</span></th>
                </tr></thead>
                <tbody>${state.rows.map(function (s) { return html`<tr key=${s._id} class=${sel.has(s._id) ? 'table-active' : ''}>
                    <td class="st-col-check"><input class="form-check-input" type="checkbox" aria-label=${'Select ' + props.scriptName(s.scriptId)} checked=${sel.has(s._id)} onChange=${function () { sel.toggle(s._id); }} /></td>
                    <td>${props.scriptName(s.scriptId)}</td>
                    <td><${DeviceCell} id=${s.node} /></td>
                    <td>${ST.fmt.recurrence(s)}${ST.fmt.zoneNote(s) ? ' (' + ST.fmt.zoneNote(s) + ')' : ''}<div class="text-body-secondary small">${ST.fmt.policy(s)}${s.endAt ? ', until ' + ST.fmt.time(s.endAt) : ''}</div></td>
                    <td>${s.paused ? html`<${ST.StatusBadge} status="paused" />` : html`<${ST.Time} t=${s.nextRun} empty="Not scheduled" />`}</td>
                    <td><${ST.Time} t=${s.lastRun} empty="Never" /></td>
                    <td>${s.scheduledBy}</td>
                    <td class="st-col-actions"><div class="btn-group btn-group-sm">
                        <button class="btn st-btn-quiet" title="Edit this schedule" onClick=${function () { a.editSchedule(s); }}><${ST.Icon} name="pencil" /><span class="visually-hidden">Edit</span></button>
                        <button class="btn st-btn-quiet" title="Run now, without changing the schedule" onClick=${function () { runNow(s); }}><${ST.Icon} name="send" /><span class="visually-hidden">Run now</span></button>
                        <button class="btn st-btn-quiet" title=${s.paused ? 'Resume this schedule' : 'Pause this schedule'} onClick=${function () { a.pauseSchedule(s, !s.paused); }}><${ST.Icon} name=${s.paused ? 'play-fill' : 'pause-fill'} /><span class="visually-hidden">${s.paused ? 'Resume' : 'Pause'}</span></button>
                        <button class="btn btn-outline-danger" title="Delete this schedule" onClick=${function () { a.deleteSchedule(s); }}><${ST.Icon} name="trash3" /><span class="visually-hidden">Delete</span></button>
                    </div></td>
                </tr>`; })}</tbody>
            </table></div>
        </${ListFrame}>`;
    }

    function HistorySection(props) {
        var list = useServerList('history', props.query), state = list.state;
        var open = function (j) {
            ST.rpc('job', { id: j._id }).then(function (full) { props.openOutput(full); }, function (e) { ST.ui.toast(e.message, 'error'); });
        };
        return html`<${ListFrame} kind="history" title="History" subtitle="Finished, missed and cancelled runs on every device you can see, newest first" query=${props.query} items=${props.items} onQuery=${props.onQuery}
            state=${state} page=${list.page} empty="No runs match." emptyIcon="clock-history">
            <div class="table-responsive"><table class="table table-sm table-hover st-table mb-0">
                <thead><tr><th>Finished</th><th>Script</th><th>Device</th><th>Status</th><th>Took</th><th>Run by</th><th>Output</th></tr></thead>
                <tbody>${state.rows.map(function (j) { var out = ST.jobOutput(j); return html`<tr key=${j._id} class="st-clickable" tabindex="0" onClick=${function (e) { if (e.target.closest('a')) return; open(j); }} onKeyDown=${function (e) { if (e.key == 'Enter') open(j); }}>
                    <td class="text-nowrap"><${ST.Time} t=${j.completeTime} /></td>
                    <td class="text-nowrap">${j.scriptName}</td>
                    <td><${DeviceCell} id=${j.node} /></td>
                    <td><${ST.StatusBadge} status=${ST.jobStatus(j, true)} /></td>
                    <td class="text-nowrap">${(j.completeTime && j.dispatchTime && !j.missed) ? ST.fmt.duration(j.completeTime - j.dispatchTime) : ''}</td>
                    <td>${j.runBy}${j.jobSchedule ? html` <span class="text-body-secondary small">(schedule)</span>` : null}</td>
                    <td><div class="st-output-preview">${out ? out.split('\n')[0] : html`<span class="text-body-tertiary">No output</span>`}</div></td>
                </tr>`; })}</tbody>
            </table></div>
        </${ListFrame}>`;
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
        var nav = [['library', 'Library', 'folder2-open'], ['queue', 'Queue', 'list-task'], ['schedules', 'Schedules', 'clock'], ['history', 'History', 'clock-history'], ['settings', 'Settings', 'gear']];
        var setQuery = function (q) { go({ section: section, id: null, query: q }); };
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
                ${section == 'queue' ? html`<${QueueSection} query=${route[0].query} items=${items} onQuery=${setQuery} />` : null}
                ${section == 'schedules' ? html`<${SchedulesSection} query=${route[0].query} items=${items} onQuery=${setQuery} scheduleActions=${scheduleActions} scriptName=${scriptName} />` : null}
                ${section == 'history' ? html`<${HistorySection} query=${route[0].query} items=${items} onQuery=${setQuery} openOutput=${actions.openOutput} />` : null}
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
