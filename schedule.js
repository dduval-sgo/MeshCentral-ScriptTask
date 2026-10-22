/**
* @description ScriptTask schedule maths: when a schedule's runs fall, in the schedule's own time zone.
* Pure functions (no database or MeshCentral access) so they can be tested on their own.
* @license Apache-2.0
*/

"use strict";

const DAY = 86400;
const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const formatters = {};

// A valid IANA time zone name, or the server's own zone
function zone(tz) {
    if (typeof tz != 'string' || tz.length == 0 || tz.length > 64) return SERVER_TZ;
    if (formatters[tz] === undefined) {
        try {
            formatters[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
        } catch (e) { formatters[tz] = null; }
    }
    return (formatters[tz] == null) ? SERVER_TZ : tz;
}
zone(SERVER_TZ);
function isValidZone(tz) { return typeof tz == 'string' && zone(tz) === tz; }

// Wall-clock parts of an instant (epoch seconds) in a time zone. day is a day number: days since 1970-01-01 on that calendar.
function localParts(t, tz) {
    tz = zone(tz);
    var p = {};
    formatters[tz].formatToParts(new Date(t * 1000)).forEach(function (x) { if (x.type != 'literal') p[x.type] = Number(x.value); });
    var day = Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 1000 / DAY);
    return { day: day, seconds: p.hour * 3600 + p.minute * 60 + p.second };
}

// The instant at which a time zone's wall clock shows the given day and time of day.
// For a time skipped by a daylight-saving change, this lands just after the gap.
function fromLocal(day, seconds, tz) {
    var guess = day * DAY + seconds;
    var wallAt = function (t) { var p = localParts(t, tz); return p.day * DAY + p.seconds; };
    var o1 = wallAt(guess) - guess, t1 = guess - o1;
    var o2 = wallAt(t1) - t1;
    if (o2 == o1) return t1;
    var t2 = guess - o2;
    if (wallAt(t2) == guess) return t2;
    if (wallAt(t1) == guess) return t1;
    return Math.max(t1, t2); // The wall-clock time doesn't exist (clocks went forward): use the moment after the gap
}

// Day of the week for a day number: 0 = Sunday
function weekday(day) { return ((day % 7) + 11) % 7; } // 1970-01-01 was a Thursday (4)

// The first run of schedule s at or after time t (epoch seconds), or null if there are no more.
// Uses s.anchorAt (the actual time of the last run) instead of s.startAt as the base when the schedule shifts to late runs.
function nextSlot(s, t) {
    var start = s.startAt, base = (s.anchorAt != null && s.anchor == 'actual') ? s.anchorAt : start;
    var interval = Math.max(1, Math.floor(Number(s.interval) || 1));
    var from = Math.max(t, start);
    var slot = null;
    switch (s.recur) {
        case 'once':
            slot = (start >= t) ? start : null;
            break;
        case 'minutes':
        case 'hourly': {
            var step = interval * ((s.recur == 'minutes') ? 60 : 3600);
            slot = (from <= base) ? base : base + Math.ceil((from - base) / step) * step;
            break;
        }
        case 'daily': {
            var b = localParts(base, s.timezone), f = localParts(from, s.timezone);
            var k = Math.max(0, Math.ceil((f.day - b.day) / interval));
            slot = fromLocal(b.day + k * interval, b.seconds, s.timezone);
            if (slot < from) slot = fromLocal(b.day + (k + 1) * interval, b.seconds, s.timezone);
            break;
        }
        case 'weekly': {
            var days = (s.daysOfWeek || []).map(Number);
            if (days.length == 0) return null;
            var b2 = localParts(base, s.timezone), f2 = localParts(from, s.timezone);
            var baseWeek = b2.day - weekday(b2.day);
            for (var d = Math.max(b2.day, f2.day - 1); d <= Math.max(b2.day, f2.day) + 7 * (interval + 1); d++) {
                if (days.indexOf(weekday(d)) === -1) continue;
                if (((d - weekday(d) - baseWeek) / 7) % interval != 0) continue;
                var c = fromLocal(d, b2.seconds, s.timezone);
                if (c >= from) { slot = c; break; }
            }
            break;
        }
    }
    if (slot != null && s.endAt != null && slot > s.endAt) return null;
    return slot;
}

// When a job for a slot stops being worth running, per the schedule's offline policy (null = never)
function expiresAt(s, slot, skipGraceSeconds) {
    switch (s.offlinePolicy) {
        case 'skip': return slot + skipGraceSeconds;
        case 'window': return slot + Math.max(60, Number(s.offlineWindow) || 3600);
        default: return null;
    }
}

module.exports = { nextSlot: nextSlot, expiresAt: expiresAt, localParts: localParts, fromLocal: fromLocal, weekday: weekday, isValidZone: isValidZone, SERVER_TZ: SERVER_TZ };
