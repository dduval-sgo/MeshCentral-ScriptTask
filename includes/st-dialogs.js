/**
* @description ScriptTask dialogs shared by plugin pages: schedule, output viewer, variable, device picker, and the settings form.
* Requires st-core.js and st-editor.js.
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
    var SPAN_UNITS = [[60, 'minutes'], [3600, 'hours'], [86400, 'days']];
    // Split seconds into the largest whole unit, e.g. 7200 -> [2, 3600]
    function splitSpan(sec) {
        for (var i = SPAN_UNITS.length - 1; i >= 0; i--) if (sec % SPAN_UNITS[i][0] == 0) return [sec / SPAN_UNITS[i][0], SPAN_UNITS[i][0]];
        return [Math.round(sec / 60), 60];
    }

    // props: title, subtitle, schedule (when editing), settings (server defaults), onSubmit(schedule) -> Promise (resolve to close), onClose
    ST.dialogs.Schedule = function (props) {
        var initial = useMemo(function () {
            var e = props.schedule, d = props.settings || {};
            if (e == null) {
                var win = splitSpan(d.defaultOfflineWindow || 7200);
                return { recur: 'once', start: localInput(nextFiveMinutes()), interval: 1, days: [new Date().getDay()], endNever: true, end: '',
                    offline: d.defaultOfflinePolicy || 'wait', windowN: win[0], windowUnit: win[1], anchor: d.defaultAnchor || 'slot' };
            }
            // Editing: keep the schedule's settings. A start time that has passed is shown as its next run.
            var startAt = (e.startAt < ST.now() && e.nextRun != null && e.nextRun > ST.now()) ? e.nextRun : e.startAt;
            if (startAt < ST.now()) startAt = Math.floor(nextFiveMinutes().getTime() / 1000);
            var w = splitSpan(e.offlineWindow || d.defaultOfflineWindow || 7200);
            var days = (e.daysOfWeek && e.daysOfWeek.length) ? e.daysOfWeek.map(Number) : [new Date(startAt * 1000).getDay()]; // Preselected if switched to weekly
            return { recur: e.recur, start: localInput(new Date(startAt * 1000)), interval: e.interval || 1, days: days,
                endNever: e.endAt == null, end: e.endAt ? localInput(new Date(e.endAt * 1000)) : '',
                offline: e.offlinePolicy || 'wait', windowN: w[0], windowUnit: w[1], anchor: e.anchor || 'slot' };
        }, []);
        var s = useState(initial);
        var f = s[0], setF = s[1];
        var busy = useState(false);
        var err = useState(null);
        var set = function (k, v) { setF(function (o) { var n = Object.assign({}, o); n[k] = v; return n; }); };
        var toggleDay = function (d) { set('days', (f.days.indexOf(d) >= 0) ? f.days.filter(function (x) { return x != d; }) : f.days.concat([d])); };
        var canShift = ['minutes', 'hourly', 'daily'].indexOf(f.recur) >= 0;
        var grace = props.settings ? props.settings.skipGraceSeconds : 120;

        var schedule = function () {
            var sc = { recur: f.recur, startAt: fromLocalInput(f.start), interval: Number(f.interval), daysOfWeek: f.days.map(String), endAt: null,
                offlinePolicy: f.offline, offlineWindow: (f.offline == 'window') ? Math.round(Number(f.windowN) * f.windowUnit) : null,
                anchor: canShift ? f.anchor : 'slot', timezone: ST.fmt.zone };
            if (sc.startAt == null) throw new Error('Choose a start time.');
            if (f.recur == 'once' && sc.startAt < ST.now() - 60) throw new Error('Choose a time in the future.');
            if (f.recur != 'once' && !(sc.interval >= 1)) throw new Error('Interval must be at least 1.');
            if (f.recur == 'weekly' && f.days.length == 0) throw new Error('Choose at least one day.');
            if (f.offline == 'window' && !(sc.offlineWindow >= 60 && sc.offlineWindow <= 30 * 86400)) throw new Error('The window must be between 1 minute and 30 days.');
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
                return txt + '. ' + ST.fmt.policy(sc) + '.';
            } catch (e) { return e.message; }
        })();
        var submit = function (e) {
            e.preventDefault();
            var sc;
            try { sc = schedule(); } catch (ex) { err[1](ex.message); return; }
            err[1](null); busy[1](true);
            props.onSubmit(sc).then(function () { busy[1](false); }, function (ex) { busy[1](false); err[1](ex.message); });
        };
        var radio = function (name, value, label, extra) {
            var id = 'st-' + name + '-' + value;
            return html`<div class="form-check">
                <input class="form-check-input" type="radio" name=${'st-' + name} id=${id} checked=${f[name] == value} onChange=${function () { set(name, value); }} />
                <label class="form-check-label" for=${id}>${label}</label>${extra || null}
            </div>`;
        };

        return html`<${ST.Modal} title=${props.title || 'Schedule'} onClose=${props.onClose} footer=${html`
            <button type="button" class="btn btn-secondary" onClick=${props.onClose}>Cancel</button>
            <button type="submit" form="st-schedule" class="btn btn-primary" disabled=${busy[0]}>${busy[0] ? html`<${ST.Spinner} class="me-1" />` : html`<${ST.Icon} name="calendar-plus" class="me-1" />`}${props.schedule ? 'Save schedule' : 'Schedule'}</button>`}>
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
                <div class="row g-3 mb-3">
                    <fieldset class=${canShift ? 'col-md-7' : 'col-12'}>
                        <legend class="form-label fs-6">If the device is offline</legend>
                        ${radio('offline', 'wait', 'Run when it reconnects')}
                        ${radio('offline', 'window', 'Run if it reconnects within', f.offline == 'window' ? html`
                            <div class="input-group input-group-sm mt-1 st-window">
                                <input type="number" min="1" step="1" class="form-control" aria-label="Window length" value=${f.windowN} onInput=${function (e) { set('windowN', e.target.value); }} />
                                <select class="form-select" aria-label="Window unit" value=${f.windowUnit} onChange=${function (e) { set('windowUnit', Number(e.target.value)); }}>
                                    ${SPAN_UNITS.map(function (u) { return html`<option value=${u[0]}>${u[1]}</option>`; })}
                                </select>
                            </div>` : null)}
                        ${radio('offline', 'skip', 'Skip', html`<div class="form-text mt-0">Runs only if the device is online within ${ST.fmt.span(grace)} of the scheduled time.</div>`)}
                    </fieldset>
                    ${canShift ? html`<fieldset class="col-md-5">
                        <legend class="form-label fs-6">If a run happens late</legend>
                        ${radio('anchor', 'slot', 'Keep the original schedule')}
                        ${radio('anchor', 'actual', 'Shift to the actual run time')}
                    </fieldset>` : null}
                </div>
                <div class="form-text">${summary}</div>
                ${props.schedule && props.schedule.timezone && props.schedule.timezone != ST.fmt.zone ? html`<div class="form-text">This schedule was created in ${props.schedule.timezone} time. Saving it uses your time zone (${ST.fmt.zone}).</div>` : null}
                ${err[0] ? html`<div class="alert alert-danger py-2 mt-3 mb-0">${err[0]}</div>` : null}
            </form>
        </${ST.Modal}>`;
    };

    // ---- Settings (managers) ----

    // props: settings, onSaved(settings)
    ST.SettingsForm = function (props) {
        var st = props.settings;
        var w = splitSpan(st.defaultOfflineWindow);
        var s = useState({ grace: Math.round(st.skipGraceSeconds / 60), offline: st.defaultOfflinePolicy, windowN: w[0], windowUnit: w[1], anchor: st.defaultAnchor });
        var f = s[0], setF = s[1];
        var busy = useState(false), err = useState(null);
        var set = function (k, v) { setF(function (o) { var n = Object.assign({}, o); n[k] = v; return n; }); };
        var submit = function (e) {
            e.preventDefault();
            busy[1](true);
            ST.rpc('saveSettings', { skipGraceSeconds: Math.round(Number(f.grace) * 60), defaultOfflinePolicy: f.offline, defaultOfflineWindow: Math.round(Number(f.windowN) * f.windowUnit), defaultAnchor: f.anchor })
            .then(function (saved) { busy[1](false); ST.ui.toast('Settings saved.'); props.onSaved(saved); }, function (ex) { busy[1](false); err[1](ex.message); });
        };
        return html`<form id="st-settings" class="st-settings" onSubmit=${submit}>
                <div class="mb-3">
                    <label class="form-label" for="st-grace">Skip grace period</label>
                    <div class="input-group w-auto"><input type="number" min="1" max="60" step="1" class="form-control" id="st-grace" value=${f.grace} onInput=${function (e) { set('grace', e.target.value); }} /><span class="input-group-text">minutes</span></div>
                    <div class="form-text">Schedules set to Skip still run if their device comes online this long after the scheduled time. It applies to all schedules.</div>
                </div>
                <div class="st-section-title">Defaults for new schedules</div>
                <div class="row g-3">
                    <div class="col-12">
                        <label class="form-label" for="st-def-offline">If the device is offline</label>
                        <select id="st-def-offline" class="form-select" value=${f.offline} onChange=${function (e) { set('offline', e.target.value); }}>
                            <option value="wait">Run when it reconnects</option><option value="window">Run if it reconnects within…</option><option value="skip">Skip</option>
                        </select>
                        ${f.offline == 'window' ? html`<div class="input-group mt-2">
                            <input type="number" min="1" step="1" class="form-control" aria-label="Window length" value=${f.windowN} onInput=${function (e) { set('windowN', e.target.value); }} />
                            <select class="form-select" aria-label="Window unit" value=${f.windowUnit} onChange=${function (e) { set('windowUnit', Number(e.target.value)); }}>${SPAN_UNITS.map(function (u) { return html`<option value=${u[0]}>${u[1]}</option>`; })}</select>
                        </div>` : null}
                    </div>
                    <div class="col-12">
                        <label class="form-label" for="st-def-anchor">If a run happens late</label>
                        <select id="st-def-anchor" class="form-select" value=${f.anchor} onChange=${function (e) { set('anchor', e.target.value); }}>
                            <option value="slot">Keep the original schedule</option><option value="actual">Shift to the actual run time</option>
                        </select>
                    </div>
                </div>
                ${err[0] ? html`<div class="alert alert-danger py-2 mt-3 mb-0">${err[0]}</div>` : null}
                <div class="mt-3"><button type="submit" class="btn btn-primary" disabled=${busy[0]}>${busy[0] ? html`<${ST.Spinner} class="me-1" />` : null}Save settings</button></div>
            </form>`;
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
            <div class="d-flex gap-3 mb-2 small align-items-center flex-wrap">
                ${parsed != null ? html`<div class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" id="st-out-fmt" checked=${fmt[0]} onChange=${function (e) { fmt[1](e.target.checked); }} /><label class="form-check-label" for="st-out-fmt">Format JSON</label></div>` : null}
                <div class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" id="st-out-wrap" checked=${wrap[0]} onChange=${function (e) { wrap[1](e.target.checked); }} /><label class="form-check-label" for="st-out-wrap">Wrap lines</label></div>
                ${text ? html`<span class="ms-auto"><${ST.EditorThemePicker} /></span>` : null}
            </div>
            ${text ? html`<div class="st-output-frame"><${ST.CodeEditor} key=${fmt[0] && parsed != null ? 'json' : 'raw'} value=${text} readOnly=${true} wrap=${wrap[0]} /></div>`
                : html`<${ST.Empty}>${status == 'missed' ? 'This run didn\'t happen: the device was offline for longer than its schedule allows.' : status == 'cancelled' ? 'This run was cancelled before it produced any output.' : 'No output.'}</${ST.Empty}>`}
            ${(j.lateReturnVal != null || j.lateErrorVal != null) ? html`<div class="st-section-title mt-3">Result received after cancelling</div><pre class="st-output">${String(j.lateReturnVal != null ? j.lateReturnVal : j.lateErrorVal)}</pre>` : null}
        </${ST.Modal}>`;
    };

    // ---- Variable ----

    var SCOPES = [['global', 'Global (all devices)'], ['script', 'This script'], ['mesh', 'This device group'], ['node', 'This device']];

    // props: variable (optional, for editing), targets: { script: {id,name}|null, mesh: {id,name}, node: {id,name} }, scopes (optional list), onClose
    ST.dialogs.Variable = function (props) {
        var v = props.variable;
        var s = useState({ name: v ? v.name : '', scope: v ? v.scope : (props.scope || 'global'), value: v ? v.value : '' }), f = s[0], setF = s[1];
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
                        ${SCOPES.filter(function (sc) { return props.scopes == null || props.scopes.indexOf(sc[0]) >= 0; }).map(function (sc) { return html`<option value=${sc[0]}>${sc[1]}</option>`; })}
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
})();
