// Serves app/ on http://localhost:5173 (module scripts don't load from file://).
// /packs/* comes from the gitignored packs/ folder, so a local pet pack can be
// tried in the browser without ever landing in app/ (which the desktop app embeds).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../app/', import.meta.url));
const packs = fileURLToPath(new URL('../packs/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };
const port = Number(process.env.PORT) || 5173;

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  const pack = /^packs[/\\]/.test(path);
  const base = pack ? packs : root;
  const file = join(base, pack ? path.slice(6) : path || 'index.html');
  if (!file.startsWith(base)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    const type = types[extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': /^(image|font)\//.test(type) ? type : type + '; charset=utf-8' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, () => console.log(`Togami on http://localhost:${port}`));
