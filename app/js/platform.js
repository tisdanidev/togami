// Windows integration lives behind this file. In the desktop app (Tauri) these
// call the native code in src-tauri/; in the browser test build everything is
// simulated so the app can be tried without Windows.
//   blocker  -> native thread watches the foreground window, closes blocked
//               apps, minimises browsers showing blocked sites
//   media    -> Windows media controls (Spotify, browsers and other players)
//   window   -> F11 full screen

const T = globalThis.__TAURI__;
export const isNative = Boolean(T);

// ---------- blocker ----------

const blockerListeners = new Set();
let lastSync = '';

export const blocker = {
  /** Push the current lists to the native watcher. `config` = { active, apps, sites }. */
  sync(config) {
    if (!isNative) return;
    const key = JSON.stringify(config);
    if (key === lastSync) return;
    lastSync = key;
    T.core.invoke('blocker_sync', { config }).catch(() => {
      lastSync = '';
    });
  },
  /** Register a handler for "user tried to open something". */
  onAttempt(fn) {
    blockerListeners.add(fn);
    return () => blockerListeners.delete(fn);
  },
  /** Test bench: pretend the user opened an app or site. */
  simulate(target, kind) {
    for (const fn of blockerListeners) fn({ target, kind });
  },
};

if (isNative) {
  T.event.listen('blocked-attempt', (e) => {
    for (const fn of blockerListeners) fn(e.payload);
  });
}

// ---------- window ----------

export const appWindow = {
  /** F11: full screen on or off. Never switched on automatically. */
  async toggleFullscreen() {
    try {
      if (isNative) {
        const w = T.window.getCurrentWindow();
        await w.setFullscreen(!(await w.isFullscreen()));
        return;
      }
      if (document.fullscreenElement) await document.exitFullscreen?.();
      else await document.documentElement.requestFullscreen?.();
    } catch {
      // not allowed here (e.g. inside an embedded preview)
    }
  },
};

// ---------- media ----------

const mediaListeners = new Set();
let current = null;

function emit() {
  for (const fn of mediaListeners) fn(current);
}

let control;
const testHooks = {}; // browser build only

if (isNative) {
  const poll = async () => {
    try {
      const t = await T.core.invoke('media_now');
      current = t ? { ...t, sample: false } : null;
    } catch {
      current = null;
    }
    emit();
  };
  poll();
  setInterval(poll, 1000);
  control = (action) => T.core.invoke('media_control', { action }).then(() => setTimeout(poll, 250)).catch(() => {});
} else {
  // sample player for the browser build
  const SAMPLE = [
    { title: 'Weightless', artist: 'Marconi Union', source: 'Spotify', durationMs: 488_000 },
    { title: 'Clair de Lune', artist: 'Claude Debussy', source: 'Spotify', durationMs: 302_000 },
    { title: 'lofi hip hop radio', artist: 'Lofi Girl', source: 'Edge', durationMs: 0 },
    { title: 'Experience', artist: 'Ludovico Einaudi', source: 'Spotify', durationMs: 315_000 },
  ];
  let track = 0;
  let playing = true;
  let position = 92_000;
  let enabled = true;
  let lastTick = Date.now();
  const snapshot = () => {
    current = enabled ? { ...SAMPLE[track], playing, positionMs: position, sample: true } : null;
    emit();
  };
  setInterval(() => {
    const nowReal = Date.now();
    if (enabled && playing) {
      position += nowReal - lastTick;
      const d = SAMPLE[track].durationMs;
      if (d && position >= d) {
        track = (track + 1) % SAMPLE.length;
        position = 0;
      }
    }
    lastTick = nowReal;
    snapshot();
  }, 1000);
  control = (action) => {
    if (action === 'toggle') playing = !playing;
    if (action === 'next') {
      track = (track + 1) % SAMPLE.length;
      position = 0;
      playing = true;
    }
    if (action === 'previous') {
      if (position <= 4000) track = (track - 1 + SAMPLE.length) % SAMPLE.length;
      position = 0;
    }
    snapshot();
  };
  testHooks.setEnabled = (on) => {
    enabled = on;
    snapshot();
  };
  testHooks.isEnabled = () => enabled;
  snapshot();
}

export const media = {
  subscribe(fn) {
    mediaListeners.add(fn);
    fn(current);
    return () => mediaListeners.delete(fn);
  },
  toggle: () => control('toggle'),
  next: () => control('next'),
  previous: () => control('previous'),
  /** Test bench only: switch the sample player on or off. */
  setEnabled: (on) => testHooks.setEnabled?.(on),
  isEnabled: () => testHooks.isEnabled?.() ?? true,
};
