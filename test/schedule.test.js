/**
* @description Tests for schedule.js: run times in the schedule's own time zone, across daylight-saving changes.
* Run with: node --test test/*.test.js
* @author Desmond Duval
* @license Apache-2.0
*/

"use strict";

const test = require('node:test');
const assert = require('node:assert');
const S = require('../schedule.js');

const NY = 'America/New_York', LON = 'Europe/London';
// Epoch seconds for a wall-clock time in a zone, e.g. at(NY, '2026-10-30T09:00')
function at(tz, iso) {
    const [d, t] = iso.split('T'), [y, m, dd] = d.split('-').map(Number), [h, mi] = t.split(':').map(Number);
    return S.fromLocal(Math.floor(Date.UTC(y, m - 1, dd) / 86400000), h * 3600 + mi * 60, tz);
}
// Wall-clock text for an instant in a zone
function wall(tz, t) {
    return new Date(t * 1000).toLocaleString('sv-SE', { timeZone: tz, hourCycle: 'h23' }).slice(0, 16).replace(' ', 'T');
}
// The first n runs at or after t
function runs(s, t, n) {
    const out = [];
    for (let x = S.nextSlot(s, t); x != null && out.length < n; x = S.nextSlot(s, x + 1)) out.push(x);
    return out;
}

test('fromLocal and localParts round-trip, including both daylight-saving changes', function () {
    assert.strictEqual(wall(NY, at(NY, '2026-10-30T09:00')), '2026-10-30T09:00');
    assert.strictEqual(wall(NY, at(NY, '2026-11-01T01:30')), '2026-11-01T01:30'); // ambiguous hour (fall back)
    assert.strictEqual(wall(NY, at(NY, '2027-03-14T02:30')), '2027-03-14T03:30'); // skipped hour (spring forward) lands after the gap
    assert.strictEqual(S.weekday(Math.floor(Date.UTC(2026, 9, 22) / 86400000)), 4); // 22 Oct 2026 is a Thursday
});

test('daily runs keep their wall-clock time across daylight-saving changes', function () {
    const s = { recur: 'daily', interval: 1, startAt: at(NY, '2026-10-30T09:00'), timezone: NY };
    assert.deepStrictEqual(runs(s, s.startAt, 4).map(x => wall(NY, x)), ['2026-10-30T09:00', '2026-10-31T09:00', '2026-11-01T09:00', '2026-11-02T09:00']);
    const spring = { recur: 'daily', interval: 2, startAt: at(LON, '2027-03-26T08:15'), timezone: LON };
    assert.deepStrictEqual(runs(spring, spring.startAt, 3).map(x => wall(LON, x)), ['2027-03-26T08:15', '2027-03-28T08:15', '2027-03-30T08:15']);
});

test('the next run after a late time keeps the original grid', function () {
    const s = { recur: 'daily', interval: 1, startAt: at(NY, '2026-10-01T09:00'), timezone: NY };
    // Device came back at 14:30 on 20 Oct: the next slot is 21 Oct 09:00, not a catch-up run
    assert.strictEqual(wall(NY, S.nextSlot(s, at(NY, '2026-10-20T14:30'))), '2026-10-21T09:00');
    // Shifting to the actual run time moves the grid to 14:30
    const shifted = Object.assign({}, s, { anchor: 'actual', anchorAt: at(NY, '2026-10-20T14:30') });
    assert.strictEqual(wall(NY, S.nextSlot(shifted, at(NY, '2026-10-20T14:30') + 1)), '2026-10-21T14:30');
});

test('minutes and hours are fixed durations', function () {
    const s = { recur: 'minutes', interval: 15, startAt: 1000000 };
    assert.strictEqual(S.nextSlot(s, 1000000), 1000000);
    assert.strictEqual(S.nextSlot(s, 1000001), 1000900);
    assert.strictEqual(S.nextSlot(s, 1000000 + 86400 * 400), 1000000 + 86400 * 400); // a year later, still on the grid, no loop
    const h = { recur: 'hourly', interval: 2, startAt: at(NY, '2026-10-31T23:00'), timezone: NY };
    assert.deepStrictEqual(runs(h, h.startAt, 3).map(x => x - h.startAt), [0, 7200, 14400]);
});

test('weekly runs on chosen days, every N weeks', function () {
    // Thursday 22 Oct 2026, every 2 weeks on Tue and Thu at 18:40
    const s = { recur: 'weekly', interval: 2, daysOfWeek: ['2', '4'], startAt: at(NY, '2026-10-22T18:40'), timezone: NY };
    assert.deepStrictEqual(runs(s, s.startAt, 5).map(x => wall(NY, x)),
        ['2026-10-22T18:40', '2026-11-03T18:40', '2026-11-05T18:40', '2026-11-17T18:40', '2026-11-19T18:40']);
    // A schedule whose last run was months ago gets its next run in the future, not a catch-up
    assert.strictEqual(wall(NY, S.nextSlot(s, at(NY, '2027-02-01T00:00'))), '2027-02-09T18:40');
    assert.strictEqual(S.nextSlot(Object.assign({}, s, { daysOfWeek: [] }), s.startAt), null);
});

test('once and end times', function () {
    assert.strictEqual(S.nextSlot({ recur: 'once', startAt: 500 }, 400), 500);
    assert.strictEqual(S.nextSlot({ recur: 'once', startAt: 500 }, 501), null);
    assert.strictEqual(S.nextSlot({ recur: 'minutes', interval: 1, startAt: 0, endAt: 120 }, 121), null);
    assert.strictEqual(S.nextSlot({ recur: 'minutes', interval: 1, startAt: 0, endAt: 120 }, 61), 120);
});

test('offline policies set when a job expires', function () {
    assert.strictEqual(S.expiresAt({ offlinePolicy: 'wait' }, 1000, 120), null);
    assert.strictEqual(S.expiresAt({}, 1000, 120), null);
    assert.strictEqual(S.expiresAt({ offlinePolicy: 'skip' }, 1000, 120), 1120);
    assert.strictEqual(S.expiresAt({ offlinePolicy: 'window', offlineWindow: 7200 }, 1000, 120), 8200);
});

test('unknown time zones fall back to the server zone', function () {
    assert.strictEqual(S.isValidZone('Not/AZone'), false);
    assert.strictEqual(S.isValidZone(NY), true);
    const s = { recur: 'daily', interval: 1, startAt: 86400 * 100, timezone: 'Not/AZone' };
    assert.ok(S.nextSlot(s, s.startAt + 1) > s.startAt);
});
