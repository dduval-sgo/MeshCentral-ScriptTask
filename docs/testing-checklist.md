# Manual test checklist

The automated tests cover the server (on NeDB and MongoDB) and the pages in a browser, but with simulated devices: no real agent has run a script yet. This list covers what needs a real MeshCentral with real agents. It takes about an hour.

You need:
- A MeshCentral server, 1.2.0 or later, using the Modern UI. A test server is best.
- At least one **Windows** device and one **Linux** device with agents connected. A macOS device is a bonus.
- Two accounts besides your own administrator: a **manager** who isn't a full administrator, and a **plain user** with Remote Commands rights on one device.
- A backup of `meshcentral-data` (or your MongoDB database) if you're testing an upgrade.

Mark each item ✅ or note what happened.

## 1. Install

- [ ] **Fresh install:** in My Server > Plugins, Download Plugin with the `config.json` URL, enable it, and restart MeshCentral. ScriptTask appears in the plugin list with the version in `config.json`.
- [ ] **Upgrade from the original plugin** (on a copy of real data): remove the original, install this one, restart MeshCentral, and reload the browser page (Ctrl+F5). The library, schedules, history and variables are all there. Existing schedules show their next run, and one fires at its usual time.
- [ ] No ScriptTask errors in the console or `mesherrors.txt` after the restart.
- [ ] **Upgrade without a restart** (from 0.1.1 to a later version): use Upgrade in the plugin list. The console says "ScriptTask: loading version …", and the new pages appear after reloading the browser page.

## 2. Running scripts on real agents

On a device's **Plugins** tab, ScriptTask section:

- [ ] **Windows, PowerShell:** run a script that prints a few lines. The result arrives in History within a minute, with the full output in the viewer.
- [ ] **Windows, Batch:** same, with a `.bat` script.
- [ ] **Linux, Bash:** same, with a Bash script. Also try one saved from a Windows editor (CRLF line endings): it should still run.
- [ ] **Linux, PowerShell** (only if `pwsh` is installed): runs; without `pwsh`, the picker warns first.
- [ ] **JSON output:** a script that prints JSON shows formatted in the output viewer.
- [ ] **Error:** a script that writes to stderr or exits with an error shows as Error, with the message.
- [ ] **Maximum run time:** set "Stop scripts that run longer than" to 1 minute, then run a script that starts a long command (Windows: `ping -n 300 127.0.0.1`; Linux: `sleep 300`). After about a minute the run shows Error "Stopped after 60 seconds…", and the command is no longer running on the device (Task Manager or `ps`). Set it back afterwards.
- [ ] **Prompts don't hang:** a Batch script with `pause` and `set /p x=Name?`, and a Bash script with `read x`, finish straight away instead of hanging.
- [ ] **Long-running script** (e.g. `sleep 120`): shows Running, then completes. With "Flag runs with no result after" set to 5 minutes, a script that hangs longer shows "No result yet".
- [ ] **Reboot script** (e.g. `shutdown /r /t 5` or `sleep 5; reboot`): the device restarts once. When its agent reconnects, the run shows as Error ("Interrupted…") and does not run again.
- [ ] **Work folder:** while a long script runs, `scripttask` next to the agent holds `st….ps1/.bat/.sh` and `.txt` files. A non-admin user on the device can't open the folder (Windows: Access denied; Linux: permission denied). After the run, the folder is empty.
- [ ] **Leftovers from older versions:** `st*.ps1`/`st*.txt` files in the Mesh Agent folder (Windows) or `/tmp` (Linux) are gone after the agent restarts.
- [ ] **Running twice:** while a long script runs, restart MeshCentral (not the device). The run keeps going, isn't started again, and reports its result.

## 3. Variables

- [ ] A global variable, a device-group variable and a device variable with the same name: the device value wins on that device, the group value on another device in the group, the global value elsewhere.
- [ ] A **secret** variable: hidden in Variables and in the editor's hover until Reveal; the script still receives the real value.
- [ ] A name with no value runs as `VAR_NOT_FOUND`, and the Variables section lists it as undefined.
- [ ] `#GBL:nodeId#`, `#GBL:meshId#` and `#GBL:runBy#` are filled in.

## 4. Schedules and offline devices

- [ ] Schedule a script every 5 minutes on an online device: it runs at each step, and Overview's Up next shows the next one.
- [ ] **Run when it reconnects:** disconnect the agent past a scheduled time, reconnect: it runs once, straight away (no burst of catch-up runs).
- [ ] **Skip:** disconnect past a scheduled time (longer than the Skip grace period): the run shows as Missed, and the next one is scheduled as normal.
- [ ] **Run if it reconnects within…** (e.g. 10 minutes): reconnecting inside the window runs it; outside, it's Missed.
- [ ] A daily schedule shows the right local time, and the time zone note if your browser's zone differs from the schedule's.
- [ ] Pause and resume a schedule; edit one; delete one: its pending run disappears from the queue.

## 5. Several devices and batches

From the ScriptTask page:

- [ ] **Run:** pick a Bash script; Windows devices are listed but can't be selected. Run on two or more Linux devices: you land on the batch page, which fills in as results arrive, with identical output grouped together.
- [ ] **Run again** on a failed device adds its new result to the same batch.
- [ ] **Export CSV** opens in a spreadsheet with one row per device and the full output.
- [ ] **Schedule** on several devices: the batch page shows one run at a time, with the occurrence picker.
- [ ] Save a device set, reload the page, and load it again.

## 6. Permissions

Grant the manager account **Manage ScriptTask** using MeshCentral's plugin permissions, and leave the plain user with the defaults.

- [ ] **Manager (not a full administrator):** can reach the ScriptTask page (from Open ScriptTask on a device tab if My Server isn't shown). Lists, batches and variables only include devices and device groups this account can see in MeshCentral.
- [ ] **Plain user:** on a device where they have Remote Commands, can run and schedule library scripts and see that device's history. They can cancel their own runs and change their own schedules, not other people's. The ScriptTask page says it's for managers.
- [ ] **Plain user without Remote Commands** on a device: the ScriptTask section says they can't run scripts there.
- [ ] Revoking **Run scripts** from the plain user hides the run controls.

## 7. Look and feel

- [ ] Switch MeshCentral between light and dark mode, and between two Bootswatch themes, with the ScriptTask page and a device tab open: both follow straight away.
- [ ] Classic UI: the ScriptTask section asks you to switch to the Modern UI.
- [ ] Code themes: change the editor theme in Settings; it applies to the editor and the output viewer, and stays after a reload.
- [ ] A narrow window (phone-sized) is still usable on the ScriptTask page and the device tab.

## 8. MongoDB (only if you use it)

- [ ] Repeat sections 2, 4 and 5 on a MeshCentral server that uses MongoDB. The automated server tests pass on MongoDB 7 with the driver MeshCentral installs (4.17.2), but a real server hasn't been tried.
