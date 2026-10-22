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
                ${props.footer ? html`<hr class="my-2" />${props.footer}` : null}
            </div>
        </div>`;
    }

    // ---- Script picker ----

    // Searchable list of library scripts. Favourites first, then by folder. Scripts that can't run on this device are shown but can't be chosen.
    function ScriptPicker(props) {
        var open = useState(false), q = useState(''), active = useState(-1);
        var root = useRef(null), list = useRef(null);
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
                <input type="text" class="form-control" role="combobox" aria-expanded=${open[0]} aria-controls="st-combo-list" aria-autocomplete="list"
                    aria-activedescendant=${choosable[active[0]] ? 'st-opt-' + choosable[active[0]]._id : ''} aria-label="Script"
                    placeholder=${selected ? selected.name : 'Search the script library'} value=${open[0] ? q[0] : (selected ? selected.name : '')}
                    onFocus=${function () { open[1](true); }} onClick=${function () { open[1](true); }}
                    onInput=${function (e) { q[1](e.target.value); open[1](true); active[1](0); }} onKeyDown=${onKeyDown} />
            </div>
            ${open[0] ? html`<ul id="st-combo-list" class="st-combo-menu" role="listbox" ref=${list}>
                ${scripts.length == 0 ? html`<li class="st-combo-empty">The library is empty.</li>` : matches.length == 0 ? html`<li class="st-combo-empty">No scripts match.</li>` : rows}
            </ul>` : null}
        </div>`;
    }

    // ---- Run a script ----

    function RunCard(props) {
        var a = props.actions;
        var item = props.items.find(function (i) { return i._id == props.runId && i.type == 'script'; }) || null;
        var compat = item ? compatibility(item.filetype) : null;
        var blocked = compat && compat.block;
        return html`<div class="card st-card">
            <div class="card-header"><${ST.Icon} name="play-fill" />Run a script</div>
            <div class="card-body">
                <${ScriptPicker} items=${props.items} value=${props.runId} onChange=${props.onChoose} favourites=${props.favourites} onToggleFav=${props.onToggleFav} />
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
                            <button class="btn st-btn-quiet" onClick=${function () { a.runMany(item); }}><${ST.Icon} name="send" class="me-1" />Run on several devices…</button>
                            <button class="btn st-btn-quiet ms-auto" onClick=${function () { a.edit(item); }}><${ST.Icon} name="pencil" class="me-1" />Edit script</button>` : null}
                    </div>
                </div>`}
            </div>
        </div>`;
    }

    // ---- Library management (managers, until the server page exists) ----

    function LibraryItemActions(props) {
        var item = props.item, a = props.actions;
        if (item == null) return html`<div class="form-text">Select a script or folder to rename, download or delete it. Drag items onto folders to move them.</div>`;
        var isRoot = item.type == 'folder' && item.path == 'Shared';
        return html`<div class="st-lib-actions">
            <div class="st-script-head">
                <${ST.Icon} name=${item.type == 'folder' ? 'folder2-open' : 'file-earmark-code'} class=${item.type == 'folder' ? 'st-folder-icon' : 'text-body-secondary'} />
                <span class="fw-semibold">${item.name}</span>
                <span class="st-script-path">${item.path}</span>
            </div>
            <div class="st-run-actions mt-2">
                ${item.type == 'script' ? html`
                    <button class="btn btn-sm st-btn-quiet" onClick=${function () { a.edit(item); }}><${ST.Icon} name="pencil" class="me-1" />Edit</button>
                    <button class="btn btn-sm st-btn-quiet" onClick=${function () { a.download(item); }}><${ST.Icon} name="download" class="me-1" />Download</button>` : null}
                ${!isRoot ? html`
                    <button class="btn btn-sm st-btn-quiet" onClick=${function () { a.rename(item); }}>Rename</button>
                    <button class="btn btn-sm btn-outline-danger" onClick=${function () { a.remove(item); }}><${ST.Icon} name="trash3" class="me-1" />Delete</button>` : html`<span class="form-text">The top-level folder can't be renamed or deleted.</span>`}
            </div>
        </div>`;
    }

    // ---- Queue ----

    function QueueCard(props) {
        var d = props.data, a = props.actions, user = props.user;
        var canChange = function (ownerId) { return props.manage || (ownerId != null && ownerId == user.id); };
        // Soonest first; paused and finished schedules last
        var schedules = d.schedules.slice().sort(function (x, y) { return ((x.paused === true) - (y.paused === true)) || ((x.nextRun == null) - (y.nextRun == null)) || ((x.nextRun || 0) - (y.nextRun || 0)); });
        var qLimit = useState(10), sLimit = useState(10);
        var more = function (total, limit) {
            if (total <= limit[0]) return null;
            return html`<button class="btn btn-sm btn-link" onClick=${function () { limit[1](limit[0] + 25); }}>Show more (${total - limit[0]} more)</button>`;
        };
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
                </table>${more(d.queue.length, qLimit)}</div>`}
                <div class="st-section-title">Schedules</div>
                ${schedules.length == 0 ? html`<${ST.Empty}>No schedules for this device.</${ST.Empty}>` : html`
                <div class="table-responsive"><table class="table table-sm st-table">
                    <thead><tr><th>Script</th><th>Repeat</th><th>Next run</th><th>Last run</th><th>Created by</th><th class="st-col-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
                    <tbody>${schedules.slice(0, sLimit[0]).map(function (s) { return html`<tr key=${s._id}>
                        <td>${props.scriptName(s.scriptId)}</td>
                        <td>${ST.fmt.recurrence(s)}${ST.fmt.zoneNote(s) ? ' (' + ST.fmt.zoneNote(s) + ')' : ''}
                            <div class="text-body-secondary small">${ST.fmt.policy(s)}${s.endAt ? ', until ' + ST.fmt.time(s.endAt) : ''}</div></td>
                        <td>${s.paused ? html`<${ST.StatusBadge} status="paused" />` : html`<${ST.Time} t=${s.nextRun} empty="Not scheduled" />`}</td>
                        <td><${ST.Time} t=${s.lastRun} empty="Never" /></td>
                        <td>${s.scheduledBy}</td>
                        <td class="st-col-actions">${canChange(s.scheduledById) ? html`<div class="btn-group btn-group-sm" role="group" aria-label="Schedule actions">
                            <button class="btn st-btn-quiet" title="Edit this schedule" onClick=${function () { a.editSchedule(s); }}><${ST.Icon} name="pencil" /><span class="visually-hidden">Edit</span></button>
                            <button class="btn st-btn-quiet" title=${s.paused ? 'Resume this schedule' : 'Pause this schedule'} onClick=${function () { a.pauseSchedule(s, !s.paused); }}><${ST.Icon} name=${s.paused ? 'play-fill' : 'pause-fill'} /><span class="visually-hidden">${s.paused ? 'Resume' : 'Pause'}</span></button>
                            <button class="btn btn-outline-danger" title="Delete this schedule" onClick=${function () { a.deleteSchedule(s); }}><${ST.Icon} name="trash3" /><span class="visually-hidden">Delete</span></button>
                        </div>` : null}</td>
                    </tr>`; })}</tbody>
                </table>${more(schedules.length, sLimit)}</div>`}
            </div>
        </div>`;
    }

    // ---- History ----

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
        var sel = useState(store('libSelected')), selId = sel[0]; // Library tree selection (script or folder)
        var run = useState(store('runScript')), runId = run[0]; // Script chosen to run
        var fav = useState([]), favourites = fav[0];
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
                fav[1](store('favourites.' + init.user.id) || []);
                patch({ init: init });
                var jobs = [loadTree()];
                if (init.caps.run) jobs.push(loadNode());
                if (init.caps.manage) jobs.push(loadVars());
                return Promise.all(jobs);
            }).catch(function (e) { patch({ error: e.message }); });
        }, []);

        var selected = state.items.find(function (i) { return i._id == selId; }) || null;
        var runItem = state.items.find(function (i) { return i._id == runId && i.type == 'script'; }) || null;
        useEffect(function () {
            if (manage && runItem) loadScriptData(runItem._id); else patch({ scriptData: null });
        }, [manage, runItem ? runItem._id : null]);

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
                if (due.script && c.manage && latest.current.runId) loadScriptData(latest.current.runId);
                due = {};
            };
            return ST.onInvalidate(function (m) {
                if (m.library) due.library = true;
                if (m.variables) due.vars = true;
                if (m.nodeIds && m.nodeIds.indexOf(node._id) >= 0) due.node = true;
                if (m.scriptIds && m.scriptIds.indexOf(latest.current.runId) >= 0) due.script = true;
                if (timer == null) timer = setTimeout(flush, 250);
            });
        }, []);

        var choose = function (id) { run[1](id); store('runScript', id); };
        // Selecting a script in the library also makes it the script to run
        var select = function (item) { sel[1](item._id); store('libSelected', item._id); if (item.type == 'script') choose(item._id); };
        var toggleFav = function (id) {
            var next = (favourites.indexOf(id) >= 0) ? favourites.filter(function (x) { return x != id; }) : favourites.concat([id]);
            fav[1](next); store('favourites.' + state.init.user.id, next);
        };
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
                setDialog(html`<${ST.dialogs.Schedule} title=${'Schedule ' + item.name} subtitle=${many ? 'On ' + nodeIds.length + ' devices' : 'On ' + node.name} settings=${state.init.settings} onClose=${close} onSubmit=${function (sc) {
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
            editSchedule: function (s) {
                setDialog(html`<${ST.dialogs.Schedule} title=${'Edit schedule: ' + scriptName(s.scriptId)} subtitle=${'On ' + node.name + '. Saving restarts the schedule from now; its pending run is replaced.'} schedule=${s} settings=${state.init.settings} onClose=${close} onSubmit=${function (sc) {
                    return ST.rpc('updateSchedule', { scheduleId: s._id, schedule: sc }).then(function () { close(); ST.ui.toast('Schedule saved.'); });
                }} />`);
            },
            pauseSchedule: function (s, paused) {
                ST.ui.attempt(ST.rpc('pauseSchedule', { scheduleId: s._id, paused: paused }), paused ? 'Schedule paused. Its pending run was removed.' : 'Schedule resumed from its next run.');
            },
            openSettings: function () {
                ST.rpc('init', { nodeId: node._id }).then(function (fresh) {
                    setDialog(html`<${ST.dialogs.Settings} settings=${fresh.settings} onClose=${close} onSaved=${function (saved) { patch({ init: Object.assign({}, state.init, { settings: saved }) }); close(); }} />`);
                }, function (e) { ST.ui.toast(e.message, 'error'); });
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
                        sel[1](r.id); store('libSelected', r.id); choose(r.id);
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
                    <div class="card-body"><${HistoryTable} jobs=${d.history} empty="No runs on this device yet." onOpen=${function (j) { actions.openOutput(j, false); }}
                        canRunAgain=${function (j) { var sc = state.items.find(function (i) { return i._id == j.scriptId; }); var c = sc ? compatibility(sc.filetype) : null; return sc != null && !(c && c.block); }}
                        onRunAgain=${function (j) { var sc = state.items.find(function (i) { return i._id == j.scriptId; }); if (sc) actions.runNow(sc); }} /></div>
                </div>`) : null}
            ${manage ? html`
                <div class="st-group-title d-flex align-items-center gap-2"><span><${ST.Icon} name="lock" class="me-1" />Manager tools<span class="fw-normal"> · only ScriptTask managers see these. They move to the ScriptTask server page in a later release.</span></span>
                    <button class="btn btn-sm st-btn-quiet ms-auto" onClick=${actions.openSettings}><${ST.Icon} name="gear" class="me-1" />Settings</button></div>
                <div class="row g-3">
                    <div class="col-xl-5">
                        <${Library} items=${state.items} selId=${selId} onSelect=${select} collapsed=${collapsed} onToggle=${toggleFolder} manage=${manage} actions=${actions}
                            footer=${html`<${LibraryItemActions} item=${selected} actions=${actions} />`} />
                    </div>
                    <div class="col-xl-7">
                        ${runItem ? html`<div class="card st-card">
                            <div class="card-header"><${ST.Icon} name="send" />${runItem.name} on all devices</div>
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
                        <${VariablesCard} vars=${state.vars} script=${runItem} actions=${actions} />
                    </div>
                </div>` : null}
            ${dialog}
        </div>`;
    }

    preact.render(html`<${App} />`, document.getElementById('app'));
    ST.autosize(160);
})();
