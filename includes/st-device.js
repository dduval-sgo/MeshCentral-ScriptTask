/**
* @description ScriptTask device tab: run and schedule library scripts on one device, and see its queue and history.
* ScriptTask managers also get library editing, multi-device runs and variables here until the server page exists.
* Requires st-core.js and st-dialogs.js.
* @license Apache-2.0
*/

"use strict";

(function () {
    var html = ST.html;
    var useState = preactHooks.useState, useEffect = preactHooks.useEffect, useMemo = preactHooks.useMemo, useRef = preactHooks.useRef, useCallback = preactHooks.useCallback;
    var host = ST.host;
    var node = host ? host.currentNode : null;

    // ---- Small helpers ----

    function store(key, value) {
        try {
            if (value === undefined) return JSON.parse(localStorage.getItem('scripttask.' + key));
            localStorage.setItem('scripttask.' + key, JSON.stringify(value));
        } catch (e) { return null; }
    }
    function nodeName(id) {
        var n = (host && host.nodes) ? host.nodes.find(function (x) { return x._id == id; }) : null;
        return n ? n.name : id.split('/').pop().substring(0, 8) + '…';
    }
    function meshName(id) { return (host && host.meshes && host.meshes[id]) ? host.meshes[id].name : 'Device group'; }

    // Windows, other, or unknown (null) for the current device
    function deviceIsWindows() {
        if (node == null) return null;
        if (node.osdesc) return /windows/i.test(node.osdesc);
        if (node.agent && node.agent.id) return [1, 2, 3, 4, 21, 22, 34].indexOf(node.agent.id) >= 0;
        return null;
    }
    // Why a script type can't (or might not) run on this device
    function compatibility(filetype) {
        var win = deviceIsWindows();
        if (win === null) return null;
        if (filetype == 'bat' && !win) return { block: true, msg: 'Batch scripts only run on Windows.' };
        if (filetype == 'bash' && win) return { block: true, msg: 'Bash scripts don\'t run on Windows.' };
        if (filetype == 'ps1' && !win) return { block: false, msg: 'Needs PowerShell (pwsh) installed on this device.' };
        return null;
    }
    function detectType(fileName, content) {
        var ext = fileName.split('.').pop().toLowerCase();
        if (ext == 'ps1') return 'ps1';
        if (ext == 'bat' || ext == 'cmd') return 'bat';
        if (ext == 'sh' || ext == 'bash' || content.startsWith('#!')) return 'bash';
        return null;
    }

    // Arrange the flat library list into folders
    function buildTree(items) {
        var folders = {}, roots = [], orphans = [];
        items.forEach(function (i) { if (i.type == 'folder') folders[i.path] = { item: i, folders: [], scripts: [] }; });
        Object.keys(folders).forEach(function (path) {
            var parentPath = path.substring(0, path.lastIndexOf('/'));
            if (parentPath && folders[parentPath]) folders[parentPath].folders.push(folders[path]); else roots.push(folders[path]);
        });
        items.forEach(function (i) { if (i.type == 'script') { if (folders[i.path]) folders[i.path].scripts.push(i); else orphans.push(i); } });
        var byName = function (a, b) { return (a.item || a).name.localeCompare((b.item || b).name); };
        Object.keys(folders).forEach(function (p) { folders[p].folders.sort(byName); folders[p].scripts.sort(byName); });
        roots.sort(byName);
        return { roots: roots, orphans: orphans.sort(byName) };
    }

    // ---- Library ----

    function TreeFolder(props) {
        var f = props.folder, item = f.item;
        var collapsed = props.collapsed.indexOf(item.path) >= 0;
        var over = useState(false);
        var drop = props.manage ? {
            onDragOver: function (e) { e.preventDefault(); e.stopPropagation(); over[1](true); },
            onDragLeave: function () { over[1](false); },
            onDrop: function (e) { e.preventDefault(); e.stopPropagation(); over[1](false); props.onDrop(e, item); }
        } : {};
        return html`<li>
            <div class=${'st-tree-row' + (props.selId == item._id ? ' st-selected' : '') + (over[0] ? ' st-drop-target' : '')} draggable=${props.manage && item.path != 'Shared'}
                onDragStart=${function (e) { e.dataTransfer.setData('application/x-scripttask-item', item._id); }}
                onClick=${function () { props.onSelect(item); props.onToggle(item.path); }} ...${drop} title=${item.path}>
                <span class="st-tree-chevron"><${ST.Icon} name=${collapsed ? 'chevron-right' : 'chevron-down'} /></span>
                <${ST.Icon} name=${collapsed ? 'folder2' : 'folder2-open'} class="st-folder-icon" />
                <span class="st-tree-name">${item.name}</span>
            </div>
            ${collapsed ? null : html`<ul>
                ${f.folders.map(function (c) { return html`<${TreeFolder} key=${c.item._id} ...${props} folder=${c} />`; })}
                ${f.scripts.map(function (s) { return html`<${TreeScript} key=${s._id} script=${s} selId=${props.selId} onSelect=${props.onSelect} manage=${props.manage} />`; })}
            </ul>`}
        </li>`;
    }

    function TreeScript(props) {
        var s = props.script;
        var compat = compatibility(s.filetype);
        return html`<li>
            <div class=${'st-tree-row' + (props.selId == s._id ? ' st-selected' : '')} draggable=${props.manage}
                onDragStart=${function (e) { e.dataTransfer.setData('application/x-scripttask-item', s._id); }}
                onClick=${function () { props.onSelect(s); }} title=${compat ? compat.msg : s.name}>
                <span class="st-tree-chevron"></span>
                <${ST.Icon} name="file-earmark-code" class=${compat && compat.block ? 'text-body-tertiary' : 'text-body-secondary'} />
                <span class=${'st-tree-name' + (compat && compat.block ? ' text-body-tertiary' : '')}>${s.name}${props.showPath ? html` <span class="st-script-path">${s.path}</span>` : null}</span>
                <span class="st-type">${s.filetype}</span>
            </div>
        </li>`;
    }

    function Library(props) {
        var q = useState('');
        var dropping = useState(false);
        var fileInput = useRef(null);
        var tree = useMemo(function () { return buildTree(props.items); }, [props.items]);
        var matches = q[0] ? props.items.filter(function (i) { return i.type == 'script' && i.name.toLowerCase().indexOf(q[0].toLowerCase()) >= 0; }) : null;

        var onDrop = function (e, folder) {
            dropping[1](false);
            var moveId = e.dataTransfer.getData('application/x-scripttask-item');
            if (moveId && folder) { if (moveId != folder._id) props.actions.move(moveId, folder._id); return; }
            if (e.dataTransfer.files && e.dataTransfer.files.length) props.actions.upload(e.dataTransfer.files, folder ? folder._id : null);
        };
        var cardDrop = props.manage ? {
            onDragOver: function (e) { if (Array.from(e.dataTransfer.types).indexOf('Files') >= 0) { e.preventDefault(); dropping[1](true); } },
            onDragLeave: function (e) { if (e.currentTarget.contains(e.relatedTarget)) return; dropping[1](false); },
            onDrop: function (e) { e.preventDefault(); onDrop(e, null); }
        } : {};

        return html`<div class="card st-card" ...${cardDrop}>
            <div class="card-header">
                Script library
                ${props.manage ? html`<div class="st-actions">
                    <button class="btn btn-sm st-btn-quiet" title="New script" aria-label="New script" onClick=${props.actions.newScript}><${ST.Icon} name="file-earmark-plus" /></button>
                    <button class="btn btn-sm st-btn-quiet" title="New folder" aria-label="New folder" onClick=${props.actions.newFolder}><${ST.Icon} name="folder-plus" /></button>
                    <button class="btn btn-sm st-btn-quiet" title="Upload scripts (.ps1, .bat, .sh)" aria-label="Upload scripts" onClick=${function () { fileInput.current.click(); }}><${ST.Icon} name="upload" /></button>
                    <input type="file" class="d-none" multiple accept=".ps1,.bat,.cmd,.sh,.bash" ref=${fileInput} onChange=${function (e) { props.actions.upload(e.target.files, props.selId); e.target.value = ''; }} />
                </div>` : null}
            </div>
            <div class="card-body">
                ${dropping[0] ? html`<div class="st-drop-hint"><${ST.Icon} name="upload" class="me-1" />Drop scripts to add them to the library</div>` : null}
                <input type="search" class="form-control form-control-sm mb-2" placeholder="Search scripts" aria-label="Search scripts" value=${q[0]} onInput=${function (e) { q[1](e.target.value); }} />
                ${props.items.length == 0 ? html`<${ST.Spinner} />` : matches ? (
                    matches.length == 0 ? html`<${ST.Empty}>No scripts match.</${ST.Empty}>` :
                    html`<ul class="st-tree">${matches.map(function (s) { return html`<${TreeScript} key=${s._id} script=${s} selId=${props.selId} onSelect=${props.onSelect} showPath=${true} />`; })}</ul>`
                ) : html`<ul class="st-tree">
                    ${tree.roots.map(function (f) { return html`<${TreeFolder} key=${f.item._id} folder=${f} selId=${props.selId} onSelect=${props.onSelect} collapsed=${props.collapsed} onToggle=${props.onToggle} manage=${props.manage} onDrop=${onDrop} />`; })}
                    ${tree.orphans.map(function (s) { return html`<${TreeScript} key=${s._id} script=${s} selId=${props.selId} onSelect=${props.onSelect} manage=${props.manage} />`; })}
                </ul>`}
                ${props.manage && props.items.length <= 1 ? html`<div class="form-text mt-2">Drop .ps1, .bat or .sh files here to add them.</div>` : null}
            </div>
        </div>`;
    }

    // ---- Selected item ----

    function ScriptPanel(props) {
        var item = props.item;
        if (item == null) return html`<div class="card st-card"><div class="card-body"><${ST.Empty} icon="file-earmark-code">Choose a script from the library to run it on this device.</${ST.Empty}></div></div>`;
        var a = props.actions;
        if (item.type == 'folder') {
            return html`<div class="card st-card"><div class="card-body">
                <div class="st-script-head"><${ST.Icon} name="folder2-open" class="st-folder-icon" /><span class="st-script-name">${item.name}</span></div>
                <div class="st-script-path">${item.path}</div>
                ${props.manage && item.path != 'Shared' ? html`<div class="st-run-actions">
                    <button class="btn btn-sm st-btn-quiet" onClick=${function () { a.rename(item); }}><${ST.Icon} name="pencil" class="me-1" />Rename</button>
                    <button class="btn btn-sm btn-outline-danger" onClick=${function () { a.remove(item); }}><${ST.Icon} name="trash3" class="me-1" />Delete</button>
                </div>` : null}
            </div></div>`;
        }
        var compat = compatibility(item.filetype);
        var blocked = compat && compat.block;
        return html`<div class="card st-card"><div class="card-body">
            <div class="st-script-head">
                <span class="st-script-name">${item.name}</span>
                <span class="st-type" title=${ST.fmt.filetype(item.filetype)}>${item.filetype}</span>
            </div>
            <div class="st-script-path">${item.path}</div>
            ${compat ? html`<div class=${'alert py-2 px-3 mt-2 mb-0 small ' + (blocked ? 'alert-warning' : 'alert-info')}><${ST.Icon} name=${blocked ? 'exclamation-triangle-fill' : 'info-circle'} class="me-1" />${compat.msg}</div>` : null}
            <div class="st-run-actions">
                ${props.canRun ? html`
                    <button class="btn btn-primary" disabled=${blocked} onClick=${function () { a.runNow(item); }}><${ST.Icon} name="play-fill" class="me-1" />Run now</button>
                    <button class="btn st-btn-quiet" disabled=${blocked} onClick=${function () { a.schedule(item); }}><${ST.Icon} name="calendar-plus" class="me-1" />Schedule…</button>` : null}
                ${props.manage ? html`
                    <button class="btn st-btn-quiet" onClick=${function () { a.runMany(item); }}><${ST.Icon} name="send" class="me-1" />Run on several devices…</button>
                    <div class="btn-group ms-auto" role="group" aria-label="Script actions">
                        <button class="btn st-btn-quiet" title="Edit" onClick=${function () { a.edit(item); }}><${ST.Icon} name="pencil" class="me-1" />Edit</button>
                        <button class="btn st-btn-quiet" title="Rename" aria-label="Rename" onClick=${function () { a.rename(item); }}>Rename</button>
                        <button class="btn st-btn-quiet" title="Download" aria-label="Download" onClick=${function () { a.download(item); }}><${ST.Icon} name="download" /></button>
                        <button class="btn btn-outline-danger" title="Delete" aria-label="Delete" onClick=${function () { a.remove(item); }}><${ST.Icon} name="trash3" /></button>
                    </div>` : null}
            </div>
        </div></div>`;
    }

    // ---- Queue ----

    function QueueCard(props) {
        var d = props.data, a = props.actions, user = props.user;
        var canChange = function (ownerId) { return props.manage || (ownerId != null && ownerId == user.id); };
        var schedules = d.schedules.slice().sort(function (x, y) { return ((x.nextRun == null) - (y.nextRun == null)) || ((x.nextRun || 0) - (y.nextRun || 0)); });
        return html`<div class="card st-card">
            <div class="card-header">
                <${ST.Icon} name="list-task" />Queue
                ${props.manage && d.queue.length > 1 ? html`<div class="st-actions"><button class="btn btn-sm btn-outline-danger" onClick=${a.cancelAll}>Cancel all pending</button></div>` : null}
            </div>
            <div class="card-body">
                <div class="st-section-title">Pending runs</div>
                ${d.queue.length == 0 ? html`<${ST.Empty}>Nothing waiting to run.</${ST.Empty}>` : html`
                <div class="table-responsive"><table class="table table-sm st-table">
                    <thead><tr><th>Script</th><th>Status</th><th>When</th><th>Run by</th><th class="st-col-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
                    <tbody>${d.queue.map(function (j) { return html`<tr key=${j._id}>
                        <td>${j.scriptName}</td>
                        <td><${ST.StatusBadge} status=${ST.jobStatus(j, d.online)} /></td>
                        <td class="text-nowrap">${(j.dontQueueUntil != null && j.dontQueueUntil > ST.now()) ? html`Due <${ST.Time} t=${j.dontQueueUntil} />` : html`Queued <${ST.Time} t=${j.queueTime} />`}</td>
                        <td>${j.runBy}${j.jobSchedule ? html` <span class="text-body-secondary small">(schedule)</span>` : null}</td>
                        <td class="st-col-actions">${canChange(j.runById) ? html`<button class="btn btn-sm btn-outline-danger" title="Cancel this run" onClick=${function () { a.cancelJob(j); }}><${ST.Icon} name="x-lg" /><span class="visually-hidden">Cancel</span></button>` : null}</td>
                    </tr>`; })}</tbody>
                </table></div>`}
                <div class="st-section-title">Schedules</div>
                ${schedules.length == 0 ? html`<${ST.Empty}>No schedules for this device.</${ST.Empty}>` : html`
                <div class="table-responsive"><table class="table table-sm st-table">
                    <thead><tr><th>Script</th><th>Repeat</th><th>Next run</th><th>Last run</th><th>Created by</th><th class="st-col-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
                    <tbody>${schedules.map(function (s) { return html`<tr key=${s._id}>
                        <td>${props.scriptName(s.scriptId)}</td>
                        <td>${ST.fmt.recurrence(s)}${s.endAt ? html`<div class="text-body-secondary small">until ${ST.fmt.time(s.endAt)}</div>` : null}</td>
                        <td><${ST.Time} t=${s.nextRun} empty="Not scheduled" /></td>
                        <td><${ST.Time} t=${s.lastRun} empty="Never" /></td>
                        <td>${s.scheduledBy}</td>
                        <td class="st-col-actions">${canChange(s.scheduledById) ? html`<button class="btn btn-sm btn-outline-danger" title="Delete this schedule" onClick=${function () { a.deleteSchedule(s); }}><${ST.Icon} name="trash3" /><span class="visually-hidden">Delete</span></button>` : null}</td>
                    </tr>`; })}</tbody>
                </table></div>`}
            </div>
        </div>`;
    }

    // ---- History ----

    function HistoryTable(props) {
        var limit = useState(25);
        var rows = props.jobs.slice(0, limit[0]);
        if (props.jobs.length == 0) return html`<${ST.Empty} icon="clock-history">${props.empty}</${ST.Empty}>`;
        return html`<div class="table-responsive"><table class="table table-sm table-hover st-table">
                <thead><tr><th>Finished</th>${props.showDevice ? html`<th>Device</th>` : html`<th>Script</th>`}<th>Status</th><th>Took</th><th>Run by</th><th>Output</th></tr></thead>
                <tbody>${rows.map(function (j) { var out = ST.jobOutput(j); return html`<tr key=${j._id} class="st-clickable" tabindex="0" onClick=${function () { props.onOpen(j); }} onKeyDown=${function (e) { if (e.key == 'Enter') props.onOpen(j); }}>
                    <td class="text-nowrap"><${ST.Time} t=${j.completeTime || j.queueTime} /></td>
                    <td class="text-nowrap">${props.showDevice ? nodeName(j.node) : j.scriptName}</td>
                    <td><${ST.StatusBadge} status=${ST.jobStatus(j, true)} /></td>
                    <td class="text-nowrap">${(j.completeTime && j.dispatchTime) ? ST.fmt.duration(j.completeTime - j.dispatchTime) : ''}</td>
                    <td>${j.runBy}</td>
                    <td><div class="st-output-preview">${out ? out.split('\n')[0] : html`<span class="text-body-tertiary">No output</span>`}</div></td>
                </tr>`; })}</tbody>
            </table>
            ${props.jobs.length > rows.length ? html`<button class="btn btn-sm btn-link" onClick=${function () { limit[1](limit[0] + 50); }}>Show more (${props.jobs.length - rows.length} older)</button>` : null}
        </div>`;
    }

    // ---- Variables (managers) ----

    var SCOPE_ORDER = { global: 0, script: 1, mesh: 2, node: 3 };
    var SCOPE_LABEL = { global: 'Global', script: 'Script', mesh: 'Device group', node: 'Device' };

    function VariablesCard(props) {
        var a = props.actions;
        // Variables that apply to this device and the selected script, most specific first; mark the ones that lose
        var relevant = (props.vars || []).filter(function (v) {
            if (v.scope == 'global') return true;
            if (v.scope == 'script') return props.script != null && v.scopeTarget == props.script._id;
            if (v.scope == 'mesh') return v.scopeTarget == node.meshid;
            if (v.scope == 'node') return v.scopeTarget == node._id;
            return false;
        }).sort(function (x, y) { return x.name.localeCompare(y.name) || (SCOPE_ORDER[y.scope] - SCOPE_ORDER[x.scope]); });
        var seen = {};
        relevant.forEach(function (v) { v._overridden = seen[v.name] === true; seen[v.name] = true; });
        return html`<div class="card st-card">
            <div class="card-header"><${ST.Icon} name="braces" />Variables<span class="text-body-secondary fw-normal small">for this device${props.script ? ' and ' + props.script.name : ''}</span>
                <div class="st-actions"><button class="btn btn-sm st-btn-quiet" onClick=${function () { a.editVar(null); }}><${ST.Icon} name="plus-lg" class="me-1" />New variable</button></div>
            </div>
            <div class="card-body">
                ${props.vars == null ? html`<${ST.Spinner} />` : relevant.length == 0 ? html`<${ST.Empty}>No variables apply here.</${ST.Empty}>` : html`
                <div class="table-responsive"><table class="table table-sm st-table">
                    <thead><tr><th>Name</th><th>Value</th><th>Applies to</th><th class="st-col-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
                    <tbody>${relevant.map(function (v) { return html`<tr key=${v._id} class=${v._overridden ? 'text-body-tertiary' : ''}>
                        <td><code>#${v.name}#</code></td>
                        <td><div class="st-output-preview">${v.value}</div>${v._overridden ? html`<div class="small">Overridden by a more specific value</div>` : null}</td>
                        <td>${SCOPE_LABEL[v.scope]}</td>
                        <td class="st-col-actions">
                            <button class="btn btn-sm st-btn-quiet me-1" title="Edit" onClick=${function () { a.editVar(v); }}><${ST.Icon} name="pencil" /><span class="visually-hidden">Edit</span></button>
                            <button class="btn btn-sm btn-outline-danger" title="Delete" onClick=${function () { a.deleteVar(v); }}><${ST.Icon} name="trash3" /><span class="visually-hidden">Delete</span></button>
                        </td>
                    </tr>`; })}</tbody>
                </table></div>`}
            </div>
        </div>`;
    }

    function NewScriptDialog(props) {
        var s = useState({ name: '', filetype: deviceIsWindows() === false ? 'bash' : 'ps1' }), f = s[0], setF = s[1];
        var submit = function (e) { e.preventDefault(); if (f.name.trim()) props.onSubmit(f); };
        return html`<${ST.Modal} title="New script" onClose=${props.onClose} footer=${html`
            <button type="button" class="btn btn-secondary" onClick=${props.onClose}>Cancel</button>
            <button type="submit" form="st-new-script" class="btn btn-primary" disabled=${!f.name.trim()}>Create and edit</button>`}>
            <form id="st-new-script" onSubmit=${submit}>
                <div class="mb-3"><label class="form-label" for="st-ns-name">Name</label><input id="st-ns-name" class="form-control" autofocus value=${f.name} onInput=${function (e) { setF(Object.assign({}, f, { name: e.target.value })); }} /></div>
                <label class="form-label" for="st-ns-type">Type</label>
                <select id="st-ns-type" class="form-select" value=${f.filetype} onChange=${function (e) { setF(Object.assign({}, f, { filetype: e.target.value })); }}>
                    <option value="ps1">PowerShell</option><option value="bat">Batch</option><option value="bash">Bash</option>
                </select>
                ${props.folder ? html`<div class="form-text">In ${props.folder}</div>` : null}
            </form>
        </${ST.Modal}>`;
    }

    // ---- App ----

    function App() {
        var st = useState({ init: null, error: null, items: [], data: null, vars: null, scriptData: null });
        var state = st[0], setState = st[1];
        var patch = useCallback(function (p) { setState(function (o) { return Object.assign({}, o, p); }); }, []);
        var sel = useState(store('selected')), selId = sel[0];
        var col = useState(store('collapsed') || []), collapsed = col[0];
        var dlg = useState(null), dialog = dlg[0], setDialog = dlg[1];
        var caps = state.init ? state.init.caps : null;
        var manage = caps != null && caps.manage;

        var loadTree = function () { return ST.rpc('tree').then(function (items) { patch({ items: items }); }); };
        var loadNode = function () { return ST.rpc('nodeData', { nodeId: node._id }).then(function (d) { patch({ data: d }); }); };
        var loadVars = function () { return ST.rpc('variables').then(function (v) { patch({ vars: v }); }); };
        var loadScriptData = function (id) { return ST.rpc('scriptData', { scriptId: id }).then(function (d) { patch({ scriptData: d }); }, function () { patch({ scriptData: null }); }); };

        useEffect(function () {
            if (node == null) { patch({ error: 'Open this tab from a device page in MeshCentral.' }); return; }
            ST.rpc('init', { nodeId: node._id }).then(function (init) {
                patch({ init: init });
                var jobs = [loadTree()];
                if (init.caps.run) jobs.push(loadNode());
                if (init.caps.manage) jobs.push(loadVars());
                return Promise.all(jobs);
            }).catch(function (e) { patch({ error: e.message }); });
        }, []);

        var selected = state.items.find(function (i) { return i._id == selId; }) || null;
        useEffect(function () {
            if (manage && selected && selected.type == 'script') loadScriptData(selected._id); else patch({ scriptData: null });
        }, [manage, selected ? selected._id : null]);

        // Re-query whatever a change notice says is out of date (debounced, as notices can come in bursts)
        var latest = useRef({});
        latest.current = { caps: caps, selId: selId, selType: selected ? selected.type : null };
        useEffect(function () {
            var due = {}, timer = null;
            var flush = function () {
                var c = latest.current.caps; timer = null;
                if (c == null) return;
                if (due.library) loadTree().catch(function () { });
                if (due.node && c.run) loadNode().catch(function () { });
                if (due.vars && c.manage) loadVars().catch(function () { });
                if (due.script && c.manage && latest.current.selType == 'script') loadScriptData(latest.current.selId);
                due = {};
            };
            return ST.onInvalidate(function (m) {
                if (m.library) due.library = true;
                if (m.variables) due.vars = true;
                if (m.nodeIds && m.nodeIds.indexOf(node._id) >= 0) due.node = true;
                if (m.scriptIds && m.scriptIds.indexOf(latest.current.selId) >= 0) due.script = true;
                if (timer == null) timer = setTimeout(flush, 250);
            });
        }, []);

        var select = function (item) { sel[1](item._id); store('selected', item._id); };
        var toggleFolder = function (path) {
            var next = (collapsed.indexOf(path) >= 0) ? collapsed.filter(function (p) { return p != path; }) : collapsed.concat([path]);
            col[1](next); store('collapsed', next);
        };
        var scriptName = function (id) { var s = state.items.find(function (i) { return i._id == id; }); return s ? s.name : '(deleted script)'; };
        var close = function () { setDialog(null); };
        var folderOf = function (item) { if (item == null) return 'Shared'; return item.path; };

        var actions = {
            runNow: function (item) {
                ST.ui.attempt(ST.rpc('runScript', { scriptId: item._id, nodeIds: [node._id] })).then(function (r) {
                    if (r == null) return;
                    if (r.accepted == 0) ST.ui.toast('You don\'t have permission to run scripts on this device.', 'error');
                    else ST.ui.toast((state.data && state.data.online) ? item.name + ' queued. It will start within a minute.' : item.name + ' queued. It will run when this device comes online.');
                });
            },
            schedule: function (item, nodeIds) {
                var many = nodeIds != null;
                setDialog(html`<${ST.dialogs.Schedule} title=${'Schedule ' + item.name} subtitle=${many ? 'On ' + nodeIds.length + ' devices' : 'On ' + node.name} onClose=${close} onSubmit=${function (sc) {
                    return ST.rpc('addSchedule', { scriptId: item._id, nodeIds: many ? nodeIds : [node._id], schedule: sc }).then(function (r) {
                        close();
                        ST.ui.toast('Scheduled on ' + r.accepted + ' device' + (r.accepted == 1 ? '' : 's') + (r.refused.length ? '. Skipped ' + r.refused.length + ' you can\'t run scripts on.' : '.'));
                    });
                }} />`);
            },
            runMany: function (item) {
                var nodes = (host.nodes || []).filter(function (n) { return n.mtype == 2; }).map(function (n) { return { _id: n._id, name: n.name, meshid: n.meshid, tags: n.tags, meshName: meshName(n.meshid) }; }).sort(function (x, y) { return x.name.localeCompare(y.name); });
                setDialog(html`<${ST.dialogs.DevicePicker} nodes=${nodes} initial=${[node._id]} scriptName=${item.name} onClose=${close}
                    onSchedule=${function (ids) { actions.schedule(item, ids); }}
                    onRun=${function (ids) {
                        ST.ui.attempt(ST.rpc('runScript', { scriptId: item._id, nodeIds: ids })).then(function (r) {
                            if (r == null) return;
                            close();
                            ST.ui.toast('Queued on ' + r.accepted + ' device' + (r.accepted == 1 ? '' : 's') + (r.refused.length ? '. Skipped ' + r.refused.length + ' you can\'t run scripts on.' : '.'));
                        });
                    }} />`);
            },
            cancelJob: function (j) {
                ST.ui.confirm({ title: 'Cancel this run?', body: html`<p class="mb-0">${j.scriptName} won't run on ${node.name}.${j.dispatchTime ? ' It was already sent to the device, so it may still finish there.' : ''}</p>`, confirmText: 'Cancel run', danger: true })
                .then(function (ok) { if (ok) ST.ui.attempt(ST.rpc('cancelJob', { jobId: j._id }), 'Run cancelled.'); });
            },
            cancelAll: function () {
                ST.ui.confirm({ title: 'Cancel all pending runs?', body: html`<p class="mb-0">All ${state.data.queue.length} pending runs on ${node.name} will be cancelled. Schedules stay, and create their next run as usual.</p>`, confirmText: 'Cancel all', danger: true })
                .then(function (ok) { if (ok) ST.ui.attempt(ST.rpc('cancelAllPending', { nodeId: node._id }), 'Pending runs cancelled.'); });
            },
            deleteSchedule: function (s) {
                ST.ui.confirm({ title: 'Delete this schedule?', body: html`<p class="mb-0">${scriptName(s.scriptId)} (${ST.fmt.recurrence(s).toLowerCase()}) will stop running on ${node.name}. Its pending run is cancelled too.</p>`, confirmText: 'Delete schedule', danger: true })
                .then(function (ok) { if (ok) ST.ui.attempt(ST.rpc('deleteSchedule', { scheduleId: s._id }), 'Schedule deleted.'); });
            },
            openOutput: function (j, showDevice) {
                setDialog(html`<${ST.dialogs.Output} job=${j} scriptName=${j.scriptName} deviceName=${showDevice ? nodeName(j.node) : null} onClose=${close} />`);
            },
            // Library (managers)
            newScript: function () {
                setDialog(html`<${NewScriptDialog} folder=${folderOf(selected)} onClose=${close} onSubmit=${function (f) {
                    ST.ui.attempt(ST.rpc('addScript', { name: f.name, filetype: f.filetype, content: '', folderId: selected ? selected._id : null })).then(function (r) {
                        if (r == null) return;
                        sel[1](r.id); store('selected', r.id);
                        setDialog(html`<${ST.dialogs.Editor} scriptId=${r.id} onClose=${close} />`);
                    });
                }} />`);
            },
            newFolder: function () {
                ST.ui.prompt({ title: 'New folder', label: 'Folder name (in ' + folderOf(selected) + ')', confirmText: 'Create' }).then(function (name) {
                    if (name) ST.ui.attempt(ST.rpc('newFolder', { name: name, parentId: selected ? selected._id : null }), 'Folder created.');
                });
            },
            upload: function (files, folderId) {
                Array.from(files).forEach(function (file) {
                    file.text().then(function (content) {
                        var type = detectType(file.name, content);
                        if (type == null) { ST.ui.toast(file.name + ' wasn\'t added. Only .ps1, .bat and Bash scripts are supported.', 'error'); return; }
                        ST.ui.attempt(ST.rpc('addScript', { name: file.name, content: content, filetype: type, folderId: folderId }), file.name + ' added.');
                    });
                });
            },
            move: function (id, folderId) { ST.ui.attempt(ST.rpc('move', { id: id, toId: folderId })); },
            edit: function (item) { setDialog(html`<${ST.dialogs.Editor} scriptId=${item._id} onClose=${close} />`); },
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
                ST.ui.confirm({ title: 'Delete ' + item.name + '?', body: body, confirmText: 'Delete', danger: true })
                .then(function (ok) { if (ok) ST.ui.attempt(ST.rpc('deleteItem', { id: item._id }), item.name + ' deleted.'); });
            },
            // Variables (managers)
            editVar: function (v) {
                if (v) v = Object.assign({}, v, { scopeTargetName: v.scope == 'script' ? scriptName(v.scopeTarget) : v.scope == 'mesh' ? meshName(v.scopeTarget) : v.scope == 'node' ? nodeName(v.scopeTarget) : null });
                var targets = {
                    script: (selected && selected.type == 'script') ? { id: selected._id, name: 'Script: ' + selected.name } : null,
                    mesh: { id: node.meshid, name: 'Device group: ' + meshName(node.meshid) },
                    node: { id: node._id, name: 'Device: ' + node.name }
                };
                setDialog(html`<${ST.dialogs.Variable} variable=${v} targets=${targets} onClose=${close} />`);
            },
            deleteVar: function (v) {
                ST.ui.confirm({ title: 'Delete #' + v.name + '#?', body: html`<p class="mb-0">Scripts that use it will get the next most specific value, or VAR_NOT_FOUND.</p>`, confirmText: 'Delete', danger: true })
                .then(function (ok) { if (ok) ST.ui.attempt(ST.rpc('deleteVar', { id: v._id }), 'Variable deleted.'); });
            }
        };

        useEffect(function () { if (state.init || state.error) document.body.classList.remove('st-loading'); }, [state.init, state.error]);

        if (document.documentElement.getAttribute('data-st-classic') == '1') {
            return html`<div class="alert alert-info st-classic-notice"><strong>ScriptTask needs the Modern UI.</strong> Switch to it from your account menu, then reopen this device.</div>`;
        }
        if (state.error) return html`<div class="alert alert-danger"><${ST.Icon} name="exclamation-triangle-fill" class="me-1" />${state.error}</div>`;
        if (state.init == null) return null;
        if (!caps.visible) return html`<div class="alert alert-warning">This device wasn't found, or you don't have access to it.</div>`;

        var d = state.data;
        var online = d ? d.online : state.init.node.online;
        return html`<div>
            <div class="st-strip">
                ${online ? html`<span class="badge text-bg-success"><${ST.Icon} name="wifi" class="me-1" />Online</span>` : html`<span class="badge st-badge-outline-warning"><${ST.Icon} name="wifi-off" class="me-1" />Offline</span>`}
                <span class="st-strip-note">${online ? 'Runs start within a minute.' : 'Runs wait until this device comes online.'}</span>
            </div>
            ${!caps.run ? html`<div class="alert alert-warning py-2"><${ST.Icon} name="lock" class="me-1" />${caps.remoteCommand
                ? 'You don\'t have the ScriptTask "Run scripts" permission on this device.'
                : 'You can\'t run scripts on this device. It needs the Remote Commands right in its device group.'}</div>` : null}
            <div class="row g-3">
                ${(caps.run || manage) ? html`<div class="col-lg-4">
                    <${Library} items=${state.items} selId=${selId} onSelect=${select} collapsed=${collapsed} onToggle=${toggleFolder} manage=${manage} actions=${actions} />
                </div>` : null}
                <div class=${(caps.run || manage) ? 'col-lg-8' : 'col-12'}>
                    ${(caps.run || manage) ? html`<${ScriptPanel} item=${selected} canRun=${caps.run} manage=${manage} actions=${actions} />` : null}
                    ${caps.run ? (d == null ? html`<${ST.Spinner} />` : html`
                        <${QueueCard} data=${d} manage=${manage} user=${state.init.user} actions=${actions} scriptName=${scriptName} />
                        <div class="card st-card">
                            <div class="card-header"><${ST.Icon} name="clock-history" />History</div>
                            <div class="card-body"><${HistoryTable} jobs=${d.history} empty="No runs on this device yet." onOpen=${function (j) { actions.openOutput(j, false); }} /></div>
                        </div>`) : null}
                    ${manage && selected && selected.type == 'script' ? html`<div class="card st-card">
                        <div class="card-header"><${ST.Icon} name="send" />${selected.name} on all devices</div>
                        <div class="card-body">
                            ${state.scriptData == null ? html`<${ST.Spinner} />` : html`
                                <div class="st-section-title">Schedules</div>
                                ${state.scriptData.schedules.length == 0 ? html`<${ST.Empty}>Not scheduled anywhere.</${ST.Empty}>` : html`<div class="table-responsive"><table class="table table-sm st-table">
                                    <thead><tr><th>Device</th><th>Repeat</th><th>Next run</th><th>Created by</th></tr></thead>
                                    <tbody>${state.scriptData.schedules.slice().sort(function (x, y) { return ((x.nextRun == null) - (y.nextRun == null)) || ((x.nextRun || 0) - (y.nextRun || 0)); }).map(function (s) { return html`<tr key=${s._id}><td>${nodeName(s.node)}</td><td>${ST.fmt.recurrence(s)}</td><td><${ST.Time} t=${s.nextRun} empty="Not scheduled" /></td><td>${s.scheduledBy}</td></tr>`; })}</tbody>
                                </table></div>`}
                                <div class="st-section-title">History</div>
                                <${HistoryTable} jobs=${state.scriptData.history.filter(function (j) { return j.completeTime != null; })} showDevice=${true} empty="This script hasn't run anywhere yet." onOpen=${function (j) { actions.openOutput(j, true); }} />`}
                        </div>
                    </div>` : null}
                    ${manage ? html`<${VariablesCard} vars=${state.vars} script=${selected && selected.type == 'script' ? selected : null} actions=${actions} />` : null}
                </div>
            </div>
            ${dialog}
        </div>`;
    }

    preact.render(html`<${App} />`, document.getElementById('app'));
    ST.autosize(160);
})();
