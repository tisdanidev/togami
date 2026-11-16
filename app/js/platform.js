// Windows, macOS and Android integration lives behind this file. In the apps
// (Tauri) these call the native code in src-tauri/; in the browser test build
// everything is simulated so the app can be tried without either.
//
// Android has a single window: the pet and the Ask chat run in frames inside
// it, and use the main page's Tauri bridge (parent.__TAURI__).
//   blocker  -> native thread watches the app in front, closes blocked apps,
//               closes browser tabs on blocked sites (Chrome, Edge, Firefox;
//               Safari, Brave and Arc on macOS)
//               Android: an Accessibility service reports the app in front
//   media    -> Windows media controls (Spotify, browsers and other players),
//               Spotify and Music on macOS, media sessions on Android
//   window   -> F11 (⌃⌘F on macOS) full screen
//   notify / updater -> notifications, self-update from GitHub releases
//   access   -> macOS: the Accessibility permission the blocker needs for sites
//   pet      -> the desktop pet window (pet.html), from an imported pet pack
//   ai       -> Groq requests (the key stays in native code), the Ask window
//               (chat.html) and screen snips (snip.html / macOS screencapture)

/** The main page's bridge, in a frame inside it (Android's pet and chat). */
const parentTauri = (() => {
  try {
    return globalThis.parent && globalThis.parent !== globalThis ? globalThis.parent.__TAURI__ : undefined;
  } catch {
    return undefined; // not the same origin
  }
})();
const T = parentTauri || globalThis.__TAURI__;
export const isNative = Boolean(T);
/** Running in a frame of the Android app (the pet or the Ask chat). */
export const isFramed = Boolean(parentTauri);
/** The Android app: one window, touch, no full screen key. */
export const isAndroid = isNative && /Android/i.test(globalThis.navigator?.userAgent || '');
/** The pet and the chat have windows of their own (desktop app). */
const ownWindows = isNative && !isAndroid;
/** "Togami Dev": the test build (tauri.dev.conf.json opens index.html?flavor=dev). */
export const isDev = isNative && new URLSearchParams(location.search).get('flavor') === 'dev';
/** Running on a Mac (the macOS app, or the browser build opened on a Mac). */
export const isMac = /Mac/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');

/** Words that differ between Windows and macOS. */
export const OS = isAndroid
  ? { name: 'Android', fullscreen: '', tray: 'background', notifications: 'Notifications', builtIn: ['Phone', 'Settings', 'Home screen', 'Keyboard', 'Togami'] }
  : isMac
    ? { name: 'macOS', fullscreen: '⌃⌘F', tray: 'menu bar', notifications: 'Notifications', builtIn: ['Finder', 'System Settings', 'Activity Monitor', 'Togami'] }
    : { name: 'Windows', fullscreen: 'F11', tray: 'tray', notifications: 'Windows notifications', builtIn: ['Windows', 'Settings', 'Task Manager', 'Togami'] };

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
  /** Togami Dev: what the native watcher last saw in front ({ exe, title, url, target }). */
  seen: () => (isNative ? T.core.invoke('blocker_seen').catch(() => null) : Promise.resolve(null)),
  /** Test bench: pretend the user opened an app or site. */
  simulate(target, kind) {
    for (const fn of blockerListeners) fn({ target, kind });
  },
};

if (isNative && !isFramed) {
  T.event.listen('blocked-attempt', (e) => {
    for (const fn of blockerListeners) fn(e.payload);
  });
}

// ---------- window ----------

export const appWindow = {
  /** F11 (⌃⌘F on macOS): full screen on or off. Never switched on automatically. */
  /** Android: the colour behind the status and navigation bars. */
  bars(color, dark) {
    if (isAndroid && !isFramed) T.core.invoke('system_bars', { color, dark }).catch(() => {});
  },
  async toggleFullscreen() {
    if (isAndroid) return;
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

// ---------- notifications ----------

/** A system notification (desktop app) or a browser notification if allowed. */
export function notify(title, body) {
  if (isNative) {
    T.core.invoke('notify', { title, body }).catch(() => {});
    return;
  }
  try {
    if (globalThis.Notification?.permission === 'granted') new Notification(title, { body });
  } catch {
    // not allowed here
  }
}

// ---------- updates ----------

export const updater = {
  available: isNative && !isDev && !isFramed, // the dev build never updates itself
  /** Android: the update is a new APK that Togami downloads and hands to Android's installer. */
  apk: isAndroid,
  version: () => (isNative ? T.core.invoke('app_version') : Promise.resolve('')),
  /** Resolves to { version, notes } when a newer release exists, else null. */
  check: () => T.core.invoke('update_check'),
  /** Desktop: downloads, installs and restarts Togami.
   *  Android: starts the download and install; resolves false when Android first
   *  needs "Install unknown apps" for Togami (its settings page opens). */
  install: () => T.core.invoke('update_install'),
  /** Android: { phase: idle|downloading|installing|confirm|error, done, total, error, allowed }. */
  progress: () => T.core.invoke('update_progress'),
};

// ---------- desktop pet ----------

// Desktop app: pet.html runs in its own transparent, always-on-top window.
// Browser build: it runs in an iframe in the corner of the page, and the pack
// comes from the gitignored packs/current folder on the dev server.
// Android: an iframe too, with the installed pack (pet.js reads it through
// this page's bridge), scaled to fit the phone. Touch has no hover, so the
// page lays tap targets over the pet's hit rectangles and passes taps and
// long-presses on to it.
const petActs = new Set();
let petFrame = null;
let petRects = [];
let petScale = 1;
let petTaps = null;

function browserPetFrame() {
  if (petFrame) return petFrame;
  petFrame = document.createElement('iframe');
  petFrame.src = 'pet.html';
  petFrame.title = 'Desktop pet';
  petFrame.className = 'pet-frame';
  petFrame.setAttribute('allowtransparency', 'true');
  document.body.append(petFrame);
  // the pack sets the window size (pet.json "window")
  const manifest = isAndroid ? T.core.invoke('pet_pack').then((p) => p.manifest) : fetch('packs/current/pet.json').then((r) => r.json());
  manifest
    .then(({ window: w }) => {
      const width = w?.width || 560;
      const height = w?.height || 340;
      petFrame.style.width = width + 'px';
      petFrame.style.height = height + 'px';
      if (isAndroid) fitPet(width);
    })
    .catch(() => {});
  addEventListener('message', (e) => {
    if (e.source !== petFrame.contentWindow) return;
    if (e.data?.type === 'pet-hit') {
      petRects = e.data.rects;
      placeTaps();
    }
    if (e.data?.type === 'pet-leave' && !isAndroid) petFrame.style.pointerEvents = 'none';
    if (e.data?.type === 'pet-act') for (const fn of petActs) fn(e.data);
  });
  if (isAndroid) {
    petTaps = document.createElement('div');
    petTaps.className = 'pet-taps';
    document.body.append(petTaps);
    wireTouchPet();
    return petFrame;
  }
  // the iframe only takes the pointer while it is over the pet
  addEventListener('pointermove', (e) => {
    const f = petFrame.getBoundingClientRect();
    const x = e.clientX - f.left;
    const y = e.clientY - f.top;
    const over = !petFrame.hidden && petRects.some(([l, t, w, h]) => x >= l && y >= t && x < l + w && y < t + h);
    if (over) petFrame.style.pointerEvents = 'auto';
  });
  return petFrame;
}

/** Android: the pack's window is sized for a desktop; shrink it to fit the phone. */
function fitPet(width) {
  const fit = () => {
    petScale = Math.min(1, (innerWidth * 0.9) / width);
    petFrame.style.transform = petScale < 1 ? `scale(${petScale})` : '';
    placeTaps();
  };
  fit();
  addEventListener('resize', fit);
}

/** Android: tap targets over the pet's hit rectangles. */
function placeTaps() {
  if (!petTaps) return;
  const f = petFrame.getBoundingClientRect();
  petTaps.hidden = petFrame.hidden;
  petTaps.replaceChildren(
    ...petRects.map(([l, t, w, h]) => {
      const d = document.createElement('div');
      Object.assign(d.style, { left: f.left + l * petScale + 'px', top: f.top + t * petScale + 'px', width: w * petScale + 'px', height: h * petScale + 'px' });
      return d;
    }),
  );
}

/** Android: a tap pokes (or presses the badge, menu or speech box), a long-press opens the menu. */
function wireTouchPet() {
  const at = (e) => {
    const f = petFrame.getBoundingClientRect();
    return { x: (e.clientX - f.left) / petScale, y: (e.clientY - f.top) / petScale };
  };
  const post = (type, e) => petFrame.contentWindow?.postMessage({ type, ...(e ? at(e) : {}) }, '*');
  let press = null;
  petTaps.addEventListener('pointerdown', (e) => {
    const p = { long: false };
    p.timer = setTimeout(() => {
      p.long = true;
      post('touch-menu', e);
    }, 480);
    press = p;
  });
  const end = (e) => {
    if (!press) return;
    clearTimeout(press.timer);
    if (!press.long && e.type === 'pointerup') post('touch-tap', e);
    press = null;
  };
  petTaps.addEventListener('pointerup', end);
  petTaps.addEventListener('pointercancel', end);
  petTaps.addEventListener('contextmenu', (e) => e.preventDefault());
  // a tap anywhere else closes the pet's menu
  addEventListener(
    'pointerdown',
    (e) => {
      if (!petTaps.contains(e.target)) post('touch-outside');
    },
    true,
  );
  addEventListener('resize', placeTaps);
}

export const pet = {
  /** Packs can be imported in the desktop app only. */
  canImport: isNative,
  /** Name of the installed pet pack, or null. */
  async packName() {
    if (isNative) return T.core.invoke('pet_has_pack').catch(() => null);
    try {
      const r = await fetch('packs/current/pet.json');
      return r.ok ? (await r.json()).name || 'Pet' : null;
    } catch {
      return null;
    }
  },
  show() {
    if (!ownWindows) {
      browserPetFrame().hidden = false;
      placeTaps();
      return Promise.resolve();
    }
    let pos = null;
    try {
      pos = JSON.parse(localStorage.getItem('togami.pet.pos'));
    } catch {}
    return T.core.invoke('pet_show', { pos: Array.isArray(pos) ? pos : null });
  },
  hide() {
    if (!ownWindows) {
      if (petFrame) petFrame.hidden = true;
      placeTaps();
      return;
    }
    T.core.invoke('pet_hide').catch(() => {});
  },
  /** The session as the pet shows it (timer badge, Start menu). Sent every second. */
  state(s) {
    if (ownWindows) T.event.emitTo('pet', 'pet-state', s).catch(() => {});
    else petFrame?.contentWindow?.postMessage({ type: 'state', state: s }, '*');
  },
  /** Tell the pet something happened; it picks its own line. */
  say(moment, vars = {}) {
    if (ownWindows) T.event.emitTo('pet', 'pet-say', { moment, vars }).catch(() => {});
    else petFrame?.contentWindow?.postMessage({ type: 'say', moment, vars }, '*');
  },
  /** Have the pet say this exact text (the Ask chat's replies). */
  line(text) {
    if (ownWindows) T.event.emitTo('pet', 'pet-line', { text }).catch(() => {});
    else (petFrame || (isFramed ? parent : opener)?.document?.querySelector('.pet-frame'))?.contentWindow?.postMessage({ type: 'line', text }, '*');
  },
  /** { name, personality } from the installed pack, or null. */
  async persona() {
    if (isNative) return T.core.invoke('pet_persona').catch(() => null);
    try {
      const r = await fetch('packs/current/pet.json');
      if (!r.ok) return null;
      const m = await r.json();
      return { name: m.name || 'Pet', personality: m.personality || null };
    } catch {
      return null;
    }
  },
  /** Install a pet pack from a .zip File. Resolves to the pack's name. */
  async import(file) {
    return T.core.invoke('pet_import', new Uint8Array(await file.arrayBuffer()));
  },
  remove: () => T.core.invoke('pet_remove'),
  /** Menu choices made on the pet: { act: 'hide' } or { act: 'start', id }. */
  onAct(fn) {
    petActs.add(fn);
  },
};

if (ownWindows) {
  T.event.listen('pet-act', (e) => {
    for (const fn of petActs) fn(e.payload);
  });
}

// ---------- Accessibility (macOS app) ----------

// Reading tab titles and closing tabs needs Accessibility on macOS. Blocking apps,
// and reading addresses in Safari and Chromium browsers, works without it.
// On Android all blocking needs Togami's Accessibility service, and now
// playing needs notification access.
export const access = {
  needed: isNative && !isFramed && (isMac || isAndroid),
  /** true or false on macOS and Android, null elsewhere. */
  granted: () => (isNative ? T.core.invoke('access_status').catch(() => null) : Promise.resolve(null)),
  /** Asks macOS, or opens its Accessibility settings. */
  request: () => isNative && T.core.invoke('access_request').catch(() => {}),
  /** Android: notification access, for now playing. */
  media: {
    needed: isAndroid && !isFramed,
    granted: () => (isAndroid ? T.core.invoke('listener_status').catch(() => null) : Promise.resolve(null)),
    request: () => isAndroid && T.core.invoke('listener_request').catch(() => {}),
  },
  /** Android: Togami's App info, where "Allow restricted settings" is. */
  appInfo: () => isAndroid && T.core.invoke('app_info').catch(() => {}),
};

// ---------- AI help (Groq) ----------

// The desktop app sends requests from native code, which keeps the key; the
// browser build answers with samples and needs no key.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SAMPLE_PLAN = {
  intention: 'History essay draft',
  focusMin: 45,
  breakMin: 10,
  cycles: 3,
  longBreakMin: 20,
  blockSites: ['netflix.com', 'discord.com'],
  blockApps: ['Spotify'],
  why: 'Sample plan (browser build): longer blocks suit essay writing, with a proper break at the end.',
};

export const ai = {
  /** Real replies from Groq (desktop app), or samples (browser build). */
  real: isNative,
  /** Screen snips need the desktop app. */
  canSnip: ownWindows,
  /** Android: a screenshot or photo is attached from the gallery instead. */
  canPick: isAndroid,
  /** "…abcd" when a key is saved, null when not. The browser build needs none. */
  keyStatus: () => (isNative ? T.core.invoke('ai_key_status').catch(() => null) : Promise.resolve('sample')),
  /** Checks the key with Groq and saves it. Resolves to "…abcd". */
  setKey: (key) => T.core.invoke('ai_key_set', { key }),
  clearKey: () => T.core.invoke('ai_key_clear'),
  /** One reply: `req` = { model, messages, json } (see ai.js). Resolves to the text. */
  async complete(req) {
    if (isNative) return T.core.invoke('ai_chat', req);
    await wait(700);
    if (req.json) return JSON.stringify(SAMPLE_PLAN);
    const last = req.messages.at(-1).content;
    return Array.isArray(last)
      ? 'This is a sample answer (browser build). In the desktop app, Groq looks at your snip and explains it.'
      : 'This is a sample reply (browser build). In the desktop app the answer comes from Groq.';
  },
  /** Opens the Ask window (a popup in the browser build). */
  openChat() {
    if (isAndroid) return Promise.resolve(chatSheet());
    if (isNative) return T.core.invoke('chat_open');
    open('chat.html', 'togami-chat', 'width=420,height=620');
    return Promise.resolve();
  },
  /** Starts a screen snip; the picked area turns up in the Ask window. */
  snip: () => (isNative ? T.core.invoke('snip_start') : Promise.reject(new Error('Screen snips need the desktop app.'))),
  /** The Ask window: take the last snip (a data URL), once. */
  takeSnip: () => (isNative ? T.core.invoke('chat_take_snip') : Promise.resolve(null)),
  /** The Ask window: a snip is waiting. */
  onSnip(fn) {
    if (ownWindows) T.event.listen('chat-snip', fn);
  },
  /** Android: the chat sheet asks to be closed. */
  closeChat() {
    if (isFramed) parent.postMessage({ type: 'chat-close' }, '*');
  },
  /** macOS: the Screen Recording permission snips need. */
  screen: {
    needed: isNative && isMac,
    granted: () => (isNative ? T.core.invoke('screen_status').catch(() => null) : Promise.resolve(null)),
    request: () => isNative && T.core.invoke('screen_request').catch(() => {}),
  },
};

// Android: the chat (chat.html) in a full-screen frame. Back closes it.
let chatFrame = null;

function chatSheet() {
  if (chatFrame) return;
  chatFrame = document.createElement('iframe');
  chatFrame.src = 'chat.html';
  chatFrame.title = 'Ask';
  chatFrame.className = 'chat-sheet';
  document.body.append(chatFrame);
  history.pushState({ togamiChat: true }, '');
  const onMessage = (e) => {
    if (e.source === chatFrame?.contentWindow && e.data?.type === 'chat-close') history.back();
  };
  const close = () => {
    removeEventListener('popstate', close);
    removeEventListener('message', onMessage);
    chatFrame?.remove();
    chatFrame = null;
  };
  addEventListener('popstate', close);
  addEventListener('message', onMessage);
}

// ---------- background (desktop app) ----------

// Closing the window only hides Togami; the tray (menu bar) icon reopens or quits it.
export const background = {
  /** Tray menu choices: "pet" (show or hide the pet) and "quit". */
  onTray(fn) {
    if (ownWindows) T.event.listen('tray-act', (e) => fn(e.payload));
  },
  /** A tick every second from the native side, which keeps running while the window is hidden. */
  onHeartbeat(fn) {
    if (isNative && !isFramed) T.event.listen('heartbeat', fn);
  },
  show: () => isNative && T.core.invoke('show_main'),
  exit: () => isNative && T.core.invoke('app_exit'),
};

// ---------- media ----------

const mediaListeners = new Set();
let current = null;

function emit() {
  for (const fn of mediaListeners) fn(current);
}

let control;
let startMedia; // the polling starts with the first subscriber (the Ask window has none)
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
  startMedia = () => {
    poll();
    setInterval(poll, 1000);
  };
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
  startMedia = () => setInterval(() => {
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
    if (startMedia) {
      startMedia();
      startMedia = null;
    }
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
