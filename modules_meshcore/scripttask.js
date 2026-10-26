/** 
* @description MeshCentral ScriptTask plugin
* @author Ryan Blenis
* @author Desmond Duval (modifications)
* Modified by Desmond Duval, 2026: private work folder with cleanup, running-job tracking, checkJobs. See changelog.md.
* @copyright 
* @license Apache-2.0
*/

"use strict";
var mesh;
var obj = this;
var _sessionid;
var isWsconnection = false;
var wscon = null;
var db = require('SimpleDataStore').Shared();
var pendingDownload = [];
var debug_flag = false;
var runningJobs = [];
var runningJobPIDs = {};

var dbg = function(str) {
    if (debug_flag !== true) return;
    var fs = require('fs');
    var logStream = fs.createWriteStream('scripttask.txt', {'flags': 'a'});
    // use {'flags': 'a'} to append and {'flags': 'w'} to erase and write a new file
    logStream.write('\n'+new Date().toLocaleString()+': '+ str);
    logStream.end('\n');
}

function removeRunningJob(jobId) {
    var i = runningJobs.indexOf(jobId);
    if (i >= 0) runningJobs.splice(i, 1);
    delete runningJobPIDs[jobId];
}

// ---- Work folder ----
// Scripts (with their variables filled in) and their output are written to a "scripttask" folder next to the agent,
// readable only by the agent's account and administrators. It is emptied when this module starts, so files from
// runs that never finished don't pile up. Earlier versions wrote st*.ps1/.bat/.sh/.txt files into the agent's
// folder or a temp folder; those are removed too.

var LEGACY_FILE = /^st[0-9a-v]{6,16}\.(ps1|bat|sh|txt)$/;
var LEGACY_DIRS_UNIX = ['/usr/local/mesh', '/tmp', '/usr/local/mesh_services/meshagent', '/var/tmp'];
var workDir = null, workDirWaiting = null;

function joinPath(dir, name) { return dir + ((process.platform == 'win32') ? '\\' : '/') + name; }
function agentDir() {
    try {
        var p = process.execPath;
        var i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        if (i > 0) return p.substring(0, i);
    } catch (e) { }
    return null;
}
// The folder the earlier versions used, as a fallback
function legacyDir() {
    if (process.platform == 'win32') return process.cwd();
    var fs = require('fs');
    for (var i = 0; i < LEGACY_DIRS_UNIX.length; i++) { if (fs.existsSync(LEGACY_DIRS_UNIX[i])) return LEGACY_DIRS_UNIX[i]; }
    return '/tmp';
}
// Run commands in a shell (cmd.exe or sh), the way the script runners do, and call done() when it exits
function shellCommands(lines, done) {
    try {
        var child = (process.platform == 'win32')
            ? require('child_process').execFile(process.env['windir'] + '\\system32\\cmd.exe')
            : require('child_process').execFile('/bin/sh', ['sh']);
        child.stderr.on('data', function (chunk) { dbg('Shell: ' + chunk); });
        child.stdout.on('data', function (chunk) { });
        child.on('exit', function () { done(); });
        var eol = (process.platform == 'win32') ? '\r\n' : '\n';
        lines.forEach(function (l) { child.stdin.write(l + eol); });
        child.stdin.write('exit' + eol);
    } catch (e) { dbg('Shell error: ' + e); done(); }
}
function emptyFolder(dir, onlyLegacy) {
    var fs = require('fs');
    try {
        fs.readdirSync(dir).forEach(function (name) {
            if (onlyLegacy && !LEGACY_FILE.test(name)) return;
            try { fs.unlinkSync(joinPath(dir, name)); } catch (e) { } // A file still in use is left for next time
        });
    } catch (e) { dbg('Could not clean ' + dir + ': ' + e); }
}
// Calls back with the work folder, creating and locking it down first if needed
function withWorkDir(callback) {
    if (workDir != null) { callback(workDir); return; }
    if (workDirWaiting != null) { workDirWaiting.push(callback); return; }
    workDirWaiting = [callback];
    var fs = require('fs');
    var base = agentDir(), dir = (base != null) ? joinPath(base, 'scripttask') : null;
    var finish = function (chosen) {
        workDir = chosen;
        emptyFolder(workDir, workDir != dir); // Empty our own folder; in a shared fallback folder, only our old files
        var waiting = workDirWaiting; workDirWaiting = null;
        waiting.forEach(function (cb) { cb(workDir); });
    };
    try { if (dir != null && !fs.existsSync(dir)) fs.mkdirSync(dir); } catch (e) { dbg('Could not create ' + dir + ': ' + e); }
    if (dir == null || !fs.existsSync(dir)) { finish(legacyDir()); return; }
    if (process.platform == 'win32') {
        // Only SYSTEM (S-1-5-18) and Administrators (S-1-5-32-544), whatever the system's language
        shellCommands(['icacls "' + dir + '" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F'], function () { finish(dir); });
    } else {
        shellCommands(["chmod 700 '" + dir.split("'").join("'\\''") + "'"], function () { finish(dir); });
    }
}
// Remove files left by earlier versions, in the folders they used
function cleanLegacyFiles() {
    var fs = require('fs');
    var dirs = (process.platform == 'win32') ? [process.cwd()] : LEGACY_DIRS_UNIX;
    dirs.forEach(function (d) { if (fs.existsSync(d)) emptyFolder(d, true); });
}
setTimeout(function () {
    try { cleanLegacyFiles(); withWorkDir(function () { }); } catch (e) { dbg('Startup cleanup failed: ' + e); }
}, 5000);

function consoleaction(args, rights, sessionid, parent) {
    isWsconnection = false;
    wscon = parent;
    var _sessionid = sessionid;
    if (typeof args['_'] == 'undefined') {
      args['_'] = [];
      args['_'][1] = args.pluginaction;
      args['_'][2] = null;
      args['_'][3] = null;
      args['_'][4] = null;
      isWsconnection = true;
    }
    
    var fnname = args['_'][1];
    mesh = parent;
    
    switch (fnname) {
        case 'triggerJob':
            var jObj = { 
                jobId: args.jobId,
                scriptId: args.scriptId,
                replaceVars: args.replaceVars,
                scriptHash: args.scriptHash,
                dispatchTime: args.dispatchTime
            };
            //dbg('jObj args is ' + JSON.stringify(jObj));
            var sObj = getScriptFromCache(jObj.scriptId);
            //dbg('sobj = ' + JSON.stringify(sObj) + ', shash = ' + jObj.scriptHash);
            if (sObj == null || sObj.contentHash != jObj.scriptHash) {
                // get from the server, then run
                //dbg('Getting and caching script '+ jObj.scriptId);
                mesh.SendCommand({ 
                    "action": "plugin", 
                    "plugin": "scripttask",
                    "pluginaction": "getScript",
                    "scriptId": jObj.scriptId, 
                    "sessionid": _sessionid,
                    "tag": "console"
                });
                pendingDownload.push(jObj);
            } else {
                // ready to run
                runScript(sObj, jObj);
            }
        break;
        case 'cacheScript':
            var sObj = args.script;
            cacheScript(sObj);
            // Run the jobs that were waiting for this script, and keep the rest waiting
            var ready = pendingDownload.filter(function (pd) { return pd.scriptId == sObj._id && pd.scriptHash == sObj.contentHash; });
            pendingDownload = pendingDownload.filter(function (pd) { return ready.indexOf(pd) === -1; });
            ready.forEach(function (pd) { runScript(JSON.parse(JSON.stringify(sObj)), pd); });
        break;
        case 'checkJobs':
            // The server asks which of the runs it sent are still running here (after the agent reconnects).
            // Runs this agent doesn't know are reported, so the server records them as interrupted instead of rerunning.
            var ids = Array.isArray(args.jobIds) ? args.jobIds : [];
            var notRunning = ids.filter(function (id) {
                if (runningJobs.indexOf(id) !== -1) return false;
                return !pendingDownload.some(function (pd) { return pd.jobId == id; });
            });
            if (notRunning.length) mesh.SendCommand({
                "action": "plugin",
                "plugin": "scripttask",
                "pluginaction": "jobsNotRunning",
                "jobIds": notRunning,
                "sessionid": _sessionid,
                "tag": "console"
            });
        break;
        case 'clearAll':
            clearCache();
            mesh.SendCommand({ 
                "action": "plugin", 
                "plugin": "scripttask",
                "pluginaction": "clearAllPendingJobs",
                "sessionid": _sessionid,
                "tag": "console"
            });
            return 'Cache cleared. All pending jobs cleared.';
        break;
        case 'clearCache':
            clearCache();
            return 'The script cache has been cleared';
        break;
        case 'debug':
            debug_flag = (debug_flag) ? false : true;
            var str = (debug_flag) ? 'on' : 'off';
            return 'Debugging is now ' + str;
        break;
        case 'getPendingJobs':
            var ret = '';
            if (pendingDownload.length == 0) return "No jobs pending script download";
            pendingDownload.forEach(function(pd, k) {     
                ret += 'Job ' + k + ': ' + 'JobID: ' + pd.jobId + ' ScriptID: ' + pd.scriptId;
            });
            return ret;
        break;
        default:
            dbg('Unknown action: '+ fnname + ' with data ' + JSON.stringify(args));
        break;
    }
}

function finalizeJob(job, retVal, errVal) {
    if (errVal != null && errVal.stack != null) errVal = errVal.stack;
    removeRunningJob(job.jobId);
    mesh.SendCommand({ 
        "action": "plugin", 
        "plugin": "scripttask",
        "pluginaction": "jobComplete",
        "jobId": job.jobId,
        "scriptId": job.scriptId,
        "retVal": retVal,
        "errVal": errVal,
        "dispatchTime": job.dispatchTime, // include original run time (long running tasks could have tried a re-send)
        "sessionid": _sessionid,
        "tag": "console"
    });
}
//@TODO Test powershell on *nix devices with and without powershell installed
function runPowerShell(sObj, jObj, dir) {
    if (process.platform != 'win32') return runPowerShellNonWin(sObj, jObj, dir);
    const fs = require('fs');
    var rand =  Math.random().toString(32).replace('0.', '');
    
    var oName = joinPath(dir, 'st' + rand + '.txt');
    var pName = joinPath(dir, 'st' + rand + '.ps1');
    var pwshout = '', pwsherr = '', cancontinue = false;
    try {
        fs.writeFileSync(pName, sObj.content);
        var outstr = '', errstr = '';
        var child = require('child_process').execFile(process.env['windir'] + '\\system32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy Bypass'] );
        child.stderr.on('data', function (chunk) { errstr += chunk; });
        child.stdout.on('data', function (chunk) { });
        runningJobPIDs[jObj.jobId] = child.pid;
        var quote = function (p) { return "'" + p.split("'").join("''") + "'"; };
        child.stdin.write('Set-Location -LiteralPath ' + quote(dir) + '\r\n');
        child.stdin.write('& ' + quote(pName) + ' | Out-File -LiteralPath ' + quote(oName) + ' -Encoding UTF8\r\n');
        child.on('exit', function(procRetVal, procRetSignal) {
            dbg('Exiting with '+procRetVal + ', Signal: ' + procRetSignal); 
            if (errstr != '') {
                finalizeJob(jObj, null, errstr);
                try { 
                    fs.unlinkSync(oName);
                    fs.unlinkSync(pName);
                } catch (e) { dbg('Could not unlink files, error was: ' + e); }
                return;
            }
            if (procRetVal == 1) {
                finalizeJob(jObj, null, 'Process terminated unexpectedly.');
                try { 
                    fs.unlinkSync(oName);
                    fs.unlinkSync(pName);
                } catch (e) { dbg('Could not unlink files, error was: ' + e); }
                return;
            }
            try { 
                outstr = fs.readFileSync(oName, 'utf8').toString();
            } catch (e) { outstr = (procRetVal) ? 'Failure' : 'Success'; }
            if (outstr) {
                //outstr = outstr.replace(/[^\x20-\x7E]/g, ''); 
                try { outstr = outstr.trim(); } catch (e) { }
            } else {
                outstr = (procRetVal) ? 'Failure' : 'Success';
            }
            dbg('Output is: ' + outstr);
            finalizeJob(jObj, outstr);
            try { 
                fs.unlinkSync(oName);
                fs.unlinkSync(pName);
            } catch (e) { }
        });
        child.stdin.write('exit\r\n');
        //child.waitExit(); // this was causing the event loop to stall on long-running scripts, switched to '.on exit'

    } catch (e) { 
        dbg('Error block was (PowerShell): ' + e);
        finalizeJob(jObj, null, e);
    }
}

function runPowerShellNonWin(sObj, jObj, dir) {
    const fs = require('fs');
    var rand =  Math.random().toString(32).replace('0.', '');
    var path = dir + '/';
    
    var oName = 'st' + rand + '.txt';
    var pName = 'st' + rand + '.ps1';
    var pwshout = '', pwsherr = '', cancontinue = false;
    try {
        var childp = require('child_process').execFile('/bin/sh', ['sh']);
        childp.stderr.on('data', function (chunk) { pwsherr += chunk; });
        childp.stdout.on('data', function (chunk) { pwshout += chunk; });
        childp.stdin.write('which pwsh' + '\n');
        childp.stdin.write('exit\n');
        childp.waitExit();
    } catch (e) { finalizeJob(jObj, null, "Couldn't determine pwsh in env: " + e); }
    if (pwsherr != '') {
        finalizeJob(jObj, null, "PowerShell env determination error: " + pwsherr);
        return;
    }
    if (pwshout.trim() != '') {
        cancontinue = true;
    }
    if (cancontinue === false) { finalizeJob(jObj, null, "PowerShell is not installed"); return; }
    try {
        fs.writeFileSync(path + pName, '#!' + pwshout + '\n' + sObj.content.split('\r\n').join('\n').split('\r').join('\n'));
        var outstr = '', errstr = '';
        var child = require('child_process').execFile('/bin/sh', ['sh']);
        child.stderr.on('data', function (chunk) { errstr += chunk; });
        child.stdout.on('data', function (chunk) { });
        runningJobPIDs[jObj.jobId] = child.pid;
        
        child.stdin.write("cd '" + dir.split("'").join("'\\''") + "'\n");
        child.stdin.write('chmod 700 ' + pName + '\n');                                                                                                                                        
        child.stdin.write('./' + pName + ' > ' + oName + '\n');
        child.on('exit', function(procRetVal, procRetSignal) {
            if (errstr != '') {
                finalizeJob(jObj, null, errstr);
                try {
                    fs.unlinkSync(path + oName);
                    fs.unlinkSync(path + pName);
                } catch (e) { dbg('Could not unlink files, error was: ' + e + ' for path ' + path); }
                return;
            }
            if (procRetVal == 1) {
                finalizeJob(jObj, null, 'Process terminated unexpectedly.');
                try {
                    fs.unlinkSync(path + oName);
                    fs.unlinkSync(path + pName);
                } catch (e) { dbg('Could not unlink files1, error was: ' + e + ' for path ' + path); }
                return;
            }
            try { 
                outstr = fs.readFileSync(path + oName, 'utf8').toString();
            } catch (e) { outstr = (procRetVal) ? 'Failure' : 'Success'; }
            if (outstr) {
                //outstr = outstr.replace(/[^\x20-\x7E]/g, ''); 
                try { outstr = outstr.trim(); } catch (e) { }
            } else {
                outstr = (procRetVal) ? 'Failure' : 'Success';
            }
            dbg('Output is: ' + outstr);
            finalizeJob(jObj, outstr);
            try {
                fs.unlinkSync(path + oName);
                fs.unlinkSync(path + pName);
            } catch (e) { dbg('Could not unlink files2, error was: ' + e + ' for path ' + path); }
        });
        child.stdin.write('exit\n');
    } catch (e) { 
        dbg('Error block was (PowerShellNonWin): ' + e);
        finalizeJob(jObj, null, e);
    }
}

function runBat(sObj, jObj, dir) {
    if (process.platform != 'win32') {
        finalizeJob(jObj, null, 'Platform not supported.');
        return;
    }
    const fs = require('fs');
    var rand =  Math.random().toString(32).replace('0.', '');
    var oName = joinPath(dir, 'st' + rand + '.txt');
    var pName = joinPath(dir, 'st' + rand + '.bat');
    try {
        fs.writeFileSync(pName, sObj.content);
        var outstr = '', errstr = '';
        var child = require('child_process').execFile(process.env['windir'] + '\\system32\\cmd.exe');
        child.stderr.on('data', function (chunk) { errstr += chunk; });
        child.stdout.on('data', function (chunk) { });
        runningJobPIDs[jObj.jobId] = child.pid;
        child.stdin.write('cd /d "' + dir + '"\r\n');
        child.stdin.write('"' + pName + '" > "' + oName + '"\r\n');
        child.stdin.write('exit\r\n');

        child.on('exit', function(procRetVal, procRetSignal) {
            if (errstr != '') {
                try { 
                    fs.unlinkSync(oName);
                    fs.unlinkSync(pName);
                } catch (e) { dbg('Could not unlink files, error was: ' + e); }
                finalizeJob(jObj, null, errstr);
                return;
            }
            if (procRetVal == 1) {
                try { 
                    fs.unlinkSync(oName);
                    fs.unlinkSync(pName);
                } catch (e) { dbg('Could not unlink files, error was: ' + e); }
                finalizeJob(jObj, null, 'Process terminated unexpectedly.');
                return;
            }
            try { 
                outstr = fs.readFileSync(oName, 'utf8').toString();
            } catch (e) { outstr = (procRetVal) ? 'Failure' : 'Success'; }
            if (outstr) {
                //outstr = outstr.replace(/[^\x20-\x7E]/g, ''); 
                try { outstr = outstr.trim(); } catch (e) { }
            } else {
                outstr = (procRetVal) ? 'Failure' : 'Success';
            }
            dbg('Output is: ' + outstr);
            try {
                fs.unlinkSync(oName);
                fs.unlinkSync(pName);
            } catch (e) { dbg('Could not unlink files, error was: ' + e); }
            finalizeJob(jObj, outstr);
        });
    } catch (e) { 
        dbg('Error block was (BAT): ' + e);
        finalizeJob(jObj, null, e);
    }
}

function runBash(sObj, jObj, dir) {
    if (process.platform == 'win32') {
        finalizeJob(jObj, null, 'Platform not supported.');
        return;
    }
    const fs = require('fs');
    var path = dir + '/';
    //var child = require('child_process');
    //child.execFile(process.env['windir'] + '\\system32\\cmd.exe', ['/c', 'RunDll32.exe user32.dll,LockWorkStation'], { type: 1 });
    
    var rand =  Math.random().toString(32).replace('0.', '');
    var oName = 'st' + rand + '.txt';
    var pName = 'st' + rand + '.sh';
    try {
        fs.writeFileSync(path + pName, sObj.content);
        var outstr = '', errstr = '';
        var child = require('child_process').execFile('/bin/sh', ['sh']);
        child.stderr.on('data', function (chunk) { errstr += chunk; });
        child.stdout.on('data', function (chunk) { });
        runningJobPIDs[jObj.jobId] = child.pid;
        child.stdin.write("cd '" + dir.split("'").join("'\\''") + "'\n");
        child.stdin.write('chmod 700 ' + pName + '\n');
        child.stdin.write('./' + pName + ' > ' + oName + '\n');
        child.stdin.write('exit\n');
        
        child.on('exit', function(procRetVal, procRetSignal) {
            if (errstr != '') {
                try {
                    fs.unlinkSync(path + oName);
                    fs.unlinkSync(path + pName);
                } catch (e) { dbg('Could not unlink files, error was: ' + e + ' for path ' + path); }
                finalizeJob(jObj, null, errstr);
                return;
            }
            if (procRetVal == 1) {
                try {
                    fs.unlinkSync(path + oName);
                    fs.unlinkSync(path + pName);
                } catch (e) { dbg('Could not unlink files1, error was: ' + e + ' for path ' + path); }
                finalizeJob(jObj, null, 'Process terminated unexpectedly.');
                return;
            }
            try { 
                outstr = fs.readFileSync(path + oName, 'utf8').toString();
            } catch (e) { outstr = (procRetVal) ? 'Failure' : 'Success'; }
            if (outstr) {
                //outstr = outstr.replace(/[^\x20-\x7E]/g, ''); 
                try { outstr = outstr.trim(); } catch (e) { }
            } else {
                outstr = (procRetVal) ? 'Failure' : 'Success';
            }
            dbg('Output is: ' + outstr);
            try {
                fs.unlinkSync(path + oName);
                fs.unlinkSync(path + pName);
            } catch (e) { dbg('Could not unlink files2, error was: ' + e + ' for path ' + path); }
            finalizeJob(jObj, outstr);
        });
    } catch (e) { 
        dbg('Error block was (bash): ' + e);
        finalizeJob(jObj, null, e);
    }
}

function jobIsRunning(jObj) {
    if (runningJobs.indexOf(jObj.jobId) === -1) return false;
    return true;
}

function runScript(sObj, jObj) {
    // get current processes and clean running jobs if they are no longer running (computer fell asleep, user caused process to stop, etc.)
    if (process.platform != 'linux' && runningJobs.length) { // linux throws errors here in the meshagent for some reason
        require('process-manager').getProcesses(function (plist) {
            dbg('Got process list');
            dbg('There are currently ' + runningJobs.length + ' running jobs.');
            if (runningJobs.length) {
                runningJobs.slice().forEach(function (jobId) {
                    dbg('Checking for running job: ' + jobId + ' with PID ' + runningJobPIDs[jobId]);
                    if (typeof plist[runningJobPIDs[jobId]] == 'undefined' || typeof plist[runningJobPIDs[jobId]].cmd != 'string') {
                        dbg('Found job with no process. Removing running status.');
                        removeRunningJob(jobId);
                        //dbg('RunningJobs: ' + JSON.stringify(runningJobs));
                        //dbg('RunningJobsPIDs: ' + JSON.stringify(runningJobPIDs));
                    }
                });
            }
        });
    }
    if (jobIsRunning(jObj)) { dbg('Job already running job id [' + jObj.jobId + ']. Skipping.'); return; }
    if (jObj.replaceVars != null) {
        Object.getOwnPropertyNames(jObj.replaceVars).forEach(function(key) {
          var val = jObj.replaceVars[key];
          sObj.content = sObj.content.replace(new RegExp('#'+key+'#', 'g'), val);
          dbg('replacing var '+ key + ' with ' + val);
        });
        sObj.content = sObj.content.replace(new RegExp('#(.*?)#', 'g'), 'VAR_NOT_FOUND');
    }
    runningJobs.push(jObj.jobId);
    dbg('Running Script '+ sObj._id);
    withWorkDir(function (dir) {
        switch (sObj.filetype) {
            case 'ps1':
                runPowerShell(sObj, jObj, dir);
            break;
            case 'bat':
                runBat(sObj, jObj, dir);
            break;
            case 'bash':
                runBash(sObj, jObj, dir);
            break;
            default:
                dbg('Unknown filetype: '+ sObj.filetype);
                finalizeJob(jObj, null, 'Unknown script type: ' + sObj.filetype);
            break;
        }
    });
}
function getScriptFromCache(id) {
    var script = db.Get('pluginScriptTask_script_' + id);
    if (script == '' || script == null) return null;
    try {
        script = JSON.parse(script);
    } catch (e) { return null; }
    return script;
}
function cacheScript(sObj) {
    db.Put('pluginScriptTask_script_' + sObj._id, sObj);
}
function clearCache() {
    db.Keys.forEach(function(k) {
        if (k.indexOf('pluginScriptTask_script_') === 0) {
            db.Put(k, null);
            db.Delete(k);
        }
    });
}

function sendConsoleText(text, sessionid) {
    if (typeof text == 'object') { text = JSON.stringify(text); }
    mesh.SendCommand({ "action": "msg", "type": "console", "value": text, "sessionid": sessionid });
}

module.exports = { consoleaction : consoleaction };
