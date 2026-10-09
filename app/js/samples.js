// Example history shown on first run so the Ledger isn't empty. Every entry is
// flagged `sample` (labelled "Example" in the UI, excluded from penalties) and
// can be cleared from the Ledger or Settings.

import { MIN } from './engine.js';

const H = 60 * MIN;
const D = 24 * H;

export function seedSamples(state, now) {
  const day = (n, h, m = 0) => {
    const d = new Date(now - n * D);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const rows = [
    { n: 6, h: 16, type: 'complete', p: 'revision', i: 'Chemistry flashcards, unit 3', f: 100, outcome: 'yes' },
    { n: 5, h: 19, type: 'complete', p: 'essay', i: 'History essay outline', f: 150, outcome: 'partly' },
    { n: 4, h: 20, type: 'quit', p: 'essay', i: 'History essay intro', f: 22, planned: 150, reason: 'Friends were on Discord', lockout: 10, debt: 60 },
    { n: 3, h: 17, type: 'complete', p: 'essay', i: 'History essay intro, second try', f: 150, outcome: 'yes' },
    { n: 2, h: 15, type: 'complete', p: 'deep', i: 'Maths past paper 2023', f: 180, outcome: 'yes' },
    { n: 1, h: 18, type: 'quit', p: 'revision', i: 'Spanish vocab', f: 40, planned: 100, reason: 'Dinner', pardoned: true },
    { n: 1, h: 20, type: 'complete', p: 'revision', i: 'Spanish vocab', f: 100, outcome: 'yes' },
  ];
  for (const r of rows) {
    const at = day(r.n, r.h);
    const e = {
      id: state.nextId++,
      type: r.type,
      at,
      startedAt: at - (r.f + 30) * MIN,
      profileId: r.p,
      intention: r.i,
      focusMs: r.f * MIN,
      plannedFocusMs: (r.planned ?? r.f) * MIN,
      pauses: 0,
      sample: true,
    };
    if (r.type === 'complete') e.outcome = r.outcome;
    if (r.type === 'quit') Object.assign(e, { reason: r.reason, pardoned: Boolean(r.pardoned), lockoutMs: (r.lockout ?? 0) * MIN, debtMs: (r.debt ?? 0) * MIN, forced: false });
    state.ledger.push(e);
  }
  const tries = [['Discord', 9], ['youtube.com', 6], ['reddit.com', 3], ['Steam', 2], ['tiktok.com', 1]];
  for (const [target, count] of tries) {
    for (let k = 0; k < count; k++) state.attempts.push({ at: now - ((k * 7 + target.length) % 6) * D - 3 * H, target, sample: true });
  }
}

export function clearSamples(state) {
  state.ledger = state.ledger.filter((e) => !e.sample);
  state.attempts = state.attempts.filter((a) => !a.sample);
}

export function hasSamples(state) {
  return state.ledger.some((e) => e.sample) || state.attempts.some((a) => a.sample);
}
