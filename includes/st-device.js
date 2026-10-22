/**
* @description ScriptTask device tab: run and schedule library scripts on one device, and see its queue and history.
* ScriptTask managers also get multi-device runs, the variables that apply here, and links to the ScriptTask page.
* Requires st-core.js, st-dialogs.js, st-editor.js and st-shared.js.
* @license Apache-2.0
*/

"use strict";

(function () {
    var html = ST.html;
    var useState = preactHooks.useState, useEffect = preactHooks.useEffect, useMemo = preactHooks.useMemo, useRef = preactHooks.useRef, useCallback = preactHooks.useCallback;
    var host = ST.host;
    var node = host ? host.currentNode : null;
    var S = ST.shared, store = S.store, nodeName = S.nodeName, meshName = S.meshName;

    // ---- Small helpers ----

    // Why a script type can't (or might not) run on this device
    function compatibility(filetype) { return S.compatibility(filetype, S.isWindows(node)); }

    // ---- Run a script ----

    function RunCard(props) {
        var a = props.actions;
        var item = props.items.find(function (i) { return i._id == props.runId && i.type == 'script'; }) || null;
        var compat = item ? compatibility(item.filetype) : null;
        var blocked = compat && compat.block;
        return html`<div class="card st-card">
            <div class="card-header"><${ST.Icon} name="play-fill" />Run a script</div>
            <div class="card-body">
                <${S.ScriptPicker} items=${props.items} value=${props.runId} onChange=${props.onChoose} favourites=${props.favourites} onToggleFav=${props.onToggleFav} compat=${compatibility} />
                ${item == null ? html`<div class="form-text mt-2">Choose a script. Star the ones you use often to keep them at the top.</div>` : html`
                <div class="st-chosen">
                    <div class="st-script-head">
                        <span class="st-script-name">${item.name}</span>
                        <span class="st-type" title=${ST.fmt.filetype(item.filetype)}>${item.filetype}</span>
                        <span class="st-script-path">${item.path}</span>
                    </div>
                    ${compat ? html`<div class=${'alert py-2 px-3 mt-2 mb-0 small ' + (blocked ? 'alert-warning' : 'alert-info')}><${ST.Icon} name=${blocked ? 'exclamation-triangle-fill' : 'info-circle'} class="me-1" />${compat.msg}</div>` : null}
                    <div class="st-run-actions">
                        ${props.canRun ? html`
                            <button class="btn btn-primary" disabled=${blocked} onClick=${function () { a.runNow(item); }}><${ST.Icon} name="play-fill" class="me-1" />Run now</button>
                            <button class="btn st-btn-quiet" disabled=${blocked} onClick=${function () { a.schedule(item); }}><${ST.Icon} name="calendar-plus" class="me-1" />Schedule…</button>` : null}
                        ${props.manage ? html`
                            <button class="btn st-btn-quiet" onClick=${function () { a.runMany(item); }}><${ST.Icon} name="send" class="me-1" />Run on several devices…<${ST.Icon} name="box-arrow-up-right" class="ms-1 small" /></button>
                            <button class="btn st-btn-quiet ms-auto" onClick=${function () { a.openLibrary(item._id); }}><${ST.Icon} name="pencil" class="me-1" />Edit in library<${ST.Icon} name="box-arrow-up-right" class="ms-1 small" /></button>` : null}
                    </div>
                </div>`}
            </div>
        </div>`;
    }

    // ---- Queue ----

    function QueueCard(props) {
        var d = props.data, a = props.actions, user = props.user;
        var canChange = function (ownerId) { return props.manage || (ownerId != null && ownerId == user.id); };
        var qLimit = useState(10);
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
                    <tbody>${d.queue.slice(0, qLimit[0]).map(function (j) { return html`<tr key=${j._id}>
                        <td>${j.scriptName}</td>
                        <td><${ST.StatusBadge} status=${ST.jobStatus(j, d.online)} /></td>
                        <td class="text-nowrap">${(j.dontQueueUntil != null && j.dontQueueUntil > ST.now()) ? html`Due <${ST.Time} t=${j.dontQueueUntil} />` : html`Queued <${ST.Time} t=${j.queueTime} />`}
                            ${(j.expiresAt != null && j.dispatchTime == null && j.expiresAt > ST.now()) ? html`<div class="text-body-secondary small">Skipped if not sent by ${ST.fmt.time(j.expiresAt)}</div>` : null}</td>
                        <td>${j.runBy}${j.jobSchedule ? html` <span class="text-body-secondary small">(schedule)</span>` : null}</td>
                        <td class="st-col-actions">${canChange(j.runById) ? html`<button class="btn btn-sm btn-outline-danger" title="Cancel this run" onClick=${function () { a.cancelJob(j); }}><${ST.Icon} name="x-lg" /><span class="visually-hidden">Cancel</span></button>` : null}</td>
                    </tr>`; })}</tbody>
                </table><${S.ShowMore} total=${d.queue.length} limit=${qLimit} /></div>`}
                <div class="st-section-title">Schedules</div>
                <${S.ScheduleTable} schedules=${d.schedules} scriptName=${props.scriptName} canChange=${function (sc) { return canChange(sc.scheduledById); }} actions=${a} empty="No schedules for this device." />
            </div>
        </div>`;
    }

    // ---- Variables (managers) ----

    var SCOPE_ORDER = S.SCOPE_ORDER, SCOPE_LABEL = S.SCOPE_LABEL;

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

    // ---- App ----

    function App() {
        var st = useState({ init: null, error: null, items: [], data: null, vars: null });
        var state = st[0], setState = st[1];
        var patch = useCallback(function (p) { setState(function (o) { return Object.assign({}, o, p); }); }, []);
        var run = useState(store('runScript')), runId = run[0]; // Script chosen to run
        var fav = useState([]), favourites = fav[0];
        var dlg = useState(null), dialog = dlg[0], setDialog = dlg[1];
        var caps = state.init ? state.init.caps : null;
        var manage = caps != null && caps.manage;

        var loadTree = function () { return ST.rpc('tree').then(function (items) { patch({ items: items }); }); };
        var loadNode = function () { return ST.rpc('nodeData', { nodeId: node._id }).then(function (d) { patch({ data: d }); }); };
        var loadVars = function () { return ST.rpc('variables').then(function (v) { patch({ vars: v }); }); };

        useEffect(function () {
            if (node == null) { patch({ error: 'Open this tab from a device page in MeshCentral.' }); return; }
            ST.rpc('init', { nodeId: node._id }).then(function (init) {
                fav[1](store('favourites.' + init.user.id) || []);
                patch({ init: init });
                var jobs = [loadTree()];
                if (init.caps.run) jobs.push(loadNode());
                if (init.caps.manage) jobs.push(loadVars());
                return Promise.all(jobs);
            }).catch(function (e) { patch({ error: e.message }); });
        }, []);

        var runItem = state.items.find(function (i) { return i._id == runId && i.type == 'script'; }) || null;

        // Re-query whatever a change notice says is out of date (debounced, as notices can come in bursts)
        var latest = useRef({});
        latest.current = { caps: caps, runId: runItem ? runItem._id : null };
        useEffect(function () {
            var due = {}, timer = null;
            var flush = function () {
                var c = latest.current.caps; timer = null;
                if (c == null) return;
                if (due.library) loadTree().catch(function () { });
                if (due.node && c.run) loadNode().catch(function () { });
                if (due.vars && c.manage) loadVars().catch(function () { });
                if (due.settings) ST.rpc('init', { nodeId: node._id }).then(function (fresh) { setState(function (o) { return Object.assign({}, o, { init: Object.assign({}, o.init, { settings: fresh.settings }) }); }); }, function () { });
                due = {};
            };
            return ST.onInvalidate(function (m) {
                if (m.library) due.library = true;
                if (m.variables) due.vars = true;
                if (m.settings) due.settings = true;
                if (m.nodeIds && m.nodeIds.indexOf(node._id) >= 0) due.node = true;
                if (timer == null) timer = setTimeout(flush, 250);
            });
        }, []);

        var choose = function (id) { run[1](id); store('runScript', id); };
        var toggleFav = function (id) {
            var next = (favourites.indexOf(id) >= 0) ? favourites.filter(function (x) { return x != id; }) : favourites.concat([id]);
            fav[1](next); store('favourites.' + state.init.user.id, next);
        };
        var scriptName = function (id) { var s = state.items.find(function (i) { return i._id == id; }); return s ? s.name : '(deleted script)'; };
        var close = function () { setDialog(null); };

        var actions = Object.assign(S.scheduleActions({ setDialog: setDialog, close: close, settings: function () { return state.init.settings; }, deviceName: function () { return node.name; }, scriptName: scriptName }), {
            // Open the ScriptTask page (My Server > Plugins) at a script, or at the library
            openLibrary: function (scriptId) {
                store('openRoute', scriptId ? '#/library/' + scriptId : '#/library');
                if (typeof host.goPlugin == 'function') host.goPlugin('scripttask', 'ScriptTask');
            },
            runNow: function (item) {
                ST.ui.attempt(ST.rpc('runScript', { scriptId: item._id, nodeIds: [node._id] })).then(function (r) {
                    if (r == null) return;
                    if (r.accepted == 0) ST.ui.toast('You don\'t have permission to run scripts on this device.', 'error');
                    else ST.ui.toast((state.data && state.data.online) ? item.name + ' queued. It will start within a minute.' : item.name + ' queued. It will run when this device comes online.');
                });
            },
            schedule: function (item) {
                setDialog(html`<${ST.dialogs.Schedule} title=${'Schedule ' + item.name} subtitle=${'On ' + node.name} settings=${state.init.settings} onClose=${close} onSubmit=${function (sc) {
                    return ST.rpc('addSchedule', { scriptId: item._id, nodeIds: [node._id], schedule: sc }).then(function (r) {
                        close();
                        ST.ui.toast(r.accepted ? 'Scheduled.' : 'You can\'t run scripts on this device.', r.accepted ? undefined : 'error');
                    });
                }} />`);
            },
            // Multi-device runs are on the ScriptTask page, starting with this script and this device
            runMany: function (item) {
                store('openRoute', '#/run?script=' + encodeURIComponent(item._id) + '&devices=' + encodeURIComponent(node._id));
                if (typeof host.goPlugin == 'function') host.goPlugin('scripttask', 'ScriptTask');
            },
            cancelJob: function (j) {
                ST.ui.confirm({ title: 'Cancel this run?', body: html`<p class="mb-0">${j.scriptName} won't run on ${node.name}.${j.dispatchTime ? ' It was already sent to the device, so it may still finish there.' : ''}</p>`, confirmText: 'Cancel run', danger: true })
                .then(function (ok) { if (ok) ST.ui.attempt(ST.rpc('cancelJob', { jobId: j._id }), 'Run cancelled.'); });
            },
            cancelAll: function () {
                ST.ui.confirm({ title: 'Cancel all pending runs?', body: html`<p class="mb-0">All ${state.data.queue.length} pending runs on ${node.name} will be cancelled. Schedules stay, and create their next run as usual.</p>`, confirmText: 'Cancel all', danger: true })
                .then(function (ok) { if (ok) ST.ui.attempt(ST.rpc('cancelAllPending', { nodeId: node._id }), 'Pending runs cancelled.'); });
            },
            openOutput: function (j, showDevice) {
                setDialog(html`<${ST.dialogs.Output} job=${j} scriptName=${j.scriptName} deviceName=${showDevice ? nodeName(j.node) : null} onClose=${close} />`);
            },
            // Variables (managers)
            editVar: function (v) {
                if (v) v = Object.assign({}, v, { scopeTargetName: v.scope == 'script' ? scriptName(v.scopeTarget) : v.scope == 'mesh' ? meshName(v.scopeTarget) : v.scope == 'node' ? nodeName(v.scopeTarget) : null });
                var targets = {
                    script: runItem ? { id: runItem._id, name: 'Script: ' + runItem.name } : null,
                    mesh: { id: node.meshid, name: 'Device group: ' + meshName(node.meshid) },
                    node: { id: node._id, name: 'Device: ' + node.name }
                };
                setDialog(html`<${ST.dialogs.Variable} variable=${v} targets=${targets} onClose=${close} />`);
            },
            deleteVar: function (v) {
                ST.ui.confirm({ title: 'Delete #' + v.name + '#?', body: html`<p class="mb-0">Scripts that use it will get the next most specific value, or VAR_NOT_FOUND.</p>`, confirmText: 'Delete', danger: true })
                .then(function (ok) { if (ok) ST.ui.attempt(ST.rpc('deleteVar', { id: v._id }), 'Variable deleted.'); });
            }
        });

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
                ${node.osdesc ? html`<span class="st-strip-end st-strip-note">${node.osdesc}</span>` : null}
            </div>
            ${!caps.run ? html`<div class="alert alert-warning py-2"><${ST.Icon} name="lock" class="me-1" />${caps.remoteCommand
                ? 'You don\'t have the ScriptTask "Run scripts" permission on this device.'
                : 'You can\'t run scripts on this device. It needs the Remote Commands right in its device group.'}</div>` : null}
            ${(caps.run || manage) ? html`<${RunCard} items=${state.items} runId=${runId} onChoose=${choose} favourites=${favourites} onToggleFav=${toggleFav} canRun=${caps.run} manage=${manage} actions=${actions} />` : null}
            ${caps.run ? (d == null ? html`<${ST.Spinner} />` : html`
                <${QueueCard} data=${d} manage=${manage} user=${state.init.user} actions=${actions} scriptName=${scriptName} />
                <div class="card st-card">
                    <div class="card-header"><${ST.Icon} name="clock-history" />History</div>
                    <div class="card-body"><${S.HistoryTable} jobs=${d.history} empty="No runs on this device yet." onOpen=${function (j) { actions.openOutput(j, false); }}
                        canRunAgain=${function (j) { var sc = state.items.find(function (i) { return i._id == j.scriptId; }); var c = sc ? compatibility(sc.filetype) : null; return sc != null && !(c && c.block); }}
                        onRunAgain=${function (j) { var sc = state.items.find(function (i) { return i._id == j.scriptId; }); if (sc) actions.runNow(sc); }} /></div>
                </div>`) : null}
            ${manage ? html`
                <div class="st-group-title d-flex align-items-center gap-2"><span><${ST.Icon} name="lock" class="me-1" />Manager tools<span class="fw-normal"> · only ScriptTask managers see these</span></span>
                    <button class="btn btn-sm st-btn-quiet ms-auto" onClick=${function () { actions.openLibrary(null); }}><${ST.Icon} name="folder2-open" class="me-1" />Open ScriptTask<${ST.Icon} name="box-arrow-up-right" class="ms-1 small" /></button></div>
                <${VariablesCard} vars=${state.vars} script=${runItem} actions=${actions} />` : null}
            ${dialog}
        </div>`;
    }

    preact.render(html`<${App} />`, document.getElementById('app'));
    ST.autosize(160);
})();
