// The snip window (snip.html, Windows): shows the grabbed screen, lets you
// drag out an area, and hands it to the Ask window as a JPEG.

import { toJpeg } from './image.js';

const T = globalThis.__TAURI__;
const $ = (s) => document.querySelector(s);
const canvas = $('#shot');
const dim = $('#dim');
const sel = $('#sel');

let start = null; // where the drag began, in CSS pixels
let done = false;

boot();

async function boot() {
  try {
    const buf = await T.core.invoke('snip_image');
    const view = new DataView(buf);
    const w = view.getUint32(0, true);
    const h = view.getUint32(4, true);
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf, 8, w * h * 4), w, h), 0, 0);
  } catch {
    return cancel();
  }
  await T.core.invoke('snip_ready');
}

function cancel() {
  if (done) return;
  done = true;
  T.core.invoke('snip_cancel');
}

/** The selection from the drag start to (x, y), in CSS pixels. */
function rect(x, y) {
  return { x: Math.min(start.x, x), y: Math.min(start.y, y), w: Math.abs(x - start.x), h: Math.abs(y - start.y) };
}

addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || done) return;
  start = { x: e.clientX, y: e.clientY };
  $('#hint').hidden = true;
});

addEventListener('pointermove', (e) => {
  if (!start) return;
  const r = rect(e.clientX, e.clientY);
  dim.hidden = true;
  sel.hidden = false;
  Object.assign(sel.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
});

addEventListener('pointerup', (e) => {
  if (!start || done) return;
  let r = rect(e.clientX, e.clientY);
  start = null;
  // a click (no real drag) takes the whole screen
  if (r.w < 8 || r.h < 8) r = { x: 0, y: 0, w: innerWidth, h: innerHeight };
  const kx = canvas.width / innerWidth;
  const ky = canvas.height / innerHeight;
  const image = toJpeg(canvas, Math.round(r.x * kx), Math.round(r.y * ky), Math.max(1, Math.round(r.w * kx)), Math.max(1, Math.round(r.h * ky)));
  done = true;
  T.core.invoke('snip_done', { image }).catch(() => T.core.invoke('snip_cancel'));
});

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancel();
});
addEventListener('contextmenu', (e) => {
  e.preventDefault();
  cancel();
});
