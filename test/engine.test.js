import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../app/js/engine.js';

const MIN = E.MIN;
// A Wednesday at 10:00 local time, so weekly counts start from a known Monday.
const T0 = new Date(2026, 9, 7, 10, 0, 0).getTime();

function fresh(profile = { focusMin: 25, breakMin: 5, longBreakMin: 15, cycles: 2 }) {
  const s = E.defaultState();
  Object.assign(s.profiles[0], profile);
  return s;
}

test('plan alternates focus and break, long break last, debt on first focus', () => {
  const plan = E.buildPlan({ focusMin: 25, breakMin: 5, longBreakMin: 15, cycles: 3 }, 10 * MIN);
  assert.deepEqual(plan.map((p) => [p.kind, p.ms / MIN]), [
    ['focus', 35], ['break', 5], ['focus', 25], ['break', 5], ['focus', 25], ['long', 15],
  ]);
});

test('phases advance with the clock and the session completes', () => {
  const s = fresh();
  E.start(s, { intention: 'Essay' }, T0);
  assert.equal(E.sessionView(s, T0 + 10 * MIN).remaining, 15 * MIN);
  const ev = E.tick(s, T0 + 26 * MIN);
  assert.equal(ev[0].type, 'phase');
  assert.equal(E.sessionView(s, T0 + 26 * MIN).phase.kind, 'break');
  const done = E.tick(s, T0 + 80 * MIN);
  assert.ok(done.some((e) => e.type === 'complete'));
  assert.equal(s.session, null);
  assert.equal(s.streak, 1);
  assert.equal(s.ledger.at(-1).focusMs, 50 * MIN);
});

test('blocking is on during focus and off during breaks by default', () => {
  const s = fresh();
  E.start(s, {}, T0);
  assert.equal(E.isBlocked(s, 'youtube.com', T0 + MIN), true);
  assert.equal(E.isBlocked(s, 'm.youtube.com', T0 + MIN), true);
  assert.equal(E.isBlocked(s, 'Task Manager', T0 + MIN), false);
  assert.equal(E.isBlocked(s, 'docs.google.com', T0 + MIN), false);
  E.tick(s, T0 + 26 * MIN);
  assert.equal(E.isBlocked(s, 'youtube.com', T0 + 26 * MIN), false);
  s.settings.blockBreaks = true;
  assert.equal(E.isBlocked(s, 'youtube.com', T0 + 26 * MIN), true);
});

test('pause waits two minutes with blocking still on, then freezes the timer', () => {
  const s = fresh();
  E.start(s, {}, T0);
  E.requestPause(s, T0 + 5 * MIN);
  E.tick(s, T0 + 6 * MIN);
  assert.equal(E.sessionView(s, T0 + 6 * MIN).pause, 'pending');
  assert.equal(E.isBlocked(s, 'youtube.com', T0 + 6 * MIN), true);
  E.tick(s, T0 + 7 * MIN);
  const v = E.sessionView(s, T0 + 7 * MIN);
  assert.equal(v.pause, 'paused');
  assert.equal(E.isBlocked(s, 'youtube.com', T0 + 7 * MIN), false);
  // timer frozen at 7 minutes in
  assert.equal(E.sessionView(s, T0 + 9 * MIN).remaining, 18 * MIN);
  E.resume(s, T0 + 9 * MIN);
  assert.equal(E.sessionView(s, T0 + 10 * MIN).remaining, 17 * MIN);
  assert.equal(E.isBlocked(s, 'youtube.com', T0 + 10 * MIN), true);
});

test('cancelling a pending pause keeps the session running', () => {
  const s = fresh();
  E.start(s, {}, T0);
  E.requestPause(s, T0 + MIN);
  E.cancelPause(s);
  E.tick(s, T0 + 5 * MIN);
  assert.equal(E.sessionView(s, T0 + 5 * MIN).pause, 'none');
});

test('a pause ends on its own after ten minutes', () => {
  const s = fresh();
  E.start(s, {}, T0);
  E.requestPause(s, T0);
  const ev = E.tick(s, T0 + 30 * MIN);
  assert.ok(ev.some((e) => e.type === 'paused'));
  assert.ok(ev.some((e) => e.type === 'resumed' && e.auto));
  // paused from 2 to 12 minutes, so at 30 minutes, 20 minutes of focus have run
  assert.equal(E.sessionView(s, T0 + 30 * MIN).remaining, 5 * MIN);
});

test('pausing is refused during breaks and in the last two minutes', () => {
  const s = fresh();
  E.start(s, {}, T0);
  assert.equal(E.requestPause(s, T0 + 24 * MIN)[0].type, 'error');
  E.tick(s, T0 + 26 * MIN);
  assert.equal(E.requestPause(s, T0 + 26 * MIN)[0].type, 'error');
});

test('quitting escalates the lockout through the week and adds debt', () => {
  const s = fresh();
  const lock = [];
  let t = T0;
  for (let i = 0; i < 4; i++) {
    E.start(s, {}, t);
    E.quit(s, { reason: 'test' }, t + 5 * MIN);
    lock.push(s.lockout.until - (t + 5 * MIN));
    t = s.lockout.until + MIN;
    E.tick(s, t);
    s.debtMs = 0;
  }
  assert.deepEqual(lock.map((m) => m / MIN), [10, 25, 45, 45]);
  assert.equal(s.streak, 0);
});

test('debt is the skipped focus time, capped, and lands on the next session', () => {
  const s = fresh();
  E.start(s, {}, T0);
  E.quit(s, {}, T0 + 5 * MIN); // 20 left in this block + 25 in the next
  assert.equal(s.debtMs, 45 * MIN);
  E.tick(s, T0 + 20 * MIN);
  E.start(s, {}, T0 + 20 * MIN);
  assert.equal(s.session.plan[0].ms, 70 * MIN);
  assert.equal(s.debtMs, 0);
  E.quit(s, {}, T0 + 21 * MIN);
  assert.equal(s.debtMs, E.RULES.debtCapMs);
});

test('lockout blocks starting and keeps blocking on', () => {
  const s = fresh();
  E.start(s, {}, T0);
  E.quit(s, {}, T0 + MIN);
  assert.equal(E.isBlocked(s, 'youtube.com', T0 + 5 * MIN), true);
  assert.equal(E.isLocked(s, T0 + 5 * MIN), true);
  assert.equal(E.start(s, {}, T0 + 5 * MIN)[0].type, 'error');
  E.tick(s, T0 + 12 * MIN);
  assert.equal(E.isLocked(s, T0 + 12 * MIN), false);
});

test('a pardon cancels lockout and debt but the quit stays in the ledger', () => {
  const s = fresh();
  s.pardons = 1;
  s.streak = 4;
  E.start(s, {}, T0);
  E.quit(s, { usePardon: true }, T0 + MIN);
  assert.equal(s.lockout, null);
  assert.equal(s.debtMs, 0);
  assert.equal(s.pardons, 0);
  assert.equal(s.streak, 4);
  assert.equal(s.ledger.at(-1).pardoned, true);
  // pardoned quits don't escalate the next one
  assert.equal(E.quitCost(s, T0 + 2 * MIN).lockoutMs, 10 * MIN);
});

test('every fifth completed session earns a pardon, up to three', () => {
  const s = fresh({ focusMin: 1, breakMin: 1, longBreakMin: 0, cycles: 1 });
  let t = T0;
  const earned = [];
  for (let i = 0; i < 20; i++) {
    E.start(s, {}, t);
    t += 2 * MIN;
    if (E.tick(s, t).some((e) => e.type === 'pardonEarned')) earned.push(i + 1);
  }
  assert.deepEqual(earned, [5, 10, 15]);
  assert.equal(s.pardons, 3);
});

test('emergency unlock ends everything once a week without a penalty', () => {
  const s = fresh();
  E.start(s, {}, T0);
  E.emergency(s, T0 + MIN);
  assert.equal(s.session, null);
  assert.equal(s.lockout, null);
  assert.equal(s.debtMs, 0);
  E.start(s, {}, T0 + 2 * MIN);
  assert.equal(E.emergency(s, T0 + 3 * MIN)[0].type, 'error');
  // next Monday it is back
  const monday = new Date(2026, 9, 12, 9).getTime();
  assert.equal(E.emergencyAvailable(s, monday), true);
});

test('closing the app mid-session counts as a forced quit', () => {
  const s = fresh();
  E.start(s, {}, T0);
  assert.deepEqual(E.checkClosedGap(s, 1000, 1000 + 30_000, T0 + MIN), []);
  const ev = E.checkClosedGap(s, 1000, 1000 + 5 * MIN, T0 + 5 * MIN);
  assert.equal(ev[0].entry.forced, true);
  assert.ok(s.lockout);
});

test('week stats count focus time, quits and distractions', () => {
  const s = fresh();
  E.start(s, {}, T0);
  E.recordAttempt(s, 'Discord', T0 + MIN);
  E.recordAttempt(s, 'Discord', T0 + 2 * MIN);
  E.recordAttempt(s, 'youtube.com', T0 + 3 * MIN);
  E.tick(s, T0 + 80 * MIN);
  const w = E.weekStats(s, T0 + 81 * MIN);
  assert.equal(w.completed, 1);
  assert.equal(w.focusMs, 50 * MIN);
  assert.deepEqual(w.distractions[0], { target: 'Discord', count: 2 });
  assert.equal(w.days[2], 50 * MIN); // Wednesday
});

test('custom session type is always present and last after loading old state', () => {
  const old = E.defaultState();
  old.profiles = old.profiles.filter((p) => !p.custom);
  old.profileId = 'gone';
  const s = E.normalizeState(old);
  assert.equal(s.profiles.at(-1).id, 'custom');
  assert.equal(s.profiles.filter((p) => p.custom).length, 1);
  assert.equal(s.profileId, 'essay');
  assert.equal(s.settings.sidebar, true);
});

test('timer fields are clamped to their limits', () => {
  assert.equal(E.clampField('focusMin', 500, 25), 180);
  assert.equal(E.clampField('focusMin', 'abc', 25), 25);
  assert.equal(E.clampField('longBreakMin', -3, 10), 0);
  assert.equal(E.clampField('cycles', 2.6, 1), 3);
});
