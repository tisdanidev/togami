// Bundles app/ into one HTML file (dist/togami.html) for the claude.ai test
// artifact: CSS and JS inlined, no doctype/html/head/body (the host adds them).
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const app = new URL('../app/', import.meta.url);
const html = await readFile(new URL('index.html', app), 'utf8');
const css = await readFile(new URL('styles.css', app), 'utf8');
const googleFonts = await readFile(new URL('./google-fonts.txt', import.meta.url), 'utf8');
const js = await build({
  entryPoints: [new URL('js/main.js', app).pathname],
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  target: 'es2022',
});

const head = html.match(/<head>([\s\S]*)<\/head>/)[1]
  .replace(/<meta[^>]*>\s*/g, '')
  .replace('<link rel="stylesheet" href="styles.css" />', () => `<style>\n${css}</style>`)
  // the desktop app ships its fonts; the web test build loads them from Google Fonts
  .replace('<link rel="stylesheet" href="fonts/fonts.css" />\n', () => googleFonts);
const body = html.match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script type="module" src="js\/main.js"><\/script>/, () => `<script>${js.outputFiles[0].text}</script>`);

await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
const out = new URL('../dist/togami.html', import.meta.url);
await writeFile(out, head.trim() + '\n' + body.trim() + '\n');
console.log(`Wrote ${out.pathname} (${Math.round((head.length + body.length) / 1024)} KB)`);
