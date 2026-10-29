// Checks a pet pack folder before it is zipped: every file pet.json, style.css
// and layout.html point at exists, the required layout ids are there, lines
// only use placeholders their moment gets. See blank_pet/AI_PACK_GUIDE.md.
// Usage: npm run check-pack [-- <folder>]   (default: blank_pet)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2] || 'blank_pet';
const errors = [], warnings = [];
const ok = /\.(webp|png|woff2|woff|ttf|otf|css|html)$/i;
const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
const has = (f) => files.includes(f);
let pack;
try { pack = JSON.parse(readFileSync(join(dir, 'pet.json'), 'utf8')); } catch (e) { console.log('ERROR pet.json missing or not valid JSON: ' + e.message); process.exit(1); }
for (const f of ['style.css', 'layout.html']) if (!has(f)) errors.push(`${f} is missing`);
if (readdirSync(dir).some((f) => statSync(join(dir, f)).isDirectory())) warnings.push('subfolders are ignored on import; keep every file next to pet.json');
const total = files.filter((f) => ok.test(f) || f === 'pet.json').reduce((n, f) => n + statSync(join(dir, f)).size, 0);
if (total > 64 * 1024 * 1024) errors.push(`pack is ${(total / 1048576).toFixed(1)} MB; the limit is 64 MB`);
if (typeof pack.name !== 'string' || !pack.name.trim()) errors.push('"name" must be a non-empty string');
const ex = pack.expressions;
if (!ex || typeof ex !== 'object' || !Object.keys(ex).length) errors.push('"expressions" must be an object with at least one expression');
else {
  if (!ex[pack.idle]) errors.push(`"idle" (${JSON.stringify(pack.idle)}) is not one of the expressions`);
  for (const [n, e] of Object.entries(ex)) {
    if (!e.open) errors.push(`expression "${n}" has no "open" frame`);
    for (const f of [...(e.intro || []), e.open, e.closed].filter(Boolean)) {
      if (!/\.(webp|png)$/i.test(f)) errors.push(`expression "${n}": ${f} must be .webp or .png`);
      else if (!has(f)) errors.push(`expression "${n}": ${f} is not in the folder (names are case-sensitive)`);
    }
    if (!e.closed) warnings.push(`expression "${n}" has no "closed" frame, so it won't blink`);
  }
}
const MOMENTS = ['hello', 'workStart', 'breakStart', 'breakEnd', 'sessionEnd', 'blockWarn', 'block', 'pauseRequested', 'paused', 'resumed', 'quit', 'lockout', 'lockoutEnded', 'pardon', 'update', 'idle', 'late', 'poke'];
const VARS = { workStart: ['intention', 'min'], breakStart: ['intention', 'min'], breakEnd: ['intention', 'min'], blockWarn: ['target'], block: ['target'], lockout: ['min'], update: ['version'] };
for (const [m, lines] of Object.entries(pack.lines || {})) {
  if (!MOMENTS.includes(m)) { errors.push(`lines: unknown moment "${m}"`); continue; }
  if (!Array.isArray(lines)) { errors.push(`lines.${m} must be an array`); continue; }
  lines.forEach((l, i) => {
    if (typeof l?.t !== 'string' || !l.t) errors.push(`lines.${m}[${i}] has no "t" text`);
    else for (const [, v] of l.t.matchAll(/\{(\w+)\}/g)) if (!(VARS[m] || []).includes(v)) errors.push(`lines.${m}[${i}] uses {${v}}, which ${m} never gets, so the line can never be used`);
    if (l?.e && ex && !ex[l.e]) errors.push(`lines.${m}[${i}] uses expression "${l.e}", which doesn't exist`);
    if (l?.t?.length > 90) warnings.push(`lines.${m}[${i}] is ${l.t.length} characters; it may overflow the box`);
  });
  if (lines.length && lines.every((l) => /\{intention\}/.test(l?.t || ''))) warnings.push(`lines.${m}: every line uses {intention}, which is empty when the user typed none; add a line without it`);
}
for (const m of MOMENTS) if (!pack.lines?.[m]?.length) warnings.push(`no lines for "${m}" (a plain built-in line is used)`);
if (has('layout.html')) {
  const html = readFileSync(join(dir, 'layout.html'), 'utf8');
  for (const id of ['card', 'sprite', 'bubble', 'text']) if (!new RegExp(`id=["']${id}["']`).test(html)) errors.push(`layout.html has no element with id="${id}"`);
  if (!/<img\b[^>]*\bid=["']sprite["']/.test(html)) errors.push('#sprite must be an <img>');
  if (/<script|\son\w+=/i.test(html)) warnings.push('layout.html has scripts or on* handlers; they are removed on load');
  for (const [, f] of html.matchAll(/\s(?:src|href)=["']([^"'#][^"']*)["']/g)) if (!has(f)) errors.push(`layout.html points at ${f}, which is not in the folder`);
}
if (has('style.css')) {
  const css = readFileSync(join(dir, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, , f] of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) if (f && !f.startsWith('#') && !f.startsWith('data:') && !has(f.replace(/^\.\//, ''))) errors.push(`style.css url(${f}) is not a file in the folder (it will be dropped)`);
  if (/@import/i.test(css)) warnings.push('style.css @import is removed on load');
}
for (const f of files) if (!ok.test(f) && f !== 'pet.json') warnings.push(`${f} is not a pack file type and is left out on import (fine for notes and licences)`);
for (const w of warnings) console.log('warning ' + w);
for (const e of errors) console.log('ERROR ' + e);
console.log(errors.length ? `\n${errors.length} error(s): fix them before zipping.` : `\nOK: ${pack.name} is a valid pack (${warnings.length} warning(s)).`);
process.exit(errors.length ? 1 : 0);
