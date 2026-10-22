/**
* @description ScriptTask dialogs shared by plugin pages: schedule, output viewer, script editor, variable, device picker.
* Requires st-core.js.
* @license Apache-2.0
*/

"use strict";

(function () {
    var html = ST.html;
    var useState = preactHooks.useState, useEffect = preactHooks.useEffect, useMemo = preactHooks.useMemo, useRef = preactHooks.useRef;
    ST.dialogs = {};

    function pad(n) { return (n < 10 ? '0' : '') + n; }
    // Format a Date for <input type="datetime-local">
    function localInput(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
    function fromLocalInput(v) { var t = new Date(v).getTime(); return isNaN(t) ? null : Math.floor(t / 1000); }
    function nextFiveMinutes() { var d = new Date(Date.now() + 60000); d.setSeconds(0, 0); d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5); return d; }

    // ---- Schedule ----

    var RECURS = [['once', 'Once'], ['minutes', 'Minutes'], ['hourly', 'Hourly'], ['daily', 'Daily'], ['weekly', 'Weekly']];
    var UNITS = { minutes: 'minute(s)', hourly: 'hour(s)', daily: 'day(s)', weekly: 'week(s)' };
    var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // props: title, subtitle, onSubmit(schedule) -> Promise (resolve to close), onClose
    ST.dialogs.Schedule = function (props) {
        var s = useState({ recur: 'once', start: localInput(nextFiveMinutes()), interval: 1, days: [new Date().getDay()], endNever: true, end: '' });
        var f = s[0], setF = s[1];
        var busy = useState(false);
        var err = useState(null);
        var set = function (k, v) { setF(function (o) { var n = Object.assign({}, o); n[k] = v; return n; }); };
        var toggleDay = function (d) { set('days', (f.days.indexOf(d) >= 0) ? f.days.filter(function (x) { return x != d; }) : f.days.concat([d])); };

        var schedule = function () {
            var sc = { recur: f.recur, startAt: fromLocalInput(f.start), interval: Number(f.interval), daysOfWeek: f.days.map(String), endAt: null };
            if (sc.startAt == null) throw new Error('Choose a start time.');
            if (f.recur != 'once' && !(sc.interval >= 1)) throw new Error('Interval must be at least 1.');
            if (f.recur == 'weekly' && f.days.length == 0) throw new Error('Choose at least one day.');
            if (f.recur != 'once' && !f.endNever) {
                sc.endAt = fromLocalInput(f.end);
                if (sc.endAt == null) throw new Error('Choose an end time, or tick Never.');
                if (sc.endAt <= sc.startAt) throw new Error('The end time must be after the start time.');
            }
            return sc;
        };
        var summary = (function () {
            try {
                var sc = schedule();
                var txt = ST.fmt.recurrence(sc) + ', starting ' + ST.fmt.time(sc.startAt);
                if (sc.recur != 'once') txt += sc.endAt ? ', until ' + ST.fmt.time(sc.endAt) : ', with no end';
                return txt + '.';
            } catch (e) { return e.message; }
        })();
        var submit = function (e) {
            e.preventDefault();
            var sc;
            try { sc = schedule(); } catch (ex) { err[1](ex.message); return; }
            err[1](null); busy[1](true);
            props.onSubmit(sc).then(function () { busy[1](false); }, function (ex) { busy[1](false); err[1](ex.message); });
        };

        return html`<${ST.Modal} title=${props.title || 'Schedule'} onClose=${props.onClose} footer=${html`
            <button type="button" class="btn btn-secondary" onClick=${props.onClose}>Cancel</button>
            <button type="submit" form="st-schedule" class="btn btn-primary" disabled=${busy[0]}>${busy[0] ? html`<${ST.Spinner} class="me-1" />` : html`<${ST.Icon} name="calendar-plus" class="me-1" />`}Schedule</button>`}>
            <form id="st-schedule" onSubmit=${submit}>
                ${props.subtitle ? html`<p class="text-body-secondary small mb-3">${props.subtitle}</p>` : null}
                <div class="mb-3">
                    <div class="form-label">Repeat</div>
                    <div class="btn-group flex-wrap" role="group" aria-label="Repeat">
                        ${RECURS.map(function (r) { return html`
                            <input type="radio" class="btn-check" name="st-recur" id=${'st-recur-' + r[0]} checked=${f.recur == r[0]} onChange=${function () { set('recur', r[0]); }} />
                            <label class="btn btn-outline-primary btn-sm" for=${'st-recur-' + r[0]}>${r[1]}</label>`; })}
                    </div>
                </div>
                <div class="row g-3 mb-3">
                    <div class="col-sm-7">
                        <label class="form-label" for="st-start">${f.recur == 'once' ? 'Run at' : 'Start'}</label>
                        <input type="datetime-local" class="form-control" id="st-start" value=${f.start} onInput=${function (e) { set('start', e.target.value); }} required />
                    </div>
                    ${f.recur != 'once' ? html`
                    <div class="col-sm-5">
                        <label class="form-label" for="st-interval">Every</label>
                        <div class="input-group">
                            <input type="number" min="1" step="1" class="form-control" id="st-interval" value=${f.interval} onInput=${function (e) { set('interval', e.target.value); }} />
                            <span class="input-group-text">${UNITS[f.recur]}</span>
                        </div>
                    </div>` : null}
                </div>
                ${f.recur == 'weekly' ? html`
                <div class="mb-3">
                    <div class="form-label">On</div>
                    <div class="btn-group st-days flex-wrap" role="group" aria-label="Days of the week">
                        ${DAYS.map(function (d, i) { return html`
                            <input type="checkbox" class="btn-check" id=${'st-day-' + i} checked=${f.days.indexOf(i) >= 0} onChange=${function () { toggleDay(i); }} />
                            <label class="btn btn-outline-primary btn-sm" for=${'st-day-' + i}>${d}</label>`; })}
                    </div>
                </div>` : null}
                ${f.recur != 'once' ? html`
                <div class="mb-3">
                    <label class="form-label" for="st-end">End</label>
                    <div class="d-flex align-items-center gap-3 flex-wrap">
                        <div class="form-check mb-0">
                            <input class="form-check-input" type="checkbox" id="st-end-never" checked=${f.endNever} onChange=${function (e) { set('endNever', e.target.checked); }} />
                            <label class="form-check-label" for="st-end-never">Never</label>
                        </div>
                        <input type="datetime-local" class="form-control w-auto" id="st-end" disabled=${f.endNever} value=${f.end} onInput=${function (e) { set('end', e.target.value); }} />
                    </div>
                </div>` : null}
                <div class="form-text">${summary}</div>
                <div class="form-text">Scheduled runs only happen while the device is online. A run that's due while it's offline happens when it reconnects.</div>
                ${err[0] ? html`<div class="alert alert-danger py-2 mt-3 mb-0">${err[0]}</div>` : null}
            </form>
        </${ST.Modal}>`;
    };

    // ---- Output viewer ----

    // props: job, scriptName, deviceName, onClose
    ST.dialogs.Output = function (props) {
        var j = props.job;
        var raw = ST.jobOutput(j);
        var parsed = useMemo(function () { try { var o = JSON.parse(raw); return (o !== null && typeof o == 'object') ? JSON.stringify(o, null, 2) : null; } catch (e) { return null; } }, [raw]);
        var fmt = useState(parsed != null), wrap = useState(true);
        var text = (fmt[0] && parsed != null) ? parsed : raw;
        var status = ST.jobStatus(j, true);
        var copy = function () {
            navigator.clipboard.writeText(text).then(function () { ST.ui.toast('Output copied.'); }, function () { ST.ui.toast('Couldn\'t copy. Select the text and copy it instead.', 'error'); });
        };
        var download = function () {
            var a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
            a.download = (props.scriptName || 'output').replace(/[^\w.-]+/g, '_') + '-' + (j.completeTime || 'output') + '.txt';
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        };
        return html`<${ST.Modal} size="xl" title=${'Output: ' + (props.scriptName || j.scriptName || 'script')} onClose=${props.onClose} footer=${html`
            <button type="button" class="btn st-btn-quiet me-auto" onClick=${download}><${ST.Icon} name="download" class="me-1" />Download</button>
            <button type="button" class="btn st-btn-quiet" onClick=${copy}>Copy</button>
            <button type="button" class="btn btn-primary" onClick=${props.onClose}>Close</button>`}>
            <dl class="st-meta">
                <dt>Status</dt><dd><${ST.StatusBadge} status=${status} /></dd>
                ${props.deviceName ? html`<dt>Device</dt><dd>${props.deviceName}</dd>` : null}
                <dt>Run by</dt><dd>${j.runBy || 'unknown'}${j.jobSchedule ? ' (schedule)' : ''}</dd>
                <dt>Queued</dt><dd>${ST.fmt.time(j.queueTime)}</dd>
                ${j.dispatchTime ? html`<dt>Sent to device</dt><dd>${ST.fmt.time(j.dispatchTime)}</dd>` : null}
                ${j.completeTime ? html`<dt>Finished</dt><dd>${ST.fmt.time(j.completeTime)}${j.dispatchTime ? ' (took ' + ST.fmt.duration(j.completeTime - j.dispatchTime) + ')' : ''}</dd>` : null}
            </dl>
            <div class="d-flex gap-3 mb-2 small">
                ${parsed != null ? html`<div class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" id="st-out-fmt" checked=${fmt[0]} onChange=${function (e) { fmt[1](e.target.checked); }} /><label class="form-check-label" for="st-out-fmt">Format JSON</label></div>` : null}
                <div class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" id="st-out-wrap" checked=${wrap[0]} onChange=${function (e) { wrap[1](e.target.checked); }} /><label class="form-check-label" for="st-out-wrap">Wrap lines</label></div>
            </div>
            ${text ? html`<pre class=${'st-output' + (wrap[0] ? '' : ' st-nowrap')}>${text}</pre>` : html`<${ST.Empty}>No output.</${ST.Empty}>`}
            ${(j.lateReturnVal != null || j.lateErrorVal != null) ? html`<div class="st-section-title mt-3">Result received after cancelling</div><pre class="st-output">${String(j.lateReturnVal != null ? j.lateReturnVal : j.lateErrorVal)}</pre>` : null}
        </${ST.Modal}>`;
    };

    // ---- Script editor ----

    var TYPES = [['ps1', 'PowerShell'], ['bat', 'Batch'], ['bash', 'Bash']];

    // Indent or outdent the selected lines of a textarea, or insert spaces at the cursor
    function handleTab(e, indent) {
        var ta = e.target, v = ta.value, start = ta.selectionStart, end = ta.selectionEnd;
        e.preventDefault();
        var lineStart = v.lastIndexOf('\n', start - 1) + 1;
        if (start == end && !e.shiftKey) {
            ta.setRangeText(indent, start, end, 'end');
        } else {
            var blockEnd = (end > start && v[end - 1] == '\n') ? end - 1 : end;
            var lines = v.substring(lineStart, blockEnd).split('\n');
            var changed = lines.map(function (l) {
                if (!e.shiftKey) return indent + l;
                if (l.startsWith(indent)) return l.substring(indent.length);
                return l.replace(/^[ \t]{1,4}/, '');
            }).join('\n');
            ta.setRangeText(changed, lineStart, blockEnd, 'select');
        }
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // props: scriptId, onClose
    ST.dialogs.Editor = function (props) {
        var s = useState(null), script = s[0], setScript = s[1];
        var orig = useRef(null);
        var busy = useState(false);
        useEffect(function () {
            ST.rpc('getScript', { id: props.scriptId }).then(function (sc) { orig.current = sc; setScript({ name: sc.name, filetype: sc.filetype, content: sc.content || '' }); }, function (e) { ST.ui.toast(e.message, 'error'); props.onClose(); });
        }, []);
        var dirty = script != null && orig.current != null && (script.name != orig.current.name || script.filetype != orig.current.filetype || script.content != (orig.current.content || ''));
        var close = function () {
            if (!dirty) { props.onClose(); return; }
            ST.ui.confirm({ title: 'Discard changes?', body: 'Your changes to this script haven\'t been saved.', confirmText: 'Discard', danger: true }).then(function (ok) { if (ok) props.onClose(); });
        };
        var save = function (e) {
            if (e) e.preventDefault();
            if (!script.name.trim()) { ST.ui.toast('Give the script a name.', 'error'); return; }
            busy[1](true);
            ST.rpc('saveScript', { id: props.scriptId, name: script.name, filetype: script.filetype, content: script.content }).then(function () {
                busy[1](false); orig.current = Object.assign({}, orig.current, script); ST.ui.toast('Script saved.'); setScript(Object.assign({}, script));
            }, function (ex) { busy[1](false); ST.ui.toast(ex.message, 'error'); });
        };
        var set = function (k, v) { setScript(function (o) { var n = Object.assign({}, o); n[k] = v; return n; }); };
        var onKeyDown = function (e) {
            if (e.key == 'Tab') handleTab(e, script.filetype == 'bash' ? '  ' : '    ');
            else if ((e.ctrlKey || e.metaKey) && e.key == 's') { e.preventDefault(); save(); }
        };
        return html`<${ST.Modal} size="xl" title=${dirty ? 'Edit script (unsaved)' : 'Edit script'} onClose=${close} footer=${html`
            <span class="form-text me-auto">Tab indents, Shift+Tab outdents, Ctrl+S saves.</span>
            <button type="button" class="btn btn-secondary" onClick=${close}>Close</button>
            <button type="submit" form="st-editor" class="btn btn-primary" disabled=${!dirty || busy[0]}>${busy[0] ? html`<${ST.Spinner} class="me-1" />` : null}Save</button>`}>
            ${script == null ? html`<div class="text-center py-5"><${ST.Spinner} /></div>` : html`
            <form id="st-editor" onSubmit=${save}>
                <div class="row g-2 mb-2">
                    <div class="col-sm-8"><label class="form-label" for="st-ed-name">Name</label><input id="st-ed-name" class="form-control" value=${script.name} onInput=${function (e) { set('name', e.target.value); }} /></div>
                    <div class="col-sm-4"><label class="form-label" for="st-ed-type">Type</label><select id="st-ed-type" class="form-select" value=${script.filetype} onChange=${function (e) { set('filetype', e.target.value); }}>${TYPES.map(function (t) { return html`<option value=${t[0]}>${t[1]}</option>`; })}</select></div>
                </div>
                <textarea class="form-control st-code" spellcheck=${false} autocomplete="off" autocapitalize="off" aria-label="Script" value=${script.content} onInput=${function (e) { set('content', e.target.value); }} onKeyDown=${onKeyDown}></textarea>
            </form>`}
        </${ST.Modal}>`;
    };

    // ---- Variable ----

    var SCOPES = [['global', 'Global (all devices)'], ['script', 'This script'], ['mesh', 'This device group'], ['node', 'This device']];

    // props: variable (optional, for editing), targets: { script: {id,name}|null, mesh: {id,name}, node: {id,name} }, onClose
    ST.dialogs.Variable = function (props) {
        var v = props.variable;
        var s = useState({ name: v ? v.name : '', scope: v ? v.scope : 'global', value: v ? v.value : '' }), f = s[0], setF = s[1];
        var busy = useState(false), err = useState(null);
        var set = function (k, val) { setF(function (o) { var n = Object.assign({}, o); n[k] = val; return n; }); };
        // When editing, keep the variable's existing target unless its scope changes
        var target = function (scope) {
            if (v && v.scope == scope) return { id: v.scopeTarget, name: v.scopeTargetName };
            return props.targets[scope] || null;
        };
        var submit = function (e) {
            e.preventDefault();
            var t = target(f.scope);
            if (f.scope != 'global' && t == null) { err[1]('Select a script in the library first.'); return; }
            busy[1](true);
            var args = { name: f.name, scope: f.scope, scopeTarget: (f.scope == 'global') ? null : t.id, value: f.value };
            if (v) args.id = v._id;
            ST.rpc(v ? 'editVar' : 'addVar', args).then(function () { busy[1](false); props.onClose(); }, function (ex) { busy[1](false); err[1](ex.message); });
        };
        var t = target(f.scope);
        return html`<${ST.Modal} title=${v ? 'Edit variable' : 'New variable'} onClose=${props.onClose} footer=${html`
            <button type="button" class="btn btn-secondary" onClick=${props.onClose}>Cancel</button>
            <button type="submit" form="st-var" class="btn btn-primary" disabled=${busy[0] || !f.name.trim()}>Save</button>`}>
            <form id="st-var" onSubmit=${submit}>
                <div class="mb-3">
                    <label class="form-label" for="st-var-name">Name</label>
                    <div class="input-group"><span class="input-group-text">#</span><input id="st-var-name" class="form-control" value=${f.name} onInput=${function (e) { set('name', e.target.value); }} autofocus /><span class="input-group-text">#</span></div>
                    <div class="form-text">Use it in a script as <code>#${f.name || 'name'}#</code>.</div>
                </div>
                <div class="mb-3">
                    <label class="form-label" for="st-var-scope">Applies to</label>
                    <select id="st-var-scope" class="form-select" value=${f.scope} onChange=${function (e) { set('scope', e.target.value); }}>
                        ${SCOPES.map(function (sc) { return html`<option value=${sc[0]}>${sc[1]}</option>`; })}
                    </select>
                    ${f.scope != 'global' ? html`<div class="form-text">${t ? t.name : 'No script selected.'}</div>` : null}
                </div>
                <div class="mb-1">
                    <label class="form-label" for="st-var-value">Value</label>
                    <textarea id="st-var-value" class="form-control" rows="3" value=${f.value} onInput=${function (e) { set('value', e.target.value); }}></textarea>
                </div>
                <div class="form-text">When names match, device beats group, group beats script, and script beats global.</div>
                ${err[0] ? html`<div class="alert alert-danger py-2 mt-3 mb-0">${err[0]}</div>` : null}
            </form>
        </${ST.Modal}>`;
    };

    // ---- Device picker ----

    // props: nodes [{_id,name,meshid,tags,meshName}], initial [ids], scriptName, onRun(ids), onSchedule(ids), onClose
    ST.dialogs.DevicePicker = function (props) {
        var sel = useState(new Set(props.initial || [])), selected = sel[0], setSelected = sel[1];
        var q = useState(''), mesh = useState(''), tag = useState('');
        var meshes = useMemo(function () { var m = {}; props.nodes.forEach(function (n) { m[n.meshid] = n.meshName; }); return Object.keys(m).map(function (k) { return [k, m[k]]; }).sort(function (a, b) { return a[1].localeCompare(b[1]); }); }, []);
        var tags = useMemo(function () { var t = {}; props.nodes.forEach(function (n) { (n.tags || []).forEach(function (x) { t[x] = 1; }); }); return Object.keys(t).sort(); }, []);
        var shown = props.nodes.filter(function (n) {
            if (mesh[0] && n.meshid != mesh[0]) return false;
            if (tag[0] && (n.tags || []).indexOf(tag[0]) === -1) return false;
            if (q[0] && n.name.toLowerCase().indexOf(q[0].toLowerCase()) === -1) return false;
            return true;
        });
        var toggle = function (id) { var n = new Set(selected); if (n.has(id)) n.delete(id); else n.add(id); setSelected(n); };
        var allShown = shown.length > 0 && shown.every(function (n) { return selected.has(n._id); });
        var toggleShown = function () { var n = new Set(selected); shown.forEach(function (x) { if (allShown) n.delete(x._id); else n.add(x._id); }); setSelected(n); };
        var ids = Array.from(selected);
        return html`<${ST.Modal} size="lg" title=${'Run ' + props.scriptName + ' on several devices'} onClose=${props.onClose} footer=${html`
            <span class="me-auto text-body-secondary small">${ids.length} selected</span>
            <button type="button" class="btn btn-secondary" onClick=${props.onClose}>Cancel</button>
            <button type="button" class="btn btn-outline-primary" disabled=${ids.length == 0} onClick=${function () { props.onSchedule(ids); }}><${ST.Icon} name="calendar-plus" class="me-1" />Schedule…</button>
            <button type="button" class="btn btn-primary" disabled=${ids.length == 0} onClick=${function () { props.onRun(ids); }}><${ST.Icon} name="play-fill" class="me-1" />Run now</button>`}>
            <div class="row g-2 mb-2">
                <div class="col-md-5"><input class="form-control form-control-sm" placeholder="Search devices" value=${q[0]} onInput=${function (e) { q[1](e.target.value); }} aria-label="Search devices" /></div>
                <div class="col-md-4"><select class="form-select form-select-sm" value=${mesh[0]} onChange=${function (e) { mesh[1](e.target.value); }} aria-label="Device group"><option value="">All device groups</option>${meshes.map(function (m) { return html`<option value=${m[0]}>${m[1]}</option>`; })}</select></div>
                <div class="col-md-3"><select class="form-select form-select-sm" value=${tag[0]} onChange=${function (e) { tag[1](e.target.value); }} aria-label="Tag"><option value="">All tags</option>${tags.map(function (t) { return html`<option value=${t}>${t}</option>`; })}</select></div>
            </div>
            <div class="form-check mb-2"><input class="form-check-input" type="checkbox" id="st-pick-all" checked=${allShown} onChange=${toggleShown} /><label class="form-check-label" for="st-pick-all">Select all shown (${shown.length})</label></div>
            <div class="list-group list-group-flush st-picker">
                ${shown.length == 0 ? html`<${ST.Empty}>No devices match.</${ST.Empty}>` : shown.map(function (n) { return html`
                    <label key=${n._id} class="list-group-item list-group-item-action">
                        <input class="form-check-input m-0" type="checkbox" checked=${selected.has(n._id)} onChange=${function () { toggle(n._id); }} />
                        <span class="flex-grow-1">${n.name}</span>
                        <span class="text-body-secondary small">${n.meshName}</span>
                    </label>`; })}
            </div>
            <div class="form-text mt-2">Devices you don't have Remote Commands rights on are skipped.</div>
        </${ST.Modal}>`;
    };
})();
