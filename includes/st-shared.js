/**
* @description ScriptTask pieces shared by the device tab and the server page: helpers, the library tree,
* and the schedule and history tables. Requires st-core.js and st-dialogs.js.
* @license Apache-2.0
*/

"use strict";

(function () {
    var html = ST.html;
    var useState = preactHooks.useState, useMemo = preactHooks.useMemo, useRef = preactHooks.useRef, useEffect = preactHooks.useEffect;
    var host = ST.host;
    var S = ST.shared = {};

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


    // Windows (true), not Windows (false), or unknown (null) for a device
    function isWindows(n) {
        if (n == null) return null;
        if (n.osdesc) return /windows/i.test(n.osdesc);
        if (n.agent && n.agent.id) return [1, 2, 3, 4, 21, 22, 34].indexOf(n.agent.id) >= 0;
        return null;
    }
    // Why a script type can't ({ block: true }) or might not run on a device
    function compatibility(filetype, win) {
        if (win === null) return null;
        if (filetype == 'bat' && !win) return { block: true, msg: 'Batch scripts only run on Windows.' };
        if (filetype == 'bash' && win) return { block: true, msg: 'Bash scripts don\'t run on Windows.' };
        if (filetype == 'ps1' && !win) return { block: false, msg: 'Needs PowerShell (pwsh) installed on this device.' };
        return null;
    }

    // ---- Script picker ----

    // Searchable list of library scripts. Favourites first, then by folder.
    // props.compat(filetype), if given, says why a script can't run (shown, but can't be chosen) or might not.
    function ScriptPicker(props) {
        var compatibility = props.compat || function () { return null; };
        var open = useState(false), q = useState(''), active = useState(-1);
        var root = useRef(null), list = useRef(null), listId = props.id || 'st-combo-list';
        var favs = props.favourites;
        var scripts = props.items.filter(function (i) { return i.type == 'script'; });
        var selected = scripts.find(function (s) { return s._id == props.value; }) || null;
        var query = q[0].trim().toLowerCase();
        var matches = scripts.filter(function (s) { return !query || s.name.toLowerCase().indexOf(query) >= 0 || s.path.toLowerCase().indexOf(query) >= 0; })
            .sort(function (a, b) { return ((favs.indexOf(b._id) >= 0) - (favs.indexOf(a._id) >= 0)) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name); });
        var choosable = matches.filter(function (s) { var c = compatibility(s.filetype); return !(c && c.block); });

        var close = function () { open[1](false); q[1](''); active[1](-1); };
        var choose = function (s) { props.onChange(s._id); close(); if (root.current) root.current.querySelector('input').blur(); };

        // Close when clicking elsewhere, and make sure the page is tall enough to show the whole list
        useEffect(function () {
            if (!open[0]) return;
            var onDown = function (e) { if (root.current && !root.current.contains(e.target)) close(); };
            document.addEventListener('mousedown', onDown);
            var prev = document.body.style.minHeight;
            if (list.current) document.body.style.minHeight = Math.ceil(list.current.getBoundingClientRect().bottom + window.scrollY + 16) + 'px';
            return function () { document.removeEventListener('mousedown', onDown); document.body.style.minHeight = prev; };
        }, [open[0]]);
        useEffect(function () {
            var el = list.current && list.current.querySelector('.st-combo-option.active');
            if (el) el.scrollIntoView({ block: 'nearest' });
        }, [active[0]]);

        var onKeyDown = function (e) {
            if (e.key == 'ArrowDown' || e.key == 'ArrowUp') {
                e.preventDefault();
                if (!open[0]) { open[1](true); return; }
                var i = choosable.findIndex(function (s) { return s._id == (choosable[active[0]] || {})._id; });
                i = (e.key == 'ArrowDown') ? Math.min(choosable.length - 1, i + 1) : Math.max(0, i - 1);
                active[1](i);
            } else if (e.key == 'Enter') {
                e.preventDefault();
                var pick = choosable[active[0]] || (choosable.length == 1 ? choosable[0] : null);
                if (pick) choose(pick);
            } else if (e.key == 'Escape') {
                close();
            }
        };

        var lastGroup = null;
        var rows = [];
        matches.forEach(function (s) {
            var group = (favs.indexOf(s._id) >= 0) ? 'Favourites' : s.path;
            if (group != lastGroup) { rows.push(html`<li key=${'g-' + group} class="st-combo-group" role="presentation">${group}</li>`); lastGroup = group; }
            var c = compatibility(s.filetype), blocked = c && c.block, fav = favs.indexOf(s._id) >= 0;
            var isActive = choosable[active[0]] && choosable[active[0]]._id == s._id;
            rows.push(html`<li key=${s._id} id=${'st-opt-' + s._id} role="option" aria-selected=${s._id == props.value} aria-disabled=${blocked ? 'true' : 'false'}
                class=${'st-combo-option' + (isActive ? ' active' : '') + (blocked ? ' st-disabled' : '') + (s._id == props.value ? ' st-current' : '')}
                title=${blocked ? c.msg : ''} onMouseDown=${function (e) { e.preventDefault(); if (!blocked) choose(s); }}>
                <button type="button" class=${'st-fav-btn' + (fav ? ' on' : '')} title=${fav ? 'Remove from favourites' : 'Add to favourites'} aria-label=${fav ? 'Remove from favourites' : 'Add to favourites'} aria-pressed=${fav}
                    onMouseDown=${function (e) { e.preventDefault(); e.stopPropagation(); props.onToggleFav(s._id); }}><${ST.Icon} name=${fav ? 'star-fill' : 'star'} /></button>
                <span class="st-combo-name">${s.name}${blocked ? html`<span class="st-combo-reason">${c.msg}</span>` : null}</span>
                <span class="st-type">${s.filetype}</span>
            </li>`);
        });

        return html`<div class="st-combo" ref=${root}>
            <div class="input-group">
                <span class="input-group-text"><${ST.Icon} name="search" /></span>
                <input type="text" class="form-control" role="combobox" aria-expanded=${open[0]} aria-controls=${listId} aria-autocomplete="list"
                    aria-activedescendant=${choosable[active[0]] ? 'st-opt-' + choosable[active[0]]._id : ''} aria-label="Script"
                    placeholder=${selected ? selected.name : 'Search the script library'} value=${open[0] ? q[0] : (selected ? selected.name : '')}
                    onFocus=${function () { open[1](true); }} onClick=${function () { open[1](true); }}
                    onInput=${function (e) { q[1](e.target.value); open[1](true); active[1](0); }} onKeyDown=${onKeyDown} />
            </div>
            ${open[0] ? html`<ul id=${listId} class="st-combo-menu" role="listbox" ref=${list}>
                ${scripts.length == 0 ? html`<li class="st-combo-empty">The library is empty.</li>` : matches.length == 0 ? html`<li class="st-combo-empty">No scripts match.</li>` : rows}
            </ul>` : null}
        </div>`;
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
                ${f.scripts.map(function (s) { return html`<${TreeScript} key=${s._id} script=${s} selId=${props.selId} onSelect=${props.onSelect} manage=${props.manage} compat=${props.compat} />`; })}
            </ul>`}
        </li>`;
    }

    function TreeScript(props) {
        var s = props.script;
        var compat = props.compat ? props.compat(s.filetype) : null;
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
                    html`<ul class="st-tree">${matches.map(function (s) { return html`<${TreeScript} key=${s._id} script=${s} selId=${props.selId} onSelect=${props.onSelect} showPath=${true} compat=${props.compat} />`; })}</ul>`
                ) : html`<ul class="st-tree">
                    ${tree.roots.map(function (f) { return html`<${TreeFolder} key=${f.item._id} folder=${f} selId=${props.selId} onSelect=${props.onSelect} collapsed=${props.collapsed} onToggle=${props.onToggle} manage=${props.manage} onDrop=${onDrop} compat=${props.compat} />`; })}
                    ${tree.orphans.map(function (s) { return html`<${TreeScript} key=${s._id} script=${s} selId=${props.selId} onSelect=${props.onSelect} manage=${props.manage} compat=${props.compat} />`; })}
                </ul>`}
                ${props.manage && props.items.length <= 1 ? html`<div class="form-text mt-2">Drop .ps1, .bat or .sh files here to add them.</div>` : null}
                ${props.footer ? html`<hr class="my-2" />${props.footer}` : null}
            </div>
        </div>`;
    }


    // A "Show more" button for a table showing the first rows of a longer list
    function ShowMore(props) {
        if (props.total <= props.limit[0]) return null;
        return html`<button class="btn btn-sm btn-link" onClick=${function () { props.limit[1](props.limit[0] + 25); }}>Show more (${props.total - props.limit[0]} more)</button>`;
    }

    // Soonest first; paused and finished schedules last
    function sortSchedules(list) {
        return list.slice().sort(function (x, y) { return ((x.paused === true) - (y.paused === true)) || ((x.nextRun == null) - (y.nextRun == null)) || ((x.nextRun || 0) - (y.nextRun || 0)); });
    }

    // props: schedules, showDevice (else the script column), scriptName(id), canChange(schedule), actions { editSchedule, pauseSchedule, deleteSchedule }, empty
    function ScheduleTable(props) {
        var limit = useState(10), a = props.actions;
        var schedules = sortSchedules(props.schedules);
        if (schedules.length == 0) return html`<${ST.Empty}>${props.empty}</${ST.Empty}>`;
        return html`<div class="table-responsive"><table class="table table-sm st-table">
            <thead><tr><th>${props.showDevice ? 'Device' : 'Script'}</th><th>Repeat</th><th>Next run</th><th>Last run</th><th>Created by</th><th class="st-col-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody>${schedules.slice(0, limit[0]).map(function (s) { return html`<tr key=${s._id}>
                <td>${props.showDevice ? nodeName(s.node) : props.scriptName(s.scriptId)}</td>
                <td>${ST.fmt.recurrence(s)}${ST.fmt.zoneNote(s) ? ' (' + ST.fmt.zoneNote(s) + ')' : ''}
                    <div class="text-body-secondary small">${ST.fmt.policy(s)}${s.endAt ? ', until ' + ST.fmt.time(s.endAt) : ''}</div></td>
                <td>${s.paused ? html`<${ST.StatusBadge} status="paused" />` : html`<${ST.Time} t=${s.nextRun} empty="Not scheduled" />`}</td>
                <td><${ST.Time} t=${s.lastRun} empty="Never" /></td>
                <td>${s.scheduledBy}</td>
                <td class="st-col-actions">${props.canChange(s) ? html`<div class="btn-group btn-group-sm" role="group" aria-label="Schedule actions">
                    <button class="btn st-btn-quiet" title="Edit this schedule" onClick=${function () { a.editSchedule(s); }}><${ST.Icon} name="pencil" /><span class="visually-hidden">Edit</span></button>
                    <button class="btn st-btn-quiet" title=${s.paused ? 'Resume this schedule' : 'Pause this schedule'} onClick=${function () { a.pauseSchedule(s, !s.paused); }}><${ST.Icon} name=${s.paused ? 'play-fill' : 'pause-fill'} /><span class="visually-hidden">${s.paused ? 'Resume' : 'Pause'}</span></button>
                    <button class="btn btn-outline-danger" title="Delete this schedule" onClick=${function () { a.deleteSchedule(s); }}><${ST.Icon} name="trash3" /><span class="visually-hidden">Delete</span></button>
                </div>` : null}</td>
            </tr>`; })}</tbody>
        </table><${ShowMore} total=${schedules.length} limit=${limit} /></div>`;
    }

    // Schedule actions for ScheduleTable. ctx: setDialog, close, settings() -> server settings, deviceName(schedule), scriptName(id)
    function scheduleActions(ctx) {
        return {
            editSchedule: function (s) {
                ctx.setDialog(html`<${ST.dialogs.Schedule} title=${'Edit schedule: ' + ctx.scriptName(s.scriptId)} subtitle=${'On ' + ctx.deviceName(s) + '. Saving restarts the schedule from now; its pending run is replaced.'} schedule=${s} settings=${ctx.settings()} onClose=${ctx.close} onSubmit=${function (sc) {
                    return ST.rpc('updateSchedule', { scheduleId: s._id, schedule: sc }).then(function () { ctx.close(); ST.ui.toast('Schedule saved.'); });
                }} />`);
            },
            pauseSchedule: function (s, paused) {
                ST.ui.attempt(ST.rpc('pauseSchedule', { scheduleId: s._id, paused: paused }), paused ? 'Schedule paused. Its pending run was removed.' : 'Schedule resumed from its next run.');
            },
            deleteSchedule: function (s) {
                ST.ui.confirm({ title: 'Delete this schedule?', body: html`<p class="mb-0">${ctx.scriptName(s.scriptId)} (${ST.fmt.recurrence(s).toLowerCase()}) will stop running on ${ctx.deviceName(s)}. Its pending run is cancelled too.</p>`, confirmText: 'Delete schedule', danger: true })
                .then(function (ok) { if (ok) ST.ui.attempt(ST.rpc('deleteSchedule', { scheduleId: s._id }), 'Schedule deleted.'); });
            }
        };
    }

    function HistoryTable(props) {
        var limit = useState(25);
        var rows = props.jobs.slice(0, limit[0]);
        if (props.jobs.length == 0) return html`<${ST.Empty} icon="clock-history">${props.empty}</${ST.Empty}>`;
        return html`<div class="table-responsive"><table class="table table-sm table-hover st-table">
                <thead><tr><th>Finished</th>${props.showDevice ? html`<th>Device</th>` : html`<th>Script</th>`}<th>Status</th><th>Took</th><th>Run by</th><th>Output</th>${props.onRunAgain ? html`<th class="st-col-actions"><span class="visually-hidden">Actions</span></th>` : null}</tr></thead>
                <tbody>${rows.map(function (j) { var out = ST.jobOutput(j); return html`<tr key=${j._id} class="st-clickable" tabindex="0" onClick=${function () { props.onOpen(j); }} onKeyDown=${function (e) { if (e.key == 'Enter') props.onOpen(j); }}>
                    <td class="text-nowrap"><${ST.Time} t=${j.completeTime || j.queueTime} /></td>
                    <td class="text-nowrap">${props.showDevice ? nodeName(j.node) : j.scriptName}</td>
                    <td><${ST.StatusBadge} status=${ST.jobStatus(j, true)} /></td>
                    <td class="text-nowrap">${(j.completeTime && j.dispatchTime) ? ST.fmt.duration(j.completeTime - j.dispatchTime) : ''}</td>
                    <td>${j.runBy}</td>
                    <td><div class="st-output-preview">${out ? out.split('\n')[0] : html`<span class="text-body-tertiary">No output</span>`}</div></td>
                    ${props.onRunAgain ? html`<td class="st-col-actions">${props.canRunAgain(j) ? html`<button class="btn btn-sm st-btn-quiet" title=${'Run ' + j.scriptName + ' again'} onClick=${function (e) { e.stopPropagation(); props.onRunAgain(j); }}><${ST.Icon} name="arrow-repeat" class="me-1" />Run again</button>` : null}</td>` : null}
                </tr>`; })}</tbody>
            </table>
            ${props.jobs.length > rows.length ? html`<button class="btn btn-sm btn-link" onClick=${function () { limit[1](limit[0] + 50); }}>Show more (${props.jobs.length - rows.length} older)</button>` : null}
        </div>`;
    }


    function NewScriptDialog(props) {
        var s = useState({ name: '', filetype: props.filetype || 'ps1' }), f = s[0], setF = s[1];
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


    // A variable's value in a list; secrets stay hidden until revealed
    function VarValue(props) {
        var v = props.variable, shown = useState(null);
        if (v.secret !== true) return html`<div class="st-output-preview">${v.value}</div>`;
        var reveal = function () {
            if (shown[0] != null) { shown[1](null); return; }
            ST.rpc('revealVar', { id: v._id }).then(function (val) { shown[1](val); }, function (e) { ST.ui.toast(e.message, 'error'); });
        };
        return html`<div class="st-secret">
            ${shown[0] != null ? html`<span class="st-output-preview">${shown[0]}</span>` : html`<span class="st-secret-mask" title="Secret">••••••••</span>`}
            <button type="button" class="btn btn-sm btn-link p-0" onClick=${reveal}>${shown[0] != null ? 'Hide' : 'Reveal'}</button>
        </div>`;
    }

    var SCOPE_ORDER = { global: 0, script: 1, mesh: 2, node: 3 };
    var SCOPE_LABEL = { global: 'Global', script: 'Script', mesh: 'Device group', node: 'Device' };

    Object.assign(S, {
        store: store, nodeName: nodeName, meshName: meshName, isWindows: isWindows, compatibility: compatibility, ScriptPicker: ScriptPicker, detectType: detectType, buildTree: buildTree,
        Library: Library, ShowMore: ShowMore, sortSchedules: sortSchedules, ScheduleTable: ScheduleTable, scheduleActions: scheduleActions,
        HistoryTable: HistoryTable, NewScriptDialog: NewScriptDialog, VarValue: VarValue, SCOPE_ORDER: SCOPE_ORDER, SCOPE_LABEL: SCOPE_LABEL
    });
})();
