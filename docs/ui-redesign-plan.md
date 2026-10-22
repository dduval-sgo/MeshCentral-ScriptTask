# ScriptTask UI Redesign Plan

Scope of this pass: looks, usability, and quality-of-life fixes. Server and data changes are included only where the new UI needs them. Everything else is listed under [Later work](#later-work).

Reference: MeshCentral source at `1.3.0` (`views/default3.handlebars` is the Modern UI, `views/default.handlebars` is the Classic UI, `pluginHandler.js`).

### Decisions so far

| Topic | Decision |
|---|---|
| Rendering | Preact + htm, vendored (§4) |
| Host UI | **Modern UI only.** Classic UI isn't supported. |
| Minimum MeshCentral | **1.2.0** (§1, "Minimum version") |
| Roles | **Admins** use the server page: library, batch runs, schedules, variables, settings. **Users** can run and schedule existing library scripts on a single device from its device tab, and see all of that device's past runs (§3.5). |
| Permissions | Built now, because the admin/user split depends on them (§3.5) |
| Batch results view | Yes (§3.4) |
| Substituted-script preview | Dropped. Manual runs are one-liners. |
| Schedule lists | Sorted by next run, soonest first. No upcoming-runs list on the device page. |
| Offline devices and late runs | Per-schedule policies (§3.6) |

---

## 1. Where things stand today

### What the plugin renders

| View | File | How it's reached | Notes |
|---|---|---|---|
| Device tab | `views/user.handlebars` (1,022 lines) | `onDeviceRefreshEnd` → `registerPluginTab` → iframe `?pin=scripttask&user=1`, fixed at 700px | Does everything: script tree, editor launch, run, multi-device scheduling, node and script schedules, node and script history, variables. Accordion of collapsible grey bars. |
| Script editor | `views/scriptedit.handlebars` | `window.open` popup. Saves through `window.opener.callback` | Plain `<textarea>`. Hard-coded `#036` background. Popup blockers break it, and a reload loses the data. Tab inserts nothing. |
| Scheduler | `views/schedule.handlebars` | `window.open` popup. `scriptId` and `nodes` are put on the popup's `window` | Uses `tail.DateTime`. Reloading the popup loses its data ("Page reloaded and data lost"). Hard-coded `#036`. |
| Admin panel | `views/admin.handlebars` | Nothing. `hasAdminPanel` is `false`, and the route needs `admin=1`, which MeshCentral's `goPlugin()` never sends | Says "Nothing to see here... yet." |
| Procedure editor | `procedit` | Referenced in `scripttask.js:211`, but the file doesn't exist | Dead code path |

### UI problems found

- **No theme support.** Light-only hard-coded colours (`#CCC` zebra rows, `#777` bars, `lightgray` selection, `#036` popups). Fonts are Trebuchet. Neither UI's night mode is respected.
- **Everything is on the device page.** The global library, cross-device scheduling, script-wide history and global variables all sit inside one device's tab.
- **Scope leaks into the wrong page.** "Script History" and "Script Schedules" on the device page show every device. Variables can only be scoped to the *current* device or its group, so you have to visit a device to create a variable for another one.
- **The queue can't be edited.** Pending jobs can't be cancelled one at a time. The only bulk clear is the agent console command `clearAll`. Schedules can be deleted but not edited or paused.
- **Output is unreadable.** Output is inlined into a table cell, `\n` becomes `<br>`, and there's no monospace, no expand, no copy, no download. History is capped at 200 rows with no paging or filtering.
- **Unescaped `innerHTML` everywhere.** Script names, variable values and **script output from agents** are injected without escaping. Output from a compromised or careless script can run JS in an admin's session. This is fixed as a side effect of the new rendering layer (see §4).
- **Uses the host's dialogs.** `parent.setDialogMode(...)` behaves differently in Classic and Modern, and it reaches into parent DOM IDs (`stvarname`, ...).
- **Event handler collisions.** Client handlers are single slots on `parent.pluginHandler.scripttask.loadHistory` and similar. Once a server page and a device tab are both alive in the same top window, they will overwrite each other.
- **Broadcast data model.** Every change runs `DispatchEvent(['*', 'server-users'], ...)` with the **full history, output and variable values** attached. Every logged-in user receives it. This is noisy, and it's a data exposure problem (§7).

### Hooks MeshCentral gives us (verified in 1.3.0 source)

- `hasAdminPanel: true` → My Server → Plugins shows the plugin name as a link. `goPlugin()` loads `/pluginadmin.ashx?pin=scripttask` (no other params) into `#p43iframe`, which is sized `calc(100vh - …)`. This is our server-level page. Only users who can see My Server → Plugins get this entry point, so the device tab also needs a link (§3.2).
- `registerPluginTab` → device page tab (`#p19pages`). We control the iframe.
- `serveraction(command, myparent, grandparent)`. `myparent` is the user's `meshuser` session, so `myparent.send(...)` replies **to that user only**. The client routes `{action:'plugin', plugin, method}` to `pluginHandler[plugin][method](server, message)`. This gives us a proper request/response channel instead of broadcasting.
- `hook_agentCoreIsStable(agent, server)` fires when an agent connects. We can dispatch its queued jobs immediately instead of waiting up to 60 seconds for the queue tick.
- `hook_setupHttpHandlers(webserver, parent)` lets us register our own Express routes, for static assets and an optional REST surface, instead of the `include=1&path=` passthrough.
- Plugin permissions (`registerPermissions` / `checkPluginPermission`, with group and device overrides and an admin UI in Modern) shipped in 1.1.58. The role split is built on them (§3.5).

### How MeshCentral themes (what we have to follow)

| | Modern UI (`default3`) | Classic UI (`default`) |
|---|---|---|
| Framework | Bootstrap 5.3 (`styles/bootstrap[-min].css`) | None |
| Theme | Bootswatch. `<link id="theme-stylesheet">` href is swapped to `styles/themes/<name>/bootstrap-min.css`. Stored in `localStorage.theme` | — |
| Dark mode | `<html data-bs-theme="dark\|light">` plus `body.night`. Dark-base themes (cyborg, darkly, solar, vapor) force dark. A server `features2` flag can force either mode | `body.night` only |

All of this is same-origin with our iframe.

### Minimum version

The Modern UI's history in MeshCentral releases:

| Release | Date | What changed |
|---|---|---|
| 1.1.33 | Oct 2024 | Modern UI added, labelled `[BETA]` (#6450) |
| 1.1.38 | Jan 2025 | Bootswatch themes (`styles/themes/*`) |
| 1.1.57 | Feb 2026 | Theme packs for custom themes (Modern UI only) |
| 1.1.58 | Mar 2026 | Plugin permissions framework (`registerPermissions`, `checkPluginPermission`) and its Modern UI dialog |
| **1.2.0** | **May 2026** | First minor-version release after the above. Later releases are Modern UI fixes, not new foundations. |
| 1.3.0 | Oct 2026 | `MeshCentralTheme.isDarkBaseTheme`. We don't need it, because we copy the parent's resolved `data-bs-theme`. |

MeshCentral never formally announced the Modern UI as stable. **1.2.0** is the practical floor: Modern UI with themes, plus the permissions framework the role split needs. The hard technical floor is 1.1.58, if we ever need to support older servers. `config.json` `meshCentralCompat` becomes `>=1.2.0`.

---

## 2. Design principles

1. **Look like MeshCentral, not like a plugin.** Load the host's own Bootstrap stylesheet and current Bootswatch theme into our iframes, and use only Bootstrap components and CSS variables (`--bs-body-bg`, `--bs-secondary-bg`, `--bs-border-color`, `--bs-emphasis-color`, `--bs-primary`, …). If we hard-code no colours, every theme works with no extra effort.
2. **Device page = this device. Server page = everything.** No cross-device data on the device tab, apart from the script library you pick from.
3. **No popups.** Editors, schedulers and confirmations are in-page panels, off-canvas drawers or Bootstrap modals inside our own iframe.
4. **Ask for what you need.** The page sends a request and gets a targeted reply. Change notifications are small "something changed for node X / script Y" invalidations that the open view re-queries.
5. **No build step for install.** MeshCentral installs plugins from a repo zip with no `npm install`, so all front-end dependencies are vendored as pre-built files in `includes/`. A tiny optional build script regenerates them.
6. **Modern UI only.** No Classic UI code paths. If the page is loaded from Classic UI, it shows a short "Switch to the Modern UI to use ScriptTask" notice.
7. **Show only what the user can do.** Controls a user lacks permission for are hidden, not disabled, and the server enforces the same rules (§3.5).

---

## 3. Information architecture

### 3.1 Server page: "ScriptTask" (My Server → Plugins → ScriptTask)

**Admins only** (§3.5). Full-height app shell. Left-hand vertical nav collapses to a top `nav-pills` row in narrow viewports. The URL hash keeps the current section and filters (`#/history?script=…&status=error`), so reload and back/forward work and views can be bookmarked.

| Section | Contents |
|---|---|
| **Overview** | Stat cards: queued, waiting for offline device, running, failed (24h), active schedules. "Needs attention" list (recent failures, jobs dispatched but never completed). "Up next": the next 10 scheduled runs. Each card links into a filtered Queue or History view. |
| **Library** | Two panes. Left: folder tree with search, drag-and-drop move, file-drop upload, context menu (New script/folder, Rename, Duplicate, Download, Delete). Right: the selected script, with sub-tabs **Editor · Schedules · History · Variables**. Editor toolbar: type selector, indent setting, Save (Ctrl+S), Revert, **Run…**. A dirty-state badge and a navigate-away guard prevent losing edits. |
| **Run / Batch** | Target builder: filter devices by group, tag, OS, online/offline, and name search. Selection chips with a live count. Then pick a script → **Run now** or **Schedule** (inline schedule form, §3.3). Warns about incompatible targets (`.bat` on Linux/macOS, `.ps1` with no PowerShell) before submitting. Saved target sets ("All Windows servers") are stored per user. |
| **Queue** | Every job not yet completed, server-wide. Columns: script, device (+ group, online dot), status, queued, not-before, run by, source (manual / schedule). Status values: *Waiting for device* · *Queued* · *Dispatched* (with age, and a "stale" flag after N minutes) · *Scheduled*. Multi-select → **Cancel**, **Run now** (clears not-before). Filters match History. |
| **Schedules** | Every `jobSchedule`, **sorted by next run, soonest first**, with paused schedules last. Columns: readable recurrence ("Every 2 weeks on Mon, Thu at 09:00"), offline policy, last run (late runs flagged), next run, created by. Actions: **Edit**, **Pause/Resume**, **Run now**, **Delete**. Bulk select. |
| **History** | Server-wide job log, paged and filtered on the server: script, device, group, status, run by, date range, and full-text search in output. Clicking a row opens an off-canvas **Output viewer** (§3.4). Rows from the same batch are grouped and can be expanded. |
| **Variables** | One table for every scope, with proper target pickers (script picker, group picker, device picker). Columns: name, value (masked if flagged secret), scope, target. Search and scope filter. A "where used" link lists scripts that reference `#name#`. |
| **Settings** | History retention (days, now hard-coded 90), history page size, queue tick interval, stale-dispatch threshold, default schedule time step, default indent per script type, **default offline policy and late-run anchoring for new schedules, and the Skip grace period** (default 2 minutes, server-wide, §3.6). Saved as a `settings` doc in the plugin DB. Per-user editor preferences (font size, wrap, tab vs spaces) go in localStorage. |

### 3.2 Device tab (this device only)

Single column, with sections as Bootstrap cards (not accordions) so everything is visible at a glance. The iframe resizes to its content with a `ResizeObserver`, so there's no fixed 700px height and no nested scrollbars.

Sections marked *(admin)* are hidden from users (§3.5).

1. **Header strip.** Online/offline badge, OS, and a note when offline: "Jobs will run when this device reconnects". *(admin)* **Open Script Library ↗** calls `parent.goPlugin('scripttask', 'ScriptTask')`.
2. **Run a script.** Searchable script picker (folder path shown as muted text, with type badge). Pinned/favourite scripts appear first. Scripts whose type can't run on this device's OS are listed but disabled, with the reason. Actions: **Run now** and **Schedule…** (inline form).
3. **Queue.** Pending jobs and schedules for this device, soonest first. Users can cancel their own pending jobs, and edit, pause or delete schedules they created. Other people's items are shown read-only. *(admin)* Act on any job or schedule, plus **Cancel all pending**.
4. **History.** All of this device's runs, whoever started them. Status badge (including *Missed*, §3.6), relative time (absolute on hover), duration, a one-line output preview, and click to open the Output viewer. **Run again** on any row the user is allowed to run.
5. *(admin)* **Variables (effective).** Every variable that applies to this device, showing which scope wins (global → script → group → device) and what was overridden. Device-scope variables can be edited here. Anything else links to the server page.

### 3.3 Shared components

- **Schedule form** (used in Library, Run/Batch, Device tab and Schedules → Edit). Recurrence as a segmented control (Once · Minutes · Hourly · Daily · Weekly). Native `datetime-local` inputs replace `tail.DateTime`. Weekday toggle buttons. End: Never / On date. **If the device is offline** and **If a run is late** controls (§3.6), pre-filled from Settings. A one-line summary under the form, e.g. "Every 2 weeks on Mon, Thu at 09:00, skipped if offline for more than 2h".
- **Script picker**: combobox with keyboard navigation and search over name and path.
- **Device picker**: filterable list with group/tag/OS facets, used by Run/Batch and variable targets.
- **Status badge**: one mapping used everywhere. Queued `secondary`, Waiting `warning`-outline, Dispatched/Running `info` + spinner, Completed `success`, Error `danger`, Cancelled `secondary`-outline, Missed `warning`.
- **Toasts** for action results. **Confirm modal** for destructive actions, listing what will be affected ("Cancel 14 pending jobs on 9 devices?").
- **Empty states** with a next step ("No scripts yet. Drop .ps1, .bat or .sh files here, or create one."). Skeleton loaders instead of blank tables.

### 3.4 Output viewer

Off-canvas panel (right side, wide), also openable as a full page.

- Header: script, device, run by, queued/dispatched/completed times, duration, status.
- Body: monospace, theme-aware, line numbers, wrap toggle, search. Reuse the read-only code editor (§5) so highlighting and search come for free.
- JSON output is detected and shown as a pretty view or collapsible tree, with a raw toggle. Error output (stderr) gets its own tab.
- Actions: Copy, Download `.txt`, Run again, Open script.
- For batch runs, a **Batch results** view: a device × status matrix, with **devices grouped by identical output** ("212 devices returned `OK`; 3 returned something else"). This turns a fleet-wide query script into a readable report. Export as CSV.

### 3.5 Roles and permissions

Two roles, built on MeshCentral's plugin permissions framework (≥1.1.58, so guaranteed by the 1.2.0 floor). Admins can grant or deny them per user group, device group or device from MeshCentral's own permissions dialog.

| Permission | Grants | Default |
|---|---|---|
| `manage` | Server page: library editing, batch runs, all schedules, variables, settings. Admin controls on the device tab. | Denied. Full site admins (`siteadmin == 0xFFFFFFFF`) always pass. |
| `run` | Device tab: run or schedule existing library scripts on that device. Cancel own pending jobs; edit, pause or delete own schedules. View the device's full queue, schedules and history, including output from runs other people started. | Allowed |

On top of the plugin permission, every device-targeted action also requires the MeshCentral device right that its own "Run Commands" feature checks (`MESHRIGHT_REMOTECOMMAND`, 0x20000), using `GetNodeWithRights`. A user who can't run commands on a device in MeshCentral can't run scripts on it here. Batch runs check this per target and report the devices that were refused.

Enforcement is on the server, in every RPC handler and in `handleAdminReq` (the server page returns 403 without `manage`). The client receives a `caps` object (`{ manage, run, remoteCommand }`) with the first response and uses it only to hide controls.

This also closes most of the authorisation gap noted under Later work. Secret variables and substitution escaping stay there.

### 3.6 Offline devices and late runs

A scheduled job can only run when its device is online. Two settings per schedule control what happens otherwise. Defaults for new schedules come from Settings.

**If the device is offline at the scheduled time**

| Option | Behaviour |
|---|---|
| **Run when it reconnects** | The job waits, however long. Several missed slots collapse into one run, so there's no backlog of catch-up runs. *This is today's behaviour.* |
| **Run if it reconnects within…** | Takes a window (e.g. 2 hours). If the device comes online inside the window, the job runs. If not, the job is recorded as **Missed** and the schedule moves on to its next slot. |
| **Skip** | Runs only if the device is online at the scheduled time. In practice this is a short window: the **Skip grace period**, a server-wide setting (default 2 minutes, not set per schedule) that covers the one-minute queue tick. It shares an implementation with the option above. Otherwise the job is recorded as **Missed**. |

Missed runs appear in History and on the Overview, so silently skipped work is visible.

**If a recurring run happens late**

| Option | Behaviour | Example: daily at 09:00, device online at 14:30 |
|---|---|---|
| **Keep the original schedule** | The next run is the next slot on the original grid. *This is today's behaviour.* | Runs 14:30 today, then 09:00 tomorrow |
| **Shift to the actual run time** | The next run is measured from when this run actually started. | Runs 14:30 today, then 14:30 tomorrow, and it stays there |

Recommendations:
- Default to **Keep the original schedule**. It's what people expect from "daily at 09:00", and it can't drift.
- **Shift** is offered for Minutes, Hourly and Daily. **Weekly with chosen weekdays always keeps the original schedule**, because "shift" has no clear meaning when the run days are fixed (does a Thursday run on Friday make the next one Tuesday or Wednesday?).
- One-time schedules only use the offline policy. Late-run anchoring doesn't apply.
- Manual **Run now** jobs always wait for the device to reconnect, and can be cancelled from the queue.

Implementation notes (data changes are in §6):
- Each job created from a schedule gets `expiresAt` (`dontQueueUntil + window`, or `null` for "run when it reconnects").
- The queue tick marks undispatched jobs past `expiresAt` as `status:'missed'`, then lets the schedule create its next job.
- For "shift", `determineNextJobTime` measures from the job's `dispatchTime` instead of the previous slot. For "keep", today's slot arithmetic is kept, but calculated in local wall-clock time so daylight-saving changes don't move 09:00 to 10:00 (see §7).

---

## 4. Front-end architecture

### Theme sync (`includes/st-theme.js`, loaded first in every view)

1. Find the host. If `window.parent !== window`, read `parent.document`. Otherwise (standalone tab, e.g. a pop-out Output viewer) use `localStorage.theme`, `localStorage.nightMode` and `prefers-color-scheme`, the same inputs MeshCentral uses.
2. Stylesheet. Copy the `href` of the parent's `#theme-stylesheet` into our own `<link id="theme-stylesheet">`. If the parent has none, it's Classic UI: show the "switch to Modern UI" notice.
3. Mode. Copy the parent's resolved `<html data-bs-theme>`. This already accounts for the user's setting, browser preference, server-forced modes and dark-base themes, so we never recalculate it.
4. Watch. A `MutationObserver` on the parent's `<html>` attributes and the `#theme-stylesheet` `href` re-applies changes live. Switching theme or mode in MeshCentral updates the open plugin pages with no reload.
5. Set `body { background: transparent }` in the device tab so it blends into the host card, and use `--bs-body-bg` on the server page.
6. Avoid a flash of the wrong theme: an inline `<head>` snippet sets `data-bs-theme` before first paint.

Plugin CSS (`includes/st.css`) only references `--bs-*` variables. One small layer of plugin tokens maps onto them (`--st-row-hover: var(--bs-tertiary-bg)` and so on).

### Rendering

**Preact + htm**, vendored (~5KB gz, MIT, no build step, tagged-template JSX). Text is escaped by default, which ends the `innerHTML` XSS class outright.

Shared modules in `includes/`:

- `st-rpc.js`: `rpc(action, args) → Promise` over `parent.meshserver.send`, with `reqId` correlation and a timeout. A **listener registry**, so several views can subscribe to the same event type, replaces the single `pluginHandler.scripttask.loadHistory` slot. Exports to the host page become one `onRpcResult` and one `onInvalidate` that fan out to registered listeners.
- `st-components.js`: StatusBadge, RelativeTime, ScriptPicker, DevicePicker, ScheduleForm, ConfirmModal, Toasts, OutputViewer, DataTable (sort, paging, multi-select, sticky header).
- `st-format.js`: recurrence → text, duration, relative time, byte size.

### Views and routes

`handleAdminReq` is reorganised so each page is its own template sharing one layout partial:

| Query | View |
|---|---|
| *(none)* (what `goPlugin` sends) | Server app shell (`views/server.handlebars`). 403 without `manage`. |
| `user=1` | Device tab (`views/device.handlebars`) |
| `user=1&output=<jobId>` | Standalone output page |
| `dl=<id>` / `include=1` | Unchanged (include path hardened, §7) |

`scriptedit`, `schedule` and `admin` are removed. `tail.DateTime` is removed from `includes/`.

---

## 5. Code editor

**Recommendation: CodeMirror 6**, vendored as one pre-built bundle (`includes/codemirror/st-editor.min.js`, ~300–400KB min, MIT).

| | CodeMirror 6 | Monaco |
|---|---|---|
| Size | ~350KB bundle | ~4MB+, plus web workers |
| Theming | CSS variables. Follows Bootswatch with no extra work | Its own theme API. Has to be mapped by hand on every switch |
| Languages | `@codemirror/legacy-modes`: shell, powershell. Batch: a ~40-line custom `StreamLanguage` | shell, powershell, bat built in |
| Mobile / a11y | Good | Weak on mobile |
| Diff view | `@codemirror/merge` | Built in |
| Offline / air-gapped servers | Vendored file | Vendored, but heavy |

Editor features for this pass:

- Syntax highlighting per type (`ps1`, `bat`, `bash`). Type is auto-detected on upload (shebang, extension) and can be changed in the toolbar.
- **Respects indentation.** Tab/Shift-Tab indent and outdent, auto-indent on Enter, and a configurable unit per type (defaults: PowerShell 4 spaces, Bash 2 spaces, Batch 4 spaces, or tabs). A status-bar indicator works like VS Code's ("Spaces: 4") and can be clicked to change. Existing files are detected from their content.
- Line numbers, active-line highlight, bracket matching, code folding, search/replace (Ctrl+F / Ctrl+H), multi-cursor.
- **Line endings.** The status bar shows LF/CRLF. Saving normalises (`bash` → LF, `bat`/`ps1` → CRLF). This replaces the split/join done today in `db.js`, which is also buggy (§7).
- **Variable awareness.** `#name#` tokens are highlighted. Hovering shows the value for each scope that defines it. An unknown variable gets a warning underline, because it would become `VAR_NOT_FOUND` at run time.
- Ctrl+S save, Ctrl+Enter "Run…", dirty indicator, "unsaved changes" guard.
- The same component in read-only mode powers the Output viewer.

Build: `tools/build-editor/` (package.json + esbuild, ~20 lines). Output is committed. Contributors only run it when bumping CodeMirror.

---

## 6. Server and data changes this UI needs

These stay in scope because the UI can't work without them.

1. **RPC endpoint.** `serveraction` handles `{pluginaction:'rpc', method, reqId, args}` and replies with `myparent.send({action:'plugin', plugin:'scripttask', method:'onRpcResult', reqId, ok, data|error})`. Existing actions move behind it.
2. **Targeted invalidations.** Replace the `['*','server-users']` payload broadcasts with `{pluginaction:'invalidate', scopes:{nodeIds, scriptIds, queue, schedules, library, variables}}`. These carry no data and are dispatched to targets limited by node or group rights where possible.
3. **New queries.** Server-wide queue (incomplete jobs, with filters). All schedules. History with server-side paging, sorting and filters (`skip/limit`, and NEMongo needs `.skip()`). Overview counts. Effective variables for a node.
4. **Queue editing.**
   - `cancelJobs(ids[])`: delete jobs where `completeTime == null`. If already dispatched, mark `status:'cancelled'` instead of deleting, so a late `jobComplete` from the agent is recorded but doesn't revive the job. Killing a running process on the agent is listed under Later work.
   - `runJobsNow(ids[])` sets `dontQueueUntil = now`.
   - `updateSchedule(id, patch)`, `pauseSchedule(id, bool)` (new `paused` field, skipped by `getSchedulesDueForJob`), `runScheduleNow(id)`.
5. **Batch identity.** `runScript` and `addScheduledJob` stamp a `batchId` on every job or schedule they create, so batch results can be grouped (§3.4).
6. **Explicit job status.** Store `status` (`queued|dispatched|complete|error|cancelled`) alongside the timestamps. Today it's derived in the browser with an order-dependent rule. Add a one-time migration using the existing, unused `dbVersion`.
7. **Settings document** (`type:'settings'`) read at startup and used by the queue timer, cleanup and history limits.
8. **Dispatch on connect** via `hook_agentCoreIsStable`, so "Waiting for device" turns into "Dispatched" seconds after a device comes online.
9. **Offline and late-run policies** (§3.6). Schedule fields `offlinePolicy` (`'wait'|'window'|'skip'`), `offlineWindow` (seconds) and `anchor` (`'slot'|'actual'`). Job field `expiresAt`. Settings field `skipGraceSeconds` (default 120). New job status `missed`. The queue tick expires jobs. `determineNextJobTime` is rewritten around local wall-clock dates, with unit tests, since it's the core of this behaviour. Existing schedules migrate to `wait` + `slot`, which is exactly today's behaviour.
10. **Permissions** (§3.5). `registerPermissions` at startup. A `requireCaps(user, nodeId?)` helper used by every handler. Device rights resolved through `GetNodeWithRights`.
11. **Indexes.** Add `type` and compound `{type, node}`, `{type, completeTime}`, `{type, scriptId}` on Mongo and NeDB. Every query filters on `type`, and none of the current indexes cover it.

---

## 7. Bugs found while reading (fix opportunistically when the code is touched)

| Where | Problem |
|---|---|
| `db.js:71` | `args.content = args.content = split('\r\n')…` calls an undefined `split`. Editing a bash script with `filetype` set would throw. `editScript` never sends `filetype`, so line endings are never normalised on edit. |
| `db.js:137–144` | `getSchedulesDueForJob` has two `$or` keys in one object literal. The `endAt` clause is silently dropped. (Also, the dropped clause was `$lte`, so it would have been wrong anyway.) |
| `scripttask.js:607` | The non-array branch of `addScheduledJob` uses undefined `test` and `sObj`, so it throws. |
| `scripttask.js:288–313` | Hourly and daily recurrence add fixed seconds (`interval * 86400`) to the previous slot. Across a daylight-saving change, "daily at 09:00" becomes 08:00 or 10:00 permanently. |
| `scripttask.js:351` | `console.log('testing date: ' …)` runs on every weekly-schedule evaluation, every minute. |
| `scripttask.js:468–499` | Folder rename: `doc.path.replace(doc.name, …)` replaces the *first* match (wrong if a parent folder shares the name). Every child item gets the *folder's* path, which flattens nested subfolders. Moves have the same flattening issue. |
| `scripttask.js:423` | Deleting a folder removes only direct children by exact path. Nested folders become orphans, and their schedules and jobs remain (`@TODO` in code). |
| `scripttask.js:209` | `procedit` view doesn't exist. |
| `scripttask.js:128` | History cleanup runs on a 1-in-100 random roll per minute. It should be deterministic (e.g. hourly). |
| `scripttask.js:66–119` | Jobs whose script was deleted throw on `script[0].content` every tick, forever. They should be marked as errored. |
| `config.json` | `homepage`, `configUrl`, `downloadUrl`, `changelogUrl` and `versionHistoryUrl` all still point at `ryanblenis/…`. Installs of this fork will "update" back to upstream. This needs repointing before the first release of the fork. |

---

## Later work

Not part of this pass. Listed so they can be scheduled.

### Security

The two biggest gaps are closed in this pass:
- *No authorisation in `serveraction`*: closed by §3.5.
- *History, output and variables broadcast to every user*: closed by §6.1–6.2.

Remaining:
- **Secret variables.** Add a "secret" flag: masked in the UI, never sent to the browser after save.
- **Variable substitution is unescaped** in the agent (`modules_meshcore/scripttask.js` `runScript`). A value containing quotes or `;` changes the script's meaning. At minimum, document it. Better, offer per-type quoting helpers (`#name:ps#`, `#name:sh#`).
- **Include passthrough** (`res.sendFile(__dirname + '/includes/' + path)`). Verify traversal handling, and switch to `sendFile(path, { root })` or a `hook_setupHttpHandlers` static route.
- `Content-disposition` filename isn't quoted or encoded.

### Execution and agent

- Per-script **timeout** and **cancel a running job** (the agent already tracks `runningJobPIDs`).
- Capture the **exit code** and separate stdout/stderr. Today any stderr output, or exit code 1, means "error", and other non-zero codes count as success.
- Output size cap and truncation marker. Optional streaming of partial output for long jobs.
- Temp file location. `.bat`/`.ps1` files are written to the agent's working directory. Use the OS temp dir with restrictive permissions.
- **Triggers.** Today a job runs when its device is *online* at the next queue tick. "On agent connect" (via `hook_agentCoreIsStable`) and "on user login" (agent-side session events) would be real trigger types, if that's the behaviour you're after.
- More interpreters: `sh`/`zsh`/`python`, and macOS PowerShell/`pwsh` detection.

### Library and workflow

- **Script versions with diff** (CodeMirror merge view) and restore.
- **Script parameters**: declare inputs that prompt at run time (typed, with defaults), separate from global variables.
- Import/export the library (zip/JSON). Optionally sync a folder from a Git repo.
- Descriptions, tags and OS compatibility metadata on scripts. The Run/Batch warnings would use them.
- Rerun only the failed devices in a batch. Notify on failure via MeshCentral's messaging (email, Telegram, etc.).

### Engineering

- Tests: unit tests for `determineNextJobTime` (weekly logic is hard to follow), NEMongo, and RPC handlers. A small headless smoke test that loads the views against a mock parent.
- Lint and format config (ESLint + Prettier, or matching the existing style).
- Remove dead code: `malix_*` stubs, commented-out debug blocks, `admin.handlebars`.
- Update the readme and screenshots. Bump the version, and add changelog entries per Keep a Changelog.

---

## 8. Proposed delivery order

Each step can ship on its own and keeps the plugin working.

1. ✅ **Foundation** (done). Theme sync, shared CSS, RPC + listener registry, vendored Preact/htm, routes. Permissions and server-side enforcement (§3.5). Fix the `config.json` URLs and set `meshCentralCompat: ">=1.2.0"`. *Visible result:* the existing device tab restyled and theme-aware, with admin-only controls hidden from users.
   Notes from building it:
   - MeshCentral constructs plugins before `registerPermissions` exists, so permissions are registered in `server_startup`. With nothing registered, `checkPluginPermission` allows everything, so ScriptTask falls back to its own defaults in that case (manage denied).
   - Interim: library editing, multi-device runs and variables are on the device tab for managers until the server page (step 4) exists.
   - Tested on MeshCentral 1.3.0 with Playwright (default, Flatly, Darkly, Solar, Vapor; light and dark; live switching; admin, run-only and no-rights users) and with `test/server.test.js`. The Linux agent binary crashes in the cloud test VM, so agent round trips are covered by the server tests, not end to end.
2. **Device tab rebuild.** Script picker with Run now and Schedule, editable queue (cancel), history + Output viewer, admin effective variables. Server: cancel/run-now/edit-schedule/pause, node-scoped queries.
3. **Scheduling engine.** Offline and late-run policies (§3.6), the `missed` status, a wall-clock rewrite of `determineNextJobTime` with unit tests, migration of existing schedules, dispatch on connect.
4. **Server page shell + Library + editor.** `hasAdminPanel: true`, CodeMirror bundle, tree, editor, script-scoped tabs.
5. **Queue, Schedules, History (server-wide).** Paged queries, filters, bulk actions. Schedules sorted by next run.
6. **Run/Batch + batch results.** Device picker, `batchId`, grouped results matrix.
7. **Variables + Settings + Overview.**
8. **Polish.** Keyboard shortcuts, empty states, readme and screenshots, version bump.

## Open questions

None outstanding. Answered so far:
- Users can schedule runs on their devices and see every past run on them, including other people's. They can change only their own pending jobs and schedules.
- Skip grace period defaults to 2 minutes and is a server-wide plugin setting.
