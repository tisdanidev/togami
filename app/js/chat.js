// The Ask window (chat.html): chat with the pet, or with Togami when no pet
// pack is installed, about your work, and ask about snips of the screen.
// The pet also says the first sentence of each reply in its speech box.
//
// The session comes from the main window's saved state (same storage), so a
// focus session keeps the chat on the work (see chatSystem in ai.js). The
// conversation is kept on this computer without its pictures.

import * as store from './store.js';
import * as E from './engine.js';
import * as clock from './clock.js';
import { ai, pet } from './platform.js';
import { chatSystem, chatRequest, firstSentence } from './ai.js';
import { fitImage } from './image.js';
import { esc } from './format.js';

const KEY = 'togami.chat.v1';
const KEEP = 40; // messages kept between openings

const $ = (s) => document.querySelector(s);
const log = $('#log');
const msg = $('#msg');
const send = $('#send');
const attach = $('#attach');

let history = loadHistory(); // [{ role: 'user' | 'assistant', text, image? }]
let pending = null; // a snip waiting to be asked about (data URL)
let busy = false;
let persona = { name: 'Togami', personality: null };

boot();

async function boot() {
  applyTheme();
  const p = await pet.persona();
  if (p) persona = p;
  $('#who').textContent = persona.name;
  document.title = `Ask ${persona.name}`;
  if (ai.canPick) {
    // Android: attach a screenshot or photo instead of snipping
    $('#snip').title = 'Attach a screenshot or photo to ask about it';
    $('#snip').setAttribute('aria-label', 'Attach a picture');
    $('#close').hidden = false;
  } else if (!ai.canSnip) {
    $('#snip').disabled = true;
    $('#snip').title = 'Screen snips need the desktop app';
  }
  if (!ai.real) $('#note').textContent = 'Browser build: replies are samples.';
  renderLog();
  renderContext();
  setInterval(renderContext, 3000);
  ai.onSnip(takeSnip);
  takeSnip();
  msg.focus();
}

// ---------- state ----------

function loadHistory() {
  try {
    const h = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(h) ? h.filter((m) => m && typeof m.text === 'string') : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    // pictures stay out of storage; the message remembers there was one
    const keep = history.slice(-KEEP).map(({ role, text, image, snip }) => ({ role, text, snip: snip || Boolean(image) }));
    localStorage.setItem(KEY, JSON.stringify(keep));
  } catch {
    // storage full or blocked: the chat still works for now
  }
}

/** The running session, as chatSystem wants it, or null. */
function session() {
  const s = store.load();
  if (!s?.session) return null;
  const v = E.sessionView(s, clock.now());
  return v ? { kind: v.phase.kind, intention: s.session.intention || '' } : null;
}

function applyTheme() {
  const t = store.load()?.settings?.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// ---------- rendering ----------

function renderContext() {
  const s = session();
  const el = $('#ctx');
  el.className = 'ctx' + (s ? (s.kind === 'focus' ? ' focus' : ' brk') : '');
  el.textContent = !s ? 'Here to help' : s.kind === 'focus' ? `Focus${s.intention ? ` · ${s.intention}` : ''}` : 'On a break';
}

/** A reply as HTML: paragraphs, line breaks, **bold** and `code`. */
function rich(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function renderLog(error = null) {
  if (!history.length && !busy && !error) {
    log.innerHTML = `<div class="c-empty"><h2>Ask ${esc(persona.name)}</h2>
      Ask about anything you're working on${ai.canSnip ? ', or snip part of your screen to have it explained' : ai.canPick ? ', or attach a screenshot or photo to have it explained' : ''}.</div>`;
    return;
  }
  log.innerHTML =
    history
      .map((m) =>
        m.role === 'user'
          ? `<div class="msg user">${m.image ? `<img src="${m.image}" alt="Snip" />` : m.snip ? '<small class="muted">[snip]</small><br>' : ''}${esc(m.text)}</div>`
          : `<div class="msg bot"><div class="who">${esc(persona.name)}</div>${rich(m.text)}</div>`,
      )
      .join('') +
    (busy ? `<div class="msg bot"><div class="who">${esc(persona.name)}</div><span class="dots" aria-label="Thinking"><i></i><i></i><i></i></span></div>` : '') +
    (error ? `<div class="msg err">${esc(error)}<br><button class="btn" type="button" id="retry">Try again</button></div>` : '');
  log.scrollTop = log.scrollHeight;
}

function renderAttach() {
  attach.hidden = !pending;
  if (pending) $('#attachImg').src = pending;
  msg.placeholder = pending ? 'Ask about this snip, or pick one below…' : 'Ask about your work…';
}

function fitInput() {
  msg.style.height = '40px';
  msg.style.height = Math.min(140, msg.scrollHeight + 2) + 'px';
}

// ---------- asking ----------

async function ask(text) {
  text = text.trim();
  if (busy || (!text && !pending)) return;
  history.push({ role: 'user', text, image: pending || undefined });
  pending = null;
  msg.value = '';
  fitInput();
  renderAttach();
  await reply();
}

async function reply() {
  busy = true;
  send.disabled = true;
  renderLog();
  const system = chatSystem({ name: persona.name, personality: persona.personality, session: session() });
  try {
    const text = await ai.complete(chatRequest(system, history));
    history.push({ role: 'assistant', text: text.trim() });
    saveHistory();
    busy = false;
    renderLog();
    pet.line(firstSentence(text));
  } catch (err) {
    busy = false;
    renderLog(String(err?.message ?? err));
  } finally {
    send.disabled = false;
  }
}

async function takeSnip() {
  const image = await ai.takeSnip();
  if (!image) return;
  try {
    pending = await fitImage(image);
  } catch {
    pending = null;
    return renderLog('That snip could not be read. Try again.');
  }
  renderAttach();
  msg.focus();
}

// ---------- events ----------

$('#compose').addEventListener('submit', (e) => {
  e.preventDefault();
  ask(msg.value);
});

msg.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    ask(msg.value);
  }
});
msg.addEventListener('input', fitInput);

attach.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-ask]');
  if (chip) ask(msg.value.trim() || chip.dataset.ask);
});

$('#unattach').addEventListener('click', () => {
  pending = null;
  renderAttach();
});

$('#snip').addEventListener('click', () => {
  if (ai.canPick) return $('#pick').click();
  ai.snip().catch((err) => renderLog(String(err?.message ?? err)));
});

$('#pick').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const url = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    pending = await fitImage(url);
  } catch {
    pending = null;
    return renderLog('That picture could not be read. Try another.');
  }
  renderAttach();
});

$('#close').addEventListener('click', () => ai.closeChat());

$('#clear').addEventListener('click', () => {
  if (busy) return;
  history = [];
  saveHistory();
  renderLog();
  msg.focus();
});

log.addEventListener('click', (e) => {
  if (e.target.id === 'retry' && !busy && history.at(-1)?.role === 'user') reply();
});

// the theme can change in the main window
addEventListener('storage', (e) => {
  if (e.key === 'togami.state.v1' || e.key === null) applyTheme();
});
addEventListener('focus', () => {
  applyTheme();
  renderContext();
});
