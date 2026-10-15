// Projection mapper server: serves the player (/player) and the control page (/), keeps the show state,
// and pushes every change to all open pages over Server-Sent Events. Node built-ins only, no packages.
// Home Wi-Fi only: there is no login, so never expose this port to the internet.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { defaultState, normalizeState } from './public/js/model.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const BUILTIN_SCENES = path.join(PUB, 'scenes');
const DATA = process.env.PM_DATA || path.join(ROOT, 'data');
const MEDIA = path.join(DATA, 'media');
const LAYOUTS = path.join(DATA, 'layouts');
const USER_SCENES = path.join(DATA, 'scenes');
const STATE_FILE = path.join(DATA, 'state.json');
const PORT = +process.env.PORT || 8080;
for (const d of [DATA, MEDIA, LAYOUTS, USER_SCENES]) fs.mkdirSync(d, { recursive: true });

let state;
try { state = normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); }
catch { state = defaultState(); }

let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(state, null, 1), (e) => { if (!e) fs.rename(tmp, STATE_FILE, () => {}); });
  }, 400);
}

const clients = new Set();
function broadcast(origin) {
  const msg = `event: state\ndata: ${JSON.stringify({ state, origin })}\n\n`;
  for (const c of clients) c.write(msg);
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,100}$/;
const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

function safeJoin(base, rel) {
  const p = path.resolve(base, '.' + path.sep + decodeURIComponent(rel));
  return p.startsWith(base + path.sep) ? p : null;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function sendFile(req, res, file) {
  let st;
  try { st = await fsp.stat(file); } catch { st = null; }
  if (!st || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    // Byte ranges, so <video> can stream and loop large files.
    const start = range[1] ? +range[1] : 0, end = range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

async function listFiles(dir, ext) {
  try { return (await fsp.readdir(dir)).filter((f) => !ext || f.endsWith(ext)).sort(); } catch { return []; }
}

async function handleApi(req, res, parts) {
  const [, , what, name] = parts; // ['', 'api', what, name]
  const m = req.method;

  if (what === 'state') {
    if (m === 'GET') return json(res, 200, state);
    if (m === 'PUT') {
      const body = JSON.parse((await readBody(req, 2e6)).toString('utf8'));
      if (!body || !body.state || !Array.isArray(body.state.surfaces)) return json(res, 400, { error: 'Expected { state, origin }' });
      const version = (state.version | 0) + 1;
      state = normalizeState(body.state);
      state.version = version;
      saveSoon();
      broadcast(body.origin || null);
      return json(res, 200, { version });
    }
  }

  if (what === 'events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify({ state, origin: null })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (what === 'scenes') {
    if (m === 'GET' && !name) {
      const ids = new Set([...(await listFiles(BUILTIN_SCENES, '.js')), ...(await listFiles(USER_SCENES, '.js'))].map((f) => f.slice(0, -3)));
      return json(res, 200, [...ids].sort());
    }
    if (m === 'PUT' && name && SCENE_ID.test(name)) {
      // A scene is an ES module (see public/scenes/README.md). Runs in the player: home network only.
      await fsp.writeFile(path.join(USER_SCENES, name + '.js'), await readBody(req, 512e3));
      return json(res, 200, { ok: true, id: name });
    }
  }

  if (what === 'media') {
    if (m === 'GET' && !name) return json(res, 200, await listFiles(MEDIA));
    const file = name && NAME.test(decodeURIComponent(name)) ? safeJoin(MEDIA, name) : null;
    if (!file) return json(res, 400, { error: 'Bad file name' });
    if (m === 'PUT') {
      const tmp = file + '.part';
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmp);
        req.pipe(out); out.on('finish', resolve); out.on('error', reject); req.on('error', reject);
      });
      await fsp.rename(tmp, file);
      return json(res, 200, { ok: true });
    }
    if (m === 'DELETE') { await fsp.rm(file, { force: true }); return json(res, 200, { ok: true }); }
  }

  if (what === 'layouts') {
    if (m === 'GET' && !name) return json(res, 200, (await listFiles(LAYOUTS, '.json')).map((f) => f.slice(0, -5)));
    const file = name && NAME.test(decodeURIComponent(name)) ? safeJoin(LAYOUTS, name + '.json') : null;
    if (!file) return json(res, 400, { error: 'Bad layout name' });
    if (m === 'GET') {
      try { return json(res, 200, JSON.parse(await fsp.readFile(file, 'utf8'))); } catch { return json(res, 404, { error: 'No such layout' }); }
    }
    if (m === 'PUT') {
      const body = JSON.parse((await readBody(req, 2e6)).toString('utf8'));
      await fsp.writeFile(file, JSON.stringify({ surfaces: body.surfaces || [], masks: body.masks || [], output: body.output }, null, 1));
      return json(res, 200, { ok: true });
    }
    if (m === 'DELETE') { await fsp.rm(file, { force: true }); return json(res, 200, { ok: true }); }
  }

  json(res, 404, { error: 'Unknown API route' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p.startsWith('/api/')) return await handleApi(req, res, p.split('/'));
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (p === '/' || p === '/control') return sendFile(req, res, path.join(PUB, 'control.html'));
    if (p === '/player') return sendFile(req, res, path.join(PUB, 'player.html'));
    if (p.startsWith('/scenes/')) {
      const rel = p.slice('/scenes/'.length);
      const user = safeJoin(USER_SCENES, rel);
      if (user && fs.existsSync(user)) return sendFile(req, res, user);
      const builtin = safeJoin(BUILTIN_SCENES, rel);
      return builtin ? sendFile(req, res, builtin) : (res.writeHead(404), res.end());
    }
    if (p.startsWith('/media/')) {
      const f = safeJoin(MEDIA, p.slice('/media/'.length));
      return f ? sendFile(req, res, f) : (res.writeHead(404), res.end());
    }
    const f = safeJoin(PUB, p.slice(1));
    return f ? sendFile(req, res, f) : (res.writeHead(404), res.end());
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`Projection mapper on port ${PORT}`);
  for (const ip of ['localhost', ...ips]) console.log(`  control: http://${ip}:${PORT}/   player: http://${ip}:${PORT}/player`);
});
