/**
* @description Server-side tests for the ScriptTask plugin, run against a stubbed MeshCentral and an in-memory NeDB.
* Run with: MESHCENTRAL_PARENT=/path/containing/node_modules node --test test/*.test.js
* MESHCENTRAL_PARENT is the folder whose node_modules holds MeshCentral's NeDB (where MeshCentral is installed).
* @license Apache-2.0
*/

"use strict";

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const LIN = 'node//linux0001', WIN = 'node//windows001', OTHER = 'node//hidden0001';
const MESH = 'mesh//group0001';
const REMOTECOMMAND = 0x00020000;

// Device rights per user, as MeshCentral's GetNodeWithRights would report them
const RIGHTS = {
    'user//admin': { [LIN]: 0xFFFFFFFF, [WIN]: 0xFFFFFFFF },
    'user//alice': { [LIN]: 8 | REMOTECOMMAND, [WIN]: 8 | REMOTECOMMAND },
    'user//bob': { [LIN]: 8 }
};
const USERS = {
    admin: { _id: 'user//admin', name: 'admin', siteadmin: 0xFFFFFFFF },
    alice: { _id: 'user//alice', name: 'alice', siteadmin: 0 },
    bob: { _id: 'user//bob', name: 'bob', siteadmin: 0 }
};

const contexts = [];
// Stop the timers each plugin instance starts, so the test process can exit
test.after(function () {
    contexts.forEach(function (ctx) {
        clearInterval(ctx.plugin.intervalTimer);
        if (ctx.plugin.db && ctx.plugin.db.scriptFilex) ctx.plugin.db.scriptFilex.stopAutocompaction();
        fs.rmSync(ctx.dataDir, { recursive: true, force: true });
    });
});

function createPlugin() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scripttask-test-'));
    const events = [];
    const meshServer = {
        debug: function () { },
        args: {},
        parentpath: process.env.MESHCENTRAL_PARENT || path.join(__dirname, '..'),
        getConfigFilePath: function (f) { return path.join(dataDir, f); },
        webserver: {
            wsagents: {},
            GetNodeWithRights: function (domain, user, nodeId, cb) {
                const r = (RIGHTS[user._id] || {})[nodeId];
                if (r == null) { cb(null, 0, false); return; }
                cb({ _id: nodeId, meshid: MESH, name: nodeId }, r, true);
            },
            CreateNodeDispatchTargets: function (meshId, nodeId) { return ['*', meshId, nodeId]; }
        },
        db: { Get: function (id, cb) { cb(null, [{ _id: id, meshid: MESH }]); } },
        DispatchEvent: function (targets, source, ev) { events.push({ targets: targets, ev: ev }); },
        pluginHandler: {}
    };
    // A stand-in for MeshCentral's plugin handler with the permissions framework (1.1.58+)
    const registered = {};
    const pluginHandler = {
        parent: meshServer,
        registerPermissions: function (name, perms) { registered[name] = perms; },
        getPluginPermissions: function (name) { return registered[name] ? { defaults: {} } : null; },
        checkPluginPermission: function (user, name, perm) {
            if (user.siteadmin === 0xFFFFFFFF) return true;
            return registered[name][perm].default == 'allowed';
        }
    };
    const plugin = require('../scripttask.js').scripttask(pluginHandler);
    plugin.server_startup();
    clearInterval(plugin.intervalTimer);
    const ctx = { plugin, events, dataDir, registered };
    contexts.push(ctx);
    return ctx;
}

// Call an RPC method as a user; resolves the reply ({ ok, data } or { ok:false, error })
function rpc(plugin, user, method, args) {
    return new Promise(function (resolve) {
        const session = { user: USERS[user], domain: { id: '' }, send: function (m) { resolve(m); } };
        plugin.serveraction({ action: 'plugin', plugin: 'scripttask', pluginaction: 'rpc', method: method, args: args || {}, reqId: 'r1' }, session);
    });
}
function agentSends(plugin, nodeId, command) {
    plugin.serveraction(Object.assign({ action: 'plugin', plugin: 'scripttask' }, command), { dbNodeKey: nodeId, send: function () { } });
}
const wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms || 50); }); };
// The DB layer finishes connecting asynchronously
async function ready(ctx) { for (let i = 0; i < 50 && ctx.plugin.db.addScript == null; i++) await wait(20); await wait(50); }

test('permissions are registered at startup and fail closed', async function () {
    const ctx = createPlugin(); await ready(ctx);
    assert.ok(ctx.registered.scripttask, 'permissions registered');
    assert.strictEqual((await rpc(ctx.plugin, 'alice', 'init', { nodeId: LIN })).data.caps.manage, false);
    assert.strictEqual((await rpc(ctx.plugin, 'admin', 'init', { nodeId: LIN })).data.caps.manage, true);
    const bob = (await rpc(ctx.plugin, 'bob', 'init', { nodeId: LIN })).data.caps;
    assert.deepStrictEqual([bob.run, bob.remoteCommand, bob.visible], [false, false, true]);
    // A user can't see or run on a device they have no rights to
    assert.strictEqual((await rpc(ctx.plugin, 'alice', 'runScript', { scriptId: 'x', nodeIds: [OTHER] })).ok, false);
});

test('managers only: library, variables, multi-device runs', async function () {
    const ctx = createPlugin(); await ready(ctx);
    for (const m of ['newFolder', 'addScript', 'variables', 'addVar', 'getScript', 'scriptData']) {
        const r = await rpc(ctx.plugin, 'alice', m, { name: 'x', filetype: 'bash', content: '', scope: 'global', id: 'x', scriptId: 'x' });
        assert.strictEqual(r.ok, false, m + ' should be refused for alice');
    }
    const s = await rpc(ctx.plugin, 'admin', 'addScript', { name: 'Up', filetype: 'bash', content: 'uptime\r\n' });
    assert.ok(s.ok);
    assert.strictEqual((await rpc(ctx.plugin, 'alice', 'runScript', { scriptId: s.data.id, nodeIds: [LIN, WIN] })).error, 'Only ScriptTask managers can do this.');
    const one = await rpc(ctx.plugin, 'alice', 'runScript', { scriptId: s.data.id, nodeIds: [LIN] });
    assert.deepStrictEqual(one.data, { accepted: 1, refused: [], batchId: null });
    const bob = await rpc(ctx.plugin, 'bob', 'runScript', { scriptId: s.data.id, nodeIds: [LIN] });
    assert.deepStrictEqual(bob.data, { accepted: 0, refused: [LIN], batchId: null });
    // Bash line endings are normalised on save
    assert.strictEqual((await rpc(ctx.plugin, 'admin', 'getScript', { id: s.data.id })).data.content, 'uptime\n');
});

test('users can cancel only their own jobs and schedules', async function () {
    const ctx = createPlugin(); await ready(ctx);
    const s = (await rpc(ctx.plugin, 'admin', 'addScript', { name: 'Up', filetype: 'bash', content: 'uptime' })).data.id;
    await rpc(ctx.plugin, 'admin', 'runScript', { scriptId: s, nodeIds: [LIN] });
    await rpc(ctx.plugin, 'alice', 'runScript', { scriptId: s, nodeIds: [LIN] });
    const start = Math.floor(Date.now() / 1000) + 3600;
    assert.ok((await rpc(ctx.plugin, 'alice', 'addSchedule', { scriptId: s, nodeIds: [LIN], schedule: { recur: 'daily', interval: 1, startAt: start } })).ok);
    const d = (await rpc(ctx.plugin, 'alice', 'nodeData', { nodeId: LIN })).data;
    const adminJob = d.queue.find(function (j) { return j.runById == 'user//admin'; });
    const aliceJob = d.queue.find(function (j) { return j.runById == 'user//alice' && j.jobSchedule == null; });
    assert.strictEqual((await rpc(ctx.plugin, 'alice', 'cancelJob', { jobId: adminJob._id })).ok, false);
    assert.strictEqual((await rpc(ctx.plugin, 'alice', 'cancelJob', { jobId: aliceJob._id })).ok, true);
    assert.strictEqual((await rpc(ctx.plugin, 'alice', 'deleteSchedule', { scheduleId: d.schedules[0]._id })).ok, true);
    const after = (await rpc(ctx.plugin, 'alice', 'nodeData', { nodeId: LIN })).data;
    assert.strictEqual(after.schedules.length, 0);
    assert.strictEqual(after.queue.filter(function (j) { return j.runById == 'user//alice'; }).length, 0, 'schedule\'s pending job removed too');
    assert.strictEqual(after.queue.length, 1);
});

test('agents can only complete their own jobs; cancelled jobs stay cancelled', async function () {
    const ctx = createPlugin(); await ready(ctx);
    const s = (await rpc(ctx.plugin, 'admin', 'addScript', { name: 'Up', filetype: 'bash', content: 'uptime' })).data.id;
    await rpc(ctx.plugin, 'admin', 'runScript', { scriptId: s, nodeIds: [LIN] });
    await rpc(ctx.plugin, 'admin', 'runScript', { scriptId: s, nodeIds: [LIN] });
    let q = (await rpc(ctx.plugin, 'admin', 'nodeData', { nodeId: LIN })).data.queue;
    const [j1, j2] = q;
    // Another device reporting this job is ignored
    agentSends(ctx.plugin, WIN, { pluginaction: 'jobComplete', jobId: j1._id, scriptId: s, retVal: 'spoofed', errVal: null, dispatchTime: 1 });
    await wait(100);
    q = (await rpc(ctx.plugin, 'admin', 'nodeData', { nodeId: LIN })).data.queue;
    assert.strictEqual(q.length, 2, 'spoofed completion ignored');
    // The right device completes it
    agentSends(ctx.plugin, LIN, { pluginaction: 'jobComplete', jobId: j1._id, scriptId: s, retVal: 'ok', errVal: null, dispatchTime: 1 });
    await wait(100);
    // Cancel j2 after it was dispatched, then the agent reports late
    await ctx.plugin.db.update(j2._id, { dispatchTime: 5 });
    assert.ok((await rpc(ctx.plugin, 'admin', 'cancelJob', { jobId: j2._id })).ok);
    agentSends(ctx.plugin, LIN, { pluginaction: 'jobComplete', jobId: j2._id, scriptId: s, retVal: 'late', errVal: null, dispatchTime: 5 });
    await wait(100);
    const d = (await rpc(ctx.plugin, 'admin', 'nodeData', { nodeId: LIN })).data;
    assert.strictEqual(d.queue.length, 0);
    const h1 = d.history.find(function (j) { return j._id == j1._id; }), h2 = d.history.find(function (j) { return j._id == j2._id; });
    assert.strictEqual(h1.returnVal, 'ok');
    assert.strictEqual(h2.cancelled, true);
    assert.strictEqual(h2.returnVal, null);
    assert.strictEqual(h2.lateReturnVal, 'late');
    // Change notices go to the device's audience and carry ids only
    const notice = ctx.events.find(function (e) { return e.ev.nodeIds && e.ev.nodeIds[0] == LIN; });
    assert.deepStrictEqual(notice.targets, ['*', MESH, LIN]);
    assert.strictEqual(notice.ev.history, undefined);
});

test('folder rename, move and delete keep nested items consistent', async function () {
    const ctx = createPlugin(); await ready(ctx);
    const tree = async function () { return (await rpc(ctx.plugin, 'admin', 'tree')).data; };
    const byName = async function (n) { return (await tree()).find(function (i) { return i.name == n; }); };
    await rpc(ctx.plugin, 'admin', 'newFolder', { name: 'A' });
    await rpc(ctx.plugin, 'admin', 'newFolder', { name: 'B', parentId: (await byName('A'))._id });
    await rpc(ctx.plugin, 'admin', 'newFolder', { name: 'A2', parentId: (await byName('B'))._id }); // a descendant whose name contains its ancestor's
    const sid = (await rpc(ctx.plugin, 'admin', 'addScript', { name: 'deep', filetype: 'bash', content: 'x', folderId: (await byName('A2'))._id })).data.id;
    await rpc(ctx.plugin, 'admin', 'addSchedule', { scriptId: sid, nodeIds: [LIN], schedule: { recur: 'once', startAt: Math.floor(Date.now() / 1000) + 600 } });

    assert.ok((await rpc(ctx.plugin, 'admin', 'rename', { id: (await byName('A'))._id, name: 'Ops' })).ok);
    assert.deepStrictEqual((await tree()).map(function (i) { return i.path + ':' + i.name; }).sort(),
        ['Shared/Ops/B/A2:A2', 'Shared/Ops/B/A2:deep', 'Shared/Ops/B:B', 'Shared/Ops:Ops', 'Shared:Shared']);

    assert.ok((await rpc(ctx.plugin, 'admin', 'move', { id: (await byName('B'))._id, toId: (await byName('Shared'))._id })).ok);
    assert.strictEqual((await byName('deep')).path, 'Shared/B/A2');
    assert.strictEqual((await rpc(ctx.plugin, 'admin', 'move', { id: (await byName('B'))._id, toId: (await byName('A2'))._id })).ok, false, 'no moving into itself');

    assert.ok((await rpc(ctx.plugin, 'admin', 'deleteItem', { id: (await byName('B'))._id })).ok);
    assert.deepStrictEqual((await tree()).map(function (i) { return i.name; }).sort(), ['Ops', 'Shared']);
    const d = (await rpc(ctx.plugin, 'admin', 'nodeData', { nodeId: LIN })).data;
    assert.strictEqual(d.schedules.length + d.queue.length, 0, 'schedules and pending jobs of deleted scripts removed');
});

test('include paths are restricted to the includes folder', async function () {
    const ctx = createPlugin(); await ready(ctx);
    const served = [];
    const res = { statusCode: 200, sendStatus: function (c) { this.statusCode = c; }, sendFile: function (p, opts) { served.push([p, opts.root]); } };
    for (const bad of ['../scripttask.js', 'vendor/../../db.js', '/etc/passwd', 'st.css/../../x.js', '.hidden.js', 'st.html', '']) {
        res.statusCode = 200;
        ctx.plugin.serveInclude({ query: { path: bad } }, res);
        assert.strictEqual(res.statusCode, 404, bad);
    }
    ctx.plugin.serveInclude({ query: { path: 'vendor/preact-10.29.8.umd.js' } }, res);
    assert.deepStrictEqual(served, [['vendor/preact-10.29.8.umd.js', path.join(__dirname, '..', 'includes') + '/']]);
});

// ---- Scheduling engine ----

async function scheduleOn(ctx, user, sched) {
    const sid = (await rpc(ctx.plugin, 'admin', 'addScript', { name: 'S' + Math.random(), filetype: 'bash', content: 'true' })).data.id;
    const r = await rpc(ctx.plugin, user, 'addSchedule', { scriptId: sid, nodeIds: [LIN], schedule: sched });
    assert.ok(r.ok, JSON.stringify(r));
    const d = (await rpc(ctx.plugin, user, 'nodeData', { nodeId: LIN })).data;
    return { sid, schedule: d.schedules.find(s => s.scriptId == sid), jobs: d.queue.filter(j => j.scriptId == sid), d };
}
async function jobsFor(ctx, scriptId) { return (await ctx.plugin.db.scriptFile.find({ type: 'job', scriptId: scriptId }).toArray()).sort((a, b) => a.slot - b.slot); }
const nowS = () => Math.floor(Date.now() / 1000);

test('a new schedule gets one job for its first slot', async function () {
    const ctx = createPlugin(); await ready(ctx);
    const start = nowS() + 3600;
    const r = await scheduleOn(ctx, 'alice', { recur: 'daily', interval: 1, startAt: start, timezone: 'America/New_York' });
    assert.strictEqual(r.jobs.length, 1);
    assert.strictEqual(r.jobs[0].slot, start);
    assert.strictEqual(r.jobs[0].expiresAt, null);
    assert.strictEqual(r.schedule.nextRun, start);
    await ctx.plugin.queueRun();
    assert.strictEqual((await jobsFor(ctx, r.sid)).length, 1, 'no duplicate jobs from the queue tick');
});

test('offline policies: Skip and an expired window are Missed, Wait keeps waiting, no backlog', async function () {
    const ctx = createPlugin(); await ready(ctx);
    const past = nowS() - 200; // first slot 200s ago, device offline
    const skip = await scheduleOn(ctx, 'admin', { recur: 'minutes', interval: 60, startAt: past, offlinePolicy: 'skip' });
    const wait = await scheduleOn(ctx, 'admin', { recur: 'minutes', interval: 60, startAt: past, offlinePolicy: 'wait' });
    const win = await scheduleOn(ctx, 'admin', { recur: 'minutes', interval: 60, startAt: past, offlinePolicy: 'window', offlineWindow: 120 });
    const winLong = await scheduleOn(ctx, 'admin', { recur: 'minutes', interval: 60, startAt: past, offlinePolicy: 'window', offlineWindow: 3600 });
    assert.strictEqual(skip.jobs[0].expiresAt, past + 120, 'Skip uses the server-wide grace period');
    await ctx.plugin.queueRun();
    const s = await jobsFor(ctx, skip.sid), w = await jobsFor(ctx, wait.sid), wn = await jobsFor(ctx, win.sid), wl = await jobsFor(ctx, winLong.sid);
    assert.deepStrictEqual(s.map(j => [j.slot - past, j.missed === true, j.completeTime != null]), [[0, true, true], [3600, false, false]]);
    assert.deepStrictEqual(wn.map(j => [j.slot - past, j.missed === true]), [[0, true], [3600, false]]);
    assert.deepStrictEqual(w.map(j => [j.slot - past, j.completeTime]), [[0, null]], 'Wait keeps the overdue job and adds nothing');
    assert.deepStrictEqual(wl.map(j => [j.slot - past, j.completeTime]), [[0, null]]);
    const hist = (await rpc(ctx.plugin, 'admin', 'nodeData', { nodeId: LIN })).data.history;
    assert.ok(hist.some(j => j.missed && j.scriptId == skip.sid), 'Missed run is in history');
});

test('an online device gets due jobs, but not expired ones', async function () {
    const ctx = createPlugin(); await ready(ctx);
    const sent = [];
    ctx.plugin.meshServer.webserver.wsagents[LIN] = { dbMeshKey: MESH, send: function (m) { sent.push(JSON.parse(m)); } };
    const due = await scheduleOn(ctx, 'admin', { recur: 'minutes', interval: 60, startAt: nowS() - 30, offlinePolicy: 'skip' });
    const stale = await scheduleOn(ctx, 'admin', { recur: 'minutes', interval: 60, startAt: nowS() - 250, offlinePolicy: 'skip' });
    await ctx.plugin.queueRun(); await wait(150);
    assert.deepStrictEqual(sent.map(m => m.scriptId), [due.sid]);
    assert.ok((await jobsFor(ctx, stale.sid))[0].missed);
    delete ctx.plugin.meshServer.webserver.wsagents[LIN];
});

test('pause and resume skip the slots in between; cancelling a run skips one occurrence', async function () {
    const ctx = createPlugin(); await ready(ctx);
    const start = nowS() + 600;
    const r = await scheduleOn(ctx, 'alice', { recur: 'hourly', interval: 1, startAt: start });
    assert.ok((await rpc(ctx.plugin, 'alice', 'pauseSchedule', { scheduleId: r.schedule._id, paused: true })).ok);
    await ctx.plugin.queueRun();
    assert.strictEqual((await jobsFor(ctx, r.sid)).length, 0, 'paused: no job, and the tick does not add one');
    assert.ok((await rpc(ctx.plugin, 'alice', 'pauseSchedule', { scheduleId: r.schedule._id, paused: false })).ok);
    let jobs = await jobsFor(ctx, r.sid);
    assert.deepStrictEqual(jobs.map(j => j.slot), [start], 'resumes at the next slot from now');
    assert.ok((await rpc(ctx.plugin, 'alice', 'cancelJob', { jobId: jobs[0]._id })).ok);
    jobs = await jobsFor(ctx, r.sid);
    assert.deepStrictEqual(jobs.map(j => j.slot), [start + 3600], 'cancelling skips to the following slot');
    // Bob can't touch alice's schedule; admin can
    assert.strictEqual((await rpc(ctx.plugin, 'bob', 'pauseSchedule', { scheduleId: r.schedule._id, paused: true })).ok, false);
});

test('late runs keep the grid, or shift to the actual run time', async function () {
    const ctx = createPlugin(); await ready(ctx);
    const keep = await scheduleOn(ctx, 'admin', { recur: 'hourly', interval: 1, startAt: nowS() - 250, anchor: 'slot' });
    const shift = await scheduleOn(ctx, 'admin', { recur: 'hourly', interval: 1, startAt: nowS() - 250, anchor: 'actual' });
    const ranAt = nowS() - 10; // ran ~4 minutes late
    for (const r of [keep, shift]) {
        const j = (await jobsFor(ctx, r.sid))[0];
        await ctx.plugin.db.update(j._id, { dispatchTime: ranAt });
        agentSends(ctx.plugin, LIN, { pluginaction: 'jobComplete', jobId: j._id, scriptId: r.sid, retVal: 'ok', errVal: null, dispatchTime: ranAt });
    }
    await wait(200);
    const k = await jobsFor(ctx, keep.sid), sh = await jobsFor(ctx, shift.sid);
    assert.strictEqual(k[1].slot - k[0].slot, 3600, 'keeps the original grid');
    assert.strictEqual(sh[1].slot, ranAt + 3600, 'next run an hour after it actually ran');
    // Weekly schedules can't shift
    const wk = await scheduleOn(ctx, 'admin', { recur: 'weekly', interval: 1, daysOfWeek: [1], startAt: nowS() + 60, anchor: 'actual' });
    assert.strictEqual(wk.schedule.anchor, 'slot');
});

test('editing a schedule restarts it from now, and rejects a one-time run in the past', async function () {
    const ctx = createPlugin(); await ready(ctx);
    const r = await scheduleOn(ctx, 'alice', { recur: 'daily', interval: 1, startAt: nowS() + 600 });
    const bad = await rpc(ctx.plugin, 'alice', 'updateSchedule', { scheduleId: r.schedule._id, schedule: { recur: 'once', startAt: nowS() - 3600 } });
    assert.strictEqual(bad.error, 'Choose a time in the future.');
    const start2 = nowS() + 7200;
    assert.ok((await rpc(ctx.plugin, 'alice', 'updateSchedule', { scheduleId: r.schedule._id, schedule: { recur: 'hourly', interval: 2, startAt: start2, offlinePolicy: 'skip' } })).ok);
    const jobs = await jobsFor(ctx, r.sid);
    assert.deepStrictEqual(jobs.map(j => [j.slot, j.expiresAt]), [[start2, start2 + 120]]);
    // A one-time schedule is removed after its run
    const once = await scheduleOn(ctx, 'admin', { recur: 'once', startAt: nowS() + 30 });
    const oj = (await jobsFor(ctx, once.sid))[0];
    agentSends(ctx.plugin, LIN, { pluginaction: 'jobComplete', jobId: oj._id, scriptId: once.sid, retVal: 'ok', errVal: null, dispatchTime: nowS() });
    await wait(200);
    const d = (await rpc(ctx.plugin, 'admin', 'nodeData', { nodeId: LIN })).data;
    assert.ok(!d.schedules.some(s => s.scriptId == once.sid), 'one-time schedule removed');
});

test('settings: managers only, validated, and used for Skip', async function () {
    const ctx = createPlugin(); await ready(ctx);
    assert.strictEqual((await rpc(ctx.plugin, 'alice', 'saveSettings', { skipGraceSeconds: 300 })).ok, false);
    assert.strictEqual((await rpc(ctx.plugin, 'admin', 'saveSettings', { skipGraceSeconds: 5, defaultOfflineWindow: 7200 })).ok, false);
    const saved = await rpc(ctx.plugin, 'admin', 'saveSettings', { skipGraceSeconds: 300, defaultOfflinePolicy: 'window', defaultOfflineWindow: 1800, defaultAnchor: 'actual' });
    assert.deepStrictEqual(saved.data, { skipGraceSeconds: 300, defaultOfflinePolicy: 'window', defaultOfflineWindow: 1800, defaultAnchor: 'actual' });
    assert.deepStrictEqual((await rpc(ctx.plugin, 'alice', 'init', { nodeId: LIN })).data.settings, saved.data);
    const start = nowS() + 60;
    const r = await scheduleOn(ctx, 'admin', { recur: 'minutes', interval: 5, startAt: start, offlinePolicy: 'skip' });
    assert.strictEqual(r.jobs[0].expiresAt, start + 300);
});

test('schedules from before this version keep working without migration', async function () {
    const ctx = createPlugin(); await ready(ctx);
    const sid = (await rpc(ctx.plugin, 'admin', 'addScript', { name: 'Legacy', filetype: 'bash', content: 'true' })).data.id;
    const start = nowS() - 86400 * 20 - 3600; // daily, started 20 days ago at this time minus an hour
    // A schedule and pending job as the old engine stored them: no policy, anchor, time zone, lastSlot or slot fields
    const sched = await ctx.plugin.db.addJobSchedule({ scriptId: sid, node: LIN, scheduledBy: 'admin', recur: 'daily', interval: 1, daysOfWeek: [], startAt: start, endAt: null, lastRun: null, nextRun: start + 86400 * 20, type: 'jobSchedule' });
    await ctx.plugin.db.addJob({ scriptId: sid, scriptName: 'Legacy', node: LIN, runBy: 'admin', dontQueueUntil: start + 86400 * 20, jobSchedule: sched.insertedId });
    await ctx.plugin.queueRun();
    let jobs = await jobsFor(ctx, sid);
    assert.strictEqual(jobs.length, 1, 'the existing pending job is kept; nothing is added');
    assert.strictEqual(jobs[0].completeTime, null, 'a legacy job never expires (wait policy)');
    agentSends(ctx.plugin, LIN, { pluginaction: 'jobComplete', jobId: jobs[0]._id, scriptId: sid, retVal: 'ok', errVal: null, dispatchTime: nowS() });
    await wait(200);
    jobs = await jobsFor(ctx, sid);
    const next = jobs.find(j => j.completeTime == null);
    assert.strictEqual(next.slot, start + 86400 * 21, 'next run is tomorrow on the original grid, with no catch-up');
});

test('the ScriptTask page is for managers; the device tab is for everyone', async function () {
    const ctx = createPlugin(); await ready(ctx);
    const call = function (user, query) {
        const res = { code: 200, rendered: null, status: function (c) { this.code = c; return this; }, send: function () { }, sendStatus: function (c) { this.code = c; }, render: function (v) { this.rendered = path.basename(v); } };
        ctx.plugin.handleAdminReq({ query: query }, res, USERS[user]);
        return res;
    };
    assert.deepStrictEqual([call('admin', {}).rendered, call('alice', {}).code, call('alice', {}).rendered], ['server', 403, null]);
    assert.strictEqual(call('alice', { user: '1' }).rendered, 'device');
    // Saving settings tells open pages to reload them
    await rpc(ctx.plugin, 'admin', 'saveSettings', { skipGraceSeconds: 180, defaultOfflineWindow: 7200 });
    assert.ok(ctx.events.some(function (e) { return e.ev.settings === true && e.targets[0] == 'server-allusers'; }));
});

// ---- Server-wide queue, schedules and history ----

test('NeDB queries do not inherit sort or limit from the previous query', async function () {
    const ctx = createPlugin(); await ready(ctx);
    for (let i = 0; i < 5; i++) await ctx.plugin.db.addVariable('v' + i, 'global', null, String(i));
    const limited = await ctx.plugin.db.scriptFile.find({ type: 'variable' }).sort({ name: -1 }).limit(2).toArray();
    assert.strictEqual(limited.length, 2);
    const all = await ctx.plugin.db.scriptFile.find({ type: 'variable' }).toArray();
    assert.strictEqual(all.length, 5, 'a later query without limit gets everything');
});

test('server-wide lists: managers only, filtered, paged, and limited to visible devices', async function () {
    const ctx = createPlugin(); await ready(ctx);
    const p = ctx.plugin, now = nowS();
    const up = (await rpc(p, 'admin', 'addScript', { name: 'Up', filetype: 'bash', content: 'uptime' })).data.id;
    const disk = (await rpc(p, 'admin', 'addScript', { name: 'Disk', filetype: 'bash', content: 'df' })).data.id;
    for (let i = 0; i < 3; i++) await rpc(p, 'admin', 'runScript', { scriptId: up, nodeIds: [LIN, WIN] });
    await rpc(p, 'alice', 'runScript', { scriptId: disk, nodeIds: [LIN] });
    await p.db.addJob({ scriptId: up, scriptName: 'Up', node: OTHER, runBy: 'admin' }); // a device admin can't see
    await rpc(p, 'admin', 'addSchedule', { scriptId: disk, nodeIds: [WIN], schedule: { recur: 'daily', interval: 1, startAt: now + 3600 } });
    // Finished jobs with output, for history
    const done = async (node, script, name, fields) => { const r = await p.db.addJob({ scriptId: script, scriptName: name, node: node, runBy: 'alice' }); await p.db.update(r.insertedId, Object.assign({ dispatchTime: now - 60, completeTime: now - 30 }, fields)); };
    await done(LIN, up, 'Up', { returnVal: 'load average 0.1' });
    await done(LIN, disk, 'Disk', { returnVal: 'x'.repeat(1000) + ' needle' });
    await done(WIN, disk, 'Disk', { errorVal: 'disk full', returnVal: null });
    await done(OTHER, disk, 'Disk', { returnVal: 'secret' });

    for (const m of ['queue', 'schedules', 'history', 'cancelJobs', 'runJobsNow', 'scheduleAction']) assert.strictEqual((await rpc(p, 'alice', m, {})).ok, false, m + ' is managers only');

    let q = (await rpc(p, 'admin', 'queue', { limit: 4 })).data;
    assert.strictEqual(q.total, 8, '6 + 1 manual runs and 1 scheduled run; the hidden device is left out');
    assert.strictEqual(q.jobs.length, 4);
    assert.ok(q.jobs.every(j => j.node != OTHER));
    assert.strictEqual((await rpc(p, 'admin', 'queue', { filters: { scriptId: disk } })).data.total, 2);
    assert.strictEqual((await rpc(p, 'admin', 'queue', { filters: { source: 'schedule' } })).data.total, 1);
    assert.strictEqual((await rpc(p, 'admin', 'queue', { filters: { status: 'scheduled' } })).data.total, 1);
    assert.strictEqual((await rpc(p, 'admin', 'queue', { filters: { status: 'waiting', nodeIds: [WIN] } })).data.total, 3, 'offline device: waiting');
    assert.strictEqual((await rpc(p, 'admin', 'queue', { filters: { runBy: 'ALI' } })).data.total, 1, 'run-by filter is case-insensitive');

    const s = (await rpc(p, 'admin', 'schedules', {})).data;
    assert.strictEqual(s.total, 1);

    let h = (await rpc(p, 'admin', 'history', { limit: 2 })).data;
    assert.strictEqual(h.total, 3, 'hidden device left out of history');
    assert.strictEqual(h.jobs.length, 2);
    assert.strictEqual((await rpc(p, 'admin', 'history', { skip: 2, limit: 2 })).data.jobs.length, 1, 'second page');
    assert.strictEqual((await rpc(p, 'admin', 'history', { filters: { status: 'error' } })).data.total, 1);
    assert.strictEqual((await rpc(p, 'admin', 'history', { filters: { status: 'complete' } })).data.total, 2);
    const found = (await rpc(p, 'admin', 'history', { filters: { q: 'NEEDLE' } })).data;
    assert.strictEqual(found.total, 1, 'searches the whole output, case-insensitively');
    assert.ok(found.jobs[0].truncated && found.jobs[0].returnVal.length == 300, 'list carries only the start of long output');
    assert.ok((await rpc(p, 'admin', 'job', { id: found.jobs[0]._id })).data.returnVal.endsWith('needle'), 'full output on request');
    assert.strictEqual((await rpc(p, 'admin', 'history', { filters: { q: 'a.*b' } })).data.total, 0, 'search text is literal, not a pattern');
    // Full output: alice can see runs on a device she can run scripts on; bob can't
    assert.ok((await rpc(p, 'alice', 'job', { id: found.jobs[0]._id })).ok);
    assert.strictEqual((await rpc(p, 'bob', 'job', { id: found.jobs[0]._id })).ok, false);
});

test('bulk actions: cancel, run now, pause, resume and delete', async function () {
    const ctx = createPlugin(); await ready(ctx);
    const p = ctx.plugin, now = nowS();
    const up = (await rpc(p, 'admin', 'addScript', { name: 'Up', filetype: 'bash', content: 'uptime' })).data.id;
    await rpc(p, 'admin', 'runScript', { scriptId: up, nodeIds: [LIN, WIN] });
    await rpc(p, 'admin', 'addSchedule', { scriptId: up, nodeIds: [LIN, WIN], schedule: { recur: 'hourly', interval: 1, startAt: now + 3600, offlinePolicy: 'skip' } });
    const hidden = await p.db.addJob({ scriptId: up, scriptName: 'Up', node: OTHER, runBy: 'admin' });
    let q = (await rpc(p, 'admin', 'queue', {})).data.jobs;
    const scheduled = q.filter(j => j.state == 'scheduled');
    // Run the scheduled ones now: due immediately, and their Skip deadline is pushed out so they don't expire first
    const rn = (await rpc(p, 'admin', 'runJobsNow', { jobIds: scheduled.map(j => j._id) })).data;
    assert.deepStrictEqual(rn, { done: 2, skipped: 0 });
    q = (await rpc(p, 'admin', 'queue', {})).data.jobs;
    assert.ok(q.filter(j => j.jobSchedule).every(j => j.dontQueueUntil <= nowS() && j.expiresAt >= nowS() + 100));
    // Cancel everything, including an id on a hidden device (skipped)
    const c = (await rpc(p, 'admin', 'cancelJobs', { jobIds: q.map(j => j._id).concat([hidden.insertedId]) })).data;
    assert.deepStrictEqual(c, { done: 4, skipped: 1 });
    q = (await rpc(p, 'admin', 'queue', {})).data.jobs;
    assert.ok(q.every(j => j.jobSchedule != null), "only the schedules' next runs remain");
    assert.strictEqual(q.length, 2);
    const ids = (await rpc(p, 'admin', 'schedules', {})).data.schedules.map(s => s._id);
    assert.deepStrictEqual((await rpc(p, 'admin', 'scheduleAction', { scheduleIds: ids, action: 'pause' })).data, { done: 2, skipped: 0 });
    assert.ok((await rpc(p, 'admin', 'schedules', {})).data.schedules.every(s => s.paused));
    assert.strictEqual((await rpc(p, 'admin', 'queue', {})).data.total, 0, 'pausing removed their pending runs');
    await rpc(p, 'admin', 'scheduleAction', { scheduleIds: ids, action: 'resume' });
    assert.strictEqual((await rpc(p, 'admin', 'queue', {})).data.total, 2);
    await rpc(p, 'admin', 'scheduleAction', { scheduleIds: ids, action: 'delete' });
    assert.deepStrictEqual([(await rpc(p, 'admin', 'schedules', {})).data.total, (await rpc(p, 'admin', 'queue', {})).data.total], [0, 0]);
});

test('batches: runs across several devices are grouped, with results grouped by identical output', async function () {
    const ctx = createPlugin(); await ready(ctx);
    const p = ctx.plugin, now = nowS();
    const up = (await rpc(p, 'admin', 'addScript', { name: 'Up', filetype: 'bash', content: 'uptime' })).data.id;
    const other = (await rpc(p, 'admin', 'addScript', { name: 'Other', filetype: 'bash', content: 'true' })).data.id;
    // One device: no batch
    assert.strictEqual((await rpc(p, 'admin', 'runScript', { scriptId: up, nodeIds: [LIN] })).data.batchId, null);
    const r = (await rpc(p, 'admin', 'runScript', { scriptId: up, nodeIds: [LIN, WIN, OTHER, LIN], name: ' Patch check ' })).data;
    assert.strictEqual(r.accepted, 2, 'duplicates removed');
    assert.deepStrictEqual(r.refused, [OTHER]);
    assert.ok(r.batchId);
    const jobs = (await p.db.scriptFile.find({ type: 'job', batchId: r.batchId }).toArray());
    assert.strictEqual(jobs.length, 2);
    assert.strictEqual((await rpc(p, 'admin', 'queue', { filters: { batchId: r.batchId } })).data.total, 2);
    for (const m of ['batches', 'batch', 'targetSets', 'saveTargetSet', 'deleteTargetSet']) assert.strictEqual((await rpc(p, 'alice', m, { batchId: r.batchId })).ok, false, m + ' is managers only');

    let b = (await rpc(p, 'admin', 'batch', { batchId: r.batchId })).data;
    assert.strictEqual(b.batch.name, 'Patch check');
    assert.deepStrictEqual(b.groups.map(g => [g.state, g.nodeIds.length]), [['waiting', 2]], 'pending runs are grouped by state (no agents are connected)');
    // Same output apart from line endings and trailing space: one group
    const byNode = Object.fromEntries(jobs.map(j => [j.node, j]));
    agentSends(p, LIN, { pluginaction: 'jobComplete', jobId: byNode[LIN]._id, scriptId: up, retVal: 'up 3 days\n', errVal: null, dispatchTime: now });
    agentSends(p, WIN, { pluginaction: 'jobComplete', jobId: byNode[WIN]._id, scriptId: up, retVal: 'up 3 days\r\n', errVal: null, dispatchTime: now });
    await wait(100);
    b = (await rpc(p, 'admin', 'batch', { batchId: r.batchId })).data;
    assert.strictEqual(b.groups.length, 1);
    assert.deepStrictEqual([b.groups[0].state, b.groups[0].output, b.groups[0].nodeIds.length], ['complete', 'up 3 days', 2]);
    assert.deepStrictEqual(b.counts, { complete: 2 });
    assert.strictEqual((await rpc(p, 'admin', 'history', { filters: { batchId: r.batchId } })).data.total, 2);

    // Running again on one device joins the batch; the batch shows that device's latest run
    assert.strictEqual((await rpc(p, 'admin', 'runScript', { scriptId: other, nodeIds: [WIN], batchId: r.batchId })).ok, false, 'a different script cannot join');
    assert.strictEqual((await rpc(p, 'admin', 'runScript', { scriptId: up, nodeIds: [WIN], batchId: r.batchId })).data.batchId, r.batchId);
    b = (await rpc(p, 'admin', 'batch', { batchId: r.batchId })).data;
    assert.strictEqual(b.rows.length, 2);
    assert.deepStrictEqual(b.counts, { complete: 1, waiting: 1 });

    // A schedule across devices: a recurring batch, viewed one occurrence at a time
    const s = (await rpc(p, 'admin', 'addSchedule', { scriptId: up, nodeIds: [LIN, WIN], schedule: { recur: 'daily', interval: 1, startAt: now + 3600 } })).data;
    assert.ok(s.batchId);
    assert.strictEqual((await rpc(p, 'admin', 'schedules', { filters: { batchId: s.batchId } })).data.total, 2);
    b = (await rpc(p, 'admin', 'batch', { batchId: s.batchId })).data;
    assert.ok(b.batch.recurring);
    assert.deepStrictEqual([b.slots.length, b.slot, b.counts.scheduled], [1, now + 3600, 2]);

    const list = (await rpc(p, 'admin', 'batches', {})).data;
    assert.strictEqual(list.total, 2);
    assert.strictEqual(list.batches[0].batchId, s.batchId, 'newest first');
    assert.deepStrictEqual(list.batches[1].counts, { complete: 1, waiting: 1 });
    assert.strictEqual(list.batches[1].visibleDevices, 2);
    assert.strictEqual((await rpc(p, 'admin', 'batch', { batchId: 'nope' })).ok, false);

    // Cancelling a run before it is sent removes it; the device still shows in its batch, as not run
    const r2 = (await rpc(p, 'admin', 'runScript', { scriptId: other, nodeIds: [LIN, WIN] })).data;
    const winJob = (await p.db.scriptFile.find({ type: 'job', batchId: r2.batchId, node: WIN }).toArray())[0];
    await rpc(p, 'admin', 'cancelJobs', { jobIds: [winJob._id] });
    b = (await rpc(p, 'admin', 'batch', { batchId: r2.batchId })).data;
    assert.deepStrictEqual([b.rows.length, b.missing], [1, [WIN]]);
});

test('saved target sets belong to the manager who saved them', async function () {
    const ctx = createPlugin(); await ready(ctx);
    const p = ctx.plugin;
    assert.strictEqual((await rpc(p, 'admin', 'saveTargetSet', { name: 'Empty', nodeIds: [] })).ok, false);
    let sets = (await rpc(p, 'admin', 'saveTargetSet', { name: 'Lab', nodeIds: [LIN, WIN] })).data;
    assert.deepStrictEqual(sets.map(t => [t.name, t.nodeIds.length]), [['Lab', 2]]);
    sets = (await rpc(p, 'admin', 'saveTargetSet', { name: 'Lab', nodeIds: [LIN] })).data;
    assert.deepStrictEqual(sets.map(t => [t.name, t.nodeIds.length]), [['Lab', 1]], 'saving under the same name replaces it');
    // Another manager neither sees nor deletes it
    p.db.scriptFile.insertOne({ type: 'targetSet', ownerId: 'user//someone', name: 'Theirs', nodeIds: [WIN] });
    await wait(50);
    const theirs = (await p.db.getTargetSets('user//someone'))[0];
    assert.strictEqual((await rpc(p, 'admin', 'targetSets', {})).data.length, 1);
    assert.strictEqual((await rpc(p, 'admin', 'deleteTargetSet', { id: theirs._id })).ok, false);
    assert.deepStrictEqual((await rpc(p, 'admin', 'deleteTargetSet', { id: sets[0]._id })).data, []);
});
