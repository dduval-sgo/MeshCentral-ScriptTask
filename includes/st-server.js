/**
* @description ScriptTask page (My Server > Plugins > ScriptTask): the script library with a code editor, each script's
* schedules, history and variables across devices, and plugin settings. For ScriptTask managers.
* Requires st-core.js, st-dialogs.js, st-editor.js and st-shared.js.
* @author Desmond Duval
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

    var SECTIONS = ['overview', 'library', 'run', 'variables', 'batches', 'batch', 'queue', 'schedules', 'history', 'settings'];
    function parseRoute() {
        var m = /^#\/([a-z]+)(?:\/([^/?#]+))?(?:\?(.*))?$/.exec(location.hash);
        if (m == null || SECTIONS.indexOf(m[1]) === -1) return { section: 'overview', id: null, query: {} };
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
                var defaults = props.settings || {};
                var fallback = { ps1: defaults.indentPs1, bat: defaults.indentBat, bash: defaults.indentBash }[sc.filetype] || (sc.filetype == 'bash' ? '2' : '4');
                ST.editor.load().then(function (E) { indent[1](E.detectIndent(lf, fallback)); }, function () { });
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
            var s = varSummary(vars, n, item._id), rows = [];
            var shown = function (v) { return v.secret ? '(secret)' : v.value; };
            if (s.script) rows.push('This script: ' + shown(s.script));
            if (s.global) rows.push('Global: ' + shown(s.global));
            if (s.mesh) rows.push('Overridden in ' + plural(s.mesh, 'device group'));
            if (s.node) rows.push('Overridden on ' + plural(s.node, 'device'));
            // Built-ins are the least specific value: any variable with the same name replaces them
            if (BUILT_INS[n]) rows.push(rows.length ? 'These replace the built-in value (' + BUILT_INS[n].toLowerCase() + ').' : 'Built in: ' + BUILT_INS[n] + '.');
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
                    var s = varSummary(props.vars, n, item._id), undefinedVar = !s.script && !s.global && !s.mesh && !s.node;
                    if (BUILT_INS[n] && undefinedVar) return html`<tr key=${n}><td><code>#${n}#</code></td><td colspan="3" class="text-body-secondary">Built in: ${BUILT_INS[n]}</td></tr>`;
                    return html`<tr key=${n}>
                        <td><code>#${n}#</code>${undefinedVar ? html`<div class="small text-warning-emphasis"><${ST.Icon} name="exclamation-triangle-fill" class="me-1" />Not defined. Runs as VAR_NOT_FOUND.</div>` : null}
                            ${BUILT_INS[n] ? html`<div class="small text-body-secondary">Replaces the built-in value</div>` : null}</td>
                        <td>${s.script ? html`<${S.VarValue} variable=${s.script} />` : html`<span class="text-body-tertiary">—</span>`}</td>
                        <td>${s.global ? html`<${S.VarValue} variable=${s.global} />` : html`<span class="text-body-tertiary">—</span>`}</td>
                        <td class="small">${[s.mesh ? plural(s.mesh, 'device group') : '', s.node ? plural(s.node, 'device') : ''].filter(Boolean).join(', ') || html`<span class="text-body-tertiary">None</span>`}</td>
                    </tr>`; })}</tbody>
            </table></div>
            <div class="form-text">Device group and device values are set in <a href="#/variables">Variables</a> or on a device's ScriptTask tab. The most specific value wins: device, then group, then script, then global, then built-in.</div>`}
            <div class="st-section-title d-flex align-items-center">Script variables
                <button class="btn btn-sm st-btn-quiet ms-auto" onClick=${function () { a.editVar(null, item); }}><${ST.Icon} name="plus-lg" class="me-1" />New variable</button></div>
            ${props.scriptVars.length == 0 ? html`<${ST.Empty}>No variables are set for this script only.</${ST.Empty}>` : html`
            <div class="table-responsive"><table class="table table-sm st-table">
                <thead><tr><th>Name</th><th>Value</th><th class="st-col-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
                <tbody>${props.scriptVars.map(function (v) { return html`<tr key=${v._id}>
                    <td><code>#${v.name}#</code></td><td><${S.VarValue} variable=${v} /></td>
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

    var PAGE_SIZE = 50; // From Settings, set when the page loads and when settings change
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
        if (query.batch) f.batchId = query.batch;
        if (query.from) f.from = Math.floor(new Date(query.from + 'T00:00').getTime() / 1000);
        if (query.to) f.to = Math.floor(new Date(query.to + 'T23:59:59').getTime() / 1000);
        if (Number(query.since) > 0) f.from = ST.now() - Number(query.since);
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
            ${q.since ? html`<span class="badge st-badge-outline st-filter-chip"><${ST.Icon} name="clock-history" class="me-1" />Last ${Number(q.since) == 86400 ? '24 hours' : ST.fmt.span(Number(q.since))}
                <button type="button" class="btn-close" aria-label="Any time" onClick=${function () { set('since', ''); }}></button></span>` : null}
            ${q.batch ? html`<span class="badge st-badge-outline st-filter-chip"><${ST.Icon} name="collection" class="me-1" /><a href=${'#/batch/' + encodeURIComponent(q.batch)}>One batch</a>
                <button type="button" class="btn-close" aria-label="Show all batches" onClick=${function () { set('batch', ''); }}></button></span>` : null}
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

    function BatchLink(props) {
        if (!props.id) return null;
        return html`<a href=${'#/batch/' + encodeURIComponent(props.id)} class="st-batch-link" title="Part of a batch. Open its results."><${ST.Icon} name="collection" /><span class="visually-hidden">Open batch</span></a>`;
    }
    function DeviceCell(props) {
        var n = (host.nodes || []).find(function (x) { return x._id == props.id; });
        return html`<span class="st-device-cell">
            <span class=${'st-dot ' + (nodeOnline(props.id) ? 'st-dot-on' : 'st-dot-off')} title=${nodeOnline(props.id) ? 'Online' : 'Offline'}></span>
            <a href="#" onClick=${function (e) { e.preventDefault(); if (typeof host.gotoDevice == 'function') host.gotoDevice(props.id, 19); }} title="Open this device's page">${nodeName(props.id)}</a>
            ${n && !props.compact ? html`<span class="st-script-path">${meshName(n.meshid)}</span>` : null}
        </span>`;
    }

    // Loads one page of a server-wide list, and reloads it when the server reports changes
    function useServerList(method, query) {
        var st = useState({ loading: true, error: null, total: 0, rows: [] }), state = st[0], set = st[1];
        var page = Math.max(1, Number(query.page) || 1);
        var key = JSON.stringify(query) + PAGE_SIZE;
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
                        <td>${j.scriptName}<${BatchLink} id=${j.batchId} /></td>
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
                    <td>${props.scriptName(s.scriptId)}<${BatchLink} id=${s.batchId} /></td>
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
                    <td class="text-nowrap">${j.scriptName}<${BatchLink} id=${j.batchId} /></td>
                    <td><${DeviceCell} id=${j.node} /></td>
                    <td><${ST.StatusBadge} status=${ST.jobStatus(j, true)} /></td>
                    <td class="text-nowrap">${(j.completeTime && j.dispatchTime && !j.missed) ? ST.fmt.duration(j.completeTime - j.dispatchTime) : ''}</td>
                    <td>${j.runBy}${j.jobSchedule ? html` <span class="text-body-secondary small">(schedule)</span>` : null}</td>
                    <td><div class="st-output-preview">${out ? out.split('\n')[0] : html`<span class="text-body-tertiary">No output</span>`}</div></td>
                </tr>`; })}</tbody>
            </table></div>
        </${ListFrame}>`;
    }

    // ---- Run on several devices ----

    var OS_LABEL = { win: 'Windows', other: 'Linux / macOS', unknown: 'Unknown' };
    function osOf(n) { var w = S.isWindows(n); return w === null ? 'unknown' : (w ? 'win' : 'other'); }
    var DEVICE_ROWS = 200;

    // Choose a script and devices, then run now or schedule. Runs on more than one device become a batch.
    function RunSection(props) {
        var q = props.query;
        var sid = useState(q.script || ''), scriptId = sid[0];
        var favKey = 'favourites.' + props.userId;
        var fav = useState(store(favKey) || []);
        var sel = useState(function () { return new Set(q.devices ? q.devices.split(',') : []); }), selected = sel[0];
        var f = useState({ text: '', group: '', tag: '', os: '', conn: '' }), filt = f[0];
        var batchName = useState('');
        var sets = useState([]), setId = useState('');
        var limit = useState(DEVICE_ROWS);
        useEffect(function () { ST.rpc('targetSets').then(sets[1], function () { }); }, []);

        var item = props.items.find(function (i) { return i._id == scriptId && i.type == 'script'; }) || null;
        var nodes = useMemo(function () {
            return agentNodes().map(function (n) { return { _id: n._id, name: n.name, meshid: n.meshid, tags: n.tags || [], os: osOf(n), online: (n.conn & 1) != 0, node: n }; })
                .sort(function (a, b) { return a.name.localeCompare(b.name); });
        }, []);
        var groups = useMemo(function () { var m = {}; nodes.forEach(function (n) { m[n.meshid] = meshName(n.meshid); }); return Object.keys(m).map(function (k) { return [k, m[k]]; }).sort(function (a, b) { return a[1].localeCompare(b[1]); }); }, [nodes]);
        var tags = useMemo(function () { var t = {}; nodes.forEach(function (n) { n.tags.forEach(function (x) { t[x] = 1; }); }); return Object.keys(t).sort(); }, [nodes]);
        var blockedReason = function (n) { if (item == null) return null; var c = S.compatibility(item.filetype, S.isWindows(n.node)); return (c && c.block) ? c.msg : null; };
        var text = filt.text.trim().toLowerCase();
        var shown = nodes.filter(function (n) {
            if (text && n.name.toLowerCase().indexOf(text) < 0) return false;
            if (filt.group && n.meshid != filt.group) return false;
            if (filt.tag && n.tags.indexOf(filt.tag) < 0) return false;
            if (filt.os && n.os != filt.os) return false;
            if (filt.conn == 'online' && !n.online) return false;
            if (filt.conn == 'offline' && n.online) return false;
            if (filt.conn == 'selected' && !selected.has(n._id)) return false;
            return true;
        });
        var choosable = shown.filter(function (n) { return !blockedReason(n); });
        var allShown = choosable.length > 0 && choosable.every(function (n) { return selected.has(n._id); });
        var setFilter = function (k, v) { var o = Object.assign({}, filt); o[k] = v; f[1](o); limit[1](DEVICE_ROWS); };
        var setSelection = function (s) { sel[1](s); setId[1](''); };
        var toggle = function (id) { var n = new Set(selected); if (n.has(id)) n.delete(id); else n.add(id); setSelection(n); };
        var toggleShown = function () { var n = new Set(selected); choosable.forEach(function (x) { if (allShown) n.delete(x._id); else n.add(x._id); }); setSelection(n); };
        // Selected devices that exist here, and those of them the chosen script can run on
        var picked = nodes.filter(function (n) { return selected.has(n._id); });
        var targets = picked.filter(function (n) { return !blockedReason(n); }).map(function (n) { return n._id; });
        var skipped = picked.length - targets.length;
        var offline = picked.filter(function (n) { return !n.online && !blockedReason(n); }).length;

        var chooseScript = function (id) { sid[1](id); history.replaceState(null, '', routeHash({ section: 'run', query: { script: id } })); };
        var toggleFav = function (id) { var next = (fav[0].indexOf(id) >= 0) ? fav[0].filter(function (x) { return x != id; }) : fav[0].concat([id]); fav[1](next); store(favKey, next); };
        var loadSet = function (id) {
            var t = sets[0].find(function (x) { return x._id == id; });
            if (t == null) { setId[1](''); return; }
            sel[1](new Set(t.nodeIds)); setId[1](id);
            var gone = t.nodeIds.filter(function (n) { return !nodes.some(function (x) { return x._id == n; }); }).length;
            if (gone) ST.ui.toast(plural(gone, 'device') + ' in this set no longer exist or you can\'t see them.');
        };
        var saveSet = function () {
            var current = sets[0].find(function (x) { return x._id == setId[0]; });
            ST.ui.prompt({ title: 'Save selected devices', label: 'Name for this set of ' + plural(picked.length, 'device'), value: current ? current.name : '', confirmText: 'Save' }).then(function (name) {
                if (!name) return;
                ST.ui.attempt(ST.rpc('saveTargetSet', { name: name, nodeIds: picked.map(function (n) { return n._id; }) }), 'Saved ' + name + '.').then(function (list) {
                    if (list) { sets[1](list); var t = list.find(function (x) { return x.name == name.trim(); }); setId[1](t ? t._id : ''); }
                });
            });
        };
        var deleteSet = function () {
            var t = sets[0].find(function (x) { return x._id == setId[0]; });
            if (t) ST.ui.confirm({ title: 'Delete ' + t.name + '?', body: 'The saved set is deleted. Devices and runs are not affected.', confirmText: 'Delete', danger: true }).then(function (ok) {
                if (ok) ST.ui.attempt(ST.rpc('deleteTargetSet', { id: t._id })).then(function (list) { if (list) { sets[1](list); setId[1](''); } });
            });
        };
        var done = function (r, verb) {
            var note = r.refused.length ? ' Skipped ' + plural(r.refused.length, 'device') + ' you can\'t run scripts on.' : '';
            if (r.batchId) { ST.ui.toast(verb + ' on ' + plural(r.accepted, 'device') + '.' + note); props.go({ section: 'batch', id: r.batchId }); }
            else ST.ui.toast(r.accepted ? verb + ' on ' + nodeName(targets[0]) + '.' + note : 'You can\'t run scripts on that device.', r.accepted ? undefined : 'error');
        };
        var runNow = function () {
            ST.ui.attempt(ST.rpc('runScript', { scriptId: item._id, nodeIds: targets, name: batchName[0] || undefined })).then(function (r) { if (r) done(r, 'Queued'); });
        };
        var schedule = function () {
            props.setDialog(html`<${ST.dialogs.Schedule} title=${'Schedule ' + item.name} subtitle=${'On ' + plural(targets.length, 'device')} settings=${props.settings} onClose=${props.close} onSubmit=${function (sc) {
                return ST.rpc('addSchedule', { scriptId: item._id, nodeIds: targets, schedule: sc, name: batchName[0] || undefined }).then(function (r) { props.close(); done(r, 'Scheduled'); });
            }} />`);
        };

        return html`<div class="st-list-page st-run-page">
            <div class="st-list-head"><h2 class="h4 mb-0">Run</h2><span class="text-body-secondary small">Run or schedule a library script on several devices. Results are collected as a batch.</span></div>
            <div class="card"><div class="card-body">
                <label class="form-label st-section-title" for="st-run-script">Script</label>
                <${S.ScriptPicker} id="st-run-script-list" items=${props.items} value=${scriptId} onChange=${chooseScript} favourites=${fav[0]} onToggleFav=${toggleFav} />
                ${item ? html`<div class="st-script-head mt-2">
                    <span class="st-type" title=${ST.fmt.filetype(item.filetype)}>${item.filetype}</span><span class="st-script-path">${item.path}</span>
                    <a href=${'#/library/' + encodeURIComponent(item._id)} class="ms-auto small" onClick=${function (e) { e.preventDefault(); props.go({ section: 'library', id: item._id }); }}>Open in library</a>
                </div>` : null}
            </div></div>

            <div class="card">
                <div class="card-header st-run-devices-head">
                    <span><${ST.Icon} name="collection" class="me-1" />Devices</span>
                    <div class="st-run-sets">
                        <select class="form-select form-select-sm" aria-label="Saved device sets" value=${setId[0]} onChange=${function (e) { loadSet(e.target.value); }}>
                            <option value="">${sets[0].length ? 'Saved sets…' : 'No saved sets'}</option>
                            ${sets[0].map(function (t) { return html`<option value=${t._id}>${t.name} (${t.nodeIds.length})</option>`; })}
                        </select>
                        <button class="btn btn-sm st-btn-quiet text-nowrap" disabled=${picked.length == 0} onClick=${saveSet} title="Save the selected devices as a named set"><${ST.Icon} name="bookmark-plus" class="me-1" />Save set</button>
                        ${setId[0] ? html`<button class="btn btn-sm btn-outline-danger" onClick=${deleteSet} title="Delete this saved set"><${ST.Icon} name="trash3" /><span class="visually-hidden">Delete set</span></button>` : null}
                    </div>
                </div>
                <div class="card-body pb-2">
                    <div class="st-filters mb-2">
                        <input type="search" class="form-control form-control-sm" placeholder="Search devices" aria-label="Search devices" value=${filt.text} onInput=${function (e) { setFilter('text', e.target.value); }} />
                        <select class="form-select form-select-sm" aria-label="Device group" value=${filt.group} onChange=${function (e) { setFilter('group', e.target.value); }}>
                            <option value="">All device groups</option>${groups.map(function (g) { return html`<option value=${g[0]}>${g[1]}</option>`; })}
                        </select>
                        ${tags.length ? html`<select class="form-select form-select-sm" aria-label="Tag" value=${filt.tag} onChange=${function (e) { setFilter('tag', e.target.value); }}>
                            <option value="">All tags</option>${tags.map(function (t) { return html`<option value=${t}>${t}</option>`; })}
                        </select>` : null}
                        <select class="form-select form-select-sm" aria-label="Operating system" value=${filt.os} onChange=${function (e) { setFilter('os', e.target.value); }}>
                            <option value="">Any OS</option><option value="win">Windows</option><option value="other">Linux / macOS</option>
                        </select>
                        <select class="form-select form-select-sm" aria-label="Show" value=${filt.conn} onChange=${function (e) { setFilter('conn', e.target.value); }}>
                            <option value="">Online and offline</option><option value="online">Online</option><option value="offline">Offline</option><option value="selected">Selected only</option>
                        </select>
                    </div>
                </div>
                ${nodes.length == 0 ? html`<${ST.Empty} icon="collection">You don't have any devices with an agent.</${ST.Empty}>` : html`
                <div class="table-responsive st-run-table"><table class="table table-sm table-hover st-table mb-0">
                    <thead><tr>
                        <th class="st-col-check"><input class="form-check-input" type="checkbox" aria-label="Select all shown" checked=${allShown} disabled=${choosable.length == 0} onChange=${toggleShown} /></th>
                        <th>Device</th><th>Group</th><th>OS</th><th>Tags</th>
                    </tr></thead>
                    <tbody>${shown.length == 0 ? html`<tr><td colspan="5" class="text-center text-body-secondary py-3">No devices match.</td></tr>` : shown.slice(0, limit[0]).map(function (n) {
                        var why = blockedReason(n);
                        return html`<tr key=${n._id} class=${(selected.has(n._id) ? 'table-active' : '') + (why ? ' st-row-blocked' : '')} title=${why || ''}>
                            <td class="st-col-check"><input class="form-check-input" type="checkbox" aria-label=${'Select ' + n.name} checked=${selected.has(n._id)} disabled=${why && !selected.has(n._id)} onChange=${function () { toggle(n._id); }} /></td>
                            <td><span class=${'st-dot me-2 ' + (n.online ? 'st-dot-on' : 'st-dot-off')} title=${n.online ? 'Online' : 'Offline'}></span>${n.name}${why ? html`<div class="st-combo-reason">${why}</div>` : null}</td>
                            <td class="text-body-secondary">${meshName(n.meshid)}</td>
                            <td class="text-nowrap">${OS_LABEL[n.os]}</td>
                            <td>${n.tags.map(function (t) { return html`<span class="badge st-badge-outline me-1">${t}</span>`; })}</td>
                        </tr>`; })}</tbody>
                </table></div>
                ${shown.length > limit[0] ? html`<div class="px-3 py-2"><button class="btn btn-sm btn-link" onClick=${function () { limit[1](shown.length); }}>Show all ${shown.length} devices</button></div>` : null}`}
            </div>

            <div class="st-run-bar card">
                <div class="card-body">
                    <div class="st-run-summary">
                        <strong>${plural(picked.length, 'device')} selected</strong>
                        ${picked.length ? html`<button class="btn btn-sm btn-link p-0" onClick=${function () { setSelection(new Set()); }}>Clear</button>` : null}
                        ${skipped ? html`<div class="text-warning-emphasis small"><${ST.Icon} name="exclamation-triangle-fill" class="me-1" />${plural(skipped, 'device')} can't run ${ST.fmt.filetype(item.filetype)} scripts and will be skipped.</div>` : null}
                        ${offline ? html`<div class="text-body-secondary small"><${ST.Icon} name="wifi-off" class="me-1" />${plural(offline, 'device')} offline: runs wait until they connect.</div>` : null}
                    </div>
                    <div class="st-run-submit">
                    <input class="form-control form-control-sm st-run-name" placeholder="Batch name (optional)" aria-label="Batch name" maxlength="120" value=${batchName[0]} onInput=${function (e) { batchName[1](e.target.value); }} />
                    <button class="btn st-btn-quiet" disabled=${item == null || targets.length == 0} onClick=${schedule}><${ST.Icon} name="calendar-plus" class="me-1" />Schedule…</button>
                    <button class="btn btn-primary" disabled=${item == null || targets.length == 0} onClick=${runNow}><${ST.Icon} name="play-fill" class="me-1" />Run now${targets.length > 1 ? ' on ' + targets.length : ''}</button>
                    </div>
                </div>
            </div>
        </div>`;
    }

    // ---- Batches ----

    var STATE_ORDER = ['complete', 'error', 'missed', 'cancelled', 'none', 'stale', 'dispatched', 'queued', 'waiting', 'scheduled'];
    var BAR_CLASS = { complete: 'bg-success', error: 'bg-danger', missed: 'bg-warning', stale: 'bg-warning', cancelled: 'bg-secondary', none: 'bg-secondary', dispatched: 'bg-info', queued: 'st-bar-pending', waiting: 'st-bar-pending', scheduled: 'st-bar-pending' };
    var RERUN_STATES = ['error', 'missed', 'cancelled', 'none'];

    // A stacked bar and legend of run states
    function StateBar(props) {
        var c = props.counts || {}, total = STATE_ORDER.reduce(function (t, k) { return t + (c[k] || 0); }, 0);
        if (total == 0) return html`<span class="text-body-secondary small">No runs</span>`;
        var parts = STATE_ORDER.filter(function (k) { return c[k]; });
        return html`<div class="st-statebar">
            <div class="progress-stacked" role="img" aria-label=${parts.map(function (k) { return c[k] + ' ' + ST.STATUS[k].label.toLowerCase(); }).join(', ')}>
                ${parts.map(function (k) { return html`<div class="progress" style=${'width:' + (100 * c[k] / total) + '%'}><div class=${'progress-bar ' + BAR_CLASS[k]}></div></div>`; })}
            </div>
            ${props.legend === false ? null : html`<div class="st-statebar-legend">${parts.map(function (k) { return html`<span><span class=${'st-swatch ' + BAR_CLASS[k]}></span>${c[k]} ${ST.STATUS[k].label.toLowerCase()}</span>`; })}</div>`}
        </div>`;
    }

    function batchTitle(b) { return b.name || b.scriptName; }

    function BatchesSection(props) {
        var page = Math.max(1, Number(props.query.page) || 1);
        var st = useState({ loading: true, error: null, total: 0, rows: [] }), state = st[0], set = st[1];
        var load = useCallback(function () {
            return ST.rpc('batches', { skip: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }).then(function (r) { set({ loading: false, error: null, total: r.total, rows: r.batches }); }, function (e) { set({ loading: false, error: e.message, total: 0, rows: [] }); });
        }, [page, PAGE_SIZE]);
        useEffect(function () { load(); }, [load]);
        useEffect(function () { var timer = null; return ST.onInvalidate(function (m) { if ((m.nodeIds && m.nodeIds.length) || (m.scriptIds && m.scriptIds.length)) { clearTimeout(timer); timer = setTimeout(load, 600); } }); }, [load]);
        var open = function (b) { props.go({ section: 'batch', id: b.batchId }); };
        return html`<div class="st-list-page">
            <div class="st-list-head"><h2 class="h4 mb-0">Batches</h2><span class="text-body-secondary small">Runs and schedules across several devices, newest first</span>
                <button class="btn btn-sm btn-primary ms-auto" onClick=${function () { props.go({ section: 'run' }); }}><${ST.Icon} name="send" class="me-1" />New run</button></div>
            <div class="card"><div class="card-body p-0">
                ${state.error ? html`<div class="alert alert-danger m-3">${state.error}</div>`
                : state.loading ? html`<div class="text-center py-5"><${ST.Spinner} /></div>`
                : state.rows.length == 0 ? html`<${ST.Empty} icon="collection">No batches yet. Run or schedule a script on several devices from Run.</${ST.Empty}>`
                : html`<div class="table-responsive"><table class="table table-sm table-hover st-table mb-0">
                    <thead><tr><th>Batch</th><th>Started</th><th>Devices</th><th class="st-col-results">Results</th></tr></thead>
                    <tbody>${state.rows.map(function (b) { return html`<tr key=${b.batchId} class="st-clickable" tabindex="0" onClick=${function () { open(b); }} onKeyDown=${function (e) { if (e.key == 'Enter') open(b); }}>
                        <td><a href=${'#/batch/' + b.batchId} onClick=${function (e) { e.preventDefault(); }}>${batchTitle(b)}</a>
                            <div class="text-body-secondary small">${b.name ? b.scriptName + ' · ' : ''}${b.recurring ? html`<${ST.Icon} name="clock" class="me-1" />Scheduled: ${ST.fmt.recurrence(b.schedule || {})}` : 'Run now'}</div></td>
                        <td class="text-nowrap"><${ST.Time} t=${b.createdAt} /><div class="text-body-secondary small">${b.createdBy}</div></td>
                        <td>${b.visibleDevices}${b.visibleDevices != b.nodeIds.length ? html`<span class="text-body-secondary small"> of ${b.nodeIds.length}</span>` : null}</td>
                        <td class="st-col-results">${b.recurring && b.slot ? html`<div class="text-body-secondary small mb-1">${b.slot > ST.now() ? 'Next' : 'Latest'}: ${ST.fmt.time(b.slot)}</div>` : null}<${StateBar} counts=${b.counts} /></td>
                    </tr>`; })}</tbody>
                </table></div>`}
            </div></div>
            <${Pager} total=${state.total} page=${page} onPage=${function (pg) { props.go({ section: 'batches', query: { page: pg } }); }} />
        </div>`;
    }

    function csvCell(v) { v = (v == null) ? '' : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    function isoTime(t) { return t ? new Date(t * 1000).toISOString() : ''; }

    function DeviceChips(props) {
        var more = useState(false), max = 12;
        var ids = more[0] ? props.ids : props.ids.slice(0, max);
        return html`<div class="st-chips">${ids.map(function (id) { return html`<${DeviceCell} key=${id} id=${id} compact=${true} />`; })}
            ${props.ids.length > max ? html`<button class="btn btn-sm btn-link p-0" onClick=${function () { more[1](!more[0]); }}>${more[0] ? 'Show fewer' : '+' + (props.ids.length - max) + ' more'}</button>` : null}</div>`;
    }

    // One batch: a summary, devices grouped by identical result, and a row per device
    function BatchView(props) {
        var slot = props.query.slot ? Number(props.query.slot) : null;
        var st = useState({ loading: true, error: null, data: null }), state = st[0], set = st[1];
        var view = useState(store('batchView') || 'groups');
        var data = state.data;
        var load = useCallback(function () {
            return ST.rpc('batch', { batchId: props.id, slot: slot }).then(function (d) { set({ loading: false, error: null, data: d }); }, function (e) { set({ loading: false, error: e.message, data: null }); });
        }, [props.id, slot]);
        useEffect(function () { load(); }, [load]);
        var nodesRef = useRef([]);
        nodesRef.current = data ? data.batch.nodeIds : [];
        useEffect(function () {
            var timer = null;
            return ST.onInvalidate(function (m) {
                var hit = (m.nodeIds || []).some(function (n) { return nodesRef.current.indexOf(n) >= 0; }) || (data && (m.scriptIds || []).indexOf(data.batch.scriptId) >= 0);
                if (hit) { clearTimeout(timer); timer = setTimeout(load, 600); }
            });
        }, [load, data && data.batch.scriptId]);

        if (state.error) return html`<div class="st-list-page"><${BackLink} go=${props.go} /><div class="alert alert-danger">${state.error}</div></div>`;
        if (data == null) return html`<div class="text-center py-5"><${ST.Spinner} /></div>`;
        var b = data.batch;
        var groups = data.groups.slice();
        var counts = Object.assign({}, data.counts);
        if (data.missing.length) { groups.push({ state: 'none', output: '', nodeIds: data.missing, jobIds: [] }); counts.none = data.missing.length; }
        var script = props.items.find(function (i) { return i._id == b.scriptId && i.type == 'script'; });
        var rerunIds = [].concat.apply([], groups.filter(function (g) { return RERUN_STATES.indexOf(g.state) >= 0; }).map(function (g) { return g.nodeIds; }));
        var pending = STATE_ORDER.slice(5).reduce(function (t, k) { return t + (counts[k] || 0); }, 0);
        var setView = function (v) { view[1](v); store('batchView', v); };
        var openJob = function (jobId) { ST.rpc('job', { id: jobId }).then(function (full) { props.openOutput(full); }, function (e) { ST.ui.toast(e.message, 'error'); }); };
        var rerun = function () {
            ST.ui.confirm({ title: 'Run again on ' + plural(rerunIds.length, 'device') + '?', body: html`<p class="mb-0">${b.scriptName} runs again on the devices that had an error, missed their run, or didn't run. Their new results replace the old ones in this batch; the old runs stay in History.</p>`, confirmText: 'Run again' })
            .then(function (ok) {
                if (ok) ST.ui.attempt(ST.rpc('runScript', { scriptId: b.scriptId, nodeIds: rerunIds, batchId: b.batchId })).then(function (r) {
                    if (r) { ST.ui.toast('Queued on ' + plural(r.accepted, 'device') + (r.refused.length ? '. Skipped ' + r.refused.length + ' you can\'t run scripts on.' : '.')); load(); }
                });
            });
        };
        var exportCsv = function () {
            ST.ui.attempt(ST.rpc('batch', { batchId: b.batchId, slot: data.slot, fullOutput: true })).then(function (full) {
                if (full == null) return;
                var lines = [['Device', 'Device group', 'Status', 'Queued', 'Sent', 'Finished', 'Output'].join(',')];
                full.rows.slice().sort(function (x, y) { return nodeName(x.node).localeCompare(nodeName(y.node)); }).forEach(function (r) {
                    var n = (host.nodes || []).find(function (x) { return x._id == r.node; });
                    lines.push([nodeName(r.node), n ? meshName(n.meshid) : '', ST.STATUS[r.state].label, isoTime(r.queueTime), isoTime(r.dispatchTime), isoTime(r.completeTime), r.output].map(csvCell).join(','));
                });
                full.missing.forEach(function (id) { lines.push([nodeName(id), '', ST.STATUS.none.label, '', '', '', ''].map(csvCell).join(',')); });
                var a = document.createElement('a');
                a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }));
                a.download = batchTitle(b).replace(/[^\w.-]+/g, '_') + (data.slot ? '-' + data.slot : '') + '.csv';
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
            });
        };
        var rowsSorted = data.rows.concat(data.missing.map(function (id) { return { node: id, state: 'none' }; }))
            .sort(function (x, y) { return (STATE_ORDER.indexOf(x.state) - STATE_ORDER.indexOf(y.state)) || nodeName(x.node).localeCompare(nodeName(y.node)); });

        return html`<div class="st-list-page st-batch">
            <${BackLink} go=${props.go} />
            <div class="st-list-head">
                <h2 class="h4 mb-0">${batchTitle(b)}</h2>
                <span class="text-body-secondary small">${b.name ? b.scriptName + ' · ' : ''}${b.recurring ? 'Scheduled: ' + ST.fmt.recurrence(b.schedule || {}) + ' · ' : ''}${plural(b.nodeIds.length, 'device')} · started by ${b.createdBy} <${ST.Time} t=${b.createdAt} /></span>
            </div>
            ${b.recurring ? html`<div class="st-batch-slot">
                <label class="form-label mb-0" for="st-slot">Run</label>
                ${data.slots.length ? html`<select id="st-slot" class="form-select form-select-sm" value=${data.slot} onChange=${function (e) { props.go({ section: 'batch', id: b.batchId, query: { slot: e.target.value } }); }}>
                    ${data.slots.map(function (s) { return html`<option value=${s}>${ST.fmt.time(s)}${s > ST.now() ? ' (next)' : ''}</option>`; })}
                </select>` : html`<span class="text-body-secondary small">No runs yet</span>`}
            </div>` : null}
            <div class="card"><div class="card-body st-batch-summary">
                <${StateBar} counts=${counts} />
                <div class="st-batch-actions">
                    ${!b.recurring && rerunIds.length && script ? html`<button class="btn btn-sm btn-primary" onClick=${rerun}><${ST.Icon} name="arrow-repeat" class="me-1" />Run again on ${plural(rerunIds.length, 'device')}</button>` : null}
                    ${pending ? html`<button class="btn btn-sm st-btn-quiet" onClick=${function () { props.go({ section: 'queue', query: { batch: b.batchId } }); }}><${ST.Icon} name="list-task" class="me-1" />Queue</button>` : null}
                    ${b.recurring ? html`<button class="btn btn-sm st-btn-quiet" onClick=${function () { props.go({ section: 'schedules', query: { batch: b.batchId } }); }}><${ST.Icon} name="clock" class="me-1" />Schedules</button>` : null}
                    <button class="btn btn-sm st-btn-quiet" onClick=${function () { props.go({ section: 'history', query: { batch: b.batchId } }); }}><${ST.Icon} name="clock-history" class="me-1" />History</button>
                    <button class="btn btn-sm st-btn-quiet" disabled=${data.rows.length == 0} onClick=${exportCsv}><${ST.Icon} name="filetype-csv" class="me-1" />Export CSV</button>
                </div>
            </div></div>
            <div class="btn-group btn-group-sm align-self-start" role="group" aria-label="View">
                <button class=${'btn ' + (view[0] == 'groups' ? 'btn-secondary' : 'st-btn-quiet')} aria-pressed=${view[0] == 'groups'} onClick=${function () { setView('groups'); }}>By result</button>
                <button class=${'btn ' + (view[0] == 'devices' ? 'btn-secondary' : 'st-btn-quiet')} aria-pressed=${view[0] == 'devices'} onClick=${function () { setView('devices'); }}>By device</button>
            </div>
            ${groups.length == 0 ? html`<div class="card"><${ST.Empty} icon="collection">No runs on devices you can see.</${ST.Empty}></div>`
            : view[0] == 'groups' ? groups.map(function (g, i) {
                var finished = g.state == 'complete' || g.state == 'error';
                return html`<div class="card st-result-group" key=${g.state + i}>
                    <div class="card-header">
                        <${ST.StatusBadge} status=${g.state} />
                        <strong>${plural(g.nodeIds.length, 'device')}</strong>
                        ${finished && groups.filter(function (x) { return x.state == 'complete' || x.state == 'error'; }).length > 1 ? html`<span class="text-body-secondary small">with this output</span>` : null}
                        ${finished && g.jobIds.length ? html`<button class="btn btn-sm st-btn-quiet ms-auto" onClick=${function () { openJob(g.jobIds[0]); }}><${ST.Icon} name="eye" class="me-1" />Full output</button>` : null}
                    </div>
                    <div class="card-body">
                        ${finished ? (g.output ? html`<pre class="st-group-output">${g.output}${g.truncated ? '\n…' : ''}</pre>` : html`<div class="text-body-tertiary small mb-2">No output</div>`) : null}
                        <${DeviceChips} ids=${g.nodeIds} />
                    </div>
                </div>`;
            })
            : html`<div class="card"><div class="table-responsive"><table class="table table-sm table-hover st-table mb-0">
                <thead><tr><th>Device</th><th>Status</th><th>When</th><th>Took</th><th>Output</th></tr></thead>
                <tbody>${rowsSorted.map(function (r) {
                    var finished = r.completeTime != null;
                    return html`<tr key=${r.node} class=${finished ? 'st-clickable' : ''} tabindex=${finished ? '0' : null} onClick=${function (e) { if (finished && !e.target.closest('a')) openJob(r.jobId); }} onKeyDown=${function (e) { if (finished && e.key == 'Enter') openJob(r.jobId); }}>
                        <td><${DeviceCell} id=${r.node} /></td>
                        <td><${ST.StatusBadge} status=${r.state} /></td>
                        <td class="text-nowrap">${r.completeTime ? html`<${ST.Time} t=${r.completeTime} />` : r.dispatchTime ? html`Sent <${ST.Time} t=${r.dispatchTime} />` : r.queueTime ? html`Queued <${ST.Time} t=${r.queueTime} />` : ''}</td>
                        <td class="text-nowrap">${(r.completeTime && r.dispatchTime && r.state != 'missed') ? ST.fmt.duration(r.completeTime - r.dispatchTime) : ''}</td>
                        <td><div class="st-output-preview">${r.output ? r.output.split('\n')[0] : finished ? html`<span class="text-body-tertiary">No output</span>` : ''}</div></td>
                    </tr>`; })}</tbody>
            </table></div></div>`}
        </div>`;
    }
    function BackLink(props) {
        return html`<a href="#/batches" class="st-back" onClick=${function (e) { e.preventDefault(); props.go({ section: 'batches' }); }}><${ST.Icon} name="arrow-left" class="me-1" />Batches</a>`;
    }

    // ---- Variables ----

    var SCOPE_FILTERS = [['', 'All scopes'], ['global', 'Global'], ['script', 'Script'], ['mesh', 'Device group'], ['node', 'Device']];

    // Every variable the manager can see, with where each name is used
    function VariablesSection(props) {
        var q = props.query, items = props.items;
        var usage = useState(null);
        var text = useState(q.q || ''), timer = useRef(null);
        var loadUsage = useCallback(function () { return ST.rpc('varUsage').then(usage[1], function () { usage[1]({}); }); }, []);
        useEffect(function () { loadUsage(); }, []);
        useEffect(function () { var t = null; return ST.onInvalidate(function (m) { if (m.library || (m.scriptIds && m.scriptIds.length)) { clearTimeout(t); t = setTimeout(loadUsage, 600); } }); }, []);
        var setQ = function (k, v) { var n = Object.assign({}, q); if (v) n[k] = v; else delete n[k]; props.onQuery(n); };
        var typed = function (v) { text[1](v); clearTimeout(timer.current); timer.current = setTimeout(function () { setQ('q', v.trim()); }, 300); };

        var scripts = items.filter(function (i) { return i.type == 'script'; });
        var scriptName = function (id) { var s = scripts.find(function (x) { return x._id == id; }); return s ? s.name : null; };
        var targetText = function (v) {
            if (v.scope == 'script') return scriptName(v.scopeTarget) || '(deleted script)';
            if (v.scope == 'mesh') return meshName(v.scopeTarget);
            if (v.scope == 'node') return nodeName(v.scopeTarget);
            return 'All devices';
        };
        var vars = props.vars || [];
        var needle = (q.q || '').toLowerCase();
        var shown = vars.filter(function (v) {
            if (q.scope && v.scope != q.scope) return false;
            if (needle && v.name.toLowerCase().indexOf(needle) < 0 && (v.secret || String(v.value).toLowerCase().indexOf(needle) < 0) && targetText(v).toLowerCase().indexOf(needle) < 0) return false;
            return true;
        }).sort(function (a, b) { return a.name.localeCompare(b.name) || (S.SCOPE_ORDER[a.scope] - S.SCOPE_ORDER[b.scope]) || targetText(a).localeCompare(targetText(b)); });
        // Names scripts use that have no value anywhere (built-ins aside)
        var defined = {};
        vars.forEach(function (v) { defined[v.name] = true; });
        var undefinedNames = usage[0] ? Object.keys(usage[0]).filter(function (n) { return !defined[n] && !BUILT_INS[n]; }).sort() : [];
        var usedIn = function (name) {
            var ids = (usage[0] || {})[name] || [];
            if (usage[0] == null) return null;
            if (ids.length == 0) return html`<span class="text-body-tertiary small">Not used</span>`;
            return html`<span class="small">${ids.slice(0, 2).map(function (id, i) { return html`${i ? ', ' : ''}<a href=${'#/library/' + encodeURIComponent(id)}>${scriptName(id) || 'script'}</a>`; })}${ids.length > 2 ? html` <span class="text-body-secondary">+${ids.length - 2} more</span>` : null}</span>`;
        };
        var lastName = null;
        return html`<div class="st-list-page">
            <div class="st-list-head"><h2 class="h4 mb-0">Variables</h2><span class="text-body-secondary small">Values scripts use as #name#. Device beats device group, group beats script, script beats global, and global beats built-in.</span>
                <button class="btn btn-sm btn-primary ms-auto" onClick=${function () { props.editVar(null); }}><${ST.Icon} name="plus-lg" class="me-1" />New variable</button></div>
            ${undefinedNames.length ? html`<div class="alert alert-warning py-2 mb-0 small st-undefined-vars">
                <${ST.Icon} name="exclamation-triangle-fill" class="me-1" />Used in scripts but not defined, so they run as VAR_NOT_FOUND:
                ${undefinedNames.map(function (n) { return html` <button class="btn btn-sm btn-link p-0 align-baseline" title="Define it" onClick=${function () { props.editVar(null, n); }}><code>#${n}#</code></button>`; })}
            </div>` : null}
            <div class="st-filters">
                <input type="search" class="form-control form-control-sm st-filter-wide" placeholder="Search variables" aria-label="Search variables" value=${text[0]} onInput=${function (e) { typed(e.target.value); }} />
                <select class="form-select form-select-sm" aria-label="Scope" value=${q.scope || ''} onChange=${function (e) { setQ('scope', e.target.value); }}>
                    ${SCOPE_FILTERS.map(function (o) { return html`<option value=${o[0]}>${o[1]}</option>`; })}
                </select>
            </div>
            <div class="card"><div class="card-body p-0">
                ${props.vars == null ? html`<div class="text-center py-5"><${ST.Spinner} /></div>`
                : shown.length == 0 ? html`<${ST.Empty} icon="braces">${vars.length ? 'No variables match.' : 'No variables yet. Scripts can use values that differ per device, group or script as #name#.'}</${ST.Empty}>`
                : html`<div class="table-responsive"><table class="table table-sm table-hover st-table mb-0">
                    <thead><tr><th>Name</th><th>Applies to</th><th>Value</th><th>Used in</th><th class="st-col-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
                    <tbody>${shown.map(function (v) {
                        var first = v.name != lastName; lastName = v.name;
                        return html`<tr key=${v._id} class=${first ? 'st-var-first' : 'st-var-more'}>
                            <td>${first ? html`<code>#${v.name}#</code>` : html`<span class="visually-hidden">#${v.name}#</span>`}
                                ${first && BUILT_INS[v.name] ? html`<div class="small text-body-secondary">Replaces the built-in value</div>` : null}</td>
                            <td><span class="text-body-secondary small me-1">${S.SCOPE_LABEL[v.scope]}</span>
                                ${v.scope == 'node' ? html`<${DeviceCell} id=${v.scopeTarget} compact=${true} />`
                                : v.scope == 'script' && scriptName(v.scopeTarget) ? html`<a href=${'#/library/' + encodeURIComponent(v.scopeTarget)}>${targetText(v)}</a>`
                                : v.scope == 'global' ? null : targetText(v)}</td>
                            <td><${S.VarValue} variable=${v} /></td>
                            <td>${first ? usedIn(v.name) : null}</td>
                            <td class="st-col-actions"><div class="btn-group btn-group-sm">
                                <button class="btn st-btn-quiet" title="Edit" onClick=${function () { props.editVar(v); }}><${ST.Icon} name="pencil" /><span class="visually-hidden">Edit</span></button>
                                <button class="btn btn-outline-danger" title="Delete" onClick=${function () { props.deleteVar(v); }}><${ST.Icon} name="trash3" /><span class="visually-hidden">Delete</span></button>
                            </div></td>
                        </tr>`; })}</tbody>
                </table></div>`}
            </div></div>
        </div>`;
    }

    // ---- Overview ----

    function StatCard(props) {
        return html`<a href=${props.href} class=${'card st-stat text-decoration-none' + (props.tone ? ' st-stat-' + props.tone : '')}>
            <div class="card-body">
                <div class="st-stat-label"><${ST.Icon} name=${props.icon} class="me-1" />${props.label}</div>
                <div class="st-stat-value">${props.value}</div>
                ${props.note ? html`<div class="st-stat-note">${props.note}</div>` : null}
            </div>
        </a>`;
    }

    function OverviewSection(props) {
        var st = useState({ data: null, error: null, batches: null }), state = st[0], set = st[1];
        var load = useCallback(function () {
            return Promise.all([ST.rpc('overview'), ST.rpc('batches', { limit: 5 })]).then(function (r) { set({ data: r[0], error: null, batches: r[1].batches }); }, function (e) { set({ data: null, error: e.message, batches: null }); });
        }, []);
        useEffect(function () { load(); var iv = setInterval(load, 60000); return function () { clearInterval(iv); }; }, []);
        useEffect(function () { var t = null; return ST.onInvalidate(function (m) { if ((m.nodeIds && m.nodeIds.length) || (m.scriptIds && m.scriptIds.length)) { clearTimeout(t); t = setTimeout(load, 1000); } }); }, []);
        if (state.error) return html`<div class="alert alert-danger">${state.error}</div>`;
        var d = state.data;
        if (d == null) return html`<div class="text-center py-5"><${ST.Spinner} /></div>`;
        var openJob = function (j) { ST.rpc('job', { id: j._id }).then(props.openOutput, function (e) { ST.ui.toast(e.message, 'error'); }); };
        var attention = d.stale.length + d.failures.length;
        return html`<div class="st-list-page st-overview">
            <div class="st-list-head"><h2 class="h4 mb-0">Overview</h2><span class="text-body-secondary small">Devices you can see. Counts for errors, missed and completed runs cover the last 24 hours.</span>
                <button class="btn btn-sm btn-primary ms-auto" onClick=${function () { props.go({ section: 'run' }); }}><${ST.Icon} name="send" class="me-1" />New run</button></div>
            <div class="st-stats">
                <${StatCard} href="#/queue" icon="list-task" label="Queued or running" value=${d.queue.queued + d.queue.dispatched + d.queue.stale} note=${d.queue.stale ? d.queue.stale + ' with no result yet' : null} tone=${d.queue.stale ? 'warning' : null} />
                <${StatCard} href="#/queue?status=waiting" icon="wifi-off" label="Waiting for device" value=${d.queue.waiting} />
                <${StatCard} href="#/history?status=error&since=86400" icon="exclamation-octagon-fill" label="Errors" value=${d.day.failed} tone=${d.day.failed ? 'danger' : null} />
                <${StatCard} href="#/history?status=missed&since=86400" icon="calendar-x" label="Missed" value=${d.day.missed} tone=${d.day.missed ? 'warning' : null} />
                <${StatCard} href="#/history?status=complete&since=86400" icon="check-circle-fill" label="Completed" value=${d.day.completed} />
                <${StatCard} href="#/schedules?status=active" icon="clock" label="Active schedules" value=${d.schedules.active} note=${d.schedules.paused ? d.schedules.paused + ' paused' : null} />
            </div>
            <div class="st-overview-grid">
                <div class="card">
                    <div class="card-header"><${ST.Icon} name="exclamation-triangle-fill" class="me-1" />Needs attention${attention ? html`<span class="badge text-bg-secondary ms-2">${attention}</span>` : null}</div>
                    ${attention == 0 ? html`<${ST.Empty} icon="check-circle-fill">Nothing needs attention: no errors or missed runs in the last 24 hours.</${ST.Empty}>` : html`
                    <div class="table-responsive"><table class="table table-sm table-hover st-table mb-0">
                        <tbody>
                            ${d.stale.map(function (j) { return html`<tr key=${j._id}>
                                <td><${ST.StatusBadge} status="stale" title=${'Sent over ' + ST.fmt.span(d.staleSeconds) + ' ago without a result.'} /></td>
                                <td>${j.scriptName}<${BatchLink} id=${j.batchId} /></td><td><${DeviceCell} id=${j.node} compact=${true} /></td>
                                <td class="text-nowrap text-body-secondary">Sent <${ST.Time} t=${j.dispatchTime} /></td><td></td>
                            </tr>`; })}
                            ${d.failures.map(function (j) { var out = ST.jobOutput(j); return html`<tr key=${j._id} class="st-clickable" tabindex="0" onClick=${function (e) { if (!e.target.closest('a')) openJob(j); }} onKeyDown=${function (e) { if (e.key == 'Enter') openJob(j); }}>
                                <td><${ST.StatusBadge} status=${ST.jobStatus(j, true)} /></td>
                                <td>${j.scriptName}<${BatchLink} id=${j.batchId} /></td><td><${DeviceCell} id=${j.node} compact=${true} /></td>
                                <td class="text-nowrap text-body-secondary"><${ST.Time} t=${j.completeTime} /></td>
                                <td><div class="st-output-preview">${j.missed ? '' : out.split('\n')[0]}</div></td>
                            </tr>`; })}
                        </tbody>
                    </table></div>
                    <div class="card-footer small"><a href="#/history?status=error&since=86400">All errors</a> · <a href="#/history?status=missed&since=86400">All missed</a></div>`}
                </div>
                <div class="card">
                    <div class="card-header"><${ST.Icon} name="clock" class="me-1" />Up next</div>
                    ${d.upNext.length == 0 ? html`<${ST.Empty} icon="clock">Nothing scheduled. Schedule a script from <a href="#/run">Run</a> or a script's page in the Library.</${ST.Empty}>` : html`
                    <ul class="list-group list-group-flush st-upnext">
                        ${d.upNext.map(function (j) { return html`<li key=${j._id} class="list-group-item">
                            <span class="st-upnext-time" title=${ST.fmt.time(j.dontQueueUntil)}>${j.dontQueueUntil <= ST.now() ? 'Due ' : ''}<${ST.Time} t=${j.dontQueueUntil} /></span>
                            <span class="st-upnext-what">${j.scriptName}<${BatchLink} id=${j.batchId} /><span class="d-block small"><${DeviceCell} id=${j.node} compact=${true} /></span>
                                ${j.state != 'scheduled' ? html`<${ST.StatusBadge} status=${j.state} />` : null}</span>
                        </li>`; })}
                    </ul>
                    <div class="card-footer small"><a href="#/schedules">All schedules</a></div>`}
                </div>
            </div>
            <div class="card">
                <div class="card-header"><${ST.Icon} name="collection" class="me-1" />Recent batches</div>
                ${state.batches.length == 0 ? html`<${ST.Empty} icon="collection">No batches yet.</${ST.Empty}>` : html`
                <div class="table-responsive"><table class="table table-sm table-hover st-table mb-0"><tbody>
                    ${state.batches.map(function (b) { return html`<tr key=${b.batchId} class="st-clickable" tabindex="0" onClick=${function () { props.go({ section: 'batch', id: b.batchId }); }} onKeyDown=${function (e) { if (e.key == 'Enter') props.go({ section: 'batch', id: b.batchId }); }}>
                        <td><a href=${'#/batch/' + b.batchId} onClick=${function (e) { e.preventDefault(); }}>${batchTitle(b)}</a><div class="text-body-secondary small">${plural(b.visibleDevices, 'device')} · <${ST.Time} t=${b.createdAt} /></div></td>
                        <td class="st-col-results"><${StateBar} counts=${b.counts} /></td>
                    </tr>`; })}
                </tbody></table></div>
                <div class="card-footer small"><a href="#/batches">All batches</a></div>`}
            </div>
        </div>`;
    }

    // ---- Keyboard shortcuts ----

    var GO_KEYS = { o: 'overview', l: 'library', r: 'run', b: 'batches', q: 'queue', s: 'schedules', h: 'history', v: 'variables', ',': 'settings' };
    var SHORTCUTS = [
        ['g then o, l, r, b, q, s, h, v', 'Go to Overview, Library, Run, Batches, Queue, Schedules, History or Variables'],
        ['g then ,', 'Go to Settings'],
        ['/', 'Search on this page'],
        ['n', 'New script (Library), new variable (Variables), or new run'],
        ['Ctrl+S', 'Save the script in the editor'],
        ['Esc', 'Close a dialog'],
        ['?', 'Show these shortcuts']
    ];
    function ShortcutsDialog(props) {
        return html`<${ST.Modal} title="Keyboard shortcuts" onClose=${props.onClose}>
            <table class="table table-sm st-table st-shortcuts mb-0"><tbody>
                ${SHORTCUTS.map(function (s) { return html`<tr><td class="text-nowrap">${s[0].split(' ').map(function (k) { return k == 'then' || k == 'or' ? html` <span class="text-body-secondary">${k}</span> ` : html`<kbd>${k.replace(/,$/, '')}</kbd>${k.endsWith(',') ? ', ' : ''}`; })}</td><td>${s[1]}</td></tr>`; })}
            </tbody></table>
        </${ST.Modal}>`;
    }
    // Single-key shortcuts, ignored while typing or while a dialog is open
    function useShortcuts(handlers) {
        var ref = useRef(handlers);
        ref.current = handlers;
        useEffect(function () {
            var pendingG = 0;
            var onKey = function (e) {
                if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
                var t = e.target;
                if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"], .cm-editor')) return;
                if (document.querySelector('.st-modal-layer')) return;
                var h = ref.current;
                if (pendingG && Date.now() - pendingG < 1500 && GO_KEYS[e.key]) { e.preventDefault(); pendingG = 0; h.go(GO_KEYS[e.key]); return; }
                pendingG = 0;
                if (e.key == 'g') { pendingG = Date.now(); return; }
                if (e.key == '/') {
                    var input = document.querySelector('.st-main input[type="search"], .st-main input[role="combobox"]');
                    if (input) { e.preventDefault(); input.focus(); if (input.select) input.select(); }
                    return;
                }
                if (e.key == 'n') { e.preventDefault(); h.create(); return; }
                if (e.key == '?') { e.preventDefault(); h.help(); }
            };
            document.addEventListener('keydown', onKey);
            return function () { document.removeEventListener('keydown', onKey); };
        }, []);
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
                if (m.settings) due.settings = true;
                if (timer == null) timer = setTimeout(function () {
                    timer = null;
                    if (due.library) loadTree().catch(function () { });
                    if (due.vars) loadVars().catch(function () { });
                    // Another manager changed settings
                    if (due.settings) ST.rpc('init', {}).then(function (init) { setState(function (o) { return Object.assign({}, o, { init: Object.assign({}, o.init, { settings: init.settings }) }); }); }, function () { });
                    due = {};
                }, 250);
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
            runMany: function (item) { go({ section: 'run', query: { script: item._id } }); },
            openOutput: function (j) { setDialog(html`<${ST.dialogs.Output} job=${j} scriptName=${j.scriptName} deviceName=${nodeName(j.node)} onClose=${close} />`); },
            editVar: function (v, item) {
                setDialog(html`<${ST.dialogs.Variable} variable=${v ? Object.assign({}, v, { scopeTargetName: v.scope == 'script' ? 'Script: ' + scriptName(v.scopeTarget) : null }) : null}
                    scope=${v ? null : 'script'} scopes=${['global', 'script']} targets=${{ script: { id: item._id, name: 'Script: ' + item.name } }} onClose=${close} />`);
            },
            // From the Variables section: any scope, with a target chosen from a list
            editAnyVar: function (v, name) {
                var scripts = items.filter(function (i) { return i.type == 'script'; }).sort(function (x, y) { return x.path.localeCompare(y.path) || x.name.localeCompare(y.name); });
                var options = {
                    script: scripts.map(function (sc) { return [sc._id, sc.path + ' / ' + sc.name]; }),
                    mesh: Object.keys(host.meshes || {}).map(function (k) { return host.meshes[k]; }).filter(function (m) { return m.mtype == 2; }).sort(function (x, y) { return x.name.localeCompare(y.name); }).map(function (m) { return [m._id, m.name]; }),
                    node: agentNodes().sort(function (x, y) { return x.name.localeCompare(y.name); }).map(function (n) { return [n._id, n.name + ' (' + meshName(n.meshid) + ')']; })
                };
                // A target that isn't in the lists (a deleted script, a device not loaded here) stays selectable when editing
                if (v && v.scope != 'global' && !options[v.scope].some(function (o) { return o[0] == v.scopeTarget; })) options[v.scope].unshift([v.scopeTarget, v.scope == 'script' ? '(deleted script)' : v.scope == 'mesh' ? meshName(v.scopeTarget) : nodeName(v.scopeTarget)]);
                setDialog(html`<${ST.dialogs.Variable} variable=${v} name=${name} options=${options} onClose=${close} />`);
            },
            deleteVar: function (v) {
                ST.ui.confirm({ title: 'Delete #' + v.name + '#?', body: html`<p class="mb-0">Scripts that use it will get the next most specific value, or VAR_NOT_FOUND.</p>`, confirmText: 'Delete', danger: true })
                .then(function (ok) { if (ok) ST.ui.attempt(ST.rpc('deleteVar', { id: v._id }), 'Variable deleted.'); });
            }
        };
        useShortcuts({
            go: function (section) { go({ section: section }); },
            create: function () {
                var sec = route[0].section;
                if (sec == 'library') actions.newScript();
                else if (sec == 'variables') actions.editAnyVar(null);
                else if (sec == 'run') { var i = document.querySelector('.st-main input[role="combobox"]'); if (i) i.focus(); }
                else go({ section: 'run' });
            },
            help: function () { setDialog(html`<${ShortcutsDialog} onClose=${close} />`); }
        });
        var scheduleActions = S.scheduleActions({ setDialog: setDialog, close: close, settings: function () { return state.init.settings; }, deviceName: function (s) { return nodeName(s.node); }, scriptName: scriptName });

        if (document.documentElement.getAttribute('data-st-classic') == '1') {
            return html`<div class="alert alert-info st-classic-notice"><strong>ScriptTask needs the Modern UI.</strong> Switch to it from your account menu.</div>`;
        }
        if (state.error) return html`<div class="alert alert-danger m-3"><${ST.Icon} name="exclamation-triangle-fill" class="me-1" />${state.error}</div>`;
        if (state.init == null) return null;
        PAGE_SIZE = state.init.settings.pageSize || 50;
        if (!state.init.caps.manage) return html`<div class="alert alert-warning m-3"><${ST.Icon} name="lock" class="me-1" />The ScriptTask page is for ScriptTask managers. You can run library scripts from a device's ScriptTask tab.</div>`;

        var section = route[0].section;
        var nav = [['overview', 'Overview', 'speedometer2'], ['library', 'Library', 'folder2-open'], ['run', 'Run', 'send'], ['batches', 'Batches', 'collection'], ['queue', 'Queue', 'list-task'], ['schedules', 'Schedules', 'clock'], ['history', 'History', 'clock-history'], ['variables', 'Variables', 'braces'], ['settings', 'Settings', 'gear']];
        var navSection = (section == 'batch') ? 'batches' : section;
        var setQuery = function (q) { go({ section: section, id: null, query: q }); };
        return html`<div class="st-shell">
            <nav class="st-sidenav" aria-label="ScriptTask">
                <div class="st-brand"><${ST.Icon} name="file-earmark-code" class="me-2" />ScriptTask</div>
                <ul class="nav nav-pills flex-md-column">
                    ${nav.map(function (n) { return html`<li class="nav-item"><a href=${'#/' + n[0]} class=${'nav-link' + (navSection == n[0] ? ' active' : '')} aria-current=${navSection == n[0] ? 'page' : null}
                        onClick=${function (e) { e.preventDefault(); go({ section: n[0], id: null }); }}><${ST.Icon} name=${n[2]} class="me-2" />${n[1]}</a></li>`; })}
                </ul>
                <div class="st-sidenav-foot">Version ${state.init.version}
                    <button type="button" class="btn btn-link btn-sm p-0 d-block st-shortcuts-link" onClick=${function () { setDialog(html`<${ShortcutsDialog} onClose=${close} />`); }}>Keyboard shortcuts <kbd>?</kbd></button></div>
            </nav>
            <main class="st-main">
                ${section == 'library' ? html`<div class="st-library">
                    <div class="st-lib-tree">
                        <${S.Library} items=${state.items} selId=${route[0].id} onSelect=${select} collapsed=${collapsed} onToggle=${toggleFolder} manage=${true} actions=${actions} />
                        <input type="file" class="d-none" multiple accept=".ps1,.bat,.cmd,.sh,.bash" ref=${fileInput} onChange=${function (e) { actions.upload(e.target.files, selected ? selected._id : null); e.target.value = ''; }} />
                    </div>
                    <div class="st-lib-detail card">
                        ${state.items == null ? html`<div class="text-center py-5"><${ST.Spinner} /></div>`
                        : selected == null ? html`<div class="st-tab-body"><${ST.Empty} icon="file-earmark-code">${items.some(function (i) { return i.type == 'script'; }) ? 'Choose a script or folder in the library, or create one.' : 'No scripts yet. Create one, or upload .ps1, .bat and .sh files (you can also drop them on the library).'}
                            <div class="mt-3 d-flex gap-2 justify-content-center"><button class="btn btn-primary" onClick=${actions.newScript}><${ST.Icon} name="file-earmark-plus" class="me-1" />New script</button>
                                <button class="btn st-btn-quiet" onClick=${actions.pickUpload}><${ST.Icon} name="upload" class="me-1" />Upload</button></div></${ST.Empty}></div>`
                        : selected.type == 'folder' ? html`<${FolderPanel} key=${selected._id} item=${selected} items=${items} actions=${actions} />`
                        : html`<${ScriptWorkspace} key=${selected._id} item=${selected} vars=${state.vars} settings=${state.init.settings} actions=${actions} scheduleActions=${scheduleActions} onDirty=${function (d) { dirty.current = d; }} />`}
                    </div>
                </div>` : null}
                ${section == 'run' ? html`<${RunSection} key=${'run' + (route[0].query.script || '') + (route[0].query.devices || '')} query=${route[0].query} items=${items} userId=${state.init.user.id}
                    settings=${state.init.settings} go=${go} setDialog=${setDialog} close=${close} />` : null}
                ${section == 'overview' ? html`<${OverviewSection} go=${go} openOutput=${actions.openOutput} />` : null}
                ${section == 'variables' ? html`<${VariablesSection} query=${route[0].query} items=${items} vars=${state.vars} onQuery=${setQuery} editVar=${actions.editAnyVar} deleteVar=${actions.deleteVar} />` : null}
                ${section == 'batches' ? html`<${BatchesSection} query=${route[0].query} go=${go} />` : null}
                ${section == 'batch' ? html`<${BatchView} key=${route[0].id} id=${route[0].id} query=${route[0].query} items=${items} go=${go} openOutput=${actions.openOutput} />` : null}
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
