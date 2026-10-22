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
    assert.deepStrictEqual(one.data, { accepted: 1, refused: [] });
    const bob = await rpc(ctx.plugin, 'bob', 'runScript', { scriptId: s.data.id, nodeIds: [LIN] });
    assert.deepStrictEqual(bob.data, { accepted: 0, refused: [LIN] });
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
