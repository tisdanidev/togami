// The desktop pet (pet.html). Runs in its own always-on-top window in the
// desktop app, or in an iframe in the browser build. Togami sends it moments
// ("workStart", "block", ...); it picks a line for that moment from the pet
// pack, switches expression (playing the expression's intro frames), and
// types the line into the speech box. In between it blinks and breathes.
//
// Pet pack (pet.json): { name, size, idle, expressions: { name: { intro: [files],
// open, closed?, talk?: [files] } }, lines: { moment: [{ e: expression, t: text }] } }.
// Lines can use {intention}, {min}, {target} and {version}.

const T = globalThis.__TAURI__;
const $ = (s) => document.querySelector(s);
const card = $('#card');
const sprite = $('#sprite');
const bubble = $('#bubble');
const text = $('#text');
const menu = $('#menu');
const bands = [$('#band'), $('#band2')];

const INTRO_MS = 70;
const TYPE_MS = 24;

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
        const { manifest, files } = await T.core.invoke('pet_pack');
        return { manifest, src: (f) => files[f] };
      },
      onSay: (fn) => T.event.listen('pet-say', (e) => fn(e.payload)),
      hit: (rects) => T.core.invoke('pet_hit', { rects }).catch(() => {}),
      act(act) {
        if (act === 'open') T.core.invoke('show_main');
        else T.event.emitTo('main', 'pet-act', { act });
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
        return { manifest: await r.json(), src: (f) => 'packs/current/' + f };
      },
      onSay: (fn) => addEventListener('message', (e) => e.data?.type === 'say' && fn(e.data)),
      hit: (rects) => parent.postMessage({ type: 'pet-hit', rects }, '*'),
      act: (act) => parent.postMessage({ type: 'pet-act', act }, '*'),
      drag() {},
      init() {
        // let clicks through to the page again once the pointer leaves the pet
        addEventListener('pointermove', (e) => {
          if (!e.target.closest('#card, #bubble, #menu')) parent.postMessage({ type: 'pet-leave' }, '*');
        });
        document.addEventListener('pointerleave', () => parent.postMessage({ type: 'pet-leave' }, '*'));
      },
    };

// ---------- state ----------

let pack = null;
let src = null;
let expr = null; // current expression name
let busy = false; // playing intro frames
let speaking = null; // { timer, typing }
let lastLine = {};
let flipped = false;
try {
  flipped = localStorage.getItem('togami.pet.flip') === '1';
} catch {}

boot();

async function boot() {
  host.init();
  try {
    ({ manifest: pack, src } = await host.load());
  } catch {
    return; // no pack installed: nothing to show
  }
  await preload();
  $('#name').innerHTML = nameHtml(pack.name || 'Pet');
  card.classList.toggle('flip', flipped);
  show(idleName(), false);
  card.hidden = false;
  blinkLoop();
  setInterval(sendHit, 250);
  host.onSay(({ moment, vars }) => say(moment, vars));
  setTimeout(() => say('hello'), 700);
}

function preload() {
  const files = new Set();
  for (const e of Object.values(pack.expressions)) {
    for (const f of [...(e.intro || []), e.open, e.closed, ...(e.talk || [])]) if (f) files.add(f);
  }
  return Promise.all(
    [...files].map((f) => {
      const img = new Image();
      img.src = src(f);
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
  busy = false;
  if (intro && e.intro?.length) {
    busy = true;
    for (const f of e.intro) {
      sprite.src = src(f);
      await wait(INTRO_MS);
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
  if (!pack) return;
  const line = pickLine(moment, vars);
  if (!line) return;
  stopSpeaking();
  hideMenu();
  const me = (speaking = { timer: 0 });

  // cut-in: band slashes in, card pops, box opens
  for (const b of bands) b.classList.add('on');
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
    await wait(/[.,!?]/.test(line.t[i - 1]) ? TYPE_MS * 6 : TYPE_MS);
  }
  card.classList.remove('chatter');
  me.timer = setTimeout(() => {
    if (speaking !== me) return;
    speaking = null;
    bubble.hidden = true;
    for (const b of bands) b.classList.remove('on');
    show(idleName(), false);
  }, Math.max(3200, line.t.length * 55));
}

function stopSpeaking() {
  if (speaking) clearTimeout(speaking.timer);
  speaking = null;
  card.classList.remove('chatter');
}

function restartAnim(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// ---------- pointer: poke, drag, menu ----------

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
  bubble.hidden = true;
  for (const b of bands) b.classList.remove('on');
  show(idleName(), false);
  menu.hidden = false;
  restartAnim(menu, 'show');
});

bubble.addEventListener('click', () => {
  stopSpeaking();
  bubble.hidden = true;
  for (const b of bands) b.classList.remove('on');
  show(idleName(), false);
});

menu.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  hideMenu();
  if (act === 'talk') {
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

function hideMenu() {
  menu.hidden = true;
}

// ---------- hit rectangles (where clicks belong to the pet) ----------

let lastHit = '';

function sendHit() {
  const rects = [card, bubble, menu]
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

/** The speaker's name as P5 draws it: black, with one letter (two from 8
 *  letters, three from 16) inverted, white on a black block. */
function nameHtml(name) {
  const chars = [...name];
  const slots = chars.map((c, i) => i).filter((i) => chars[i].trim());
  const count = chars.length >= 16 ? 3 : chars.length >= 8 ? 2 : 1;
  const inv = new Set();
  while (inv.size < Math.min(count, slots.length)) inv.add(slots[Math.floor(Math.random() * slots.length)]);
  return chars.map((c, i) => (inv.has(i) ? `<b>${esc(c)}</b>` : esc(c))).join('');
}

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
