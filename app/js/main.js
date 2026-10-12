// Togami UI. Renders views from state, runs the clock, wires the Windows layer.

import * as E from './engine.js';
import * as store from './store.js';
import * as clock from './clock.js';
import { blocker, media, appWindow, notify, updater, isNative, isDev } from './platform.js';
import * as sounds from './sounds.js';
import { voice, QUIT_PHRASE } from './voice.js';
import { clock as fmtClock, fmtMin, fmtHours, fmtDate, fmtTime, esc } from './format.js';
import { seedSamples, clearSamples, hasSamples } from './samples.js';

const HOLD_MS = 5000;
const QUIT_WAIT_MS = 60_000;

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const shell = $('#shell');
const zen = $('#zen');
const overlayEl = $('#overlay');
const benchToggle = $('#benchToggle');
const bench = $('#bench');
const narrowMq = matchMedia('(max-width: 720px)');

// ---------- state ----------

let state = store.load();
if (!state) {
  state = E.defaultState();
  seedSamples(state, clock.now());
}
state.dev = isDev; // dev build: instant pause, free quit, closing isn't a quit
const APP_NAME = isDev ? 'Togami Dev' : 'Togami';
if (isDev) {
  document.body.classList.add('dev');
  $('.brand .word').insertAdjacentHTML('afterend', '<span class="dev-badge" title="Test build: no quit penalties, instant pause">DEV</span>');
}
let route = routeFromHash();
let editProfileId = state.profileId;
let intentionDraft = '';
let overlay = null; // { type, ... }
let lastMode = '';
let lastSeenWrite = 0;
let nowPlaying = null;
let mobileSidebar = false;
let appVersion = '';
let updateInfo = null; // { version, notes } once a newer version is found
let updateState = 'idle'; // idle | checking | none | installing | error
let updateError = '';

function now() {
  return clock.now();
}

function commit() {
  store.save(state);
  syncBlocker();
}

/** Tell the native watcher what to block right now (nothing when blocking is off). */
function syncBlocker() {
  const b = E.blocking(state, now());
  if (!b.on) return blocker.sync({ active: false, apps: [], sites: [] });
  const allowed = new Set([...E.ALWAYS_ALLOWED, ...state.allowlist].map((x) => x.toLowerCase()));
  const keep = (x) => !allowed.has(x.toLowerCase());
  blocker.sync({ active: true, apps: b.profile.apps.filter(keep), sites: b.profile.sites.filter(keep) });
}

// ---------- boot ----------

applyTheme();
applySidebar();
{
  const ev = E.checkClosedGap(state, store.lastSeen(), Date.now(), now());
  if (ev.length) handle(ev, { closed: true });
}
store.markSeen(Date.now());
handle(E.tick(state, now()));
render();
setInterval(loop, 250);
addEventListener('hashchange', () => {
  route = routeFromHash();
  if (narrowMq.matches) mobileSidebar = false;
  applySidebar();
  render();
});
narrowMq.addEventListener('change', applySidebar);

function routeFromHash() {
  const r = location.hash.slice(1);
  return ['focus', 'blocklist', 'ledger', 'settings'].includes(r) ? r : 'focus';
}

function loop() {
  const t = now();
  const ev = E.tick(state, t);
  if (ev.length) handle(ev);
  if (mode(t) !== lastMode) render();
  if (Date.now() - lastSeenWrite > 2000) {
    lastSeenWrite = Date.now();
    store.markSeen(lastSeenWrite);
    store.save(state);
    syncBlocker();
  }
  // quit ceremony: the wait step finishes on its own
  if (overlay?.type === 'quit' && overlay.step === 3 && t >= overlay.waitUntil) {
    overlay.step = 4;
    renderOverlay();
  }
  updateLive(t);
}

function handle(events, { closed = false } = {}) {
  const v = voice(state);
  for (const e of events) {
    switch (e.type) {
      case 'complete':
        overlay = { type: 'complete', entry: e.entry, pardon: false };
        glint();
        break;
      case 'pardonEarned':
        if (overlay?.type === 'complete') overlay.pardon = true;
        else toast(v.pardonEarned, 'gold');
        break;
      case 'resumed':
        if (e.auto) toast('The pause ran out. Blocking is back on.');
        break;
      case 'lockoutEnded':
        toast('Lockout over. Blocks are off.');
        break;
      case 'quit':
        if (closed || e.entry.forced) toast(v.closedQuit, 'neg');
        break;
      case 'error':
        toast(e.message, 'neg');
        break;
    }
  }
  if (overlay && overlay.type === 'quit' && !state.session) overlay = null;
  announce(events);
  commit();
  render();
}

/** One jingle (and notification) for the latest session moment in `events`. */
function announce(events) {
  let moment = null;
  let detail = null;
  for (const e of events) {
    if (e.type === 'started') moment = 'workStart';
    if (e.type === 'phase') moment = e.kind === 'focus' ? 'breakEnd' : 'breakStart';
    if (e.type === 'complete') (moment = 'sessionEnd'), (detail = e.entry);
  }
  if (!moment) return;
  if (state.settings.sounds) sounds.play(moment);
  if (!state.settings.notify || (document.hasFocus() && !document.hidden)) return;
  const sv = state.session && E.sessionView(state, now());
  const intention = state.session?.intention;
  const msg = {
    workStart: ['Focus started', `${fmtMin(sv?.remaining ?? 0)}${intention ? ` on ${intention}` : ''}. Blocks are on.`],
    breakStart: [sv?.phase.kind === 'long' ? 'Long break' : 'Break time', `${fmtMin(sv?.remaining ?? 0)} off. Blocks are off until it ends.`],
    breakEnd: ['Break over', `Back to focus for ${fmtMin(sv?.remaining ?? 0)}. Blocks are back on.`],
    sessionEnd: ['Session complete', `${fmtMin(detail?.focusMs ?? 0)} of focus. Nicely done.`],
  }[moment];
  notify(msg[0], msg[1]);
}

// ---------- rendering ----------

/** A key that changes whenever the screen layout should change. */
function mode(t) {
  if (E.lockoutActive(state, t)) return 'lockout';
  if (!state.session) return 'idle';
  const v = E.sessionView(state, t);
  return `run:${v.phaseIndex}:${v.pause}`;
}

function render() {
  for (const a of document.querySelectorAll('.sb-nav a')) {
    if (a.dataset.nav === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  const t = now();
  lastMode = mode(t);
  view.className = 'page' + (route === 'ledger' || route === 'settings' ? ' wide' : '');
  if (route === 'focus') view.innerHTML = viewFocus(t);
  if (route === 'blocklist') view.innerHTML = viewBlocklist(t);
  if (route === 'ledger') view.innerHTML = viewLedger(t);
  if (route === 'settings') view.innerHTML = viewSettings(t);
  const input = $('#intention');
  if (input) input.value = intentionDraft;
  renderZen(t);
  renderUpdateLine();
  fillNowPlaying();
  renderOverlay();
  renderBench();
  updateLive(t);
}

function digits(str) {
  return [...str].map((c) => (c === ':' ? '<span class="cl">:</span>' : `<span class="dg">${c}</span>`)).join('');
}

function profileLabel(p) {
  return `${p.focusMin}/${p.breakMin} ×${p.cycles}`;
}

// ----- focus page -----

function viewFocus(t) {
  if (E.lockoutActive(state, t)) return viewLockout(t);
  if (state.session) return ''; // the full-screen view covers this

  const v = voice(state);
  const p = E.getProfile(state);
  const plan = E.buildPlan(p, state.debtMs);
  const total = plan.reduce((a, x) => a + x.ms, 0);
  const cost = E.quitCost({ ...state, session: { plan, phaseIndex: 0, phaseStartedAt: t, phasePausedMs: 0 } }, t);
  const parts = [`${p.cycles} × ${p.focusMin} min`];
  if (p.cycles > 1) parts.push(`${p.breakMin} min breaks`);
  if (p.longBreakMin && p.cycles > 1) parts.push(`${p.longBreakMin} min long break`);
  parts.push(`${fmtMin(total)} total`);
  return `<section class="focus">
    <div class="seg" role="group" aria-label="Session type">
      ${state.profiles.map((x) => `<button type="button" data-act="profile" data-id="${x.id}" aria-pressed="${x.id === p.id}">${esc(x.name)}<small>${x.custom ? 'Your own' : profileLabel(x)}</small></button>`).join('')}
    </div>
    <p class="timer idle" aria-label="First focus block">${digits(fmtClock(plan[0].ms))}</p>
    ${p.custom ? customEditor(p) : ''}
    <div class="summary">${parts.join(' · ')}</div>
    ${state.debtMs ? `<div class="notice neg">${fmtMin(state.debtMs)} of debt from a quit session is added to your first block.</div>` : ''}
    <div class="field">
      <input class="input" id="intention" maxlength="120" autocomplete="off" placeholder="${esc(v.idlePrompt)}" aria-label="${esc(v.idlePrompt)}" />
    </div>
    <button class="btn primary big" type="button" data-act="start">${esc(v.start)}</button>
    <p class="quiet-line">Blocks ${p.apps.length} apps and ${p.sites.length} sites. ${state.dev ? 'Dev build: quitting and pausing are instant, with no penalties.' : `Quitting locks them for ${fmtMin(cost.lockoutMs)}.`} <a href="#settings">Rules</a></p>
  </section>`;
}

function customEditor(p) {
  const field = (f, label) => `<div class="stepper">
      <label for="cf-${f}">${label}</label>
      <div class="ctl">
        <button type="button" data-act="cstep" data-f="${f}" data-d="-1" aria-label="Less ${label.toLowerCase()}">−</button>
        <input id="cf-${f}" type="number" inputmode="numeric" data-cf="${f}" value="${p[f]}" min="${E.LIMITS[f][0]}" max="${E.LIMITS[f][1]}" />
        <button type="button" data-act="cstep" data-f="${f}" data-d="1" aria-label="More ${label.toLowerCase()}">+</button>
      </div>
    </div>`;
  return `<div class="custom">
    ${field('focusMin', 'Focus min')}
    ${field('breakMin', 'Break min')}
    ${field('cycles', 'Blocks')}
    ${field('longBreakMin', 'Long break')}
  </div>`;
}

function viewLockout(t) {
  const v = voice(state);
  const entry = state.ledger.find((e) => e.id === state.lockout.ledgerId);
  const total = entry?.lockoutMs ?? state.lockout.until - t;
  const n = E.quitsThisWeek(state, t);
  const next = E.RULES.lockoutMs[Math.min(n, E.RULES.lockoutMs.length - 1)];
  const em = E.emergencyAvailable(state, t);
  return `<section class="focus">
    <div class="phase-label"><span class="tag" style="color:var(--neg)">Locked</span></div>
    <p class="timer lock-timer" data-live="lockout"></p>
    <p class="intention-line">${esc(v.lockoutTitle)}</p>
    <p class="quiet-line">${esc(v.lockoutBody(fmtMin(total)))}</p>
    <p class="quiet-line">${n} ${n === 1 ? 'quit' : 'quits'} this week, so the next one locks blocks for ${fmtMin(next)}.${state.debtMs ? ` ${fmtMin(state.debtMs)} of debt goes on your next session.` : ''}
      ${em ? `<br><button class="link neg" type="button" data-act="emergency">Emergency unlock</button>` : '<br>Emergency unlock is used for this week.'}</p>
  </section>`;
}

// ----- full-screen session -----

function renderZen(t) {
  const s = state.session;
  if (!s) {
    zen.hidden = true;
    zen.innerHTML = '';
    document.body.classList.remove('in-session');
    return;
  }
  document.body.classList.add('in-session');
  const sv = E.sessionView(state, t);
  const v = voice(state);
  const isFocus = sv.phase.kind === 'focus';
  zen.hidden = false;
  zen.className = 'zen' + (isFocus ? (sv.pause === 'paused' ? ' paused' : '') : ' brk');
  if (!isFocus) {
    zen.innerHTML = `
      <div class="z-label">${sv.phase.kind === 'long' ? 'Long break' : 'Break'}</div>
      <div class="z-timer" data-live="timer"></div>
      <div class="z-np" data-np="full"></div>
      <div class="z-bottom"><button class="z-btn" type="button" data-act="quit">Quit session</button></div>
      <div class="z-hint">F11 full screen</div>`;
    return;
  }
  let pause = '';
  if (sv.pause === 'pending') {
    pause = `<div class="z-pause">${esc(v.pausePending)} <b data-live="pauseIn"></b><button class="z-btn" type="button" data-act="cancelPause">Cancel</button></div>`;
  } else if (sv.pause === 'paused') {
    pause = `<div class="z-pause">Blocking is off. Resumes by itself in <b data-live="pauseOut"></b><button class="z-btn strong" type="button" data-act="resume">Resume now</button></div>`;
  }
  zen.innerHTML = `
    <div class="z-label">${sv.pause === 'paused' ? 'Paused' : 'Focus'} · ${sv.focusIndex} of ${sv.focusTotal}</div>
    <div class="z-timer" data-live="timer"></div>
    ${s.intention ? `<p class="z-intent">${esc(s.intention)}</p>` : ''}
    ${pause}
    <div class="z-np z-np-quiet" data-np="full"></div>
    <div class="z-bottom">
      ${sv.pause === 'none' ? `<button class="z-btn" type="button" data-act="pause" ${sv.remaining > E.RULES.pauseWaitMs ? '' : 'disabled'}>Pause</button>` : ''}
      <button class="z-btn" type="button" data-act="quit">Quit</button>
    </div>
    <div class="z-hint">F11 full screen</div>`;
}

// ----- blocklist -----

function viewBlocklist(t) {
  const locked = E.isLocked(state, t);
  const p = E.getProfile(state, editProfileId);
  const dis = locked ? 'disabled' : '';
  const list = (items, kind) =>
    `<div class="list">
      ${items.length ? items.map((x, i) => `<div class="list-row"><span class="name">${esc(x)}</span><button class="x" type="button" data-act="rm" data-kind="${kind}" data-i="${i}" aria-label="Remove ${esc(x)}" ${dis}>×</button></div>`).join('') : `<div class="list-empty">Nothing blocked here yet.</div>`}
      <form class="list-add" data-form="${kind}">
        <input class="input sm" id="add-${kind}" placeholder="${kind === 'apps' ? 'App name, e.g. Discord' : 'Site, e.g. youtube.com'}" autocomplete="off" ${dis} />
        <button class="btn" type="submit" ${dis}>Add</button>
      </form>
    </div>`;
  return `<div class="page-head"><div><h1>Blocklist</h1><p>What each session type blocks. Breaks are ${state.settings.blockBreaks ? 'blocked too' : 'unblocked'}.</p></div></div>
    ${locked ? `<div class="banner">Locked until the ${state.session ? 'session' : 'lockout'} ends. You can't loosen blocks mid-session.</div>` : ''}
    <div class="seg" role="group" aria-label="Session type" style="margin-bottom:24px">
      ${state.profiles.map((x) => `<button type="button" data-act="editProfile" data-id="${x.id}" aria-pressed="${x.id === p.id}">${esc(x.name)}<small>${x.apps.length + x.sites.length} blocked</small></button>`).join('')}
    </div>
    <div class="cols">
      <div><div class="col-head"><h2 class="eyebrow">Apps</h2><span class="small muted">Closed when opened</span></div>${list(p.apps, 'apps')}</div>
      <div><div class="col-head"><h2 class="eyebrow">Websites</h2><span class="small muted">Includes subdomains</span></div>${list(p.sites, 'sites')}</div>
    </div>
    <div class="section">
      <div class="col-head"><h2>Always allowed</h2><span class="small muted">Never blocked, in any session</span></div>
      <div class="list">
        ${E.ALWAYS_ALLOWED.map((x) => `<div class="list-row"><span class="name">${esc(x)}</span><span class="lock">Built in</span></div>`).join('')}
        ${state.allowlist.map((x, i) => `<div class="list-row"><span class="name">${esc(x)}</span><button class="x" type="button" data-act="rm" data-kind="allow" data-i="${i}" aria-label="Remove ${esc(x)}" ${dis}>×</button></div>`).join('')}
        <form class="list-add" data-form="allow">
          <input class="input sm" id="add-allow" placeholder="App or site you need for school" autocomplete="off" ${dis} />
          <button class="btn" type="submit" ${dis}>Add</button>
        </form>
      </div>
    </div>
    <div class="section">
      <div class="toggle-row">
        <div class="lbl"><b>Block during breaks</b><span>Keep blocks on between focus blocks too.</span></div>
        <label class="switch"><input type="checkbox" id="blockBreaks" ${state.settings.blockBreaks ? 'checked' : ''} ${dis} aria-label="Block during breaks" /><i></i></label>
      </div>
    </div>`;
}

// ----- ledger -----

function viewLedger(t) {
  const v = voice(state);
  const w = E.weekStats(state, t);
  const rows = [...state.ledger].sort((a, b) => b.at - a.at);
  const maxD = Math.max(1, ...w.distractions.map((d) => d.count));
  return `<div class="page-head"><div><h1>Ledger</h1><p>Every session, finished or quit. Entries can't be edited or removed.</p></div></div>
    ${hasSamples(state) ? `<div class="notice plain" style="width:auto;margin-bottom:20px;align-items:center;justify-content:space-between">Showing example history so you can see how the ledger looks. <button class="link" type="button" data-act="clearSamples">Clear examples</button></div>` : ''}
    <div class="stats">
      <div class="stat"><span class="v">${fmtHours(w.focusMs)}</span><span class="k">Focused this week</span></div>
      <div class="stat"><span class="v">${w.completed}</span><span class="k">Sessions finished</span></div>
      <div class="stat gold"><span class="v">${state.streak}</span><span class="k">Clean streak</span></div>
      <div class="stat gold"><span class="v">${state.pardons}</span><span class="k">Pardons (max ${E.RULES.pardonMax})</span></div>
      <div class="stat ${w.quits ? 'neg' : ''}"><span class="v">${w.quits}</span><span class="k">Quits this week</span></div>
    </div>
    <div class="section">
      <h2>Focus time this week</h2>
      ${weekChart(w.days, t)}
    </div>
    <div class="section">
      <h2>What you tried to open</h2>
      ${w.distractions.length ? `<div class="dist">${w.distractions.slice(0, 6).map((d) => `<div class="dist-row"><span>${esc(d.target)}</span><span class="track"><b style="width:${(d.count / maxD) * 100}%"></b></span><span class="c">${d.count}×</span></div>`).join('')}</div>` : `<p class="muted">No blocked attempts this week.</p>`}
    </div>
    <div class="section">
      <h2>History</h2>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Result</th><th>Working on</th><th>Focus</th><th>Notes</th></tr></thead>
        <tbody>${rows.map(ledgerRow).join('')}</tbody></table></div>` : `<p class="muted">${esc(v.emptyLedger)}</p>`}
    </div>`;
}

function ledgerRow(e) {
  const badge =
    e.type === 'complete' ? '<span class="badge complete">Finished</span>'
    : e.type === 'emergency' ? '<span class="badge emergency">Emergency</span>'
    : e.pardoned ? '<span class="badge pardoned">Quit · pardoned</span>'
    : '<span class="badge quit">Quit</span>';
  let note = '';
  if (e.type === 'complete') note = e.outcome ? { yes: 'Finished the task', partly: 'Partly finished', no: "Didn't finish" }[e.outcome] : '';
  if (e.type === 'quit') {
    const bits = [];
    if (e.reason) bits.push(`“${esc(e.reason)}”`);
    if (!e.pardoned) bits.push(`<span class="note neg">Locked ${fmtMin(e.lockoutMs)}${e.debtMs ? `, ${fmtMin(e.debtMs)} debt` : ''}</span>`);
    note = bits.join('<br>');
  }
  if (e.type === 'emergency') note = 'Emergency unlock, no penalty';
  const focus = e.plannedFocusMs && e.plannedFocusMs !== e.focusMs ? `${fmtMin(e.focusMs)} / ${fmtMin(e.plannedFocusMs)}` : fmtMin(e.focusMs || 0);
  return `<tr>
    <td class="when"><b>${fmtDate(e.at)}</b>${fmtTime(e.at)}</td>
    <td>${badge}${e.sample ? '<span class="badge example">Example</span>' : ''}</td>
    <td>${e.intention ? esc(e.intention) : '<span class="muted">—</span>'}</td>
    <td class="focus-cell">${focus}</td>
    <td><span class="note">${note}</span></td>
  </tr>`;
}

function weekChart(days, t) {
  const W = 640, H = 170, padL = 34, padB = 26, padT = 18;
  const today = Math.floor((t - E.weekStart(t)) / 86_400_000);
  const maxMin = Math.max(60, ...days.map((d) => d / 60_000));
  const top = Math.ceil(maxMin / 60) * 60;
  const plotH = H - padB - padT;
  const slot = (W - padL) / 7;
  const bw = Math.min(36, slot * 0.5);
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const y = (m) => padT + plotH - (m / top) * plotH;
  const grid = [0, top / 2, top].map((m) => `<line class="grid" x1="${padL}" x2="${W}" y1="${y(m)}" y2="${y(m)}" /><text x="${padL - 8}" y="${y(m) + 4}" text-anchor="end">${m / 60}h</text>`).join('');
  const bars = days.map((ms, i) => {
    const m = ms / 60_000;
    const x = padL + slot * i + (slot - bw) / 2;
    const h = Math.max(m ? 3 : 0, (m / top) * plotH);
    const yy = padT + plotH - h;
    const r = Math.min(4, h);
    const d = h ? `M${x},${padT + plotH} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${padT + plotH} Z` : '';
    const label = `${names[i]}: ${fmtMin(ms)} focused`;
    return `<g>
      <rect x="${padL + slot * i}" y="${padT}" width="${slot}" height="${plotH}" fill="transparent"><title>${label}</title></rect>
      ${d ? `<path class="bar" d="${d}" opacity="${i === today ? 1 : 0.55}"><title>${label}</title></path>` : ''}
      ${i === today && m ? `<text x="${x + bw / 2}" y="${yy - 6}" text-anchor="middle">${fmtMin(ms)}</text>` : ''}
      <text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" ${i === today ? 'style="fill:var(--fg)"' : ''}>${names[i]}</text>
    </g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Focus minutes per day this week">${grid}${bars}</svg>`;
}

// ----- settings -----

function viewSettings(t) {
  const locked = E.isLocked(state, t);
  const dis = locked ? 'disabled' : '';
  const v = state.settings.voice;
  const sampleVoice = voice({ settings: { voice: v } });
  const em = E.emergencyAvailable(state, t);
  const named = state.profiles.filter((p) => !p.custom).length;
  return `<div class="page-head"><div><h1>Settings</h1><p>Session types, voice and appearance.</p></div></div>
    ${locked ? `<div class="banner">Session types and data are locked until the ${state.session ? 'session' : 'lockout'} ends.</div>` : ''}
    <div class="section" style="margin-top:0">
      <h2>Session types</h2>
      <div class="table-wrap ptable"><table>
        <thead><tr><th>Name</th><th>Focus (min)</th><th>Break</th><th>Long break</th><th>Blocks</th><th></th></tr></thead>
        <tbody>${state.profiles.map((p, i) => (p.custom ? '' : `<tr>
          <td><input class="input sm" data-pf="name" data-i="${i}" value="${esc(p.name)}" maxlength="24" aria-label="Name" ${dis} /></td>
          <td><input class="input sm n" type="number" min="5" max="180" data-pf="focusMin" data-i="${i}" value="${p.focusMin}" aria-label="Focus minutes" ${dis} /></td>
          <td><input class="input sm n" type="number" min="1" max="60" data-pf="breakMin" data-i="${i}" value="${p.breakMin}" aria-label="Break minutes" ${dis} /></td>
          <td><input class="input sm n" type="number" min="0" max="60" data-pf="longBreakMin" data-i="${i}" value="${p.longBreakMin}" aria-label="Long break minutes" ${dis} /></td>
          <td><input class="input sm n" type="number" min="1" max="8" data-pf="cycles" data-i="${i}" value="${p.cycles}" aria-label="Focus blocks" ${dis} /></td>
          <td><button class="btn quiet" type="button" data-act="rmProfile" data-i="${i}" ${dis || named < 2 ? 'disabled' : ''} aria-label="Delete ${esc(p.name)}">Delete</button></td>
        </tr>`)).join('')}</tbody></table></div>
      <div class="actions" style="justify-content:flex-start;margin-top:10px;align-items:center">
        <button class="btn" type="button" data-act="addProfile" ${dis}>Add session type</button>
        <span class="muted small">Custom is set right on the Focus page.</span>
      </div>
    </div>
    <div class="section">
      <h2>Voice</h2>
      <div class="seg" role="group" aria-label="Voice">
        <button type="button" data-act="voice" data-v="neutral" aria-pressed="${v === 'neutral'}">Neutral<small>Plain and kind</small></button>
        <button type="button" data-act="voice" data-v="heir" aria-pressed="${v === 'heir'}">Heir<small>Cold and superior</small></button>
      </div>
      <p class="muted small" style="margin-top:10px">Block screen preview: <i style="font-family:var(--serif);font-size:15px;color:var(--fg)">${esc(sampleVoice.blockTitle('Discord'))}</i></p>
    </div>
    <div class="section">
      <h2>Sounds and notifications</h2>
      <div class="toggle-row">
        <div class="lbl"><b>Jingles</b><span>A short sound when focus starts, a break starts, a break ends and the session finishes.</span></div>
        <label class="switch"><input type="checkbox" id="setSounds" ${state.settings.sounds ? 'checked' : ''} aria-label="Jingles" /><i></i></label>
      </div>
      <div class="actions" style="justify-content:flex-start;margin:-4px 0 6px">
        ${[['workStart', 'Focus starts'], ['breakStart', 'Break starts'], ['breakEnd', 'Break ends'], ['sessionEnd', 'Session done']].map(([k, l]) => `<button class="btn quiet" type="button" data-act="preview" data-v="${k}">▶ ${l}</button>`).join('')}
      </div>
      <div class="toggle-row">
        <div class="lbl"><b>Windows notifications</b><span>The same moments, shown as a notification while Togami isn't in front.</span></div>
        <label class="switch"><input type="checkbox" id="setNotify" ${state.settings.notify ? 'checked' : ''} aria-label="Windows notifications" /><i></i></label>
      </div>
    </div>
    ${updater.available ? `<div class="section">
      <h2>Updates</h2>
      <div class="toggle-row">
        <div class="lbl"><b>Togami ${esc(appVersion)}</b><span id="updText">${esc(updateText())}</span></div>
        ${updateInfo ? `<button class="btn primary" type="button" data-act="updInstall" ${E.isLocked(state, t) ? 'disabled title="Finish the session or lockout first"' : ''}>Restart and update</button>` : `<button class="btn" type="button" data-act="updCheck">Check now</button>`}
      </div>
    </div>` : ''}
    <div class="section">
      <h2>Appearance</h2>
      <div class="seg" role="group" aria-label="Theme">
        ${['system', 'light', 'dark'].map((x) => `<button type="button" data-act="theme" data-v="${x}" aria-pressed="${state.settings.theme === x}">${x[0].toUpperCase() + x.slice(1)}</button>`).join('')}
      </div>
    </div>
    <div class="section">
      <h2>Rules</h2>
      <div class="terms" style="width:100%;border:0;padding:0">
        <div class="row"><span class="k">Pause</span><span>Blocking keeps running for 2 min after you press Pause. A pause ends by itself after 10 min.</span></div>
        <div class="row"><span class="k">Quit</span><span>Hold for 5 seconds, type a sentence, then wait 60 seconds. You can back out at any step.</span></div>
        <div class="row"><span class="k">Lockout</span><span>Blocks stay on after a quit: 10 min for the first quit in a week, 25 for the second, 45 after that.</span></div>
        <div class="row"><span class="k">Debt</span><span>Focus time you skip is added to your next session, up to 60 min.</span></div>
        <div class="row"><span class="k">Pardons</span><span>One for every 5 finished sessions, up to 3. A pardon cancels a quit's lockout and debt. The quit stays in the ledger.</span></div>
        <div class="row"><span class="k">Closing</span><span>Closing Togami during a session counts as quitting.</span></div>
        <div class="row"><span class="k">Emergency</span><span>Once a week, end everything now with no penalty. ${em ? '<b>Available.</b>' : '<b>Used this week</b>, back on Monday.'}</span></div>
      </div>
    </div>
    <div class="section">
      <h2>Data</h2>
      <div class="actions" style="justify-content:flex-start">
        ${hasSamples(state) ? '<button class="btn" type="button" data-act="clearSamples">Clear example history</button>' : ''}
        <button class="btn danger" type="button" data-act="reset" ${dis}>Reset everything</button>
      </div>
      <p class="muted small">Everything is saved on this computer only.</p>
    </div>`;
}

// ---------- live updates (every 250 ms, no re-render) ----------

function setText(sel, text) {
  const el = document.querySelector(`[data-live="${sel}"]`);
  if (el && el.textContent !== text) el.textContent = text;
  return el;
}

function setDigits(sel, str) {
  const el = document.querySelector(`[data-live="${sel}"]`);
  if (el && el.dataset.v !== str) {
    el.dataset.v = str;
    el.innerHTML = digits(str);
  }
}

function updateLive(t) {
  // sidebar status
  const st = $('#status');
  let cls = '';
  let txt = 'Ready';
  if (E.lockoutActive(state, t)) {
    cls = 'lock';
    txt = `Locked ${fmtClock(state.lockout.until - t)}`;
  } else if (state.session) {
    const sv = E.sessionView(state, t);
    txt = `${sv.phase.kind === 'focus' ? 'Focus' : 'Break'} ${fmtClock(sv.remaining)}`;
  }
  const html = `<span class="dot"></span><span>${txt}</span>`;
  if (st.innerHTML !== html) st.innerHTML = html;
  st.className = 'sb-status ' + cls;
  document.title = state.session || cls === 'lock' ? `${txt} · ${APP_NAME}` : APP_NAME;

  if (state.session) {
    const sv = E.sessionView(state, t);
    setDigits('timer', fmtClock(sv.remaining));
    setText('pauseIn', fmtClock(sv.pauseStartsIn));
    setText('pauseOut', fmtClock(sv.pauseEndsIn));
  }
  if (E.lockoutActive(state, t)) setDigits('lockout', fmtClock(state.lockout.until - t));
  if (overlay?.type === 'block') {
    const left = blockLeft(t);
    setText('blockRemain', left == null ? '' : fmtClock(left));
  }
  if (overlay?.type === 'quit' && overlay.step === 3) setText('quitWait', fmtClock(overlay.waitUntil - t));
}

function blockLeft(t) {
  if (E.lockoutActive(state, t)) return state.lockout.until - t;
  if (state.session) return E.sessionView(state, t).remaining;
  return null;
}

// ---------- overlays ----------

function renderOverlay() {
  if (!overlay) {
    overlayEl.hidden = true;
    overlayEl.innerHTML = '';
    return;
  }
  overlayEl.hidden = false;
  const fn = { block: ovBlock, quit: ovQuit, complete: ovComplete, emergency: ovEmergency, reset: ovReset }[overlay.type];
  overlayEl.innerHTML = fn();
  const focusEl = overlayEl.querySelector('[autofocus]') || overlayEl.querySelector('button');
  focusEl?.focus({ preventScroll: true });
  if (overlay.type === 'quit' && overlay.step === 1) bindHold();
}

function markSvg() {
  return $('#mark').outerHTML.replace('id="mark"', '');
}

function ovBlock() {
  const v = voice(state);
  const t = now();
  const lock = E.lockoutActive(state, t);
  const sv = state.session && E.sessionView(state, t);
  const body = lock ? v.blockLockout(fmtMin(state.lockout.until - t)) : v.blockBody(fmtMin(sv.remaining), state.session.intention);
  const count = state.attempts.filter((a) => !a.sample && a.target === overlay.target && a.at >= new Date(t).setHours(0, 0, 0, 0)).length;
  const canPause = sv && sv.phase.kind === 'focus' && sv.pause === 'none' && sv.remaining > E.RULES.pauseWaitMs;
  return `<div class="blockscreen" role="alertdialog" aria-labelledby="bt">
    ${markSvg()}
    <h2 id="bt">${esc(v.blockTitle(overlay.target))}</h2>
    <p>${esc(body)}</p>
    <div class="remain" data-live="blockRemain"></div>
    <div class="actions">
      <button class="btn primary big" type="button" data-act="close" autofocus>${esc(v.backToWork)}</button>
      ${canPause ? '<button class="btn big" type="button" data-act="blockPause">Pause (2 min wait)</button>' : ''}
    </div>
    <div class="count">Attempt ${count} on ${esc(overlay.target)} today</div>
  </div>`;
}

function ovQuit() {
  const v = voice(state);
  const t = now();
  const step = overlay.step;
  const steps = `<div class="steps" aria-label="Step ${step} of 4">${[1, 2, 3, 4].map((i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>`;
  const em = E.emergencyAvailable(state, t);
  const foot = `<div class="foot">${em ? `Real emergency? <button class="link neg" type="button" data-act="emergency">Unlock now with no penalty</button> (once a week).` : 'Emergency unlock is used for this week.'}</div>`;
  if (step === 1) {
    return `<div class="modal" role="dialog" aria-labelledby="qt">${steps}
      <h2 id="qt">Quit this session?</h2>
      <p>Quitting has a cost. You'll see it before anything happens.</p>
      <button class="hold" type="button" id="holdBtn" style="--h:0%"><span>${esc(v.quitHold)}</span></button>
      <p class="small">${esc(v.quitHoldHint)}</p>
      <div class="actions"><button class="btn primary" type="button" data-act="close" autofocus>${esc(v.neverMind)}</button></div>
      ${foot}</div>`;
  }
  if (step === 2) {
    return `<div class="modal" role="dialog" aria-labelledby="qt">${steps}
      <h2 id="qt">Say it</h2>
      <p>${esc(v.quitType)}</p>
      <div class="phrase">${esc(QUIT_PHRASE)}</div>
      <input class="input" id="phrase" autocomplete="off" spellcheck="false" aria-label="Type the sentence" autofocus />
      <div class="actions">
        <button class="btn danger" type="button" data-act="phraseNext" id="phraseNext" disabled>Continue</button>
        <button class="btn primary" type="button" data-act="close">${esc(v.neverMind)}</button>
      </div>${foot}</div>`;
  }
  if (step === 3) {
    return `<div class="modal" role="dialog" aria-labelledby="qt">${steps}
      <h2 id="qt">Wait a minute</h2>
      <p>${esc(v.quitWait)}</p>
      <div class="wait" data-live="quitWait">${fmtClock(overlay.waitUntil - t)}</div>
      <div class="actions"><button class="btn primary" type="button" data-act="close" autofocus>${esc(v.neverMind)}</button></div>
      ${foot}</div>`;
  }
  const c = E.quitCost(state, t);
  return `<div class="modal" role="dialog" aria-labelledby="qt">${steps}
    <h2 id="qt">This is what quitting costs</h2>
    <div class="cost">
      <div><b>${fmtMin(c.lockoutMs)}</b><span>Blocks stay on. This is your ${ordinal(c.quitNumber)} quit this week.</span></div>
      <div><b>${fmtMin(c.debtMs)}</b><span>Added to your next session as debt.</span></div>
      ${c.streak ? `<div><b>${c.streak} → 0</b><span>Your clean streak resets.</span></div>` : ''}
    </div>
    <div class="field" style="width:100%"><label for="reason">Why are you quitting? This goes in the ledger.</label><input class="input" id="reason" maxlength="120" autocomplete="off" /></div>
    <div class="actions">
      <button class="btn danger solid" type="button" data-act="quitConfirm">${esc(v.quitConfirm)}</button>
      ${state.pardons ? `<button class="btn gold" type="button" data-act="quitPardon">Use a pardon (${state.pardons} left)</button>` : ''}
      <button class="btn primary" type="button" data-act="close" autofocus>${esc(v.neverMind)}</button>
    </div>
    ${state.pardons ? '<p class="small">A pardon cancels the lockout, debt and streak reset. The quit is still recorded.</p>' : ''}
    ${foot}</div>`;
}

function ovComplete() {
  const v = voice(state);
  const e = overlay.entry;
  return `<div class="modal" role="dialog" aria-labelledby="ct">
    <h2 id="ct">${esc(v.complete)}</h2>
    <p>${fmtMin(e.focusMs)} of focus${e.pauses ? `, ${e.pauses} ${e.pauses === 1 ? 'pause' : 'pauses'}` : ''}. Clean streak: <b style="color:var(--gold)">${state.streak}</b>.</p>
    ${overlay.pardon ? `<div class="notice gold" style="width:auto">${esc(v.pardonEarned)}</div>` : ''}
    <p style="color:var(--fg)">${esc(v.completeAsk(e.intention))}</p>
    <div class="actions">
      <button class="btn primary" type="button" data-act="outcome" data-v="yes" autofocus>Yes</button>
      <button class="btn" type="button" data-act="outcome" data-v="partly">Partly</button>
      <button class="btn" type="button" data-act="outcome" data-v="no">No</button>
    </div></div>`;
}

function ovEmergency() {
  const t = now();
  return `<div class="modal" role="dialog" aria-labelledby="et">
    <h2 id="et">Emergency unlock</h2>
    <p>This ends the ${state.session ? 'session' : 'lockout'} right now with no lockout, debt or streak reset. You get one per week. The next one is available on Monday.</p>
    <p>It's recorded in the ledger as an emergency.</p>
    <div class="actions">
      <button class="btn danger solid" type="button" data-act="emergencyConfirm" ${E.emergencyAvailable(state, t) ? '' : 'disabled'}>Unlock now</button>
      <button class="btn primary" type="button" data-act="close" autofocus>Cancel</button>
    </div></div>`;
}

function ovReset() {
  return `<div class="modal" role="dialog" aria-labelledby="rt">
    <h2 id="rt">Reset everything?</h2>
    <p>This deletes your session types, blocklists, ledger, streak and pardons from this computer. It can't be undone.</p>
    <div class="actions">
      <button class="btn danger solid" type="button" data-act="resetConfirm">Delete everything</button>
      <button class="btn primary" type="button" data-act="close" autofocus>Cancel</button>
    </div></div>`;
}

// ---------- now playing ----------

media.subscribe((track) => {
  nowPlaying = track;
  fillNowPlaying();
});

function fillNowPlaying() {
  for (const slot of document.querySelectorAll('[data-np]')) fillSlot(slot, slot.dataset.np);
}

function fillSlot(slot, size) {
  const tr = nowPlaying;
  const base = (slot.dataset.base ??= slot.className); // keep the slot's own layout classes
  if (!tr) {
    slot.className = `${base} np ${size} empty`;
    slot.innerHTML = 'Nothing playing';
    delete slot.dataset.k;
    return;
  }
  const key = `${tr.title}|${tr.artist}|${tr.playing}|${tr.art ? 1 : 0}`;
  if (slot.dataset.k !== key) {
    slot.dataset.k = key;
    slot.className = `${base} np ${size}`;
    const hue = [...tr.title].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
    const btn = (act, label, path) => `<button type="button" data-act="${act}" aria-label="${label}"><svg viewBox="0 0 16 16"><path d="${path}"/></svg></button>`;
    const play = tr.playing ? btn('mToggle', 'Pause', 'M4 3h3v10H4zM9 3h3v10H9z') : btn('mToggle', 'Play', 'M4 2.5v11L13 8z');
    const art = tr.art
      ? `<div class="art" style="background:center / cover no-repeat url('${tr.art}')" aria-hidden="true"></div>`
      : `<div class="art" style="background:linear-gradient(135deg, hsl(${hue} 32% 46%), hsl(${(hue + 50) % 360} 38% 28%))" aria-hidden="true">${esc(tr.title[0])}</div>`;
    slot.innerHTML = `${art}
      <div class="meta">
        <div class="t">${esc(tr.title)}${tr.sample && size !== 'mini' ? '<span class="sample">Sample</span>' : ''}</div>
        <div class="a">${esc(tr.artist)}${size === 'mini' ? '' : ` · ${esc(tr.source)}`}</div>
        <div class="bar"><b></b></div>
      </div>
      <div class="ctl">
        ${size === 'mini' ? play : btn('mPrev', 'Previous track', 'M3 3h2v10H3zM13 3v10L6 8z') + play + btn('mNext', 'Next track', 'M11 3h2v10h-2zM3 3v10l7-5z')}
      </div>`;
  }
  const bar = slot.querySelector('.bar b');
  if (bar) bar.style.width = tr.durationMs ? `${Math.min(100, (tr.positionMs / tr.durationMs) * 100)}%` : '100%';
}

// ---------- blocking ----------

// stage "warn": the user landed on a blocked site and has 5 seconds to close the
// tab (the native side shows a Windows notification); count it, show nothing.
// stage "block": the window was pushed away; show the block screen.
blocker.onAttempt(({ target, stage = 'block', warned = false }) => {
  const t = now();
  if (E.isBlocked(state, target, t)) {
    if (!warned) E.recordAttempt(state, target, t);
    commit();
    if (stage === 'warn') return;
    overlay = { type: 'block', target };
    renderOverlay();
    updateLive(t);
  } else {
    toast(`${target} is allowed right now.`);
  }
});

// ---------- actions ----------

document.addEventListener('pointerdown', sounds.unlock, { passive: true });
document.addEventListener('keydown', sounds.unlock, { passive: true });

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-act]');
  if (!btn || btn.disabled) return;
  const act = btn.dataset.act;
  const t = now();
  switch (act) {
    case 'preview':
      sounds.play(btn.dataset.v);
      break;
    case 'updCheck':
      checkForUpdate(true);
      break;
    case 'updInstall':
      if (E.isLocked(state, t)) return;
      updateState = 'installing';
      render();
      updater.install().catch((err) => {
        updateState = 'error';
        updateError = String(err);
        render();
      });
      break;
    case 'sidebar':
      if (narrowMq.matches) mobileSidebar = !mobileSidebar;
      else {
        state.settings.sidebar = !state.settings.sidebar;
        commit();
      }
      applySidebar();
      break;
    case 'profile':
      state.profileId = btn.dataset.id;
      editProfileId = btn.dataset.id;
      commit();
      render();
      break;
    case 'cstep': {
      const p = E.getProfile(state, 'custom');
      const f = btn.dataset.f;
      const step = f === 'focusMin' ? 5 : 1;
      p[f] = E.clampField(f, p[f] + Number(btn.dataset.d) * step, p[f]);
      commit();
      render();
      break;
    }
    case 'start': {
      intentionDraft = $('#intention')?.value ?? intentionDraft;
      const ev2 = E.start(state, { intention: intentionDraft }, t);
      if (ev2[0]?.type === 'started') {
        intentionDraft = '';
        if (ev2[0].debtMs) toast(`${fmtMin(ev2[0].debtMs)} of debt added to this block.`, 'neg');
      }
      handle(ev2);
      break;
    }
    case 'pause':
      handle(E.requestPause(state, t));
      break;
    case 'blockPause':
      overlay = null;
      handle(E.requestPause(state, t));
      break;
    case 'cancelPause':
      handle(E.cancelPause(state));
      break;
    case 'resume':
      handle(E.resume(state, t));
      break;
    case 'quit':
      if (state.dev) {
        handle(E.quit(state, { reason: 'Dev build' }, t));
        toast('Session ended. Dev build: no penalties.');
        break;
      }
      overlay = { type: 'quit', step: 1 };
      renderOverlay();
      break;
    case 'fire':
      sounds.play(btn.dataset.v);
      notify(btn.textContent.trim(), 'Test notification from Togami Dev.');
      break;
    case 'phraseNext':
      overlay.step = 3;
      overlay.waitUntil = t + QUIT_WAIT_MS;
      renderOverlay();
      break;
    case 'quitConfirm':
    case 'quitPardon': {
      const reason = $('#reason')?.value ?? '';
      overlay = null;
      handle(E.quit(state, { reason, usePardon: act === 'quitPardon' }, t));
      if (act === 'quitPardon') toast('Pardon used. No lockout, no debt. The quit is in the ledger.', 'gold');
      break;
    }
    case 'emergency':
      overlay = { type: 'emergency' };
      renderOverlay();
      break;
    case 'emergencyConfirm':
      overlay = null;
      handle(E.emergency(state, t));
      toast('Unlocked. Recorded in the ledger as an emergency.');
      break;
    case 'outcome':
      E.setOutcome(state, overlay.entry.id, btn.dataset.v);
      overlay = null;
      commit();
      render();
      break;
    case 'close':
      overlay = null;
      renderOverlay();
      break;
    case 'mPrev':
      media.previous();
      break;
    case 'mToggle':
      media.toggle();
      break;
    case 'mNext':
      media.next();
      break;
    case 'editProfile':
      editProfileId = btn.dataset.id;
      render();
      break;
    case 'rm': {
      if (E.isLocked(state, t)) return;
      const i = Number(btn.dataset.i);
      if (btn.dataset.kind === 'allow') state.allowlist.splice(i, 1);
      else E.getProfile(state, editProfileId)[btn.dataset.kind].splice(i, 1);
      commit();
      render();
      break;
    }
    case 'voice':
      state.settings.voice = btn.dataset.v;
      commit();
      render();
      break;
    case 'theme':
      state.settings.theme = btn.dataset.v;
      applyTheme();
      commit();
      render();
      break;
    case 'addProfile': {
      if (E.isLocked(state, t)) return;
      const id = 'p' + Date.now().toString(36);
      state.profiles.splice(state.profiles.length - 1, 0, { id, name: 'New session', focusMin: 30, breakMin: 5, longBreakMin: 15, cycles: 3, apps: ['Discord'], sites: ['youtube.com'] });
      commit();
      render();
      break;
    }
    case 'rmProfile': {
      if (E.isLocked(state, t)) return;
      const i = Number(btn.dataset.i);
      if (state.profiles[i]?.custom || state.profiles.filter((p) => !p.custom).length < 2) return;
      const [gone] = state.profiles.splice(i, 1);
      if (state.profileId === gone.id) state.profileId = state.profiles[0].id;
      if (editProfileId === gone.id) editProfileId = state.profileId;
      commit();
      render();
      break;
    }
    case 'clearSamples':
      clearSamples(state);
      commit();
      render();
      break;
    case 'reset':
      overlay = { type: 'reset' };
      renderOverlay();
      break;
    case 'resetConfirm':
      if (E.isLocked(state, t)) return;
      store.wipe();
      clock.reset();
      state = E.defaultState();
      editProfileId = state.profileId;
      overlay = null;
      applyTheme();
      applySidebar();
      commit();
      render();
      toast('Everything was reset.');
      break;
    // test bench
    case 'speed':
      clock.setSpeed(Number(btn.dataset.v));
      renderBench();
      break;
    case 'skip':
      clock.skip(Number(btn.dataset.v) * 60_000);
      loop();
      break;
    case 'sim':
      blocker.simulate(btn.dataset.v);
      break;
    case 'music':
      media.setEnabled(!media.isEnabled());
      renderBench();
      break;
    case 'closeGap':
      handle(E.checkClosedGap(state, Date.now() - 2 * 60_000, Date.now(), t), { closed: true });
      break;
  }
});

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.id === 'intention') intentionDraft = el.value;
  if (el.id === 'phrase') {
    const norm = (s) => s.toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim();
    $('#phraseNext').disabled = norm(el.value) !== norm(QUIT_PHRASE);
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'F11') {
    ev.preventDefault();
    appWindow.toggleFullscreen();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && ev.key === '\\') {
    ev.preventDefault();
    $('[data-act="sidebar"]').click();
    return;
  }
  if (ev.key === 'Enter' && ev.target.id === 'intention') {
    ev.preventDefault();
    $('[data-act="start"]')?.click();
  }
  if (ev.key === 'Enter' && ev.target.id === 'phrase' && !$('#phraseNext').disabled) $('#phraseNext').click();
  if (ev.key === 'Escape' && overlay && overlay.type !== 'complete') {
    overlay = null;
    renderOverlay();
  }
});

// paste is allowed into the intention, not into the quit sentence
document.addEventListener('paste', (ev) => {
  if (ev.target.id === 'phrase') ev.preventDefault();
});

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('[data-form]');
  if (!form) return;
  ev.preventDefault();
  if (E.isLocked(state, now())) return;
  const kind = form.dataset.form;
  const input = form.querySelector('input');
  let val = input.value.trim();
  if (!val) return;
  if (kind === 'sites' || (kind === 'allow' && /\./.test(val) && !/\s/.test(val))) {
    val = val.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  }
  const list = kind === 'allow' ? state.allowlist : E.getProfile(state, editProfileId)[kind];
  if (list.some((x) => x.toLowerCase() === val.toLowerCase())) {
    toast(`${val} is already on the list.`);
  } else {
    list.push(val);
    commit();
  }
  render();
  $(`#add-${kind}`)?.focus();
});

document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.id === 'setSounds' || el.id === 'setNotify') {
    state.settings[el.id === 'setSounds' ? 'sounds' : 'notify'] = el.checked;
    commit();
    return;
  }
  if (E.isLocked(state, now())) return;
  if (el.id === 'blockBreaks') {
    state.settings.blockBreaks = el.checked;
    commit();
    render();
  }
  if (el.dataset.cf) {
    const p = E.getProfile(state, 'custom');
    p[el.dataset.cf] = E.clampField(el.dataset.cf, el.value, p[el.dataset.cf]);
    commit();
    render();
  }
  if (el.dataset.pf) {
    const p = state.profiles[Number(el.dataset.i)];
    const f = el.dataset.pf;
    if (f === 'name') p.name = el.value.trim() || p.name;
    else p[f] = E.clampField(f, el.value, p[f]);
    commit();
    render();
  }
});

// hold-to-quit: pointer or keyboard, 5 seconds of real time
function bindHold() {
  const btn = $('#holdBtn');
  if (!btn) return;
  let raf = 0;
  let started = 0;
  const stop = () => {
    cancelAnimationFrame(raf);
    started = 0;
    btn.style.setProperty('--h', '0%');
  };
  const frame = () => {
    const p = Math.min(1, (Date.now() - started) / HOLD_MS);
    btn.style.setProperty('--h', `${p * 100}%`);
    if (p >= 1) {
      overlay.step = 2;
      renderOverlay();
      return;
    }
    raf = requestAnimationFrame(frame);
  };
  const go = (e) => {
    if (started) return;
    e.preventDefault();
    started = Date.now();
    raf = requestAnimationFrame(frame);
  };
  btn.addEventListener('pointerdown', go);
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointerleave', stop);
  btn.addEventListener('pointercancel', stop);
  btn.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') go(e);
  });
  btn.addEventListener('keyup', stop);
  btn.addEventListener('blur', stop);
}

// ---------- updates (desktop app) ----------

function updateText() {
  if (updateState === 'installing') return 'Downloading the update. Togami restarts when it is installed.';
  if (updateState === 'error') return `Update failed: ${updateError}`;
  if (updateInfo) return `Version ${updateInfo.version} is ready to install.`;
  if (updateState === 'checking') return 'Checking for updates…';
  if (updateState === 'none') return 'You have the latest version.';
  return 'Updates are checked when Togami starts and every few hours.';
}

async function checkForUpdate(manual = false) {
  if (!updater.available || updateState === 'installing') return;
  updateState = 'checking';
  if (manual) render();
  try {
    updateInfo = await updater.check();
    updateState = updateInfo ? 'idle' : 'none';
  } catch (err) {
    updateState = manual ? 'error' : 'idle';
    updateError = String(err);
  }
  renderUpdateLine();
  if (route === 'settings') render();
}

/** Small "update ready" line in the sidebar. Hidden while a session or lockout runs. */
function renderUpdateLine() {
  const el = $('#updLine');
  if (!el) return;
  const show = updateInfo && !E.isLocked(state, now());
  el.hidden = !show;
  if (show) el.innerHTML = `<span>Update ${esc(updateInfo.version)} ready</span><a href="#settings">Install</a>`;
}

if (updater.available) {
  updater.version().then((v) => {
    appVersion = v;
    if (route === 'settings') render();
  });
  setTimeout(checkForUpdate, 8000);
  setInterval(checkForUpdate, 6 * 60 * 60 * 1000);
}

// ---------- misc ----------

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

function applySidebar() {
  const open = narrowMq.matches ? mobileSidebar : state.settings.sidebar;
  shell.classList.toggle('sb-hidden', !open);
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4200);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
}

function glint() {
  const b = $('.brand');
  b.classList.remove('glint');
  void b.offsetWidth;
  b.classList.add('glint');
}

// ---------- test bench (browser build and Togami Dev) ----------

if (!isNative || isDev) {
  benchToggle.hidden = false;
  benchToggle.addEventListener('click', () => {
    bench.hidden = !bench.hidden;
    benchToggle.textContent = bench.hidden ? 'Test bench' : 'Close test bench';
    renderBench();
  });
}

// Togami Dev: live readout of what the blocker sees in front
if (isDev) {
  setInterval(async () => {
    const el = $('#seen');
    if (!el || bench.hidden) return;
    const s = await blocker.seen();
    if (!s) return;
    el.innerHTML = `<b>${esc(s.exe)}</b> · ${esc(s.title || '(no title)')}<br>address: ${esc(s.url ?? '(not read)')}<br>${s.target ? `<span style="color:var(--neg)">blocked as ${esc(s.target)}</span>` : 'not blocked'}`;
  }, 1000);
}

function renderBench() {
  if ((isNative && !isDev) || bench.hidden) return;
  const sp = clock.getSpeed();
  bench.innerHTML = `
    <h3>Test bench</h3>
    <p>${isDev ? 'Togami Dev. Blocking is real; these buttons only simulate.' : 'This build simulates Windows. The real app watches open windows and browser tabs.'}</p>
    <div><h3 style="margin-bottom:6px">Clock speed</h3><div class="row">
      ${[1, 10, 60].map((x) => `<button class="btn" type="button" data-act="speed" data-v="${x}" aria-pressed="${sp === x}">${x}×</button>`).join('')}
      <button class="btn" type="button" data-act="skip" data-v="1">+1 min</button>
      <button class="btn" type="button" data-act="skip" data-v="5">+5 min</button>
    </div></div>
    ${isDev ? `<div><h3 style="margin-bottom:6px">Blocker sees</h3><p class="seen" id="seen">Start a session, then switch to another window.</p></div>` : ''}
    <div><h3 style="margin-bottom:6px">Try to open</h3><div class="row">
      ${['Discord', 'Steam', 'youtube.com', 'reddit.com', 'docs.google.com'].map((x) => `<button class="btn" type="button" data-act="sim" data-v="${x}">${x}</button>`).join('')}
    </div></div>
    <div><h3 style="margin-bottom:6px">Jingle and notification</h3><div class="row">
      ${[['workStart', 'Focus started'], ['breakStart', 'Break time'], ['breakEnd', 'Break over'], ['sessionEnd', 'Session complete']].map(([k, l]) => `<button class="btn" type="button" data-act="fire" data-v="${k}">${l}</button>`).join('')}
    </div></div>
    ${isNative ? '' : `<div><h3 style="margin-bottom:6px">Other</h3><div class="row">
      <button class="btn" type="button" data-act="music" aria-pressed="${media.isEnabled()}">Sample music</button>
      <button class="btn" type="button" data-act="closeGap" ${state.session ? '' : 'disabled'}>Close Togami for 2 min</button>
    </div></div>`}`;
}
