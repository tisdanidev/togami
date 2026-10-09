// Windows integration lives behind this file. In the browser build everything
// is simulated so the app can be tested; the Windows build (Tauri) replaces
// these with native calls:
//   blocker  -> watch the foreground window, minimise/close blocked apps,
//               browser extension or window-title check for sites
//   media    -> Windows media session API (Spotify, browsers, etc.)
//   window   -> always-on-top compact mode, tray, start with Windows

export const isNative = Boolean(globalThis.__TAURI__);

// ---------- blocker ----------

const blockerListeners = new Set();

export const blocker = {
  /** Called by the app whenever the blocklist or session state changes. */
  sync(_state) {
    // native: push the current lists to the background watcher
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

// ---------- media ----------

const SAMPLE = [
  { title: 'Weightless', artist: 'Marconi Union', source: 'Spotify', durationMs: 488_000 },
  { title: 'Clair de Lune', artist: 'Claude Debussy', source: 'Spotify', durationMs: 302_000 },
  { title: 'lofi hip hop radio', artist: 'Lofi Girl', source: 'Edge', durationMs: 0 },
  { title: 'Experience', artist: 'Ludovico Einaudi', source: 'Spotify', durationMs: 315_000 },
];

const mediaListeners = new Set();
let track = 0;
let playing = true;
let position = 92_000;
let enabled = true;
let lastTick = Date.now();

function current() {
  if (!enabled) return null;
  return { ...SAMPLE[track], playing, positionMs: position, sample: !isNative };
}

function emit() {
  const t = current();
  for (const fn of mediaListeners) fn(t);
}

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
  emit();
}, 1000);

export const media = {
  subscribe(fn) {
    mediaListeners.add(fn);
    fn(current());
    return () => mediaListeners.delete(fn);
  },
  toggle() {
    playing = !playing;
    emit();
  },
  next() {
    track = (track + 1) % SAMPLE.length;
    position = 0;
    playing = true;
    emit();
  },
  previous() {
    if (position > 4000) position = 0;
    else track = (track - 1 + SAMPLE.length) % SAMPLE.length;
    position = 0;
    emit();
  },
  /** Test bench: switch the sample player on or off. */
  setEnabled(on) {
    enabled = on;
    emit();
  },
  isEnabled: () => enabled,
};
