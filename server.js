// Projection mapper server: serves the guest page (/), the PIN-locked setup page (/setup) and the player
// (/player), keeps the show state, runs the party prompt queue, and pushes every change to all open pages over
// Server-Sent Events. Home network only: never expose these ports to the internet.
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { defaultState, normalizeState } from './public/js/model.js';
import { createParty } from './party-server.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const BUILTIN_SCENES = path.join(PUB, 'scenes');
const DATA = process.env.PM_DATA || path.join(ROOT, 'data');
const MEDIA = path.join(DATA, 'media');
const LAYOUTS = path.join(DATA, 'layouts');
const USER_SCENES = path.join(DATA, 'scenes');
const STATE_FILE = path.join(DATA, 'state.json');
const PORT = +process.env.PORT || 8080;
const HTTPS_PORT = +process.env.HTTPS_PORT || 8443;
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
function broadcastEvent(name, data) {
  const msg = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
const broadcast = (origin) => broadcastEvent('state', { state, origin });
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000);

// Server-side state change (party playback): bump the version, save, push to everyone.
function updateState(fn) {
  fn(state);
  state.version = (state.version | 0) + 1;
  saveSoon();
  broadcast(null);
}

// Settings that never go to the browser: the setup PIN, login tokens and the Claude API key.
const CONFIG_FILE = path.join(DATA, 'config.json');
let configData = {};
try { configData = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { configData = {}; }
const config = {
  get: () => configData,
  set(patch) { configData = { ...configData, ...patch }; fs.writeFileSync(CONFIG_FILE, JSON.stringify(configData, null, 1)); },
};
const pinSet = () => !!(process.env.PM_PIN || configData.pin);
const hashPin = (pin) => crypto.createHash('sha256').update('pm:' + pin).digest('hex');
function pinMatches(pin) {
  if (process.env.PM_PIN) return String(pin) === process.env.PM_PIN;
  return configData.pin && hashPin(String(pin)) === configData.pin;
}
function isHost(req) {
  if (!pinSet()) return true; // first run: open until a PIN is chosen
  const m = /(?:^|;\s*)pm_auth=([a-f0-9]{48})/.exec(req.headers.cookie || '');
  return !!(m && (configData.tokens || []).includes(m[1]));
}
function issueToken(res) {
  const token = crypto.randomBytes(24).toString('hex');
  config.set({ tokens: [...(configData.tokens || []), token].slice(-20) });
  res.setHeader('Set-Cookie', `pm_auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
}
const guestId = (req) => (req.socket.remoteAddress || '') + '|' + ((/(?:^|;\s*)pm_guest=([a-z0-9]{6,20})/.exec(req.headers.cookie || '') || [])[1] || '');

const party = createParty({ DATA, USER_SCENES, config, getState: () => state, updateState, broadcastEvent });

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
  const [, , what, name, action] = parts; // ['', 'api', what, name, action]
  const m = req.method;
  const readJson = async (limit = 2e6) => JSON.parse((await readBody(req, limit)).toString('utf8') || '{}');

  // ---- open to everyone: login, guest prompts, compile results ----
  if (what === 'auth') {
    if (m === 'GET') return json(res, 200, { host: isHost(req), pinSet: pinSet(), lan: ips, port: PORT });
    if (m === 'POST') {
      const { pin, newPin } = await readJson(4096);
      if (!pinSet()) {
        if (!/^\d{4,8}$/.test(String(newPin || ''))) return json(res, 400, { error: 'Choose a PIN of 4 to 8 digits.' });
        config.set({ pin: hashPin(String(newPin)) });
        issueToken(res);
        return json(res, 200, { ok: true });
      }
      if (!pinMatches(pin)) { await new Promise((r) => setTimeout(r, 800)); return json(res, 403, { error: 'Wrong PIN' }); }
      issueToken(res);
      return json(res, 200, { ok: true });
    }
  }

  if (what === 'queue' && !name) {
    if (m === 'GET') return json(res, 200, isHost(req) && /admin/.test(req.url) ? party.adminView() : party.publicView());
    if (m === 'POST') {
      const body = await readJson(8192);
      const r = party.submit(body, guestId(req));
      return json(res, r.error ? 400 : 200, r);
    }
  }
  if (what === 'compile' && m === 'POST') { party.compileResult(await readJson(64e3)); return json(res, 200, { ok: true }); }

  // ---- everything else that changes something is for the host only ----
  if (m !== 'GET' && !isHost(req)) return json(res, 401, { error: 'Setup PIN required' });

  if (what === 'queue' && name && m === 'POST') {
    const r = party.admin(action, name);
    return json(res, r.error ? 400 : 200, r);
  }

  if (what === 'config') {
    if (!isHost(req)) return json(res, 401, { error: 'Setup PIN required' });
    if (m === 'GET') {
      return json(res, 200, { apiKey: configData.apiKey ? 'saved' : process.env.ANTHROPIC_API_KEY ? 'environment' : 'none', model: party.model });
    }
    if (m === 'POST') {
      const body = await readJson(8192);
      if (typeof body.apiKey === 'string') config.set({ apiKey: body.apiKey.trim() || undefined });
      if (body.newPin !== undefined) {
        if (!/^\d{4,8}$/.test(String(body.newPin))) return json(res, 400, { error: 'Choose a PIN of 4 to 8 digits.' });
        config.set({ pin: hashPin(String(body.newPin)), tokens: [] });
        issueToken(res);
      }
      return json(res, 200, { ok: true });
    }
  }

  if (what === 'state') {
    if (m === 'GET') return json(res, 200, state);
    if (m === 'PUT') {
      const body = await readJson();
      if (!body || !body.state || !Array.isArray(body.state.surfaces)) return json(res, 400, { error: 'Expected { state, origin }' });
      const version = (state.version | 0) + 1;
      const partyNow = state.partyNow; // owned by the server's party playback
      state = normalizeState(body.state);
      state.partyNow = partyNow;
      state.version = version;
      saveSoon();
      broadcast(body.origin || null);
      return json(res, 200, { version });
    }
  }

  if (what === 'events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify({ state, origin: null })}\n\n`);
    res.write(`event: queue\ndata: ${JSON.stringify(party.publicView())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (what === 'scenes') {
    if (m === 'GET' && !name) {
      // Guests' generated scenes (g-*) are left out unless ?all=1.
      const all = /all=1/.test(req.url);
      const ids = new Set([...(await listFiles(BUILTIN_SCENES, '.js')), ...(await listFiles(USER_SCENES, '.js'))]
        .map((f) => f.slice(0, -3)).filter((id) => all || !id.startsWith('g-')));
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

async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p.startsWith('/api/')) return await handleApi(req, res, p.split('/'));
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (p === '/') {
      // Give each guest's browser an id, so the per-guest queue limit works behind one Wi-Fi address.
      if (!/(?:^|;\s*)pm_guest=/.test(req.headers.cookie || '')) res.setHeader('Set-Cookie', `pm_guest=${crypto.randomBytes(8).toString('hex')}; Path=/; SameSite=Lax; Max-Age=31536000`);
      return sendFile(req, res, path.join(PUB, 'party.html'));
    }
    if (p === '/setup' || p === '/control') return sendFile(req, res, path.join(PUB, 'control.html'));
    if (p === '/qr') return sendFile(req, res, path.join(PUB, 'qr.html'));
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
}

const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);

// Self-signed certificate for the https address, for phones that refuse plain http. Made once with openssl
// (on PATH, or the copy that comes with Git for Windows); browsers warn once and then allow it.
function ensureCert() {
  const key = path.join(DATA, 'key.pem'), cert = path.join(DATA, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    const host = os.hostname();
    const san = ['DNS:localhost', `DNS:${host}`, `DNS:${host}.local`, 'IP:127.0.0.1', ...ips.map((ip) => 'IP:' + ip)].join(',');
    const candidates = ['openssl', 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe', 'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe'];
    let made = false;
    for (const exe of candidates) {
      try {
        execFileSync(exe, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-keyout', key, '-out', cert,
          '-subj', '/CN=Projection Mapper', '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
        made = true;
        break;
      } catch { /* try the next one */ }
    }
    if (!made) return null;
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

http.createServer(handler).listen(PORT, '0.0.0.0', () => {
  console.log(`Projection mapper on port ${PORT}`);
  for (const ip of ['localhost', ...ips]) console.log(`  control: http://${ip}:${PORT}/   player: http://${ip}:${PORT}/player`);
});

const tls = ensureCert();
if (tls) {
  https.createServer(tls, handler).listen(HTTPS_PORT, '0.0.0.0', () => {
    for (const ip of ips) console.log(`  secure: https://${ip}:${HTTPS_PORT}/  (self-signed: accept the warning once)`);
  });
} else console.log('  (no openssl found, so no https address)');
