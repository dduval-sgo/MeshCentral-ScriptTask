/**
* @description MeshCentral ScriptTask
* @author Ryan Blenis
* @copyright
* @license Apache-2.0
*/

"use strict";

module.exports.scripttask = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.db = null;
    obj.intervalTimer = null;
    obj.debug = obj.meshServer.debug;
    obj.VIEWS = __dirname + '/views/';
    obj.INCLUDES = __dirname + '/includes/';
    obj.version = require(__dirname + '/config.json').version;
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
    obj.resetQueueTimer = function() {
        clearTimeout(obj.intervalTimer);
        obj.intervalTimer = setInterval(obj.queueRun, 1 * 60 * 1000); // every minute
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

    obj.queueRun = async function() {
        var onlineAgents = Object.keys(obj.meshServer.webserver.wsagents);
        //obj.debug('ScriptTask', 'Queue Running', Date().toLocaleString(), 'Online agents: ', onlineAgents);

        obj.db.getPendingJobs(onlineAgents)
        .then((jobs) => {
            if (jobs.length == 0) return;
            //@TODO check for a large number and use taskLimiter to queue the jobs
            jobs.forEach(job => {
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
                    //obj.debug('ScriptTask', 'Sending job to agent');
                    try {
                        obj.meshServer.webserver.wsagents[job.node].send(JSON.stringify(jObj));
                        obj.db.update(job._id, { dispatchTime: dispatchTime })
                        .then(() => { obj.invalidate({ nodeIds: [job.node] }); });
                    } catch (e) { }
                })
                .catch(e => console.log('PLUGIN: ScriptTask: Could not dispatch job.', e));
            });
        })
        .then(() => {
            obj.makeJobsFromSchedules();
            obj.cleanHistory();
        })
        .catch(e => { console.log('PLUGIN: ScriptTask: Queue Run Error: ', e); });
    };

    obj.cleanHistory = function() {
        if (Math.round(Math.random() * 100) == 99) {
            //obj.debug('Plugin', 'ScriptTask', 'Running history cleanup');
            obj.db.deleteOldHistory();
        }
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
        res.sendStatus(401);
    };

    // ---- Scheduling ----

    obj.determineNextJobTime = function(s) {
        var nextTime = null;
        var nowTime = Math.floor(new Date() / 1000);

        // special case: we've reached the end of our run
        if (s.endAt !== null && s.endAt <= nowTime) {
            return nextTime;
        }

        switch (s.recur) {
            case 'once':
                if (s.nextRun == null) nextTime = s.startAt;
                else nextTime = null;
            break;
            case 'minutes':
                /*var lRun = s.nextRun || nowTime;
                if (lRun == null) lRun = nowTime;
                nextTime = lRun + (s.interval * 60);
                if (s.startAt > nextTime) nextTime = s.startAt;*/
                if (s.nextRun == null) { // hasn't run yet, set to start time
                    nextTime = s.startAt;
                    break;
                }
                nextTime = s.nextRun + (s.interval * 60);
                // this prevents "catch-up" tasks being scheduled if an endpoint is offline for a long period of time
                // e.g. always make sure the next scheduled time is relevant to the scheduled interval, but in the future
                if (nextTime < nowTime) {
                    // initially I was worried about this causing event loop lockups
                    // if there was a long enough time gap. Testing over 50 years of backlog for a 3 min interval
                    // still ran under a fraction of a second. Safe to say this approach is safe! (~8.5 million times)
                    while (nextTime < nowTime) {
                        nextTime = nextTime + (s.interval * 60);
                    }
                }
                if (s.startAt > nextTime) nextTime = s.startAt;
            break;
            case 'hourly':
                if (s.nextRun == null) { // hasn't run yet, set to start time
                    nextTime = s.startAt;
                    break;
                }
                nextTime = s.nextRun + (s.interval * 60 * 60);
                if (nextTime < nowTime) {
                    while (nextTime < nowTime) {
                        nextTime = nextTime + (s.interval * 60 * 60);
                    }
                }
                if (s.startAt > nextTime) nextTime = s.startAt;
            break;
            case 'daily':
                if (s.nextRun == null) { // hasn't run yet, set to start time
                    nextTime = s.startAt;
                    break;
                }
                nextTime = s.nextRun + (s.interval * 60 * 60 * 24);
                if (nextTime < nowTime) {
                    while (nextTime < nowTime) {
                        nextTime = nextTime + (s.interval * 60 * 60 * 24);
                    }
                }
                if (s.startAt > nextTime) nextTime = s.startAt;
            break;
            case 'weekly':
                var tempDate = new Date();
                var nowDate = new Date(tempDate.getFullYear(), tempDate.getMonth(), tempDate.getDate());

                if (s.daysOfWeek.length == 0) {
                    nextTime = null;
                    break;
                }
                s.daysOfWeek = s.daysOfWeek.map(el => Number(el));
                var baseTime = s.startAt;
                //console.log('dow is ', s.daysOfWeek);
                var lastDayOfWeek = Math.max(...s.daysOfWeek);
                var startX = 0;
                //console.log('ldow is ', lastDayOfWeek);
                if (s.nextRun != null) {
                    baseTime = s.nextRun;
                    //console.log('basetime 2: ', baseTime);
                    if (nowDate.getDay() == lastDayOfWeek) {
                        baseTime = baseTime + ( s.interval * 604800 ) - (lastDayOfWeek * 86400);
                        //console.log('basetime 3: ', baseTime);
                    }
                    startX = 0;
                } else if (s.startAt < nowTime) {
                    baseTime = Math.floor(nowDate.getTime() / 1000);
                    //console.log('basetime 4: ', baseTime);
                }
                //console.log('startX is: ', startX);
                //var secondsFromMidnight = nowTimeDate.getSeconds() + (nowTimeDate.getMinutes() * 60) + (nowTimeDate.getHours() * 60 * 60);
                //console.log('seconds from midnight: ', secondsFromMidnight);
                //var dBaseTime = new Date(0); dBaseTime.setUTCSeconds(baseTime);
                //var dMidnight = new Date(dBaseTime.getFullYear(), dBaseTime.getMonth(), dBaseTime.getDate());
                //baseTime = Math.floor(dMidnight.getTime() / 1000);
                for (var x = startX; x <= 7; x++){
                    var checkDate = baseTime + (86400 * x);
                    var d = new Date(0); d.setUTCSeconds(checkDate);
                    var dm = new Date(d.getFullYear(), d.getMonth(), d.getDate());

                    console.log('testing date: ', dm.toLocaleString()); // dMidnight.toLocaleString());
                    //console.log('if break check :', (s.daysOfWeek.indexOf(d.getDay()) !== -1 && checkDate >= nowTime));
                    //console.log('checkDate vs nowTime: ', (checkDate - nowTime), ' if positive, nowTime is less than checkDate');
                    if (s.nextRun == null && s.daysOfWeek.indexOf(dm.getDay()) !== -1 && dm.getTime() >= nowDate.getTime()) break;
                    if (s.daysOfWeek.indexOf(dm.getDay()) !== -1 && dm.getTime() > nowDate.getTime()) break;
                    //if (s.daysOfWeek.indexOf(d.getDay()) !== -1 && Math.floor(d.getTime() / 1000) >= nowTime) break;
                }
                var sa = new Date(0); sa.setUTCSeconds(s.startAt);
                var sad = new Date(sa.getFullYear(), sa.getMonth(), sa.getDate());
                var diff = (sa.getTime() - sad.getTime()) / 1000;
                nextTime = Math.floor(dm.getTime() / 1000) + diff;
                //console.log('next schedule is ' + d.toLocaleString());
            break;
            default:
                nextTime = null;
            break;
        }

        if (s.endAt != null && nextTime > s.endAt) nextTime = null; // if the next time reaches the bound of the endAt time, nullify

        return nextTime;
    };

    obj.makeJobsFromSchedules = function(scheduleId) {
        //obj.debug('ScriptTask', 'makeJobsFromSchedules starting');
        return obj.db.getSchedulesDueForJob(scheduleId)
        .then(schedules => {
            //obj.debug('ScriptTask', 'Found ' + schedules.length + ' schedules to process. Current time is: ' + Math.floor(new Date() / 1000));
            if (schedules.length) {
                schedules.forEach(s => {
                    var nextJobTime = obj.determineNextJobTime(s);
                    var nextJobScheduled = false;
                    if (nextJobTime === null) {
                        //obj.debug('ScriptTask', 'Removing Job Schedule for', JSON.stringify(s));
                        obj.db.removeJobSchedule(s._id)
                        .then(() => { obj.invalidate({ nodeIds: [s.node], scriptIds: [s.scriptId] }); });
                    } else {
                        //obj.debug('ScriptTask', 'Scheduling Job for', JSON.stringify(s));
                        obj.db.get(s.scriptId)
                        .then(scripts => {
                            // if a script is scheduled to run, but a previous run hasn't completed,
                            // don't schedule another job for the same (device probably offline).
                            // results in the minimum jobs running once an agent comes back online.
                            return obj.db.getIncompleteJobsForSchedule(s._id)
                            .then((jobs) => {
                                if (jobs.length > 0) { /* obj.debug('Plugin', 'ScriptTask', 'Skipping job creation'); */ return Promise.resolve(); }
                                else { /* obj.debug('Plugin', 'ScriptTask', 'Creating new job'); */ nextJobScheduled = true; return obj.db.addJob( { scriptId: s.scriptId, scriptName: scripts[0].name, node: s.node, runBy: s.scheduledBy, runById: s.scheduledById || null, dontQueueUntil: nextJobTime, jobSchedule: s._id } ); }
                            });
                        })
                        .then(() => {

                            if (nextJobScheduled) { /* obj.debug('Plugin', 'ScriptTask', 'Updating nextRun time'); */ return obj.db.update(s._id, { nextRun: nextJobTime }); }
                            else { /* obj.debug('Plugin', 'ScriptTask', 'NOT updating nextRun time'); */ return Promise.resolve(); }
                        })
                        .then(() => {
                            if (nextJobScheduled) obj.invalidate({ nodeIds: [s.node], scriptIds: [s.scriptId] });
                        })
                        .catch((e) => { console.log('PLUGIN: ScriptTask: Error managing job schedules: ', e); });
                    }
                });
            }
        });
    };

    // ---- Change notices ----

    // Tell open ScriptTask pages that something changed, so they re-query what they show.
    // Notices carry ids only, never data. Device notices go only to users who can see that device.
    obj.invalidate = function(scopes) {
        var send = function(targets, payload) {
            obj.meshServer.DispatchEvent(targets, obj, Object.assign({ nolog: true, action: 'plugin', plugin: 'scripttask', pluginaction: 'onInvalidate' }, payload));
        };
        if (scopes.library || scopes.variables || (scopes.scriptIds && scopes.scriptIds.length)) {
            send(['server-allusers'], { library: scopes.library === true, variables: scopes.variables === true, scriptIds: scopes.scriptIds || [] });
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
            node: (caps.node == null) ? null : { id: caps.node._id, online: obj.meshServer.webserver.wsagents[caps.node._id] != null }
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
        var accepted = [], refused = [];
        for (var nodeId of nodeIds) {
            var caps = await obj.getNodeCaps(session, nodeId);
            if (!caps.run) { refused.push(nodeId); continue; }
            await obj.db.addJob({ scriptId: script._id, scriptName: script.name, node: nodeId, runBy: session.user.name, runById: session.user._id });
            accepted.push(nodeId);
        }
        if (accepted.length) {
            obj.resetQueueTimer();
            obj.queueRun();
            obj.invalidate({ nodeIds: accepted, scriptIds: [script._id] });
        }
        return { accepted: accepted.length, refused: refused };
    };

    obj.rpc.addSchedule = async function(args, session) {
        var script = await getOne(args.scriptId, 'script');
        var sched = cleanSchedule(args.schedule);
        var nodeIds = Array.isArray(args.nodeIds) ? args.nodeIds.map(id) : [];
        if (nodeIds.length == 0) throw new RpcError('No device given.');
        if (nodeIds.length > 1) obj.requireManage(session);
        var accepted = [], refused = [];
        for (var nodeId of nodeIds) {
            var caps = await obj.getNodeCaps(session, nodeId);
            if (!caps.run) { refused.push(nodeId); continue; }
            await obj.db.addJobSchedule(Object.assign({ scriptId: script._id, node: nodeId, scheduledBy: session.user.name, scheduledById: session.user._id, lastRun: null, nextRun: null }, sched));
            accepted.push(nodeId);
        }
        if (accepted.length) {
            await obj.makeJobsFromSchedules();
            obj.invalidate({ nodeIds: accepted, scriptIds: [script._id] });
        }
        return { accepted: accepted.length, refused: refused };
    };

    obj.rpc.cancelJob = async function(args, session) {
        var job = await getOne(args.jobId, 'job');
        await obj.requireNode(session, job.node);
        obj.requireOwnerOrManage(session, job.runById);
        if (job.completeTime != null) throw new RpcError('This job has already finished.');
        if (job.dispatchTime == null) {
            await obj.db.delete(job._id);
        } else {
            // Already sent to the device. Close it here; a late result from the agent is still recorded.
            await obj.db.update(job._id, { completeTime: Math.floor(new Date() / 1000), cancelled: true, errorVal: 'Cancelled by ' + session.user.name + ' after it was sent to the device.' });
        }
        obj.invalidate({ nodeIds: [job.node], scriptIds: [job.scriptId] });
        return true;
    };

    obj.rpc.cancelAllPending = async function(args, session) {
        obj.requireManage(session);
        var node = await obj.requireNode(session, args.nodeId);
        await obj.db.deletePendingJobsForNode(node._id);
        obj.invalidate({ nodeIds: [node._id] });
        return true;
    };

    obj.rpc.deleteSchedule = async function(args, session) {
        var sched = await getOne(args.scheduleId, 'jobSchedule');
        await obj.requireNode(session, sched.node);
        obj.requireOwnerOrManage(session, sched.scheduledById);
        await obj.db.deletePendingJobsForSchedule(sched._id);
        await obj.db.delete(sched._id);
        obj.invalidate({ nodeIds: [sched.node], scriptIds: [sched.scriptId] });
        return true;
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
        }
        obj.invalidate({ library: true, scriptIds: scripts.map(function(s) { return s._id; }) });
        return true;
    };

    // -- Variables (managers) --

    function cleanVar(args) {
        var scopes = ['global', 'script', 'mesh', 'node'];
        if (scopes.indexOf(args.scope) === -1) throw new RpcError('Invalid scope.');
        var v = { name: str(args.name, 128), scope: args.scope, scopeTarget: (args.scope == 'global') ? null : id(args.scopeTarget), value: (args.value == null) ? '' : String(args.value) };
        if (/[#\s]/.test(v.name)) throw new RpcError('Variable names can\'t contain spaces or #.');
        if (v.value.length > 64 * 1024) throw new RpcError('Value is larger than 64 KB.');
        return v;
    }

    obj.rpc.variables = function(args, session) {
        obj.requireManage(session);
        return obj.db.getVariables();
    };
    obj.rpc.addVar = async function(args, session) {
        obj.requireManage(session);
        var v = cleanVar(args);
        await obj.db.addVariable(v.name, v.scope, v.scopeTarget, v.value);
        obj.invalidate({ variables: true });
        return true;
    };
    obj.rpc.editVar = async function(args, session) {
        obj.requireManage(session);
        var existing = await getOne(args.id, 'variable');
        await obj.db.update(existing._id, cleanVar(args));
        obj.invalidate({ variables: true });
        return true;
    };
    obj.rpc.deleteVar = async function(args, session) {
        obj.requireManage(session);
        var existing = await getOne(args.id, 'variable');
        await obj.db.delete(existing._id);
        obj.invalidate({ variables: true });
        return true;
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
                    return obj.db.update(jobId, update)
                    .then(() => {
                        if (job.jobSchedule == null) return;
                        return obj.db.update(job.jobSchedule, { lastRun: completeTime } )
                        .then(() => {
                            obj.makeJobsFromSchedules(job.jobSchedule);
                        });
                    })
                    .then(() => {
                        obj.invalidate({ nodeIds: [job.node], scriptIds: [job.scriptId] });
                    });
                })
                .catch(e => { console.log('PLUGIN: ScriptTask: Failed to complete job. ', e); });
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
