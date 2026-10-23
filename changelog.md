# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Known Issues]
- None. Please feel free to submit an issue via [GitHub](https://github.com/dduval-sgo/MeshCentral-ScriptTask/issues) if you find anything.

## [0.1.1] - 2026-10-23
### Fixed
- Installing, reinstalling or upgrading the plugin without restarting MeshCentral could keep the previous version's code running, because MeshCentral's module cache isn't cleared. ScriptTask now compares its version with the one on disk and loads the new files itself.
- A copy of the plugin that has been replaced (by a reload, reinstall or upgrade), disabled or removed stops checking the queue, so two copies never send the same runs.

### Changed
- Readme: restart MeshCentral after installing, upgrading or removing the plugin.

## [0.1.0] - 2026-10-23
### Changed
- Redesigned for MeshCentral's Modern UI, with Bootstrap and Preact. Pages follow MeshCentral's theme and light/dark mode, including live switching. Classic UI is no longer supported.
- Device tab in a single column: run a script, the device's queue and schedules, its history, and for ScriptTask managers the variables that apply to it.
- The scheduler opens as a dialog instead of a popup window, and uses the browser's date and time inputs.
- Pages talk to the server through targeted request/reply messages. Changes are announced with small notices, sent only to users who can see the affected device, instead of broadcasting history, output and variable values.
- Requires MeshCentral 1.2.0 or later. Update URLs point to this fork.

### Added
- Plugin permissions: "Manage ScriptTask" (library, variables, multi-device runs; denied by default) and "Run scripts" (allowed by default). Running on a device also needs its Remote Commands right.
- Cancel individual pending runs. Users can cancel their own runs and delete their own schedules; managers can act on any.
- Output viewer with formatted JSON, line wrap, copy and download.
- Device tab: searchable script picker with per-user favourites. Scripts that can't run on the device's OS are listed but can't be chosen, with the reason shown.
- Run again from any history row.
- Long queues and schedule lists show the first 10 rows, with Show more.
- Per-schedule handling of offline devices: run when it reconnects (as before), run only if it reconnects within a set time, or skip. Runs that don't happen are recorded as Missed.
- Per-schedule handling of late runs (minutes, hourly and daily schedules): keep the original times, or shift to when the run actually happened.
- Edit and pause/resume schedules. Users can change schedules they created; managers can change any.
- Settings for managers: the Skip grace period (default 2 minutes, server-wide) and defaults for new schedules.
- Due runs start within seconds of a device connecting, instead of at the next minute's queue check.
- ScriptTask page for managers (My Server > Plugins > ScriptTask, or Open ScriptTask on a device tab): the script library with a folder tree, and for each script an editor plus its schedules, history and variables across all devices. Plugin settings moved here.
- Code editor (CodeMirror 6, bundled): line numbers, PowerShell, Bash and Batch highlighting, search and replace, Tab indenting, and #variables# highlighted, with their values on hover and unknown ones underlined. Line endings (CRLF or LF) are kept, or can be changed; Bash is always saved with LF.
- Code themes chosen per user, independent of the MeshCentral theme: Darcula, Dracula, Eclipse, GitHub Light/Dark, Monokai, Nord, One Dark, Solarized Light/Dark, Tokyo Night and VS Code Light/Dark. Auto picks GitHub Light or Darcula to match light or dark mode. Script output is shown in the same read-only code view.
- Queue, Schedules and History sections on the ScriptTask page, covering every device the manager can see. Filters for script, device group, device, status, source and who ran it (History also searches output and filters by date). Filters are kept in the page address. Lists are paged, and refresh by themselves when runs change.
- Bulk actions: cancel or run now for queued runs; pause, resume or delete schedules. A schedule's Run now runs the script once without changing the schedule.
- Runs sent to a device more than 30 minutes ago without a result are flagged "No result yet".
- Run section on the ScriptTask page: choose a script and devices (search, device group, tag, OS, online/offline, or selected only), then run now or schedule. Devices that can't run the script's type are listed but can't be selected. Selections can be saved as named device sets, per manager.
- Batches: a run or schedule on several devices is grouped as a batch, optionally named. The batch page shows progress, groups devices by identical output, lists each device's result, exports CSV, and runs again on the devices that failed, missed or didn't run. Scheduled batches are shown one run at a time.
- Queue, Schedules and History link each row to its batch, and can be filtered to one batch.
- Overview, the ScriptTask page's new landing section: counts of queued, waiting and running runs, errors, missed and completed runs in the last 24 hours, and active schedules, each opening the matching list. Needs attention lists runs with no result yet and recent errors and missed runs; Up next lists schedules' next runs; recent batches show their progress.
- Variables section: all variables in one table, with search, a scope filter, where each is used, and a warning for names scripts use that aren't defined. New variables can target any script, device group or device from a list.
- Secret variables: hidden in lists and in the editor until revealed. Scripts still receive the value.
- Settings for how long history is kept (default 90 days) and when a run is flagged "No result yet" (default 30 minutes).
- Settings for how often the queue checks for due runs (default 60 seconds), rows per page on the ScriptTask page, the start-time step for new schedules, and the indentation for scripts that don't have any yet.
- Keyboard shortcuts on the ScriptTask page (press ? to list them), and / to focus the script picker on the device tab.
- Readme rewritten, with screenshots.
- Server tests (`node --test test/*.test.js`).

### Fixed
- On MongoDB, runs and schedules now store their script and schedule as text ids, so filtering by script and looking up a schedule's runs work. Runs made by older versions are still found.
- A new schedule's default start time could be only seconds away, and already past when saved. It is now always at least a minute ahead.
- Schedules are calculated in the time zone they were created in, so "daily at 09:00" stays at 09:00 across daylight-saving changes.
- A device that was offline no longer gets a burst of catch-up runs for a weekly schedule, and a schedule's end time is honoured.
- Script names, variable values and script output are no longer inserted into the page as HTML.
- Renaming or moving a folder no longer flattens its subfolders. Deleting a folder removes everything below it, with their schedules.
- Agents can only report results for their own jobs.
- Managers only see variables for device groups and devices they can see in MeshCentral.
- Deleting a script also deletes its script variables.
- Jobs whose script was deleted are closed instead of retried every minute.
- Editing a Bash script no longer fails on line-ending normalisation.
- NeDB queries no longer inherit a previous query's sort and limit (a list could silently stop at 200 items).

### Removed
- tail.DateTime dependency.
- Library editing on the device tab (it is on the ScriptTask page now). Managers keep the variables that apply to the device, and "Run on several devices…" opens the Run section with the device chosen.

## [0.0.20] - 2025-01-08
### Fixed
- Merge PR fixing MeshCentral 1.1.35+ compatibility

## [0.0.19] - 2024-02-07
### Fixed
- Merge PR fixing scroll bars and Powershell execution policy

## [0.0.18] - 2022-03-12
### Fixed
- Compatibility with MeshCentral => 0.9.98 (promise requirement removed from MeshCentral, nedb moved to @yetzt/nedb)

## [0.0.17] - 2021-10-07
### Fixed
- Compatibility with MeshCentral > 0.9.7

## [0.0.16] - 2021-05-18
### Fixed
- Drag/drop scripts between folders

## [0.0.15] - 2020-03-07
### Fixed
- Prevent race condition with conflicting plugins changing the app views directory by using absolute paths

## [0.0.14] - 2020-02-28
### Added
- Add new script from ScriptTask plugin without dragging/uploading an existing script
- Variables introduced. Supports global, script, mesh, and node level. Overridden in that order.

## [0.0.13] - 2020-02-15
### Fixed
- Folder rename function now working as intended
- Removed ability to "edit" folders as if they were a script

## [0.0.12] - 2020-02-14
### Fixed
- Rename function broke when filetype tags were added

## [0.0.11] - 2020-01-24
### Added
- Advanced selection of nodes based on mesh and tag membership

## [0.0.10] - 2020-01-02
### Fixed
- Removed logging to MeshCentral events DB for each script run / refresh event (causing events file to grow quickly and crash NeDB instances)

## [0.0.9] - 2019-12-24
### Fixed
- Native Powershell scripts now run correctly on more versions of Linux/MacOS

## [0.0.8] - 2019-12-23
### Fixed
- Force strip carriage returns from bash scripts

## [0.0.7] - 2019-12-23
### Fixed
- Some versions of Linux don't default the agents root to the MeshAgent's directory. Added path detection for a safe temp zone. Thanks /u/Reverent for the assist in debugging that one!

## [0.0.6] - 2019-12-23
### Added
- Status return of a script as success/failure if the script does not produce output
- Endpoint debugging toggle via console (plugin scripttask debug)
### Fixed
- Made some endpoint calls a little safer with try/catch to stop errors from killing the process

## [0.0.5] - 2019-12-22
### Added
- NeDB support
### Fixed
- CSS call looking for mapping file removed
- Date/time select on schedule screen might not have had the correct mimetype, thus not appeared in some instances

## [0.0.4] - 2019-12-22
### Added
- Script type identifier to the script tree view
### Fixed
- Prevent catch-up jobs from running every minute on long running schedules when a node is offline for a period of time.
- Check for scheduled jobs 1 minute in the future to prevent schedules running 1 minute behind intended time.

## [0.0.3] - 2019-12-20
### Fixed
- Typo causing installs to think Mongo is not in use

## [0.0.2] - 2019-12-20
### Added
- Suppressed errors and made a nice error message for those without MongoDB (currently unsupported)

## [0.0.1] - 2019-12-20
### Added
- Released initial version
