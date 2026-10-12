// Saves app state on this device. The Windows build swaps this for a file in
// the app data folder; the shape stays the same.

import { normalizeState } from './engine.js';

const KEY = 'togami.state.v1';
const SEEN = 'togami.lastSeen';

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.version === 1) return normalizeState(s);
    }
  } catch {
    // storage blocked or corrupt: start fresh
  }
  return null;
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // nothing to do; the session still runs in memory
  }
}

/** Real wall-clock time the app was last running (for the closed-app rule). */
export function lastSeen() {
  try {
    return Number(localStorage.getItem(SEEN)) || 0;
  } catch {
    return 0;
  }
}

export function markSeen(realNow) {
  try {
    localStorage.setItem(SEEN, String(realNow));
  } catch {
    // ignore
  }
}

export function wipe() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(SEEN);
    localStorage.removeItem('togami.clock');
  } catch {
    // ignore
  }
}
