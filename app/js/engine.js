// Session rules: timer phases, pausing, quitting and its penalties, the ledger.
// Pure logic on a plain state object. Every function takes `now` (ms) so the
// rules can be tested and the clock can be sped up in the test build.

export const MIN = 60_000;

export const RULES = {
  pauseWaitMs: 2 * MIN, // blocking keeps running this long after Pause is pressed
  pauseMaxMs: 10 * MIN, // a pause ends on its own after this
  lockoutMs: [10 * MIN, 25 * MIN, 45 * MIN], // 1st, 2nd, 3rd+ quit in a week
  debtCapMs: 60 * MIN,
  pardonEvery: 5, // completed sessions per pardon
  pardonMax: 3,
  closedGapMs: 60_000, // app gone this long during a session counts as a quit
};

export const ALWAYS_ALLOWED = ['Windows', 'Settings', 'Task Manager', 'Togami'];

export function defaultState() {
  return {
    version: 1,
    profiles: [
      profile('essay', 'Essay', 50, 10, 20, 3, ['Discord', 'Steam'], ['youtube.com', 'reddit.com', 'tiktok.com', 'instagram.com']),
      profile('revision', 'Revision', 25, 5, 15, 4, ['Discord', 'Steam', 'Epic Games'], ['youtube.com', 'reddit.com', 'tiktok.com', 'instagram.com', 'x.com', 'twitch.tv']),
      profile('deep', 'Deep work', 90, 20, 20, 2, ['Discord', 'Steam', 'Epic Games', 'WhatsApp'], ['youtube.com', 'reddit.com', 'tiktok.com', 'instagram.com', 'x.com', 'twitch.tv', 'netflix.com']),
    ],
    profileId: 'essay',
    allowlist: ['docs.google.com', 'Calculator'],
    settings: { voice: 'neutral', theme: 'system', blockBreaks: false },
    session: null,
    lockout: null, // { until, ledgerId }
    debtMs: 0,
    pardons: 0,
    completedTowardPardon: 0,
    streak: 0,
    emergencyUsedAt: null,
    ledger: [],
    attempts: [], // { at, target }
    nextId: 1,
  };
}

function profile(id, name, focus, brk, long, cycles, apps, sites) {
  return { id, name, focusMin: focus, breakMin: brk, longBreakMin: long, cycles, apps, sites };
}

// ---------- time helpers ----------

/** Monday 00:00 local time of the week containing `now`. */
export function weekStart(now) {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d.getTime();
}

export function getProfile(state, id = state.profileId) {
  return state.profiles.find((p) => p.id === id) ?? state.profiles[0];
}

/** Focus, break, focus, break ... long break replaces the last break. */
export function buildPlan(p, debtMs = 0) {
  const plan = [];
  for (let i = 0; i < p.cycles; i++) {
    plan.push({ kind: 'focus', ms: p.focusMin * MIN + (i === 0 ? debtMs : 0) });
    if (i < p.cycles - 1) plan.push({ kind: 'break', ms: p.breakMin * MIN });
  }
  if (p.longBreakMin > 0 && p.cycles > 1) plan.push({ kind: 'long', ms: p.longBreakMin * MIN });
  return plan;
}

// ---------- derived state ----------

export function isLocked(state, now) {
  return Boolean(state.session) || lockoutActive(state, now);
}

export function lockoutActive(state, now) {
  return Boolean(state.lockout && state.lockout.until > now);
}

/** Where the session is right now. */
export function sessionView(state, now) {
  const s = state.session;
  if (!s) return null;
  const phase = s.plan[s.phaseIndex];
  const pausedFor = s.pausedAt ? now - s.pausedAt : 0;
  const elapsed = Math.max(0, now - s.phaseStartedAt - s.phasePausedMs - pausedFor);
  const remaining = Math.max(0, phase.ms - elapsed);
  const focusTotal = s.plan.filter((p) => p.kind === 'focus').length;
  const focusIndex = s.plan.slice(0, s.phaseIndex + 1).filter((p) => p.kind === 'focus').length;
  let pause = 'none';
  if (s.pausedAt) pause = 'paused';
  else if (s.pauseRequestedAt) pause = 'pending';
  return {
    phase,
    phaseIndex: s.phaseIndex,
    elapsed,
    remaining,
    focusIndex,
    focusTotal,
    pause,
    pauseStartsIn: s.pauseRequestedAt ? Math.max(0, s.pauseRequestedAt + RULES.pauseWaitMs - now) : 0,
    pauseEndsIn: s.pausedAt ? Math.max(0, s.pausedAt + RULES.pauseMaxMs - now) : 0,
    sessionRemaining: remaining + s.plan.slice(s.phaseIndex + 1).reduce((a, p) => a + p.ms, 0),
  };
}

/** Whether blocking is on, and why. */
export function blocking(state, now) {
  if (lockoutActive(state, now)) return { on: true, why: 'lockout', profile: getProfile(state, state.lockout.profileId) };
  const v = sessionView(state, now);
  if (!v) return { on: false };
  if (v.pause === 'paused') return { on: false, why: 'paused' };
  if (v.phase.kind !== 'focus' && !state.settings.blockBreaks) return { on: false, why: 'break' };
  return { on: true, why: 'session', profile: getProfile(state, state.session.profileId) };
}

/** Is `target` (an app name or a site) blocked right now? */
export function isBlocked(state, target, now) {
  const b = blocking(state, now);
  if (!b.on) return false;
  const t = target.toLowerCase();
  if ([...ALWAYS_ALLOWED, ...state.allowlist].some((a) => a.toLowerCase() === t)) return false;
  return [...b.profile.apps, ...b.profile.sites].some((x) => {
    const x2 = x.toLowerCase();
    return x2 === t || t.endsWith('.' + x2);
  });
}

function countsTowardEscalation(e, since) {
  return e.type === 'quit' && !e.pardoned && !e.sample && e.at >= since;
}

export function quitsThisWeek(state, now) {
  const since = weekStart(now);
  return state.ledger.filter((e) => countsTowardEscalation(e, since)).length;
}

/** Remaining focus time in the session: what quitting now would skip. */
function skippedFocusMs(state, now) {
  const v = sessionView(state, now);
  if (!v) return 0;
  const s = state.session;
  let ms = v.phase.kind === 'focus' ? v.remaining : 0;
  for (const p of s.plan.slice(s.phaseIndex + 1)) if (p.kind === 'focus') ms += p.ms;
  return ms;
}

/** What quitting right now would cost. */
export function quitCost(state, now) {
  const n = quitsThisWeek(state, now);
  const lockoutMs = RULES.lockoutMs[Math.min(n, RULES.lockoutMs.length - 1)];
  const debtMs = Math.min(RULES.debtCapMs - state.debtMs, skippedFocusMs(state, now));
  return { quitNumber: n + 1, lockoutMs, debtMs: Math.max(0, debtMs), pardons: state.pardons, streak: state.streak };
}

export function emergencyAvailable(state, now) {
  return !state.emergencyUsedAt || state.emergencyUsedAt < weekStart(now);
}

// ---------- actions ----------
// Each returns a list of events for the UI ({ type, ... }).

export function start(state, { intention = '', profileId = state.profileId } = {}, now) {
  if (state.session) return [{ type: 'error', message: 'A session is already running.' }];
  if (lockoutActive(state, now)) return [{ type: 'error', message: 'Blocks are locked. Wait for the lockout to end.' }];
  const p = getProfile(state, profileId);
  const debt = state.debtMs;
  state.session = {
    id: state.nextId++,
    profileId: p.id,
    intention: intention.trim(),
    startedAt: now,
    plan: buildPlan(p, debt),
    debtIncluded: debt,
    phaseIndex: 0,
    phaseStartedAt: now,
    phasePausedMs: 0,
    pauseRequestedAt: null,
    pausedAt: null,
    pauses: 0,
  };
  state.debtMs = 0;
  return [{ type: 'started', debtMs: debt }];
}

/** Advance the clock: phases, pending pauses, auto-resume, lockout end. */
export function tick(state, now) {
  const events = [];
  if (state.lockout && state.lockout.until <= now) {
    state.lockout = null;
    events.push({ type: 'lockoutEnded' });
  }
  const s = state.session;
  if (!s) return events;

  for (let guard = 0; guard < 100; guard++) {
    // a requested pause takes effect after the wait, if still in the same focus phase
    if (s.pauseRequestedAt && !s.pausedAt) {
      const at = s.pauseRequestedAt + RULES.pauseWaitMs;
      const phaseEnd = s.phaseStartedAt + s.phasePausedMs + s.plan[s.phaseIndex].ms;
      if (at < phaseEnd && at <= now) {
        s.pausedAt = at;
        s.pauseRequestedAt = null;
        s.pauses++;
        events.push({ type: 'paused' });
      }
    }
    // a pause ends on its own after the limit
    if (s.pausedAt) {
      const end = s.pausedAt + RULES.pauseMaxMs;
      if (end > now) break;
      s.phasePausedMs += RULES.pauseMaxMs;
      s.pausedAt = null;
      events.push({ type: 'resumed', auto: true });
    }
    const phase = s.plan[s.phaseIndex];
    const phaseEnd = s.phaseStartedAt + s.phasePausedMs + phase.ms;
    if (phaseEnd > now) break;
    // phase over
    s.pauseRequestedAt = null;
    if (s.phaseIndex === s.plan.length - 1) {
      events.push(...finish(state, phaseEnd));
      return events;
    }
    s.phaseIndex++;
    s.phaseStartedAt = phaseEnd;
    s.phasePausedMs = 0;
    events.push({ type: 'phase', kind: s.plan[s.phaseIndex].kind });
  }
  return events;
}

function finish(state, at) {
  const s = state.session;
  const focusMs = s.plan.filter((p) => p.kind === 'focus').reduce((a, p) => a + p.ms, 0);
  const entry = {
    id: s.id,
    type: 'complete',
    at,
    startedAt: s.startedAt,
    profileId: s.profileId,
    intention: s.intention,
    focusMs,
    plannedFocusMs: focusMs,
    pauses: s.pauses,
    outcome: null,
  };
  state.ledger.push(entry);
  state.session = null;
  state.streak++;
  state.completedTowardPardon++;
  const events = [{ type: 'complete', entry }];
  if (state.completedTowardPardon >= RULES.pardonEvery) {
    state.completedTowardPardon = 0;
    if (state.pardons < RULES.pardonMax) {
      state.pardons++;
      events.push({ type: 'pardonEarned', pardons: state.pardons });
    }
  }
  return events;
}

/** Record how the finished session went (the "did you finish?" question). */
export function setOutcome(state, id, outcome) {
  const e = state.ledger.find((x) => x.id === id && x.type === 'complete');
  if (e) e.outcome = outcome;
}

export function requestPause(state, now) {
  const s = state.session;
  const v = sessionView(state, now);
  if (!s || v.pause !== 'none') return [];
  if (v.phase.kind !== 'focus') return [{ type: 'error', message: 'You can only pause during focus time.' }];
  if (v.remaining <= RULES.pauseWaitMs) return [{ type: 'error', message: 'Less than 2 minutes left. Finish this block first.' }];
  s.pauseRequestedAt = now;
  return [{ type: 'pauseRequested' }];
}

export function cancelPause(state) {
  if (state.session) state.session.pauseRequestedAt = null;
  return [{ type: 'pauseCancelled' }];
}

export function resume(state, now) {
  const s = state.session;
  if (!s || !s.pausedAt) return [];
  s.phasePausedMs += now - s.pausedAt;
  s.pausedAt = null;
  return [{ type: 'resumed', auto: false }];
}

/** Quit the session. Applies the lockout and debt unless a pardon is spent. */
export function quit(state, { reason = '', usePardon = false, forced = false } = {}, now) {
  const s = state.session;
  if (!s) return [];
  const cost = quitCost(state, now);
  const v = sessionView(state, now);
  const planned = s.plan.filter((p) => p.kind === 'focus').reduce((a, p) => a + p.ms, 0);
  const pardoned = usePardon && state.pardons > 0;
  const entry = {
    id: s.id,
    type: 'quit',
    at: now,
    startedAt: s.startedAt,
    profileId: s.profileId,
    intention: s.intention,
    focusMs: Math.max(0, planned - skippedFocusMs(state, now)),
    plannedFocusMs: planned,
    pauses: s.pauses,
    reason: reason.trim(),
    forced,
    pardoned,
    lockoutMs: pardoned ? 0 : cost.lockoutMs,
    debtMs: pardoned ? 0 : cost.debtMs,
    phase: v.phase.kind,
  };
  state.ledger.push(entry);
  state.session = null;
  if (pardoned) {
    state.pardons--;
  } else {
    state.streak = 0;
    state.debtMs += cost.debtMs;
    state.lockout = { until: now + cost.lockoutMs, ledgerId: entry.id, profileId: s.profileId };
  }
  return [{ type: 'quit', entry }];
}

/** Once a week: end the session and any lockout now, no penalty. */
export function emergency(state, now) {
  if (!emergencyAvailable(state, now)) return [{ type: 'error', message: 'Emergency unlock is used for this week. It comes back on Monday.' }];
  if (!state.session && !lockoutActive(state, now)) return [];
  const s = state.session;
  state.ledger.push({
    id: s ? s.id : state.nextId++,
    type: 'emergency',
    at: now,
    startedAt: s ? s.startedAt : now,
    profileId: s ? s.profileId : state.lockout.profileId,
    intention: s ? s.intention : '',
    focusMs: s ? Math.max(0, s.plan.filter((p) => p.kind === 'focus').reduce((a, p) => a + p.ms, 0) - skippedFocusMs(state, now)) : 0,
  });
  state.session = null;
  state.lockout = null;
  state.emergencyUsedAt = now;
  return [{ type: 'emergency' }];
}

export function recordAttempt(state, target, now) {
  state.attempts.push({ at: now, target });
  if (state.attempts.length > 2000) state.attempts.splice(0, state.attempts.length - 2000);
}

/** The app was closed during a session: treat it as a quit. */
export function checkClosedGap(state, lastSeenReal, nowReal, now) {
  if (!state.session || !lastSeenReal) return [];
  if (nowReal - lastSeenReal < RULES.closedGapMs) return [];
  return quit(state, { reason: 'Togami was closed during the session', forced: true }, now);
}

// ---------- stats ----------

export function weekStats(state, now) {
  const since = weekStart(now);
  const entries = state.ledger.filter((e) => e.at >= since);
  const focusMs = entries.reduce((a, e) => a + (e.focusMs || 0), 0);
  const completed = entries.filter((e) => e.type === 'complete').length;
  const quits = entries.filter((e) => e.type === 'quit').length;
  const byTarget = new Map();
  for (const a of state.attempts) if (a.at >= since) byTarget.set(a.target, (byTarget.get(a.target) || 0) + 1);
  const distractions = [...byTarget].map(([target, count]) => ({ target, count })).sort((a, b) => b.count - a.count);
  // focus minutes per day, Monday first
  const days = Array.from({ length: 7 }, () => 0);
  for (const e of entries) {
    const d = Math.floor((e.at - since) / (24 * 60 * MIN));
    if (d >= 0 && d < 7) days[d] += e.focusMs || 0;
  }
  return { focusMs, completed, quits, distractions, days };
}
