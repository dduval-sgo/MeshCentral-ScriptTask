/**
* @description ScriptTask client core: server requests, change notices, formatting and shared UI components.
* Requires vendor/preact, vendor/preact-hooks, vendor/htm and st-icons.js to be loaded first.
* @author Desmond Duval
* @license Apache-2.0
*/

"use strict";

(function () {
    var ST = window.ST = {};
    var h = preact.h;
    var html = ST.html = htm.bind(h);
    var useState = preactHooks.useState, useEffect = preactHooks.useEffect, useRef = preactHooks.useRef;

    // The MeshCentral page that hosts this iframe, when there is one
    ST.host = (function () { try { if (window.parent !== window && window.parent.meshserver) return window.parent; } catch (e) { } return null; })();

    // ---- Server requests and change notices ----

    var pending = {}, seq = 0, invalidateListeners = [];
    var bus = null;
    try { bus = ST.host.pluginHandler.scripttask.getBus(); } catch (e) { bus = null; }

    function onBus(type, msg) {
        // The bus lives in the top window; drop this listener if our iframe has gone away without a pagehide
        if (window.frameElement != null && !window.frameElement.isConnected) { bus.off(onBus); return; }
        if (type == 'rpc') {
            var p = pending[msg.reqId];
            if (p == null) return;
            delete pending[msg.reqId];
            clearTimeout(p.timer);
            if (msg.ok) p.resolve(msg.data); else p.reject(new Error(msg.error || 'The request failed.'));
        } else if (type == 'invalidate') {
            invalidateListeners.slice().forEach(function (fn) { try { fn(msg); } catch (e) { console.error(e); } });
        }
    }
    if (bus) {
        bus.on(onBus);
        window.addEventListener('pagehide', function () { bus.off(onBus); });
    }

    ST.rpc = function (method, args, timeoutMs) {
        return new Promise(function (resolve, reject) {
            if (bus == null) { reject(new Error('Open this page from MeshCentral.')); return; }
            var reqId = 'st' + Date.now().toString(36) + (++seq) + Math.random().toString(36).slice(2, 6);
            pending[reqId] = {
                resolve: resolve, reject: reject,
                timer: setTimeout(function () { delete pending[reqId]; reject(new Error('The server didn\'t answer. Check your connection and try again.')); }, timeoutMs || 20000)
            };
            ST.host.meshserver.send({ action: 'plugin', plugin: 'scripttask', pluginaction: 'rpc', method: method, args: args || {}, reqId: reqId });
        });
    };

    // Subscribe to change notices from the server. Returns an unsubscribe function.
    ST.onInvalidate = function (fn) {
        invalidateListeners.push(fn);
        return function () { var i = invalidateListeners.indexOf(fn); if (i >= 0) invalidateListeners.splice(i, 1); };
    };

    // ---- Iframe sizing ----

    // Grow the hosting iframe to fit our content, so the page never has its own scrollbar.
    ST.autosize = function (minHeight) {
        var fe = window.frameElement;
        if (fe == null || typeof ResizeObserver != 'function') return;
        var last = 0;
        var update = function () {
            var height = Math.max(minHeight || 0, Math.ceil(document.body.getBoundingClientRect().height));
            if (height != last) { last = height; fe.style.height = height + 'px'; }
        };
        new ResizeObserver(update).observe(document.body);
        update();
    };

    // The top of the part of this page the user can currently see. Overlays are placed there,
    // because a tall iframe's fixed-position elements would otherwise land off screen.
    ST.visibleTop = function () {
        var fe = window.frameElement;
        if (fe == null) return 0;
        return Math.max(0, -fe.getBoundingClientRect().top);
    };

    // ---- Formatting ----

    var rtf = (typeof Intl != 'undefined' && Intl.RelativeTimeFormat) ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;
    ST.now = function () { return Math.floor(Date.now() / 1000); };
    ST.fmt = {
        time: function (t) { return (t == null) ? '' : new Date(t * 1000).toLocaleString(); },
        relative: function (t) {
            if (t == null) return '';
            var d = t - ST.now(), a = Math.abs(d);
            if (rtf == null) return ST.fmt.time(t);
            if (a < 45) return (d >= 0) ? 'in a moment' : 'just now';
            if (a < 3600) return rtf.format(Math.round(d / 60), 'minute');
            if (a < 86400) return rtf.format(Math.round(d / 3600), 'hour');
            if (a < 86400 * 30) return rtf.format(Math.round(d / 86400), 'day');
            return new Date(t * 1000).toLocaleDateString();
        },
        duration: function (s) {
            if (s == null || s < 0) return '';
            if (s < 1) return 'under a second';
            var hrs = Math.floor(s / 3600), min = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
            return [hrs ? hrs + 'h' : '', min ? min + 'm' : '', (sec && !hrs) ? sec + 's' : ''].filter(Boolean).join(' ');
        },
        recurrence: function (s) {
            if (s.recur == 'once') return 'Once';
            var units = { minutes: 'minute', hourly: 'hour', daily: 'day', weekly: 'week' };
            var txt = 'Every ' + ((s.interval > 1) ? s.interval + ' ' + units[s.recur] + 's' : units[s.recur]);
            if (s.recur == 'weekly' && Array.isArray(s.daysOfWeek)) {
                var names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                txt += ' on ' + s.daysOfWeek.map(Number).sort().map(function (d) { return names[d]; }).join(', ');
            }
            return txt;
        },
        filetype: function (t) { return { ps1: 'PowerShell', bat: 'Batch', bash: 'Bash' }[t] || t; },
        // A length of time in words, e.g. 7200 -> "2 hours"
        span: function (sec) {
            if (sec % 86400 == 0) return (sec / 86400) + ' day' + (sec == 86400 ? '' : 's');
            if (sec % 3600 == 0) return (sec / 3600) + ' hour' + (sec == 3600 ? '' : 's');
            return Math.round(sec / 60) + ' minute' + (sec == 60 ? '' : 's');
        },
        // What a schedule does when its device is offline, and with late runs
        policy: function (s, settings) {
            var txt;
            if (s.offlinePolicy == 'skip') txt = 'Skipped if the device is offline at the time';
            else if (s.offlinePolicy == 'window') txt = 'Skipped if the device is offline for more than ' + ST.fmt.span(s.offlineWindow);
            else txt = 'Runs when the device reconnects';
            if (s.anchor == 'actual') txt += '; late runs shift the schedule';
            return txt;
        },
        // The viewer's time zone, and a note when a schedule uses a different one
        zone: (typeof Intl != 'undefined') ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
        zoneNote: function (s) { return (s.timezone && s.timezone != ST.fmt.zone) ? s.timezone + ' time' : ''; }
    };

    // A job's state, from its timestamps
    ST.jobStatus = function (j, online) {
        if (j.cancelled) return 'cancelled';
        if (j.missed) return 'missed';
        if (j.completeTime != null) return (j.errorVal != null && j.returnVal == null) ? 'error' : 'complete';
        if (j.dispatchTime != null) return 'dispatched';
        if (j.expiresAt != null && j.expiresAt <= ST.now()) return 'missed'; // Past its offline deadline; the next queue check records it
        if (j.dontQueueUntil != null && j.dontQueueUntil > ST.now()) return 'scheduled';
        return online ? 'queued' : 'waiting';
    };
    ST.jobOutput = function (j) {
        var v = (j.errorVal != null && j.returnVal == null) ? j.errorVal : j.returnVal;
        if (v == null) return '';
        return (typeof v == 'string') ? v : JSON.stringify(v, null, 2);
    };

    // ---- Components ----

    ST.Icon = function (props) {
        return html`<svg class=${'bi ' + (props.class || '')} width="1em" height="1em" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: ST_ICONS[props.name] || '' }}></svg>`;
    };

    var STATUS = {
        queued: { label: 'Queued', cls: 'text-bg-secondary', icon: 'list-task', title: 'Waiting for the next queue check (within a minute).' },
        waiting: { label: 'Waiting for device', cls: 'st-badge-outline-warning', icon: 'wifi-off', title: 'Runs when the device comes online.' },
        scheduled: { label: 'Scheduled', cls: 'st-badge-outline', icon: 'clock', title: 'Not due yet.' },
        dispatched: { label: 'Running', cls: 'text-bg-info', icon: 'send', title: 'Sent to the device. Waiting for its result.' },
        stale: { label: 'No result yet', cls: 'text-bg-warning', icon: 'hourglass-split', title: 'Sent to the device a while ago without a result.' },
        complete: { label: 'Completed', cls: 'text-bg-success', icon: 'check-circle-fill', title: '' },
        error: { label: 'Error', cls: 'text-bg-danger', icon: 'exclamation-octagon-fill', title: '' },
        cancelled: { label: 'Cancelled', cls: 'st-badge-outline', icon: 'slash-circle', title: '' },
        missed: { label: 'Missed', cls: 'text-bg-warning', icon: 'calendar-x', title: 'The device was offline for longer than the schedule allows, so this run was skipped.' },
        paused: { label: 'Paused', cls: 'st-badge-outline', icon: 'pause-fill', title: 'This schedule won\'t run until it is resumed.' },
        none: { label: 'Not run', cls: 'st-badge-outline', icon: 'slash-circle', title: 'Cancelled before it was sent, or its schedule was deleted or paused.' }
    };
    ST.STATUS = STATUS;
    ST.StatusBadge = function (props) {
        var s = STATUS[props.status] || STATUS.queued;
        return html`<span class=${'badge st-status ' + s.cls} title=${props.title || s.title}><${ST.Icon} name=${s.icon} class="me-1" />${s.label}</span>`;
    };

    // Re-render every 30 seconds so relative times stay current
    var tickListeners = [];
    setInterval(function () { tickListeners.slice().forEach(function (fn) { fn(); }); }, 30000);
    ST.useTick = function () {
        var s = useState(0), set = s[1];
        useEffect(function () { var fn = function () { set(function (n) { return n + 1; }); }; tickListeners.push(fn); return function () { tickListeners.splice(tickListeners.indexOf(fn), 1); }; }, []);
    };
    ST.Time = function (props) {
        ST.useTick();
        if (props.t == null) return html`<span class="text-body-secondary">${props.empty || '—'}</span>`;
        return html`<time datetime=${new Date(props.t * 1000).toISOString()} title=${ST.fmt.time(props.t)}>${ST.fmt.relative(props.t)}</time>`;
    };

    ST.Empty = function (props) {
        return html`<div class="st-empty text-body-secondary">${props.icon ? html`<${ST.Icon} name=${props.icon} class="mb-2 fs-4 d-block mx-auto" />` : null}${props.children}</div>`;
    };

    ST.Spinner = function (props) {
        return html`<span class=${'spinner-border spinner-border-sm ' + (props.class || '')} role="status"><span class="visually-hidden">Loading</span></span>`;
    };

    // Modal dialog drawn inside this iframe, placed in the visible part of the page
    ST.Modal = function (props) {
        var top = useRef(ST.visibleTop());
        var dialog = useRef(null);
        useEffect(function () {
            var onKey = function (e) { if (e.key == 'Escape' && props.onClose) props.onClose(); };
            document.addEventListener('keydown', onKey);
            // Make sure the page is tall enough to show the whole dialog
            var prev = document.body.style.minHeight;
            if (dialog.current) document.body.style.minHeight = (top.current + dialog.current.offsetHeight + 64) + 'px';
            var focusEl = dialog.current && dialog.current.querySelector('[autofocus], .modal-body input, .modal-body select, .modal-body textarea, .modal-footer .btn-primary');
            if (focusEl) focusEl.focus();
            return function () { document.removeEventListener('keydown', onKey); document.body.style.minHeight = prev; };
        }, []);
        var size = props.size ? ' modal-' + props.size : '';
        return html`
            <div class="st-modal-layer">
                <div class="modal-backdrop show" onClick=${props.onClose}></div>
                <div class="modal d-block" role="dialog" aria-modal="true" aria-label=${props.title} onClick=${function (e) { if (e.target === e.currentTarget && props.onClose) props.onClose(); }}>
                    <div class=${'modal-dialog' + size} style=${'margin-top:' + (top.current + 24) + 'px'} ref=${dialog}>
                        <div class="modal-content">
                            <div class="modal-header">
                                <h5 class="modal-title">${props.title}</h5>
                                <button type="button" class="btn-close" aria-label="Close" onClick=${props.onClose}></button>
                            </div>
                            <div class="modal-body">${props.children}</div>
                            ${props.footer ? html`<div class="modal-footer">${props.footer}</div>` : null}
                        </div>
                    </div>
                </div>
            </div>`;
    };

    // ---- Imperative dialogs and toasts ----

    var overlay = null;
    function overlayRoot() {
        if (overlay == null) { overlay = document.createElement('div'); overlay.id = 'st-overlay'; document.body.appendChild(overlay); }
        return overlay;
    }
    function showDialog(render) {
        return new Promise(function (resolve) {
            var root = document.createElement('div');
            overlayRoot().appendChild(root);
            var done = function (value) { preact.render(null, root); root.remove(); resolve(value); };
            preact.render(render(done), root);
        });
    }

    ST.ui = {};
    // Ask before doing something. Resolves true when confirmed.
    ST.ui.confirm = function (opts) {
        return showDialog(function (done) {
            return html`<${ST.Modal} title=${opts.title} onClose=${function () { done(false); }} footer=${html`
                <button type="button" class="btn btn-secondary" onClick=${function () { done(false); }}>Cancel</button>
                <button type="button" class=${'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary')} autofocus onClick=${function () { done(true); }}>${opts.confirmText || 'OK'}</button>`}>
                ${opts.body}
            </${ST.Modal}>`;
        });
    };
    // Ask for one line of text. Resolves the text, or null when cancelled.
    ST.ui.prompt = function (opts) {
        return showDialog(function (done) {
            var Prompt = function () {
                var v = useState(opts.value || ''), value = v[0], setValue = v[1];
                var submit = function (e) { e.preventDefault(); if (value.trim()) done(value.trim()); };
                return html`<${ST.Modal} title=${opts.title} onClose=${function () { done(null); }} footer=${html`
                    <button type="button" class="btn btn-secondary" onClick=${function () { done(null); }}>Cancel</button>
                    <button type="submit" form="st-prompt" class="btn btn-primary" disabled=${!value.trim()}>${opts.confirmText || 'OK'}</button>`}>
                    <form id="st-prompt" onSubmit=${submit}>
                        <label class="form-label" for="st-prompt-input">${opts.label}</label>
                        <input id="st-prompt-input" class="form-control" value=${value} autofocus onInput=${function (e) { setValue(e.target.value); }} />
                    </form>
                </${ST.Modal}>`;
            };
            return html`<${Prompt} />`;
        });
    };

    var toasts = [], toastSeq = 0, toastRoot = null;
    function renderToasts() {
        if (toastRoot == null) { toastRoot = document.createElement('div'); overlayRoot().appendChild(toastRoot); }
        preact.render(html`
            <div class="toast-container st-toasts" style=${'top:' + (ST.visibleTop() + 12) + 'px'} aria-live="polite">
                ${toasts.map(function (t) { return html`
                    <div key=${t.id} class=${'toast show align-items-center border-0 ' + (t.kind == 'error' ? 'text-bg-danger' : 'text-bg-dark')} role="status">
                        <div class="d-flex"><div class="toast-body">${t.message}</div>
                        <button type="button" class="btn-close btn-close-white me-2 m-auto" aria-label="Close" onClick=${function () { dismiss(t.id); }}></button></div>
                    </div>`; })}
            </div>`, toastRoot);
    }
    function dismiss(id) { toasts = toasts.filter(function (t) { return t.id != id; }); renderToasts(); }
    // Show a short message. kind: 'info' or 'error'
    ST.ui.toast = function (message, kind) {
        var id = ++toastSeq;
        toasts.push({ id: id, message: message, kind: kind || 'info' });
        renderToasts();
        setTimeout(function () { dismiss(id); }, kind == 'error' ? 8000 : 4000);
    };
    // Run a request and report failures as a toast. Resolves the result, or undefined on failure.
    ST.ui.attempt = function (promise, successMessage) {
        return promise.then(function (r) { if (successMessage) ST.ui.toast(successMessage); return r; })
            .catch(function (e) { ST.ui.toast(e.message, 'error'); return undefined; });
    };
})();
