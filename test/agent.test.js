/**
* @description Tests for the agent-side module (modules_meshcore/scripttask.js), run in Node with stand-ins for the
* MeshAgent runtime: SimpleDataStore, process-manager, child_process (a fake shell) and fs (every absolute path is
* redirected into a sandbox folder, so nothing outside it is touched). Simulates a Linux agent.
* Run with: node --test test/*.test.js
* @author Desmond Duval
* @license Apache-2.0
*/

"use strict";

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const realFs = require('fs');
const Module = require('module');

const AGENT_FILE = path.join(__dirname, '..', 'modules_meshcore', 'scripttask.js');
const sandbox = realFs.mkdtempSync(path.join(os.tmpdir(), 'scripttask-agent-'));
const inBox = (p) => path.isAbsolute(p) ? path.join(sandbox, p) : p;

// fs, with absolute paths inside the sandbox
const fs = {};
['existsSync', 'mkdirSync', 'readdirSync', 'unlinkSync', 'writeFileSync', 'readFileSync'].forEach((fn) => {
    fs[fn] = (p, ...rest) => realFs[fn](inBox(p), ...rest);
});

// A fake shell: collects the lines written to it, and on "exit" runs "./x.sh > y.txt < /dev/null" by copying the
// script's "echo" text into the output file. A script containing "hang" writes its echo text but never exits, until
// another shell runs "kill_tree <its pid>".
const shells = [];
function fakeExecFile(file, args) {
    const listeners = { exit: [] };
    const exit = (code) => listeners.exit.forEach((cb) => cb(code, null));
    const child = {
        pid: 1000 + shells.length, file, args, lines: [],
        stdin: {
            write(text) {
                text.split(/\r?\n/).filter(Boolean).forEach((line) => child.lines.push(line));
                if (/^exit$/m.test(text)) setImmediate(run);
            }
        },
        stdout: { on() { } },
        stderr: { on() { } },
        on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); }
    };
    function run() {
        let cwd = '/';
        for (const line of child.lines) {
            const cd = /^cd '(.*)'$/.exec(line);
            if (cd) cwd = cd[1].split("'\\''").join("'");
            const kill = /kill_tree (\d+)$/.exec(line);
            if (kill) { const target = shells.find((s) => s.pid == Number(kill[1])); if (target) { target.killed = true; target.exit(137); } }
            const m = /^\.\/(\S+) > (\S+) < \/dev\/null$/.exec(line);
            if (m) {
                const script = fs.readFileSync(path.posix.join(cwd, m[1]), 'utf8');
                const echo = /echo (.*)/.exec(script);
                fs.writeFileSync(path.posix.join(cwd, m[2]), echo ? echo[1] + '\n' : '');
                if (/hang/.test(script)) return; // Still running
            }
        }
        exit(0);
    }
    child.exit = exit;
    shells.push(child);
    return child;
}

const sent = [];
const parent = { SendCommand(cmd) { sent.push(JSON.parse(JSON.stringify(cmd))); } };
const cache = {};
const stubs = {
    SimpleDataStore: { Shared: () => ({ Get: (k) => cache[k] || null, Put: (k, v) => { cache[k] = JSON.stringify(v); }, Delete: (k) => { delete cache[k]; }, Keys: [] }) },
    'process-manager': { getProcesses(cb) { cb({}); } },
    child_process: { execFile: fakeExecFile },
    fs
};

let agent;
test.before(function () {
    // Files from an earlier version in the folders it used, our old work folder content, and a file that isn't ours
    for (const d of ['/tmp', '/usr/local/mesh_services/meshagent', '/opt/meshagent/scripttask']) realFs.mkdirSync(inBox(d), { recursive: true });
    fs.writeFileSync('/tmp/st0a1b2c3d4e5.txt', 'old output');
    fs.writeFileSync('/tmp/st9v8u7t6s5.sh', 'old script with a secret');
    fs.writeFileSync('/tmp/keep-me.txt', 'not ours');
    fs.writeFileSync('/usr/local/mesh_services/meshagent/stabcdef123.ps1', 'old');
    fs.writeFileSync('/opt/meshagent/scripttask/left-over.txt', 'from a run that never finished');

    const origLoad = Module._load;
    Module._load = function (request, parentModule) {
        if (parentModule && parentModule.filename == AGENT_FILE && stubs[request]) return stubs[request];
        return origLoad.apply(this, arguments);
    };
    Object.defineProperty(process, 'execPath', { value: '/opt/meshagent/meshagent', configurable: true });
    test.mock.timers.enable({ apis: ['setTimeout'] });
    agent = require(AGENT_FILE);
});
test.after(function () { realFs.rmSync(sandbox, { recursive: true, force: true }); });

const call = (args) => agent.consoleaction(args, 0, 'sid', parent);
const wait = () => new Promise((r) => setImmediate(() => setImmediate(r)));
const lastSent = (action) => sent.filter((c) => c.pluginaction == action).pop();

test('on start, earlier versions\' files and unfinished runs are cleaned up, and the work folder is private', async function () {
    test.mock.timers.tick(5000);
    await wait();
    assert.deepStrictEqual(realFs.readdirSync(inBox('/tmp')).sort(), ['keep-me.txt'], 'only files matching our old names are removed');
    assert.deepStrictEqual(realFs.readdirSync(inBox('/usr/local/mesh_services/meshagent')), []);
    assert.deepStrictEqual(realFs.readdirSync(inBox('/opt/meshagent/scripttask')), [], 'the work folder is emptied');
    assert.ok(shells.some((s) => s.lines.includes("chmod 700 '/opt/meshagent/scripttask'")), 'the work folder is made private');
    assert.strictEqual(Array.prototype.remove, undefined, 'no helper is added to every array');
});

test('a script runs in the work folder, gets its variables, and its files are removed afterwards', async function () {
    call({ pluginaction: 'triggerJob', jobId: 'j1', scriptId: 's1', scriptHash: 'h1', replaceVars: { name: 'world' }, dispatchTime: 1 });
    assert.strictEqual(lastSent('getScript').scriptId, 's1');
    call({ pluginaction: 'cacheScript', script: { _id: 's1', contentHash: 'h1', filetype: 'bash', content: 'echo hello #name# #missing#' } });
    await wait(); await wait();
    const done = lastSent('jobComplete');
    assert.deepStrictEqual([done.jobId, done.retVal, done.errVal == null], ['j1', 'hello world VAR_NOT_FOUND', true]);
    const shell = shells[shells.length - 1];
    assert.ok(shell.lines.includes("cd '/opt/meshagent/scripttask'"));
    assert.ok(shell.lines.some((l) => /^chmod 700 st\w+\.sh$/.test(l)), 'the script is private too');
    assert.deepStrictEqual(realFs.readdirSync(inBox('/opt/meshagent/scripttask')), []);
});

test('two runs waiting for the same script each get their own variables', async function () {
    call({ pluginaction: 'triggerJob', jobId: 'j2', scriptId: 's2', scriptHash: 'h2', replaceVars: { who: 'first' }, dispatchTime: 1 });
    call({ pluginaction: 'triggerJob', jobId: 'j3', scriptId: 's2', scriptHash: 'h2', replaceVars: { who: 'second' }, dispatchTime: 1 });
    call({ pluginaction: 'cacheScript', script: { _id: 's2', contentHash: 'h2', filetype: 'bash', content: 'echo #who#' } });
    await wait(); await wait();
    const results = sent.filter((c) => c.pluginaction == 'jobComplete' && ['j2', 'j3'].includes(c.jobId)).map((c) => c.jobId + '=' + c.retVal).sort();
    assert.deepStrictEqual(results, ['j2=first', 'j3=second']);
});

test('checkJobs reports the runs this agent isn\'t running, and finishing one run doesn\'t forget another', async function () {
    cache['pluginScriptTask_script_s3'] = JSON.stringify({ _id: 's3', contentHash: 'h3', filetype: 'bash', content: 'hang' });
    cache['pluginScriptTask_script_s4'] = JSON.stringify({ _id: 's4', contentHash: 'h4', filetype: 'bash', content: 'echo quick' });
    call({ pluginaction: 'triggerJob', jobId: 'long', scriptId: 's3', scriptHash: 'h3', dispatchTime: 1 });
    call({ pluginaction: 'triggerJob', jobId: 'quick', scriptId: 's4', scriptHash: 'h4', dispatchTime: 1 });
    // A run still waiting for its script counts as running too
    call({ pluginaction: 'triggerJob', jobId: 'downloading', scriptId: 's5', scriptHash: 'h5', dispatchTime: 1 });
    await wait(); await wait();
    assert.strictEqual(lastSent('jobComplete').jobId, 'quick');
    sent.length = 0;
    call({ pluginaction: 'checkJobs', jobIds: ['long', 'downloading', 'quick', 'gone'] });
    assert.deepStrictEqual(lastSent('jobsNotRunning').jobIds, ['quick', 'gone']);
    sent.length = 0;
    call({ pluginaction: 'checkJobs', jobIds: ['long'] });
    assert.strictEqual(lastSent('jobsNotRunning'), undefined, 'nothing to report');
    // Sending a run that is still running again doesn't start it twice
    const before = shells.length;
    call({ pluginaction: 'triggerJob', jobId: 'long', scriptId: 's3', scriptHash: 'h3', dispatchTime: 1 });
    assert.strictEqual(shells.length, before);
});

test('a run past its maximum run time is stopped, with its output so far, and the limit is optional', async function () {
    cache['pluginScriptTask_script_s6'] = JSON.stringify({ _id: 's6', contentHash: 'h6', filetype: 'bash', content: 'echo halfway; hang' });
    sent.length = 0;
    call({ pluginaction: 'triggerJob', jobId: 'slow', scriptId: 's6', scriptHash: 'h6', dispatchTime: 1, maxRunSeconds: 600 });
    await wait();
    const runShell = shells[shells.length - 1];
    assert.ok(runShell.lines.some((l) => / < \/dev\/null$/.test(l)), 'the script reads no input');
    test.mock.timers.tick(599 * 1000); await wait();
    assert.strictEqual(lastSent('jobComplete'), undefined, 'still running before the limit');
    test.mock.timers.tick(1000); await wait(); await wait();
    assert.ok(runShell.killed, 'the shell running the script was stopped');
    assert.ok(shells.some((s) => s.lines.some((l) => l.endsWith('kill_tree ' + runShell.pid))), 'stopped with its child processes');
    const done = lastSent('jobComplete');
    assert.strictEqual(done.retVal, null);
    assert.match(done.errVal, /^Stopped after 10 minutes/);
    assert.match(done.errVal, /Output so far:\nhalfway/);
    // No limit: nothing stops it
    call({ pluginaction: 'triggerJob', jobId: 'unlimited', scriptId: 's6', scriptHash: 'h6', dispatchTime: 1, maxRunSeconds: 0 });
    await wait();
    const free = shells[shells.length - 1];
    test.mock.timers.tick(7 * 86400 * 1000); await wait();
    assert.ok(!free.killed);
});

test('variable values are inserted exactly as written', async function () {
    cache['pluginScriptTask_script_s7'] = JSON.stringify({ _id: 's7', contentHash: 'h7', filetype: 'bash', content: 'echo #pw# #url# #missing# done' });
    sent.length = 0;
    call({ pluginaction: 'triggerJob', jobId: 'literal', scriptId: 's7', scriptHash: 'h7', dispatchTime: 1, replaceVars: { pw: 'a$&b$1$$c', url: 'page#top#end' } });
    await wait(); await wait();
    assert.strictEqual(lastSent('jobComplete').retVal, 'a$&b$1$$c page#top#end VAR_NOT_FOUND done');
});
