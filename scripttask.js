/**
* @description MeshCentral ScriptTask
* @author Ryan Blenis
* @author Desmond Duval (modifications)
* Modified by Desmond Duval, 2026: redesigned interface, scheduling engine, batches, permissions and settings. See changelog.md.
* @copyright
* @license Apache-2.0
*/

"use strict";

// MeshCentral loads plugins with require(), and removing, reinstalling or upgrading a plugin doesn't clear Node's
// module cache. Until MeshCentral restarts, require() can return the previous version of this file. So the factory
// compares this code's version with the one on disk; when they differ, it drops the plugin's files from the cache
// and builds the plugin from the new files instead.
var path = require('path');
function versionOnDisk() {
    try { return JSON.parse(require('fs').readFileSync(path.join(__dirname, 'config.json'), 'utf8')).version; } catch (e) { return null; }
}
var LOADED_VERSION = versionOnDisk();
var INSTANCE_KEY = Symbol.for('meshcentral.plugin.scripttask.instance');

module.exports.scripttask = function (parent) {
    var onDisk = versionOnDisk();
    if (onDisk != null && LOADED_VERSION != null && onDisk != LOADED_VERSION) {
        console.log('PLUGIN: ScriptTask: loading version ' + onDisk + ' in place of ' + LOADED_VERSION + '. Restart MeshCentral when convenient.');
        Object.keys(require.cache).forEach(function (k) { if (k.startsWith(__dirname + path.sep)) delete require.cache[k]; });
        return require(path.join(__dirname, 'scripttask.js')).scripttask(parent);
    }
    // An earlier instance in this process (the plugin was reloaded, reinstalled or upgraded without a restart) stops
    // checking the queue, so two copies never send the same runs
    if (global[INSTANCE_KEY] && typeof global[INSTANCE_KEY].shutdown == 'function') global[INSTANCE_KEY].shutdown();

    var obj = {};
    global[INSTANCE_KEY] = obj;
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.db = null;
    obj.intervalTimer = null;
    obj.debug = obj.meshServer.debug;
    obj.VIEWS = __dirname + '/views/';
    obj.INCLUDES = __dirname + '/includes/';
    obj.version = LOADED_VERSION;
    obj.stopped = false;
    obj.exports = [
        'onDeviceRefreshEnd',
        'getBus',
        'onRpcResult',
        'onInvalidate',
        'malix_triggerOption'
    ];

    const MESHRIGHT_REMOTECOMMAND = 0x00020000;
    const SITERIGHT_FULLADMIN = 0xFFFFFFFF;
    const RECUR_TYPES = ['once', 'minutes', 'hourly', 'daily', 'weekly'];
    const FILE_TYPES = ['ps1', 'bat', 'bash'];

    // Plugin permissions, managed in MeshCentral's plugin permissions dialog (MeshCentral 1.1.58+).
    // Full site administrators always pass every check.
    obj.permissions = {
        manage: {
            title: 'Manage ScriptTask',
            desc: 'Edit the script library and variables, and run or schedule scripts on many devices at once.',
            default: 'denied'
        },
        run: {
            title: 'Run scripts',
            desc: 'Run and schedule library scripts on a device from its ScriptTask tab, and view that device\'s queue and history. Also requires the device\'s Remote Commands right.',
            default: 'allowed'
        }
    };

    obj.malix_triggerOption = function(selectElem) {
        selectElem.options.add(new Option("ScriptTask - Run Script", "scripttask_runscript"));
    }
    obj.malix_triggerFields_scripttask_runscript = function() {

    }
    // The queue check runs on an interval from Settings (every minute by default)
    obj.timerSeconds = null;
    obj.resetQueueTimer = function() {
        clearInterval(obj.intervalTimer);
        if (obj.stopped) return;
        obj.timerSeconds = obj.settingsCache ? obj.settingsCache.queueIntervalSeconds : obj.SETTINGS_DEFAULTS.queueIntervalSeconds;
        obj.intervalTimer = setInterval(obj.queueRun, obj.timerSeconds * 1000);
    };

    obj.shutdown = function() {
        obj.stopped = true;
        clearInterval(obj.intervalTimer);
    };
    // Disabling or removing the plugin drops it from MeshCentral's list without telling it; stop when that happens
    obj.isActive = function() {
        if (obj.stopped) return false;
        if (parent.plugins != null && parent.plugins.scripttask !== obj) { obj.shutdown(); return false; }
        return true;
    };

    obj.server_startup = function() {
        // Registered here, not at load: MeshCentral loads plugins before its permission functions exist
        if (typeof parent.registerPermissions == 'function') parent.registerPermissions('scripttask', obj.permissions);
        obj.meshServer.pluginHandler.scripttask_db = require (__dirname + '/db.js').CreateDB(obj.meshServer);
        obj.db = obj.meshServer.pluginHandler.scripttask_db;
        obj.resetQueueTimer();
    };

    // ---- Client-side exports (serialized into the MeshCentral web UI's pluginHandler) ----

    obj.onDeviceRefreshEnd = function() {
        pluginHandler.registerPluginTab({
            tabTitle: 'ScriptTask',
            tabId: 'pluginScriptTask'
        });
        QA('pluginScriptTask', '<iframe id="pluginIframeScriptTask" style="width: 100%; height: 480px; border: 0; display: block;" scrolling="no" frameBorder=0 src="/pluginadmin.ashx?pin=scripttask&user=1" />');
    };
    // One message bus per top window, created in the top window's realm so it outlives any plugin iframe.
    // Plugin iframes subscribe to it; replies and change notices from the server are fanned out to them.
    obj.getBus = function() {
        if (window.scripttaskBus == null) {
            var listeners = [];
            window.scripttaskBus = {
                on: function (fn) { listeners.push(fn); },
                off: function (fn) { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
                emit: function (type, msg) { listeners.slice().forEach(function (fn) { try { fn(type, msg); } catch (e) { } }); }
            };
        }
        return window.scripttaskBus;
    };
    obj.onRpcResult = function(server, message) {
        pluginHandler.scripttask.getBus().emit('rpc', message);
    };
    obj.onInvalidate = function(message) {
        pluginHandler.scripttask.getBus().emit('invalidate', message.event);
    };

    // ---- Queue ----

    obj.sending = new Set(); // Jobs being sent right now, so overlapping queue runs don't send one twice

    obj.queueRun = async function() {
        if (!obj.isActive()) return;
        try { await obj.expireJobs(); } catch (e) { console.log('PLUGIN: ScriptTask: Could not expire jobs: ', e); }
        var onlineAgents = Object.keys(obj.meshServer.webserver.wsagents);
        //obj.debug('ScriptTask', 'Queue Running', Date().toLocaleString(), 'Online agents: ', onlineAgents);

        return obj.db.getPendingJobs(onlineAgents)
        .then((jobs) => {
            if (jobs.length == 0) return;
            //@TODO check for a large number and use taskLimiter to queue the jobs
            jobs.forEach(job => {
                var key = String(job._id);
                if (obj.sending.has(key)) return;
                obj.sending.add(key);
                obj.db.get(job.scriptId)
                .then(async (script) => {
                    script = script[0];
                    if (script == null) {
                        // The script was deleted after this job was queued. Close the job instead of retrying it every minute.
                        await obj.db.update(job._id, { completeTime: Math.floor(new Date() / 1000), errorVal: 'Script no longer exists in the library.' });
                        obj.invalidate({ nodeIds: [job.node] });
                        return;
                    }
                    var foundVars = script.content.match(/#(.*?)#/g);
                    var replaceVars = {};
                    if (foundVars != null && foundVars.length > 0) {
                        var foundVarNames = [];
                        foundVars.forEach(fv => {
                            foundVarNames.push(fv.replace(/^#+|#+$/g, ''));
                        });

                        var limiters = {
                            scriptId: job.scriptId,
                            nodeId: job.node,
                            meshId: obj.meshServer.webserver.wsagents[job.node]['dbMeshKey'],
                            names: foundVarNames
                        };
                        var finvals = await obj.db.getVariables(limiters);
                        var ordering = { 'global': 0, 'script': 1, 'mesh': 2, 'node': 3 }
                        finvals.sort((a, b) => {
                            return (ordering[a.scope] - ordering[b.scope])
                              || a.name.localeCompare(b.name);
                        });
                        finvals.forEach(fv => {
                            replaceVars[fv.name] = fv.value;
                        });
                        replaceVars['GBL:meshId'] = obj.meshServer.webserver.wsagents[job.node]['dbMeshKey'];
                        replaceVars['GBL:nodeId'] = job.node;
                        replaceVars['GBL:runBy'] = job.runBy || 'unknown';
                        //console.log('FV IS', finvals);
                        //console.log('RV IS', replaceVars);
                    }
                    var dispatchTime = Math.floor(new Date() / 1000);
                    var jObj = {
                        action: 'plugin',
                        plugin: 'scripttask',
                        pluginaction: 'triggerJob',
                        jobId: job._id,
                        scriptId: job.scriptId,
                        replaceVars: replaceVars,
                        scriptHash: script.contentHash,
                        dispatchTime: dispatchTime
                    };
                    // Recorded as sent before sending: it is never sent again (see checkSentJobs)
                    var agent = obj.meshServer.webserver.wsagents[job.node];
                    if (agent == null) return;
                    await obj.db.update(job._id, { dispatchTime: dispatchTime });
                    try { agent.send(JSON.stringify(jObj)); }
                    catch (e) { await obj.db.update(job._id, { dispatchTime: null }); return; }
                    obj.invalidate({ nodeIds: [job.node] });
                })
                .catch(e => console.log('PLUGIN: ScriptTask: Could not dispatch job.', e))
                .then(() => { obj.sending.delete(key); });
            });
        })
        .then(() => {
            obj.cleanHistory();
            // Settings load after startup: pick up a non-default interval on the first check
            if (obj.settingsCache && obj.settingsCache.queueIntervalSeconds != obj.timerSeconds) obj.resetQueueTimer();
            return obj.ensureScheduleJobs().catch(e => console.log('PLUGIN: ScriptTask: Error managing job schedules: ', e));
        })
        .catch(e => { console.log('PLUGIN: ScriptTask: Queue Run Error: ', e); });
    };

    // Delete runs older than the retention setting, at most every 6 hours
    obj.lastCleanup = 0;
    obj.cleanHistory = function() {
        if (Date.now() - obj.lastCleanup < 6 * 3600 * 1000) return;
        obj.lastCleanup = Date.now();
        obj.getSettings().then(function(s) { return obj.db.deleteOldHistory(s.historyDays); })
        .catch(function(e) { console.log('PLUGIN: ScriptTask: History cleanup error: ', e); });
    };

    // ---- HTTP ----

    obj.downloadFile = function(req, res, user) {
        if (!obj.hasPerm(user, 'manage')) { res.sendStatus(401); return; }
        var id = req.query.dl;
        obj.db.get(id)
        .then(found => {
          if (found.length != 1 || found[0].type != 'script') { res.sendStatus(401); return; }
          var file = found[0];
          res.setHeader('Content-disposition', 'attachment; filename="' + file.name.replace(/["\\\r\n]/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(file.name));
          res.setHeader('Content-type', 'text/plain');
          res.send(file.content);
        });
    };

    obj.serveInclude = function(req, res) {
        var path = req.query.path;
        if (typeof path != 'string' || !/^[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-.]+)*\.(js|css)$/.test(path) || path.indexOf('..') !== -1) { res.sendStatus(404); return; }
        res.sendFile(path, { root: obj.INCLUDES, dotfiles: 'deny', maxAge: '1h' }, function (err) { if (err && !res.headersSent) res.sendStatus(404); });
    };

    obj.handleAdminReq = function(req, res, user) {
        if (req.query.include == 1) return obj.serveInclude(req, res);
        if (req.query.user == 1) {
            if (req.query.dl != null) return obj.downloadFile(req, res, user);
            res.render(obj.VIEWS + 'device', { version: obj.version });
            return;
        }
        // The ScriptTask page, opened from My Server > Plugins (MeshCentral's goPlugin sends no other parameters)
        if (!obj.hasPerm(user, 'manage')) { res.status(403).send('The ScriptTask page is for ScriptTask managers.'); return; }
        res.render(obj.VIEWS + 'server', { version: obj.version });
    };

    // ---- Scheduling ----
    // Every active schedule has exactly one incomplete job: the run for its next slot. When that job finishes,
    // expires under the schedule's offline policy, or is cancelled, the next job is created for the first slot after it.
    // Slots that passed while a device was offline are never run as a backlog.

    obj.Schedule = require(__dirname + '/schedule.js');
    obj.SETTINGS_DEFAULTS = { skipGraceSeconds: 120, defaultOfflinePolicy: 'wait', defaultOfflineWindow: 7200, defaultAnchor: 'slot', historyDays: 90, staleMinutes: 30,
        queueIntervalSeconds: 60, pageSize: 50, scheduleStepMinutes: 5, indentPs1: '4', indentBat: '4', indentBash: '2' };
    var SCHEDULE_STEPS = [1, 5, 10, 15, 30, 60], INDENTS = ['2', '4', 'tab'];
    obj.settingsCache = null;
    obj.getSettings = function() {
        if (obj.settingsCache != null) return Promise.resolve(obj.settingsCache);
        return obj.db.getSettings().then(function(saved) {
            var s = Object.assign({}, obj.SETTINGS_DEFAULTS);
            Object.keys(obj.SETTINGS_DEFAULTS).forEach(function(k) { if (saved[k] != null) s[k] = saved[k]; });
            obj.settingsCache = s;
            return s;
        });
    };

    // Run schedule changes one at a time, so the queue tick and a finishing job can't both create a schedule's next job
    var scheduleChain = Promise.resolve();
    obj.serial = function(fn) {
        var p = scheduleChain.then(fn);
        scheduleChain = p.catch(function() { });
        return p;
    };

    // Record that a job's slot is over (it ran, was missed or was cancelled), so the schedule's next job comes after it
    obj.closeSlot = function(scheduleId, job, extra) {
        if (scheduleId == null) return Promise.resolve();
        var slot = (job.slot != null) ? job.slot : job.dontQueueUntil;
        return obj.db.update(scheduleId, Object.assign({ lastSlot: slot }, extra || {}));
    };

    // Give every active schedule (or just one) that has no incomplete job a job for its next slot
    obj.ensureScheduleJobs = function(scheduleId) {
        return obj.serial(async function() {
            var settings = await obj.getSettings();
            var schedules = await obj.db.getActiveSchedules(scheduleId);
            if (schedules.length == 0) return;
            var busy = await obj.db.getScheduleIdsWithIncompleteJobs();
            var now = Math.floor(Date.now() / 1000);
            for (var s of schedules) {
                if (busy.indexOf(String(s._id)) >= 0) continue;
                // Schedules from before this version only have nextRun, the slot of their last job
                var last = (s.lastSlot != null) ? s.lastSlot : s.nextRun;
                // A new schedule starts at its start time, with a few minutes' grace. Otherwise: the first slot after the last one, and not in the past.
                var from = (last != null) ? Math.max(last + 1, now) : Math.max(s.startAt, now - 300);
                var slot = obj.Schedule.nextSlot(s, from);
                if (slot == null) {
                    // Finished: a one-time run is done, or the end time has passed
                    await obj.db.removeJobSchedule(s._id);
                    obj.invalidate({ nodeIds: [s.node], scriptIds: [s.scriptId] });
                    continue;
                }
                var scripts = await obj.db.get(s.scriptId);
                if (scripts.length == 0) continue;
                await obj.db.addJob({ scriptId: String(s.scriptId), scriptName: scripts[0].name, node: s.node, runBy: s.scheduledBy, runById: s.scheduledById || null, dontQueueUntil: slot, slot: slot, expiresAt: obj.Schedule.expiresAt(s, slot, settings.skipGraceSeconds), jobSchedule: String(s._id), batchId: s.batchId || null });
                await obj.db.update(s._id, { nextRun: slot });
                obj.invalidate({ nodeIds: [s.node], scriptIds: [s.scriptId] });
            }
        });
    };

    // Close jobs that were never sent before their offline policy ran out. They show as Missed in history.
    obj.expireJobs = async function() {
        var now = Math.floor(Date.now() / 1000);
        var jobs = await obj.db.getExpiredJobs(now);
        for (var j of jobs) {
            await obj.db.update(j._id, { completeTime: now, missed: true });
            await obj.closeSlot(j.jobSchedule, j);
            obj.invalidate({ nodeIds: [j.node], scriptIds: [j.scriptId] });
        }
        return jobs.length;
    };

    // Start a device's due jobs as soon as it connects, instead of at the next minute's queue check
    obj.hook_agentCoreIsStable = function(agent) {
        clearTimeout(obj.connectTimer);
        obj.connectTimer = setTimeout(obj.queueRun, 3000); // One queue run for a burst of reconnecting devices
        if (agent && typeof agent.dbNodeKey == 'string') {
            obj.checkSentJobs(agent).catch(function(e) { console.log('PLUGIN: ScriptTask: Could not check sent jobs: ', e); });
            obj.invalidate({ nodeIds: [agent.dbNodeKey] });
        }
    };

    // Runs are sent once and never resent: rerunning after a reboot could repeat a script that rebooted the device.
    // When a device's agent reconnects, ask it which of the runs it was sent are still running. The agent answers
    // with jobsNotRunning, and those runs are recorded as interrupted. A result that arrives later still counts.
    obj.INTERRUPTED = 'Interrupted: the device or its agent restarted before the script reported a result. It was not run again.';
    obj.checkSentJobs = async function(agent) {
        if (!obj.isActive() || obj.db == null) return;
        var sent = (await obj.db.getIncompleteJobsForNode(agent.dbNodeKey)).filter(function(j) { return j.dispatchTime != null; });
        if (sent.length == 0) return;
        agent.send(JSON.stringify({ action: 'plugin', plugin: 'scripttask', pluginaction: 'checkJobs', jobIds: sent.map(function(j) { return String(j._id); }) }));
    };
    obj.markInterrupted = async function(agent, jobIds) {
        var now = Math.floor(Date.now() / 1000), changed = false;
        for (var jobId of (Array.isArray(jobIds) ? jobIds : []).slice(0, 1000)) {
            var job = (await obj.db.get(String(jobId)))[0];
            if (job == null || job.type != 'job' || job.node != agent.dbNodeKey || job.completeTime != null || job.dispatchTime == null) continue;
            await obj.db.update(job._id, { completeTime: now, errorVal: obj.INTERRUPTED, interrupted: true });
            // A scheduled run closes its slot as usual; the schedule carries on with its next one
            if (job.jobSchedule != null) { await obj.closeSlot(job.jobSchedule, job); await obj.ensureScheduleJobs(job.jobSchedule); }
            changed = true;
        }
        if (changed) obj.invalidate({ nodeIds: [agent.dbNodeKey] });
    };

    // ---- Change notices ----

    // Tell open ScriptTask pages that something changed, so they re-query what they show.
    // Notices carry ids only, never data. Device notices go only to users who can see that device.
    obj.invalidate = function(scopes) {
        var send = function(targets, payload) {
            obj.meshServer.DispatchEvent(targets, obj, Object.assign({ nolog: true, action: 'plugin', plugin: 'scripttask', pluginaction: 'onInvalidate' }, payload));
        };
        if (scopes.library || scopes.variables || scopes.settings || (scopes.scriptIds && scopes.scriptIds.length)) {
            send(['server-allusers'], { library: scopes.library === true, variables: scopes.variables === true, settings: scopes.settings === true, scriptIds: (scopes.scriptIds || []).map(String) });
        }
        (scopes.nodeIds || []).forEach(function(nodeId) {
            obj.meshServer.db.Get(nodeId, function(err, nodes) {
                if (nodes == null || nodes.length != 1) return;
                send(obj.meshServer.webserver.CreateNodeDispatchTargets(nodes[0].meshid, nodeId), { nodeIds: [nodeId] });
            });
        });
    };

    // ---- Permissions ----

    obj.isFullAdmin = function(user) {
        return user != null && user.siteadmin === SITERIGHT_FULLADMIN;
    };
    obj.hasPerm = function(user, perm, nodeId, meshId) {
        if (user == null) return false;
        if (obj.isFullAdmin(user)) return true;
        // MeshCentral allows everything for a plugin with no registered permissions. Fail closed instead,
        // using our own defaults, if registration hasn't happened.
        if (typeof parent.checkPluginPermission != 'function' || typeof parent.getPluginPermissions != 'function' || parent.getPluginPermissions('scripttask') == null) {
            return obj.permissions[perm] != null && obj.permissions[perm].default == 'allowed';
        }
        return parent.checkPluginPermission(user, 'scripttask', perm, nodeId, meshId) === true;
    };
    // Resolve what a user may do on one device: the plugin's "run" permission plus the device's Remote Commands right,
    // which is what MeshCentral itself requires to run commands on a device.
    obj.getNodeCaps = function(session, nodeId) {
        return new Promise(function(resolve) {
            obj.meshServer.webserver.GetNodeWithRights(session.domain, session.user, nodeId, function(node, rights, visible) {
                if (node == null || !visible) { resolve({ node: null, run: false }); return; }
                var remoteCommand = (rights & MESHRIGHT_REMOTECOMMAND) != 0;
                resolve({ node: node, remoteCommand: remoteCommand, run: remoteCommand && obj.hasPerm(session.user, 'run', node._id, node.meshid) });
            });
        });
    };
    obj.requireManage = function(session) {
        if (!obj.hasPerm(session.user, 'manage')) throw new RpcError('Only ScriptTask managers can do this.');
    };
    obj.requireNode = async function(session, nodeId) {
        if (typeof nodeId != 'string') throw new RpcError('No device given.');
        var caps = await obj.getNodeCaps(session, nodeId);
        if (!caps.run) throw new RpcError('You don\'t have permission to run scripts on this device.');
        return caps.node;
    };
    // Users may change jobs and schedules they created. Managers may change any.
    obj.requireOwnerOrManage = function(session, ownerId) {
        if (obj.hasPerm(session.user, 'manage')) return;
        if (ownerId == null || ownerId != session.user._id) throw new RpcError('You can only change jobs and schedules you created.');
    };

    // ---- RPC ----

    function RpcError(message) { this.message = message; }

    function str(v, max) {
        if (typeof v != 'string') throw new RpcError('Invalid input.');
        v = v.trim();
        if (v.length == 0 || v.length > (max || 256)) throw new RpcError('Invalid input.');
        return v;
    }
    function id(v) { return str(v, 128); }
    function name(v) {
        v = str(v, 200);
        if (/[\/\\]/.test(v)) throw new RpcError('Names can\'t contain / or \\.');
        return v;
    }

    function getOne(itemId, type) {
        return obj.db.get(id(itemId)).then(function(found) {
            if (found.length != 1 || (type != null && found[0].type != type)) throw new RpcError('Not found. It may have been deleted.');
            return found[0];
        });
    }
    function folderPath(folderId) {
        if (folderId == null) return Promise.resolve('Shared');
        return getOne(folderId).then(function(f) { return f.path; }); // A folder's path includes itself; a script's path is its folder
    }
    function cleanSchedule(sj) {
        if (sj == null || RECUR_TYPES.indexOf(sj.recur) === -1) throw new RpcError('Invalid schedule.');
        var startAt = Number(sj.startAt);
        if (!isFinite(startAt) || startAt <= 0) throw new RpcError('Choose a start time.');
        var sched = { recur: sj.recur, interval: null, daysOfWeek: [], startAt: Math.floor(startAt), endAt: null };
        if (sj.recur != 'once') {
            sched.interval = Math.floor(Number(sj.interval));
            if (!(sched.interval >= 1 && sched.interval <= 10000)) throw new RpcError('Interval must be a whole number of at least 1.');
            if (sj.endAt != null) {
                sched.endAt = Math.floor(Number(sj.endAt));
                if (!isFinite(sched.endAt) || sched.endAt <= sched.startAt) throw new RpcError('The end time must be after the start time.');
            }
        }
        if (sj.recur == 'weekly') {
            if (!Array.isArray(sj.daysOfWeek)) throw new RpcError('Choose at least one day.');
            sched.daysOfWeek = sj.daysOfWeek.map(Number).filter(function(d) { return d >= 0 && d <= 6; }).map(String);
            if (sched.daysOfWeek.length == 0) throw new RpcError('Choose at least one day.');
        }
        if (sj.recur == 'once' && sched.startAt < Math.floor(Date.now() / 1000) - 300) throw new RpcError('Choose a time in the future.');
        sched.offlinePolicy = (['wait', 'window', 'skip'].indexOf(sj.offlinePolicy) >= 0) ? sj.offlinePolicy : 'wait';
        sched.offlineWindow = null;
        if (sched.offlinePolicy == 'window') {
            sched.offlineWindow = Math.floor(Number(sj.offlineWindow));
            if (!(sched.offlineWindow >= 60 && sched.offlineWindow <= 30 * 86400)) throw new RpcError('The window must be between 1 minute and 30 days.');
        }
        // Shifting to the actual run time only makes sense for evenly repeating schedules
        sched.anchor = (sj.anchor == 'actual' && ['minutes', 'hourly', 'daily'].indexOf(sj.recur) >= 0) ? 'actual' : 'slot';
        sched.timezone = obj.Schedule.isValidZone(sj.timezone) ? sj.timezone : null;
        return sched;
    }

    obj.rpc = {};

    // Everything a device tab needs to start: what this user may do, and the device's connection state.
    obj.rpc.init = async function(args, session) {
        var caps = (args.nodeId != null) ? await obj.getNodeCaps(session, id(args.nodeId)) : { node: null, run: false, remoteCommand: false };
        return {
            version: obj.version,
            user: { id: session.user._id, name: session.user.name },
            caps: { manage: obj.hasPerm(session.user, 'manage'), run: caps.run, remoteCommand: caps.remoteCommand === true, visible: caps.node != null },
            node: (caps.node == null) ? null : { id: caps.node._id, online: obj.meshServer.webserver.wsagents[caps.node._id] != null },
            settings: await obj.getSettings()
        };
    };

    obj.rpc.tree = function(args, session) {
        if (!obj.hasPerm(session.user, 'run') && !obj.hasPerm(session.user, 'manage')) throw new RpcError('No access.');
        return obj.db.getScriptTree();
    };

    obj.rpc.nodeData = async function(args, session) {
        var node = await obj.requireNode(session, args.nodeId);
        var results = await Promise.all([
            obj.db.getIncompleteJobsForNode(node._id),
            obj.db.getJobSchedulesForNode(node._id),
            obj.db.getJobNodeHistory(node._id)
        ]);
        return { online: obj.meshServer.webserver.wsagents[node._id] != null, queue: results[0], schedules: results[1], history: results[2].filter(function(j) { return j.completeTime != null; }) };
    };

    obj.rpc.runScript = async function(args, session) {
        var script = await getOne(args.scriptId, 'script');
        var nodeIds = Array.isArray(args.nodeIds) ? args.nodeIds.map(id) : [];
        if (nodeIds.length == 0) throw new RpcError('No device given.');
        if (nodeIds.length > 1) obj.requireManage(session);
        var allowed = await obj.allowedTargets(session, nodeIds), batchId = null;
        if (args.batchId != null) {
            // Running again on some of a batch's devices: the new runs join that batch, replacing those devices' results
            obj.requireManage(session);
            var batch = await obj.db.getBatch(String(args.batchId));
            if (batch == null || batch.recurring || String(batch.scriptId) != String(script._id)) throw new RpcError('That batch can\'t be run again.');
            batchId = batch.batchId;
            var added = allowed.accepted.filter(function(n) { return batch.nodeIds.indexOf(n) < 0; });
            if (added.length) await obj.db.update(batch._id, { nodeIds: batch.nodeIds.concat(added) });
        } else if (allowed.accepted.length > 1) {
            batchId = await obj.startBatch(session, script, allowed.accepted, args.name, false);
        }
        for (var nodeId of allowed.accepted) {
            await obj.db.addJob({ scriptId: String(script._id), scriptName: script.name, node: nodeId, runBy: session.user.name, runById: session.user._id, batchId: batchId });
        }
        if (allowed.accepted.length) {
            obj.resetQueueTimer();
            obj.queueRun();
            obj.invalidate({ nodeIds: allowed.accepted, scriptIds: [String(script._id)] });
        }
        return { accepted: allowed.accepted.length, refused: allowed.refused, batchId: batchId };
    };

    obj.rpc.addSchedule = async function(args, session) {
        var script = await getOne(args.scriptId, 'script');
        var sched = cleanSchedule(args.schedule);
        var nodeIds = Array.isArray(args.nodeIds) ? args.nodeIds.map(id) : [];
        if (nodeIds.length == 0) throw new RpcError('No device given.');
        if (nodeIds.length > 1) obj.requireManage(session);
        var allowed = await obj.allowedTargets(session, nodeIds);
        var batchId = (allowed.accepted.length > 1) ? await obj.startBatch(session, script, allowed.accepted, args.name, true, sched) : null;
        for (var nodeId of allowed.accepted) {
            var r = await obj.db.addJobSchedule(Object.assign({ scriptId: String(script._id), node: nodeId, scheduledBy: session.user.name, scheduledById: session.user._id, lastRun: null, nextRun: null, lastSlot: null, anchorAt: null, paused: false, batchId: batchId }, sched));
            await obj.ensureScheduleJobs(r.insertedId);
        }
        if (allowed.accepted.length) obj.invalidate({ nodeIds: allowed.accepted, scriptIds: [String(script._id)] });
        return { accepted: allowed.accepted.length, refused: allowed.refused, batchId: batchId };
    };

    // Cancel an incomplete job (permission already checked)
    obj.cancelJobDoc = async function(job, userName) {
        if (job.dispatchTime == null) {
            await obj.db.delete(job._id);
        } else {
            // Already sent to the device. Close it here; a late result from the agent is still recorded.
            await obj.db.update(job._id, { completeTime: Math.floor(new Date() / 1000), cancelled: true, errorVal: 'Cancelled by ' + userName + ' after it was sent to the device.' });
        }
        // Cancelling a schedule's run skips that occurrence; the schedule carries on with its next one
        if (job.jobSchedule != null) { await obj.closeSlot(job.jobSchedule, job); await obj.ensureScheduleJobs(job.jobSchedule); }
        obj.invalidate({ nodeIds: [job.node], scriptIds: [job.scriptId] });
    };

    obj.rpc.cancelJob = async function(args, session) {
        var job = await getOne(args.jobId, 'job');
        await obj.requireNode(session, job.node);
        obj.requireOwnerOrManage(session, job.runById);
        if (job.completeTime != null) throw new RpcError('This job has already finished.');
        await obj.cancelJobDoc(job, session.user.name);
        return true;
    };

    obj.rpc.cancelAllPending = async function(args, session) {
        obj.requireManage(session);
        var node = await obj.requireNode(session, args.nodeId);
        var jobs = await obj.db.getIncompleteJobsForNode(node._id), schedules = [];
        for (var job of jobs) {
            if (job.dispatchTime == null) await obj.db.delete(job._id);
            else await obj.db.update(job._id, { completeTime: Math.floor(new Date() / 1000), cancelled: true, errorVal: 'Cancelled by ' + session.user.name + ' after it was sent to the device.' });
            if (job.jobSchedule != null) { await obj.closeSlot(job.jobSchedule, job); schedules.push(job.jobSchedule); }
        }
        for (var sid of schedules) await obj.ensureScheduleJobs(sid);
        obj.invalidate({ nodeIds: [node._id] });
        return jobs.length;
    };

    obj.deleteScheduleDoc = async function(sched) {
        await obj.db.deletePendingJobsForSchedule(sched._id);
        await obj.db.delete(sched._id);
        obj.invalidate({ nodeIds: [sched.node], scriptIds: [sched.scriptId] });
    };

    obj.rpc.deleteSchedule = async function(args, session) {
        var sched = await getOne(args.scheduleId, 'jobSchedule');
        await obj.requireNode(session, sched.node);
        obj.requireOwnerOrManage(session, sched.scheduledById);
        await obj.deleteScheduleDoc(sched);
        return true;
    };

    obj.rpc.updateSchedule = async function(args, session) {
        var existing = await getOne(args.scheduleId, 'jobSchedule');
        await obj.requireNode(session, existing.node);
        obj.requireOwnerOrManage(session, existing.scheduledById);
        var sched = cleanSchedule(args.schedule);
        await obj.db.deleteUndispatchedJobsForSchedule(existing._id);
        // Start afresh from now: no run for a slot that has already passed
        await obj.db.update(existing._id, Object.assign(sched, { lastSlot: Math.floor(Date.now() / 1000), nextRun: null, anchorAt: null }));
        await obj.ensureScheduleJobs(existing._id);
        obj.invalidate({ nodeIds: [existing.node], scriptIds: [existing.scriptId] });
        return true;
    };

    obj.pauseScheduleDoc = async function(existing, paused) {
        if (paused) {
            await obj.db.deleteUndispatchedJobsForSchedule(existing._id);
            await obj.db.update(existing._id, { paused: true, nextRun: null });
        } else {
            // Resume with the next slot from now; slots that passed while paused are skipped
            await obj.db.update(existing._id, { paused: false, lastSlot: Math.floor(Date.now() / 1000) });
            await obj.ensureScheduleJobs(existing._id);
        }
        obj.invalidate({ nodeIds: [existing.node], scriptIds: [existing.scriptId] });
    };

    obj.rpc.pauseSchedule = async function(args, session) {
        var existing = await getOne(args.scheduleId, 'jobSchedule');
        await obj.requireNode(session, existing.node);
        obj.requireOwnerOrManage(session, existing.scheduledById);
        await obj.pauseScheduleDoc(existing, args.paused === true);
        return true;
    };

    // -- Server-wide queue, schedules and history (managers) --

    // A run sent this long ago without a result is flagged (a setting; RPCs that use it load settings first)
    function staleSeconds() { return 60 * (obj.settingsCache ? obj.settingsCache.staleMinutes : obj.SETTINGS_DEFAULTS.staleMinutes); }
    var PAGE_MAX = 200;

    // Devices this user can see, out of those with ScriptTask jobs or schedules (plus extraIds).
    // Uses MeshCentral's own rights check per device, cached briefly per user.
    var visibleCache = {};
    obj.visibleNodes = async function(session, extraIds) {
        var key = session.user._id, cached = visibleCache[key];
        if (cached == null || cached.until < Date.now()) cached = visibleCache[key] = { nodes: new Set(), checked: new Set(), until: Date.now() + 30000 };
        // Devices seen for the first time since the cache started are checked now, so new jobs show straight away
        var ids = Array.from(new Set((await obj.db.getNodeIdsInUse()).concat(extraIds || []))).filter(function(id) { return !cached.checked.has(id); });
        await Promise.all(ids.map(function(nodeId) {
            cached.checked.add(nodeId);
            return new Promise(function(resolve) {
                obj.meshServer.webserver.GetNodeWithRights(session.domain, session.user, nodeId, function(node, rights, visible) { if (node != null && visible) cached.nodes.add(nodeId); resolve(); });
            });
        }));
        return cached.nodes;
    };
    function page(args) {
        return { skip: Math.max(0, Math.floor(Number(args.skip) || 0)), limit: Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(args.limit) || 50))) };
    }
    function cleanFilters(f) {
        f = (f != null && typeof f == 'object') ? f : {};
        var out = {};
        if (typeof f.scriptId == 'string' && f.scriptId) out.scriptId = f.scriptId.substring(0, 128);
        if (Array.isArray(f.nodeIds) && f.nodeIds.length) out.nodeIds = f.nodeIds.filter(function(n) { return typeof n == 'string'; }).slice(0, 5000);
        if (typeof f.runBy == 'string' && f.runBy.trim()) out.runBy = f.runBy.trim().substring(0, 128);
        if (typeof f.status == 'string' && f.status) out.status = f.status;
        if (f.source == 'manual' || f.source == 'schedule') out.source = f.source;
        if (Number(f.from) > 0) out.from = Math.floor(Number(f.from));
        if (Number(f.to) > 0) out.to = Math.floor(Number(f.to));
        if (typeof f.q == 'string' && f.q.trim()) out.q = f.q.trim().substring(0, 200);
        if (typeof f.batchId == 'string' && f.batchId) out.batchId = f.batchId.substring(0, 64);
        return out;
    }
    function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    // The devices a query may cover: the requested ones that this user can see
    function nodeScope(filters, visible) {
        var ids = filters.nodeIds ? filters.nodeIds.filter(function(n) { return visible.has(n); }) : Array.from(visible);
        return ids;
    }
    // A queued job's state, as the pages show it
    function queueStatus(j, now) {
        if (j.dispatchTime != null) return (now - j.dispatchTime > staleSeconds()) ? 'stale' : 'dispatched';
        if (j.expiresAt != null && j.expiresAt <= now) return 'missed';
        if (j.dontQueueUntil != null && j.dontQueueUntil > now) return 'scheduled';
        return (obj.meshServer.webserver.wsagents[j.node] != null) ? 'queued' : 'waiting';
    }

    obj.rpc.queue = async function(args, session) {
        obj.requireManage(session);
        await obj.getSettings();
        var filters = cleanFilters(args.filters), p = page(args), now = Math.floor(Date.now() / 1000);
        var visible = await obj.visibleNodes(session);
        var nodes = new Set(nodeScope(filters, visible));
        var runBy = filters.runBy ? new RegExp(escapeRegex(filters.runBy), 'i') : null;
        var jobs = (await obj.db.getAllIncompleteJobs()).filter(function(j) {
            if (!nodes.has(j.node)) return false;
            if (filters.scriptId && j.scriptId != filters.scriptId) return false;
            if (filters.batchId && j.batchId != filters.batchId) return false;
            if (runBy && !runBy.test(j.runBy || '')) return false;
            if (filters.source == 'manual' && j.jobSchedule != null) return false;
            if (filters.source == 'schedule' && j.jobSchedule == null) return false;
            j.state = queueStatus(j, now);
            j.online = obj.meshServer.webserver.wsagents[j.node] != null;
            if (filters.status && j.state != filters.status) return false;
            return true;
        });
        // Running and overdue first, then by when they are due
        var order = { stale: 0, dispatched: 1, missed: 2, queued: 3, waiting: 4, scheduled: 5 };
        jobs.sort(function(a, b) { return (order[a.state] - order[b.state]) || ((a.dontQueueUntil || 0) - (b.dontQueueUntil || 0)); });
        return { total: jobs.length, jobs: jobs.slice(p.skip, p.skip + p.limit), staleSeconds: staleSeconds() };
    };

    obj.rpc.schedules = async function(args, session) {
        obj.requireManage(session);
        var filters = cleanFilters(args.filters), p = page(args);
        var visible = await obj.visibleNodes(session);
        var nodes = new Set(nodeScope(filters, visible));
        var runBy = filters.runBy ? new RegExp(escapeRegex(filters.runBy), 'i') : null;
        var list = (await obj.db.getAllSchedules()).filter(function(s) {
            if (!nodes.has(s.node)) return false;
            if (filters.scriptId && s.scriptId != filters.scriptId) return false;
            if (filters.batchId && s.batchId != filters.batchId) return false;
            if (runBy && !runBy.test(s.scheduledBy || '')) return false;
            if (filters.status == 'paused' && s.paused !== true) return false;
            if (filters.status == 'active' && s.paused === true) return false;
            return true;
        });
        // Soonest first; paused last
        list.sort(function(x, y) { return ((x.paused === true) - (y.paused === true)) || ((x.nextRun == null) - (y.nextRun == null)) || ((x.nextRun || 0) - (y.nextRun || 0)); });
        return { total: list.length, schedules: list.slice(p.skip, p.skip + p.limit) };
    };

    obj.rpc.history = async function(args, session) {
        obj.requireManage(session);
        var filters = cleanFilters(args.filters), p = page(args);
        var visible = await obj.visibleNodes(session);
        var and = [ { completeTime: { $ne: null } }, { node: { $in: nodeScope(filters, visible) } } ];
        if (filters.scriptId) and.push({ scriptId: filters.scriptId });
        if (filters.batchId) and.push({ batchId: filters.batchId });
        if (filters.runBy) and.push({ runBy: { $regex: new RegExp(escapeRegex(filters.runBy), 'i') } });
        if (filters.source == 'manual') and.push({ jobSchedule: null });
        if (filters.source == 'schedule') and.push({ jobSchedule: { $ne: null } });
        if (filters.from) and.push({ completeTime: { $gte: filters.from } });
        if (filters.to) and.push({ completeTime: { $lte: filters.to } });
        switch (filters.status) {
            case 'missed': and.push({ missed: true }); break;
            case 'cancelled': and.push({ cancelled: true }); break;
            case 'error': and.push({ errorVal: { $ne: null } }, { returnVal: null }, { missed: { $ne: true } }, { cancelled: { $ne: true } }); break;
            case 'complete': and.push({ returnVal: { $ne: null } }, { cancelled: { $ne: true } }); break;
        }
        if (filters.q) { var re = new RegExp(escapeRegex(filters.q), 'i'); and.push({ $or: [ { returnVal: { $regex: re } }, { errorVal: { $regex: re } } ] }); }
        var find = { $and: and };
        var results = await Promise.all([ obj.db.countJobs(find), obj.db.findJobs(find, { completeTime: -1 }, p.skip, p.limit) ]);
        // Lists carry the start of the output only; the full output comes from obj.rpc.job
        var jobs = results[1].map(function(j) {
            ['returnVal', 'errorVal'].forEach(function(k) { if (typeof j[k] == 'string' && j[k].length > 300) { j[k] = j[k].substring(0, 300); j.truncated = true; } });
            return j;
        });
        return { total: results[0], jobs: jobs };
    };

    // One job in full (for the output viewer): managers for devices they can see, or users who can run scripts on its device
    obj.rpc.job = async function(args, session) {
        var job = await getOne(args.id, 'job');
        if (obj.hasPerm(session.user, 'manage') && (await obj.visibleNodes(session)).has(job.node)) return job;
        await obj.requireNode(session, job.node);
        return job;
    };

    obj.rpc.cancelJobs = async function(args, session) {
        obj.requireManage(session);
        var visible = await obj.visibleNodes(session), done = 0, skipped = 0;
        for (var id of (Array.isArray(args.jobIds) ? args.jobIds : []).slice(0, 1000)) {
            var found = await obj.db.get(String(id));
            var job = found[0];
            if (job == null || job.type != 'job' || job.completeTime != null || !visible.has(job.node)) { skipped++; continue; }
            await obj.cancelJobDoc(job, session.user.name);
            done++;
        }
        return { done: done, skipped: skipped };
    };

    // Start queued or scheduled runs now instead of at their due time. Runs already sent are left alone.
    obj.rpc.runJobsNow = async function(args, session) {
        obj.requireManage(session);
        var visible = await obj.visibleNodes(session), done = 0, skipped = 0, now = Math.floor(Date.now() / 1000), nodes = [];
        for (var id of (Array.isArray(args.jobIds) ? args.jobIds : []).slice(0, 1000)) {
            var found = await obj.db.get(String(id));
            var job = found[0];
            if (job == null || job.type != 'job' || job.completeTime != null || job.dispatchTime != null || !visible.has(job.node)) { skipped++; continue; }
            var update = { dontQueueUntil: now };
            if (job.expiresAt != null && job.expiresAt < now + 120) update.expiresAt = now + 120; // Don't let it expire before the queue gets to it
            await obj.db.update(job._id, update);
            nodes.push(job.node);
            done++;
        }
        if (done) { obj.queueRun(); obj.invalidate({ nodeIds: Array.from(new Set(nodes)) }); }
        return { done: done, skipped: skipped };
    };

    obj.rpc.scheduleAction = async function(args, session) {
        obj.requireManage(session);
        if (['pause', 'resume', 'delete'].indexOf(args.action) === -1) throw new RpcError('Unknown action.');
        var visible = await obj.visibleNodes(session), done = 0, skipped = 0;
        for (var id of (Array.isArray(args.scheduleIds) ? args.scheduleIds : []).slice(0, 1000)) {
            var found = await obj.db.get(String(id));
            var sched = found[0];
            if (sched == null || sched.type != 'jobSchedule' || !visible.has(sched.node)) { skipped++; continue; }
            if (args.action == 'delete') await obj.deleteScheduleDoc(sched);
            else if ((args.action == 'pause') != (sched.paused === true)) await obj.pauseScheduleDoc(sched, args.action == 'pause');
            done++;
        }
        return { done: done, skipped: skipped };
    };

    // -- Settings (managers) --

    obj.rpc.saveSettings = async function(args, session) {
        obj.requireManage(session);
        // Fields left out keep their current values
        var before = await obj.getSettings();
        args = Object.assign({}, before, args);
        var s = {
            skipGraceSeconds: Math.floor(Number(args.skipGraceSeconds)),
            defaultOfflinePolicy: (['wait', 'window', 'skip'].indexOf(args.defaultOfflinePolicy) >= 0) ? args.defaultOfflinePolicy : 'wait',
            defaultOfflineWindow: Math.floor(Number(args.defaultOfflineWindow)),
            defaultAnchor: (args.defaultAnchor == 'actual') ? 'actual' : 'slot',
            historyDays: Math.floor(Number(args.historyDays)),
            staleMinutes: Math.floor(Number(args.staleMinutes)),
            queueIntervalSeconds: Math.floor(Number(args.queueIntervalSeconds)),
            pageSize: Math.floor(Number(args.pageSize)),
            scheduleStepMinutes: Number(args.scheduleStepMinutes),
            indentPs1: String(args.indentPs1), indentBat: String(args.indentBat), indentBash: String(args.indentBash)
        };
        if (!(s.skipGraceSeconds >= 60 && s.skipGraceSeconds <= 3600)) throw new RpcError('The Skip grace period must be between 1 and 60 minutes.');
        if (!(s.historyDays >= 1 && s.historyDays <= 3650)) throw new RpcError('Keep history for between 1 and 3650 days.');
        if (!(s.staleMinutes >= 5 && s.staleMinutes <= 1440)) throw new RpcError('The "No result yet" time must be between 5 minutes and 24 hours.');
        if (!(s.queueIntervalSeconds >= 15 && s.queueIntervalSeconds <= 600)) throw new RpcError('The queue check interval must be between 15 seconds and 10 minutes.');
        if (!(s.pageSize >= 10 && s.pageSize <= 200)) throw new RpcError('Rows per page must be between 10 and 200.');
        if (SCHEDULE_STEPS.indexOf(s.scheduleStepMinutes) < 0) throw new RpcError('Invalid schedule time step.');
        if ([s.indentPs1, s.indentBat, s.indentBash].some(function(v) { return INDENTS.indexOf(v) < 0; })) throw new RpcError('Invalid indentation.');
        if (!(s.defaultOfflineWindow >= 60 && s.defaultOfflineWindow <= 30 * 86400)) throw new RpcError('The default window must be between 1 minute and 30 days.');
        await obj.db.saveSettings(s);
        obj.settingsCache = null;
        if (s.historyDays < before.historyDays) { obj.lastCleanup = 0; obj.cleanHistory(); }
        if (s.queueIntervalSeconds != before.queueIntervalSeconds) { await obj.getSettings(); obj.resetQueueTimer(); }
        obj.invalidate({ settings: true });
        return obj.getSettings();
    };

    // -- Batches (managers) --

    // Which of these devices the user may run scripts on
    obj.allowedTargets = async function(session, nodeIds) {
        var accepted = [], refused = [];
        for (var nodeId of Array.from(new Set(nodeIds))) {
            var caps = await obj.getNodeCaps(session, nodeId);
            if (caps.run) accepted.push(nodeId); else refused.push(nodeId);
        }
        return { accepted: accepted, refused: refused };
    };
    obj.startBatch = async function(session, script, nodeIds, name, recurring, sched) {
        var batchId = require('crypto').randomBytes(9).toString('hex');
        await obj.db.addBatch({ batchId: batchId, name: (typeof name == 'string' && name.trim()) ? name.trim().substring(0, 120) : null, scriptId: String(script._id), scriptName: script.name,
            createdBy: session.user.name, createdById: session.user._id, createdAt: Math.floor(Date.now() / 1000), createdMs: Date.now(), nodeIds: nodeIds, recurring: recurring === true, schedule: sched || null });
        return batchId;
    };

    // A job's state for batch summaries: finished states, or the queue's states while pending
    function jobState(j, now) {
        if (j.completeTime == null) return queueStatus(j, now);
        if (j.cancelled) return 'cancelled';
        if (j.missed) return 'missed';
        return (j.errorVal != null && j.returnVal == null) ? 'error' : 'complete';
    }
    function jobOutput(j) {
        var v = (j.errorVal != null && j.returnVal == null) ? j.errorVal : j.returnVal;
        if (v == null) return '';
        return ((typeof v == 'string') ? v : JSON.stringify(v)).replace(/\r\n?/g, '\n').trim();
    }
    // A manual batch can have several runs per device after Run again; it shows each device's latest
    function latestPerNode(jobs) {
        var latest = {};
        jobs.forEach(function(j) {
            var cur = latest[j.node];
            // Runs queued in the same second: the unfinished one is the rerun
            if (cur == null || (j.queueTime || 0) > (cur.queueTime || 0) || ((j.queueTime || 0) == (cur.queueTime || 0) && cur.completeTime != null && j.completeTime == null)) latest[j.node] = j;
        });
        return latest;
    }
    function countStates(jobs, now) {
        var c = {};
        jobs.forEach(function(j) { var st = jobState(j, now); c[st] = (c[st] || 0) + 1; });
        return c;
    }
    // A scheduled batch's runs, one occurrence (slot) at a time: the latest one that has started, or the next one
    function slotsOf(jobs) {
        return Array.from(new Set(jobs.map(function(j) { return j.slot; }).filter(function(s) { return s != null; }))).sort(function(a, b) { return b - a; });
    }
    function currentSlot(slots, now) {
        var started = slots.filter(function(s) { return s <= now; });
        return started.length ? started[0] : (slots.length ? slots[slots.length - 1] : null);
    }

    obj.rpc.batches = async function(args, session) {
        obj.requireManage(session);
        await obj.getSettings();
        var p = page(args), now = Math.floor(Date.now() / 1000);
        var results = await Promise.all([obj.db.countBatches(), obj.db.getBatches(p.skip, p.limit)]);
        var batches = results[1];
        var visible = await obj.visibleNodes(session, [].concat.apply([], batches.map(function(b) { return b.nodeIds; })));
        var jobs = batches.length ? await obj.db.getJobsForBatches(batches.map(function(b) { return b.batchId; })) : [];
        batches.forEach(function(b) {
            var mine = jobs.filter(function(j) { return j.batchId == b.batchId && visible.has(j.node); });
            if (b.recurring) { b.slot = currentSlot(slotsOf(mine), now); mine = mine.filter(function(j) { return j.slot == b.slot; }); }
            var latest = latestPerNode(mine);
            b.counts = countStates(Object.keys(latest).map(function(k) { return latest[k]; }), now);
            b.visibleDevices = b.nodeIds.filter(function(n) { return visible.has(n); }).length;
        });
        return { total: results[0], batches: batches };
    };

    // One batch's results: devices grouped by identical output, and a row per device
    obj.rpc.batch = async function(args, session) {
        obj.requireManage(session);
        await obj.getSettings();
        var batch = await obj.db.getBatch(String(args.batchId || ''));
        if (batch == null) throw new RpcError('Batch not found.');
        var now = Math.floor(Date.now() / 1000);
        var visible = await obj.visibleNodes(session, batch.nodeIds);
        var jobs = (await obj.db.getJobsForBatches([batch.batchId])).filter(function(j) { return visible.has(j.node); });
        var slots = batch.recurring ? slotsOf(jobs) : [];
        var slot = null;
        if (batch.recurring) {
            slot = (args.slot != null && slots.indexOf(Number(args.slot)) >= 0) ? Number(args.slot) : currentSlot(slots, now);
            jobs = jobs.filter(function(j) { return j.slot == slot; });
        }
        var latest = latestPerNode(jobs);
        jobs = Object.keys(latest).map(function(k) { return latest[k]; });
        var groups = {}, rows = [];
        jobs.forEach(function(j) {
            var state = jobState(j, now), out = (j.completeTime != null) ? jobOutput(j) : '';
            var finished = ['complete', 'error'].indexOf(state) >= 0;
            var key = state + '\u0000' + (finished ? out : '');
            if (groups[key] == null) groups[key] = { state: state, output: finished ? out.substring(0, 4000) : '', truncated: finished && out.length > 4000, nodeIds: [], jobIds: [] };
            groups[key].nodeIds.push(j.node); groups[key].jobIds.push(j._id);
            rows.push({ jobId: j._id, node: j.node, state: state, queueTime: j.queueTime, dispatchTime: j.dispatchTime, completeTime: j.completeTime, output: (args.fullOutput === true) ? out : out.substring(0, 2000), outputLength: out.length });
        });
        // Most common result first; finished results before pending ones
        var order = { complete: 0, error: 0, missed: 1, cancelled: 1, stale: 2, dispatched: 3, queued: 4, waiting: 4, scheduled: 5 };
        var list = Object.keys(groups).map(function(k) { return groups[k]; }).sort(function(a, b) { return (order[a.state] - order[b.state]) || (b.nodeIds.length - a.nodeIds.length); });
        return { batch: batch, slots: slots, slot: slot, counts: countStates(jobs, now), groups: list, rows: rows,
            missing: batch.nodeIds.filter(function(n) { return visible.has(n) && latest[n] == null; }) };
    };

    obj.rpc.targetSets = function(args, session) {
        obj.requireManage(session);
        return obj.db.getTargetSets(session.user._id);
    };
    obj.rpc.saveTargetSet = async function(args, session) {
        obj.requireManage(session);
        var nodeIds = Array.isArray(args.nodeIds) ? args.nodeIds.filter(function(n) { return typeof n == 'string'; }).slice(0, 5000) : [];
        if (nodeIds.length == 0) throw new RpcError('Select some devices first.');
        await obj.db.saveTargetSet(session.user._id, str(args.name, 80), nodeIds);
        return obj.db.getTargetSets(session.user._id);
    };
    obj.rpc.deleteTargetSet = async function(args, session) {
        obj.requireManage(session);
        var set = await getOne(args.id, 'targetSet');
        if (set.ownerId != session.user._id) throw new RpcError('Not found. It may have been deleted.');
        await obj.db.delete(set._id);
        return obj.db.getTargetSets(session.user._id);
    };

    // -- Library (managers) --

    obj.rpc.getScript = function(args, session) {
        obj.requireManage(session);
        return getOne(args.id, 'script');
    };

    obj.rpc.scriptData = async function(args, session) {
        obj.requireManage(session);
        var script = await getOne(args.scriptId, 'script');
        var results = await Promise.all([obj.db.getJobScriptHistory(script._id), obj.db.getJobSchedulesForScript(script._id)]);
        return { history: results[0], schedules: results[1] };
    };

    obj.rpc.addScript = async function(args, session) {
        obj.requireManage(session);
        if (FILE_TYPES.indexOf(args.filetype) === -1) throw new RpcError('Scripts must be PowerShell (.ps1), Batch (.bat) or Bash.');
        if (typeof args.content != 'string' || args.content.length > 4 * 1024 * 1024) throw new RpcError('Script content is missing or larger than 4 MB.');
        var path = await folderPath(args.folderId);
        var r = await obj.db.addScript(name(args.name), args.content, path, args.filetype);
        obj.invalidate({ library: true });
        return { id: r.insertedId };
    };

    obj.rpc.saveScript = async function(args, session) {
        obj.requireManage(session);
        var script = await getOne(args.id, 'script');
        var filetype = (args.filetype != null) ? args.filetype : script.filetype;
        if (FILE_TYPES.indexOf(filetype) === -1) throw new RpcError('Unknown script type.');
        if (typeof args.content != 'string' || args.content.length > 4 * 1024 * 1024) throw new RpcError('Script content is missing or larger than 4 MB.');
        var newName = name(args.name);
        await obj.db.update(script._id, { name: newName, content: args.content, filetype: filetype });
        if (newName != script.name) await obj.db.updateScriptJobName(script._id, newName);
        obj.invalidate({ library: true, scriptIds: [script._id] });
        return true;
    };

    obj.rpc.newFolder = async function(args, session) {
        obj.requireManage(session);
        var parentPath = await folderPath(args.parentId);
        var folderName = name(args.name);
        await obj.db.addFolder(folderName, parentPath + '/' + folderName);
        obj.invalidate({ library: true });
        return true;
    };

    obj.rpc.rename = async function(args, session) {
        obj.requireManage(session);
        var item = await getOne(args.id);
        var newName = name(args.name);
        if (item.type == 'folder') {
            if (item.path == 'Shared') throw new RpcError('The top-level Shared folder can\'t be renamed.');
            var newPath = item.path.substring(0, item.path.length - item.name.length) + newName;
            await obj.db.rebasePath(item.path, newPath);
        } else if (item.type == 'script') {
            await obj.db.updateScriptJobName(item._id, newName);
        } else throw new RpcError('Only scripts and folders can be renamed.');
        await obj.db.update(item._id, { name: newName });
        obj.invalidate({ library: true, scriptIds: [item._id] });
        return true;
    };

    obj.rpc.move = async function(args, session) {
        obj.requireManage(session);
        var item = await getOne(args.id);
        var target = await getOne(args.toId, 'folder');
        if (item.type == 'folder') {
            if (item.path == 'Shared') throw new RpcError('The top-level Shared folder can\'t be moved.');
            if (target.path == item.path || target.path.indexOf(item.path + '/') === 0) throw new RpcError('A folder can\'t be moved into itself.');
            await obj.db.rebasePath(item.path, target.path + '/' + item.name);
        } else if (item.type == 'script') {
            await obj.db.update(item._id, { path: target.path });
        } else throw new RpcError('Only scripts and folders can be moved.');
        obj.invalidate({ library: true });
        return true;
    };

    obj.rpc.deleteItem = async function(args, session) {
        obj.requireManage(session);
        var item = await getOne(args.id);
        var scripts = [];
        if (item.type == 'folder') {
            if (item.path == 'Shared') throw new RpcError('The top-level Shared folder can\'t be deleted.');
            var contents = await obj.db.getByPathPrefix(item.path);
            scripts = contents.filter(function(i) { return i.type == 'script'; });
            for (var c of contents) await obj.db.delete(c._id);
        } else if (item.type == 'script') {
            scripts = [item];
            await obj.db.delete(item._id);
        } else throw new RpcError('Only scripts and folders can be deleted.');
        for (var s of scripts) {
            var schedules = await obj.db.getJobSchedulesForScript(s._id);
            for (var sc of schedules) await obj.db.deletePendingJobsForSchedule(sc._id);
            await obj.db.deleteSchedulesForScript(s._id);
            await obj.db.deleteVariablesForScript(s._id);
        }
        obj.invalidate({ library: true, variables: true, scriptIds: scripts.map(function(s) { return s._id; }) });
        return true;
    };

    // -- Variables (managers) --

    function cleanVar(args) {
        var scopes = ['global', 'script', 'mesh', 'node'];
        if (scopes.indexOf(args.scope) === -1) throw new RpcError('Invalid scope.');
        var v = { name: str(args.name, 128), scope: args.scope, scopeTarget: (args.scope == 'global') ? null : id(args.scopeTarget), secret: args.secret === true };
        if (/[#\s]/.test(v.name)) throw new RpcError('Variable names can\'t contain spaces or #.');
        // A secret's value is left out of lists, so editing one without a new value keeps the old value
        if (args.value !== undefined) {
            v.value = (args.value == null) ? '' : String(args.value);
            if (v.value.length > 64 * 1024) throw new RpcError('Value is larger than 64 KB.');
        }
        return v;
    }
    // Managers only see and set variables for device groups and devices they can see
    obj.canSeeMesh = function(session, meshId) {
        if (obj.isFullAdmin(session.user) && typeof obj.meshServer.webserver.IsMeshViewable != 'function') return true;
        return typeof obj.meshServer.webserver.IsMeshViewable == 'function' && obj.meshServer.webserver.IsMeshViewable(session.user, meshId) === true;
    };
    obj.canSeeNode = function(session, nodeId) {
        return new Promise(function(resolve) {
            obj.meshServer.webserver.GetNodeWithRights(session.domain, session.user, nodeId, function(node, rights, visible) { resolve(node != null && visible === true); });
        });
    };
    // newTarget: the target is being set, so a script target must exist (an existing variable may outlive its script)
    async function checkVarTarget(session, v, newTarget) {
        if (v.scope == 'mesh' && !obj.canSeeMesh(session, v.scopeTarget)) throw new RpcError('Device group not found.');
        if (v.scope == 'node' && !(await obj.canSeeNode(session, v.scopeTarget))) throw new RpcError('Device not found.');
        if (v.scope == 'script' && newTarget) await getOne(v.scopeTarget, 'script');
    }

    obj.rpc.variables = async function(args, session) {
        obj.requireManage(session);
        var vars = await obj.db.getVariables(), out = [], nodeSeen = {};
        for (var v of vars) {
            if (v.scope == 'mesh' && !obj.canSeeMesh(session, v.scopeTarget)) continue;
            if (v.scope == 'node') {
                if (nodeSeen[v.scopeTarget] == null) nodeSeen[v.scopeTarget] = await obj.canSeeNode(session, v.scopeTarget);
                if (!nodeSeen[v.scopeTarget]) continue;
            }
            if (v.secret === true) { v = Object.assign({}, v); delete v.value; }
            out.push(v);
        }
        return out;
    };
    obj.rpc.revealVar = async function(args, session) {
        obj.requireManage(session);
        var v = await getOne(args.id, 'variable');
        await checkVarTarget(session, v);
        return v.value;
    };
    // Which library scripts use each variable name, as #name#
    obj.rpc.varUsage = async function(args, session) {
        obj.requireManage(session);
        var usage = {}, re = /#([A-Za-z0-9_:.\-]+)#/g, m;
        (await obj.db.getScriptContents()).forEach(function(sc) {
            var seen = {};
            re.lastIndex = 0;
            while ((m = re.exec(sc.content || '')) != null) {
                if (seen[m[1]]) continue;
                seen[m[1]] = true;
                (usage[m[1]] = usage[m[1]] || []).push(sc._id);
            }
        });
        return usage;
    };
    obj.rpc.addVar = async function(args, session) {
        obj.requireManage(session);
        var v = cleanVar(args);
        await checkVarTarget(session, v, true);
        var r = await obj.db.addVariable(v.name, v.scope, v.scopeTarget, v.value || '');
        if (v.secret) await obj.db.update(r.insertedId, { secret: true });
        obj.invalidate({ variables: true });
        return true;
    };
    obj.rpc.editVar = async function(args, session) {
        obj.requireManage(session);
        var existing = await getOne(args.id, 'variable');
        await checkVarTarget(session, existing);
        var v = cleanVar(args);
        await checkVarTarget(session, v, v.scope != existing.scope || v.scopeTarget != existing.scopeTarget);
        if (v.value === undefined && existing.secret !== true) throw new RpcError('Invalid input.');
        await obj.db.update(existing._id, v);
        obj.invalidate({ variables: true });
        return true;
    };
    obj.rpc.deleteVar = async function(args, session) {
        obj.requireManage(session);
        var existing = await getOne(args.id, 'variable');
        await checkVarTarget(session, existing);
        await obj.db.delete(existing._id);
        obj.invalidate({ variables: true });
        return true;
    };

    // -- Overview (managers) --

    obj.rpc.overview = async function(args, session) {
        obj.requireManage(session);
        var settings = await obj.getSettings();
        var now = Math.floor(Date.now() / 1000), since = now - 86400;
        var visible = await obj.visibleNodes(session), nodes = Array.from(visible);
        var queue = (await obj.db.getAllIncompleteJobs()).filter(function(j) { return visible.has(j.node); });
        var counts = { queued: 0, waiting: 0, scheduled: 0, dispatched: 0, stale: 0, missed: 0 };
        queue.forEach(function(j) { j.state = queueStatus(j, now); counts[j.state]++; });
        var recent = { $and: [ { node: { $in: nodes } }, { completeTime: { $gte: since } } ] };
        var failed = { $and: recent.$and.concat([ { errorVal: { $ne: null } }, { returnVal: null }, { missed: { $ne: true } }, { cancelled: { $ne: true } } ]) };
        var missed = { $and: recent.$and.concat([ { missed: true } ]) };
        var completed = { $and: recent.$and.concat([ { returnVal: { $ne: null } }, { cancelled: { $ne: true } } ]) };
        var r = await Promise.all([
            obj.db.countJobs(failed), obj.db.countJobs(missed), obj.db.countJobs(completed),
            obj.db.findJobs({ $or: [ failed, missed ] }, { completeTime: -1 }, 0, 8),
            obj.db.getAllSchedules()
        ]);
        var schedules = r[4].filter(function(s) { return visible.has(s.node); });
        var trim = function(j) {
            ['returnVal', 'errorVal'].forEach(function(k) { if (typeof j[k] == 'string' && j[k].length > 300) j[k] = j[k].substring(0, 300); });
            return j;
        };
        return {
            now: now,
            staleSeconds: settings.staleMinutes * 60,
            queue: counts,
            day: { failed: r[0], missed: r[1], completed: r[2] },
            schedules: { active: schedules.filter(function(s) { return s.paused !== true && s.nextRun != null; }).length, paused: schedules.filter(function(s) { return s.paused === true; }).length },
            // Needs attention: recent errors and missed runs, and runs sent long ago without a result
            failures: r[3].map(trim),
            stale: queue.filter(function(j) { return j.state == 'stale'; }).sort(function(a, b) { return a.dispatchTime - b.dispatchTime; }).slice(0, 8),
            // Schedules' next runs, soonest first, including ones already due and waiting for their device
            upNext: queue.filter(function(j) { return j.jobSchedule != null && ['scheduled', 'queued', 'waiting'].indexOf(j.state) >= 0; }).sort(function(a, b) { return a.dontQueueUntil - b.dontQueueUntil; }).slice(0, 10)
        };
    };

    obj.handleRpc = function(command, session) {
        var reply = function(ok, data) {
            session.send({ action: 'plugin', plugin: 'scripttask', method: 'onRpcResult', reqId: command.reqId, ok: ok, data: ok ? data : undefined, error: ok ? undefined : data });
        };
        if (typeof command.method != 'string' || !Object.prototype.hasOwnProperty.call(obj.rpc, command.method)) { reply(false, 'Unknown request.'); return; }
        var args = (command.args != null && typeof command.args == 'object') ? command.args : {};
        Promise.resolve()
        .then(function() { return obj.rpc[command.method](args, session); })
        .then(function(data) { reply(true, data); })
        .catch(function(e) {
            if (e instanceof RpcError) { reply(false, e.message); return; }
            console.log('PLUGIN: ScriptTask: Error in ' + command.method + ': ', e);
            reply(false, 'Server error. See the MeshCentral log for details.');
        });
    };

    // ---- Messages from agents ----

    obj.agentAction = function(command, agent) {
        switch (command.pluginaction) {
            case 'getScript':
                //obj.debug('ScriptTask', 'getScript Triggered', JSON.stringify(command));
                obj.db.get(command.scriptId)
                .then(script => {
                    if (script.length != 1) return;
                    agent.send(JSON.stringify({
                        action: 'plugin',
                        plugin: 'scripttask',
                        pluginaction: 'cacheScript',
                        nodeid: agent.dbNodeKey,
                        rights: true,
                        sessionid: true,
                        script: script[0]
                    }));
                });
            break;
            case 'jobComplete':
                //obj.debug('ScriptTask', 'jobComplete Triggered', JSON.stringify(command));
                var jobId = command.jobId, retVal = command.retVal, errVal = command.errVal, dispatchTime = command.dispatchTime;
                var completeTime = Math.floor(new Date() / 1000);
                obj.db.get(jobId)
                .then(jobs => {
                    var job = jobs[0];
                    if (job == null || job.node != agent.dbNodeKey) return; // Agents may only report their own jobs
                    var update = { completeTime: completeTime, returnVal: retVal, errorVal: errVal, dispatchTime: dispatchTime };
                    if (job.cancelled) { update.completeTime = job.completeTime; update.errorVal = job.errorVal; update.lateReturnVal = retVal; update.lateErrorVal = errVal; delete update.returnVal; }
                    if (job.interrupted) update.interrupted = false; // It finished after all: its real result replaces "Interrupted"
                    return obj.db.update(jobId, update)
                    .then(() => {
                        if (job.jobSchedule == null || job.cancelled || job.interrupted) return; // Its slot was closed when it was cancelled or interrupted
                        return obj.db.get(job.jobSchedule)
                        .then((found) => {
                            if (found.length == 0) return;
                            var extra = { lastRun: completeTime };
                            if (found[0].anchor == 'actual') extra.anchorAt = job.dispatchTime || dispatchTime; // Late runs move the schedule to when this run actually started
                            return obj.closeSlot(job.jobSchedule, job, extra)
                            .then(() => obj.ensureScheduleJobs(job.jobSchedule));
                        });
                    })
                    .then(() => {
                        obj.invalidate({ nodeIds: [job.node], scriptIds: [job.scriptId] });
                    });
                })
                .catch(e => { console.log('PLUGIN: ScriptTask: Failed to complete job. ', e); });
            break;
            case 'jobsNotRunning':
                obj.markInterrupted(agent, command.jobIds).catch(function(e) { console.log('PLUGIN: ScriptTask: Could not record interrupted jobs: ', e); });
            break;
            case 'clearAllPendingJobs':
                obj.db.deletePendingJobsForNode(agent.dbNodeKey)
                .then(() => { obj.invalidate({ nodeIds: [agent.dbNodeKey] }); });
            break;
        }
    };

    obj.serveraction = function(command, myparent, grandparent) {
        // Called for both user sessions (meshuser) and agent connections (meshagent). Only user sessions have a user.
        if (myparent.user == null) {
            if (typeof myparent.dbNodeKey == 'string') obj.agentAction(command, myparent);
            return;
        }
        if (command.pluginaction == 'rpc') { obj.handleRpc(command, myparent); return; }
        console.log('PLUGIN: ScriptTask: unknown action ' + command.pluginaction);
    };

    return obj;
}
