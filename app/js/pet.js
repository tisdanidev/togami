// The desktop pet (pet.html). Runs in its own always-on-top window in the
// desktop app, or in an iframe in the browser build. Togami sends it moments
// ("workStart", "block", ...); it picks a line for that moment from the pet
// pack, switches expression (playing the expression's intro frames), and
// types the line into the speech box. In between it blinks.
//
// Togami has no pet look of its own: everything visual comes from the pack.
// A pack is pet.json, style.css, layout.html and the frames and fonts they
// use, all in one folder. See blank_pet/README.md for the format; in short:
//
// pet.json: { name, window?: { width, height }, timing?: { introFrame, type,
//   punctuation, hold, holdPerChar }, nameHighlight?: { minLength: letters },
//   idle, expressions: { name: { intro?: [files], open, closed? } },
//   lines: { moment: [{ e: expression, t: text }] } }.
// Lines can use {intention}, {min}, {target} and {version}.
//
// layout.html must have #card, #sprite (an img), #bubble and #text; #name,
// #menu and #badge are optional. pet.js only toggles classes on them (see
// README.md), so style.css decides how everything looks and moves.

const T = globalThis.__TAURI__;
const $ = (s) => document.querySelector(s);
const stage = $('#stage');

const TIMING = { introFrame: 70, type: 24, punctuation: 144, hold: 3200, holdPerChar: 55 };

// Used when a pack has no lines for a moment.
const FALLBACK = {
  hello: [{ t: "Hi! I'll keep you company while you work." }],
  workStart: [{ t: 'Focus time. You can do this.' }],
  breakStart: [{ t: 'Break time. Stretch a little.' }],
  breakEnd: [{ t: 'Break is over. Back to it.' }],
  sessionEnd: [{ t: 'Session complete. Well done!' }],
  blockWarn: [{ t: 'Close {target}, quick!' }],
  block: [{ t: '{target} is blocked right now.' }],
  pauseRequested: [{ t: 'Pausing in two minutes.' }],
  paused: [{ t: 'Paused.' }],
  resumed: [{ t: 'Back to work.' }],
  quit: [{ t: 'Session ended.' }],
  lockout: [{ t: 'Locked for {min} minutes.' }],
  lockoutEnded: [{ t: 'Lockout over.' }],
  pardon: [{ t: 'You earned a pardon.' }],
  update: [{ t: 'Togami {version} is ready to install.' }],
  idle: [{ t: 'Ready when you are.' }],
  late: [{ t: "It's late. Get some sleep." }],
  poke: [{ t: 'Hey there!' }],
};

// ---------- host: desktop window or browser iframe ----------

const host = T
  ? {
      async load() {
        const { manifest, files, texts } = await T.core.invoke('pet_pack');
        return { manifest, src: (f) => files[f] ?? null, text: async (f) => texts[f] ?? '' };
      },
      onSay: (fn) => T.event.listen('pet-say', (e) => fn(e.payload)),
      onState: (fn) => T.event.listen('pet-state', (e) => fn(e.payload)),
      hit: (rects) => T.core.invoke('pet_hit', { rects }).catch(() => {}),
      act(act, data = {}) {
        if (act === 'open') T.core.invoke('show_main');
        else T.event.emitTo('main', 'pet-act', { act, ...data });
      },
      drag: () => T.window.getCurrentWindow().startDragging().catch(() => {}),
      init() {
        // remember where the pet was dragged to (Togami reopens it there)
        T.window.getCurrentWindow().onMoved(({ payload }) => {
          try {
            localStorage.setItem('togami.pet.pos', JSON.stringify([payload.x, payload.y]));
          } catch {}
        });
      },
    }
  : {
      async load() {
        const r = await fetch('packs/current/pet.json');
        if (!r.ok) throw new Error('no pack');
        return {
          manifest: await r.json(),
          // only plain file names next to pet.json, like the desktop app
          src: (f) => (/^[\w.-]+$/.test(f) ? 'packs/current/' + f : null),
          text: async (f) => {
            const r = await fetch('packs/current/' + f);
            return r.ok ? r.text() : '';
          },
        };
      },
      onSay: (fn) => addEventListener('message', (e) => e.data?.type === 'say' && fn(e.data)),
      onState: (fn) => addEventListener('message', (e) => e.data?.type === 'state' && fn(e.data.state)),
      hit: (rects) => parent.postMessage({ type: 'pet-hit', rects }, '*'),
      act: (act, data = {}) => parent.postMessage({ type: 'pet-act', act, ...data }, '*'),
      drag() {},
      init() {
        // let clicks through to the page again once the pointer leaves the pet
        addEventListener('pointermove', (e) => {
          if (!e.target.closest('#card, #bubble, #menu, #badge')) parent.postMessage({ type: 'pet-leave' }, '*');
        });
        document.addEventListener('pointerleave', () => parent.postMessage({ type: 'pet-leave' }, '*'));
      },
    };

// ---------- state ----------

let pack = null;
let src = null;
let timing = TIMING;
let card, sprite, bubble, text, menu, badge, speakers; // parts of the pack's layout
let expr = null; // current expression name
let busy = false; // playing intro frames
let speaking = null; // { timer, typing }
let lastLine = {};
let app = null; // from Togami: { locked, lockoutMs, profiles, session }
let flipped = false;
try {
  flipped = localStorage.getItem('togami.pet.flip') === '1';
} catch {}

boot();

async function boot() {
  host.init();
  let readText;
  try {
    ({ manifest: pack, src, text: readText } = await host.load());
  } catch {
    return; // no pack installed: nothing to show
  }
  timing = { ...TIMING, ...pack.timing };
  if (!(await mount(readText))) return;
  await preload();
  const name = $('#name');
  if (name) name.innerHTML = nameHtml(pack.name || 'Pet');
  card.classList.toggle('flip', flipped);
  show(idleName(), false);
  stage.hidden = false;
  blinkLoop();
  setInterval(sendHit, 250);
  host.onSay(({ moment, vars }) => say(moment, vars));
  host.onState((s) => {
    app = s;
    renderBadge();
    if (!menu.hidden && menu.dataset.view === 'main') renderMenu('main');
  });
  host.act('ready'); // ask Togami for the current state
  setTimeout(() => say('hello'), 700);
}

// ---------- the pack's look: style.css and layout.html ----------

/** Puts the pack's styles and layout in the window. False if the layout lacks a required part. */
async function mount(readText) {
  const [css, layout] = await Promise.all([readText('style.css'), readText('layout.html')]);
  const style = document.createElement('style');
  style.textContent = packCss(css);
  document.head.append(style);
  stage.append(packLayout(layout));

  [card, sprite, bubble, text] = ['#card', '#sprite', '#bubble', '#text'].map((s) => $(s));
  if (!card || !(sprite instanceof HTMLImageElement) || !bubble || !text) {
    console.error('Pet pack layout.html needs #card, #sprite (an img), #bubble and #text.');
    return false;
  }
  menu = $('#menu') || stage.appendChild(Object.assign(document.createElement('div'), { id: 'menu' }));
  badge = $('#badge') || stage.appendChild(Object.assign(document.createElement('div'), { id: 'badge' }));
  speakers = [...stage.querySelectorAll('[data-speak]')];
  sprite.draggable = false;
  text.setAttribute('aria-live', 'polite');
  bubble.hidden = menu.hidden = badge.hidden = true;
  wire();
  return true;
}

/** The pack's CSS, with url()s pointing at the pack's own files or #ids in
 *  the layout (anything else is dropped). */
function packCss(css) {
  return css.replace(/@import[^;]*;?/gi, '').replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_, q, f) => {
    const s = f.startsWith('#') ? f : src(f.replace(/^\.\//, ''));
    return s ? `url("${s}")` : 'none';
  });
}

// Layout elements a pack may use: plain HTML boxes and SVG shapes.
const TAGS = new Set(
  ('div span p b i em strong small br img svg g defs symbol use path polygon polyline rect circle ellipse line ' +
    'text tspan lineargradient radialgradient stop clippath mask pattern filter fegaussianblur feoffset ' +
    'feflood fecomposite femerge femergenode fecolormatrix title desc').split(' '),
);

/** The pack's layout.html as inert markup: no scripts, handlers or outside links. */
function packLayout(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  for (const el of [...t.content.querySelectorAll('*')]) {
    if (!TAGS.has(el.localName.toLowerCase())) {
      el.remove();
      continue;
    }
    for (const { name, value } of [...el.attributes]) {
      const n = name.toLowerCase();
      if (n.startsWith('on') || n === 'srcset') el.removeAttribute(name);
      else if (n === 'src' || n === 'href' || n === 'xlink:href') {
        const v = value.trim();
        const s = v.startsWith('#') && n !== 'src' ? v : src(v.replace(/^\.\//, ''));
        if (s) el.setAttribute(name, s);
        else el.removeAttribute(name);
      } else if (n === 'style' && /url\(/i.test(value)) el.setAttribute(name, packCss(value));
    }
  }
  return t.content;
}

function preload() {
  const files = new Set();
  for (const e of Object.values(pack.expressions)) {
    for (const f of [...(e.intro || []), e.open, e.closed]) if (f) files.add(f);
  }
  return Promise.all(
    [...files].map((f) => {
      const img = new Image();
      img.src = src(f) || '';
      return img.decode().catch(() => {});
    }),
  );
}

function idleName() {
  return pack.expressions[pack.idle] ? pack.idle : Object.keys(pack.expressions)[0];
}

// ---------- expressions ----------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Switch to an expression, playing its intro frames first if `intro`. */
async function show(name, intro = true) {
  const e = pack.expressions[name] || pack.expressions[idleName()];
  name = pack.expressions[name] ? name : idleName();
  if (name === expr && !intro) return;
  expr = name;
  card.dataset.expression = name;
  busy = false;
  if (intro && e.intro?.length) {
    busy = true;
    for (const f of e.intro) {
      sprite.src = src(f);
      await wait(timing.introFrame);
      if (expr !== name) return; // switched again mid-intro
    }
    busy = false;
  }
  sprite.src = src(e.open);
}

async function blinkLoop() {
  for (;;) {
    await wait(2200 + Math.random() * 4200);
    const e = pack.expressions[expr];
    if (busy || !e?.closed) continue;
    const twice = Math.random() < 0.2;
    for (let i = 0; i < (twice ? 2 : 1); i++) {
      sprite.src = src(e.closed);
      await wait(110);
      if (pack.expressions[expr] === e && !busy) sprite.src = src(e.open);
      if (twice) await wait(140);
    }
  }
}

// ---------- speaking ----------

/** Pick a line for `moment` whose placeholders all have values. */
function pickLine(moment, vars) {
  const fits = (l) => [...l.t.matchAll(/\{(\w+)\}/g)].every((m) => vars[m[1]] != null && vars[m[1]] !== '');
  let pool = (pack.lines?.[moment] || []).filter(fits);
  if (!pool.length) pool = (FALLBACK[moment] || []).filter(fits);
  if (!pool.length) return null;
  let i = Math.floor(Math.random() * pool.length);
  if (pool.length > 1 && i === lastLine[moment]) i = (i + 1) % pool.length;
  lastLine[moment] = i;
  const line = pool[i];
  return { e: line.e, t: line.t.replace(/\{(\w+)\}/g, (_, k) => String(vars[k])) };
}

async function say(moment, vars = {}) {
  if (!pack || !card) return;
  const line = pickLine(moment, vars);
  if (!line) return;
  stopSpeaking();
  hideMenu();
  const me = (speaking = { timer: 0 });

  // cut-in: speakers (data-speak) come on, card pops, box opens
  for (const el of speakers) el.classList.add('on');
  restartAnim(card, 'pop');
  text.textContent = '';
  bubble.hidden = false;
  restartAnim(bubble, 'show');
  show(line.e || idleName());

  card.classList.add('chatter');
  for (let i = 1; i <= line.t.length; i++) {
    if (speaking !== me) return;
    // the untyped rest stays laid out (hidden) so centred text doesn't shift
    text.innerHTML = `<span>${esc(line.t.slice(0, i))}<span class="rest">${esc(line.t.slice(i))}</span></span>`;
    await wait(/[.,!?]/.test(line.t[i - 1]) ? timing.punctuation : timing.type);
  }
  card.classList.remove('chatter');
  me.timer = setTimeout(() => {
    if (speaking !== me) return;
    speaking = null;
    quiet();
  }, Math.max(timing.hold, line.t.length * timing.holdPerChar));
}

function stopSpeaking() {
  if (speaking) clearTimeout(speaking.timer);
  speaking = null;
  card.classList.remove('chatter');
}

/** Close the speech box and go back to the idle expression. */
function quiet() {
  bubble.hidden = true;
  for (const el of speakers) el.classList.remove('on');
  show(idleName(), false);
}

function restartAnim(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// ---------- pointer: poke, drag, menu, badge ----------

function wire() {
  let down = null;

  card.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    hideMenu();
    down = { x: e.screenX, y: e.screenY, dragging: false };
  });

  addEventListener('pointermove', (e) => {
    if (!down || down.dragging || !(e.buttons & 1)) return;
    if (Math.hypot(e.screenX - down.x, e.screenY - down.y) > 4) {
      down.dragging = true;
      host.drag();
    }
  });

  addEventListener('pointerup', (e) => {
    if (down && !down.dragging && e.target.closest('#card')) {
      restartAnim(card, 'wiggle');
      say('poke');
    }
    down = null;
  });

  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    stopSpeaking();
    quiet();
    renderMenu('main');
    menu.hidden = false;
    restartAnim(menu, 'show');
  });

  bubble.addEventListener('click', () => {
    stopSpeaking();
    quiet();
  });

  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    const act = btn?.dataset.act;
    if (!act) return;
    if (act === 'startMenu' || act === 'back') {
      renderMenu(act === 'back' ? 'main' : 'start');
      restartAnim(menu, 'show');
      return;
    }
    hideMenu();
    if (act === 'locked') {
      say('lockout', { min: Math.ceil((app?.lockoutMs ?? 0) / 60_000) });
    } else if (act === 'start') {
      host.act('start', { id: btn.dataset.id });
    } else if (act === 'talk') {
      const h = new Date().getHours();
      say(h >= 0 && h < 5 ? 'late' : Math.random() < 0.5 ? 'poke' : 'idle');
    } else if (act === 'flip') {
      flipped = !flipped;
      card.classList.toggle('flip', flipped);
      try {
        localStorage.setItem('togami.pet.flip', flipped ? '1' : '0');
      } catch {}
    } else host.act(act);
  });

  addEventListener('keydown', (e) => e.key === 'Escape' && hideMenu());
  addEventListener('blur', hideMenu);

  // click the badge to pause or restart the timer (blocking stays on)
  badge.addEventListener('click', () => host.act('hold'));
}

function hideMenu() {
  if (menu) menu.hidden = true;
}

/** The right-click menu: "main", or "start" (pick a session type). */
function renderMenu(view) {
  menu.dataset.view = view;
  const item = (act, label, extra = '') => `<button type="button" data-act="${act}" ${extra}><span>${label}</span></button>`;
  if (view === 'start' && app && !app.session && !app.locked) {
    menu.innerHTML =
      app.profiles.map((p) => item('start', `${esc(p.name)} <small>${esc(p.label)}</small>`, `data-id="${esc(p.id)}"`)).join('') +
      item('back', 'Back');
    return;
  }
  menu.dataset.view = 'main';
  let first = '';
  if (app && !app.session) {
    first = app.locked ? item('locked', `Locked · ${Math.ceil(app.lockoutMs / 60_000)} min`, 'class="off"') : item('startMenu', 'Start focus');
  }
  menu.innerHTML = first + item('open', 'Open Togami') + item('talk', 'Talk') + item('flip', 'Turn around') + item('hide', 'Hide');
}

// ---------- timer badge (while a session runs) ----------

function renderBadge() {
  if (!badge) return;
  const s = app?.session;
  badge.hidden = !s || !pack;
  if (!s) return;
  const sec = Math.round(s.remaining / 1000);
  const time = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  const label = s.pause === 'paused' ? 'Paused' : s.held ? 'Timer paused' : s.kind === 'focus' ? 'Focus' : s.kind === 'long' ? 'Long break' : 'Break';
  badge.classList.remove('focus', 'brk', 'paused');
  badge.classList.add(s.pause === 'paused' || s.held ? 'paused' : s.kind === 'focus' ? 'focus' : 'brk');
  badge.innerHTML = `<small>${label}</small><b>${time}</b>`;
}

// ---------- hit rectangles (where clicks belong to the pet) ----------

let lastHit = '';

function sendHit() {
  const rects = [card, bubble, menu, badge]
    .filter((el) => !el.hidden)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return [Math.floor(r.left), Math.floor(r.top), Math.ceil(r.width), Math.ceil(r.height)];
    });
  const key = JSON.stringify(rects);
  if (key === lastHit) return;
  lastHit = key;
  host.hit(rects);
}

/** The speaker's name, with some letters wrapped in <b> as the pack's
 *  nameHighlight asks: { minLength: letters }, e.g. { "1": 1, "8": 2 } gives
 *  one letter, or two from 8 characters. Which letters is random. */
function nameHtml(name) {
  const chars = [...name];
  const slots = chars.map((c, i) => i).filter((i) => chars[i].trim());
  let count = 0;
  for (const [min, n] of Object.entries(pack.nameHighlight || {})) if (chars.length >= Number(min)) count = Math.max(count, Number(n) || 0);
  const inv = new Set();
  while (inv.size < Math.min(count, slots.length)) inv.add(slots[Math.floor(Math.random() * slots.length)]);
  return chars.map((c, i) => (inv.has(i) ? `<b>${esc(c)}</b>` : esc(c))).join('');
}

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
