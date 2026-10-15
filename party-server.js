// Party mode: guests send prompts, Claude writes a GLSL scene for each one, and the scenes play in turn on the
// party surface. The queue lives in data/queue.json; generated scenes go to data/scenes/g-<id>.js.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { uid, partySurface } from './public/js/model.js';
import { surfaceAspect, outputToSurface } from './public/js/geometry.js';

const MODEL = 'claude-opus-5-5';
const MAX_PENDING_PER_GUEST = 3;
const CONCURRENT = 2;
const COMPILE_WAIT_MS = 8000;
const MAX_FIX_ATTEMPTS = 2;

const SYSTEM_PROMPT = `You create animations for a projection-mapping show at a family Halloween party. A projector mounted high
up projects onto a grey concrete driveway at night; guests (including kids) scan a QR code, type an idea on their
phone, and your animation plays on the driveway for about a minute while everyone watches and walks through it.

Write each animation as a GLSL ES 1.00 (WebGL 1) fragment shader for this engine:
- The engine prepends this header; do NOT redeclare any of it:
    precision highp float;   (mediump on GPUs without highp)
    varying vec2 v_uv;       // 0..1 across the surface; x to the right, y UP (y = 1 is the top edge)
    uniform float u_time;    // seconds since your animation started (wraps after an hour)
    uniform vec2 u_res;      // render size in pixels; its aspect matches the real surface
  plus one uniform per param you declare: colour params become "uniform vec3 u_<key>;" and range params
  "uniform float u_<key>;". Don't declare those either.
- Write helper functions and "void main(){ ... gl_FragColor = vec4(col, 1.0); }".
- WebGL 1 rules: loops need constant bounds ("for (int i = 0; i < 8; i++)"); no dynamic array indexing; float
  literals need a decimal point (1.0 not 1); no texture lookups, no derivatives (dFdx/fwidth), no #version,
  #extension or #define with arguments that recurse; smoothstep(a, b, x) needs a < b.
- Performance: it runs at about 1024 px on a Raspberry Pi 5 GPU at 60 fps. Keep it to roughly 150 noise or
  distance evaluations per pixel: no deep raymarching (at most 40 steps, simple scenes), at most 5 fbm octaves,
  no nested loops over 64 total iterations.
- Keep shapes round with the real aspect: work in p = (v_uv - 0.5) * u_res / min(u_res.x, u_res.y), which spans
  about -0.5..0.5 on the short side.

Make it look great on a driveway:
- Black means no light: the background must be black (or very dark) and the content glows. Grey concrete
  shows bold, saturated, bright colour well; it can't show black objects except as silhouettes against light.
- Use big, bold shapes and thick lines; anything finer than about 1/150 of the surface disappears. Fill most of
  the surface and keep the main subject centred. Avoid strobing faster than about 3 flashes a second.
- It should feel alive the whole time: continuous motion, maybe a slow build or a cycle every 10-30 s.
- Interpret the guest's idea generously and theatrically, with a Halloween flavour when it fits. Keep it
  spooky-fun and kid-appropriate: no gore, nudity, hateful or real-person content. If a request isn't suitable,
  make a playful Halloween animation loosely inspired by its harmless part instead, and title it accordingly.
- Some areas of the surface are masked off (blacked out) by the host; the user message lists them. Keep key
  content out of them.

Return JSON only:
- "title": a short, fun display title for the animation (max 40 characters, family-friendly).
- "fragment": the shader source (helpers + main), without the header.
- "params": 0 to 3 tweakable params, each {"key","label","type":"color"|"range","default", and for ranges
  "min","max"}; colour defaults are "#rrggbb" strings, range defaults numbers. Use [] when none are needed.

A short example of the format (yours should be richer and fit the idea):
{"title":"Pumpkin Pulse","params":[{"key":"color","label":"Glow","type":"color","default":"#ff7a00"}],
 "fragment":"void main(){ vec2 p = (v_uv - 0.5) * u_res / min(u_res.x, u_res.y); float r = length(p * vec2(1.0, 1.3));
 float g = 1.0 - smoothstep(0.30, 0.32, r); float glow = exp(-r * 6.0) * (0.6 + 0.4 * sin(u_time * 3.0));
 gl_FragColor = vec4(u_color * (g * 0.9 + glow), 1.0); }"}`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    fragment: { type: 'string' },
    params: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          label: { type: 'string' },
          type: { type: 'string', enum: ['color', 'range'] },
          default: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          min: { type: 'number' },
          max: { type: 'number' },
        },
        required: ['key', 'label', 'type', 'default'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'fragment', 'params'],
  additionalProperties: false,
};

const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

export function createParty({ DATA, USER_SCENES, config, getState, updateState, broadcastEvent }) {
  const QUEUE_FILE = path.join(DATA, 'queue.json');
  let queue = [];
  try { queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { queue = []; }
  // Anything mid-generation when the server stopped goes back in line.
  for (const it of queue) if (['generating', 'testing'].includes(it.status)) it.status = 'queued';
  let active = 0, lastGenMs = 60000;
  const compileWaits = new Map(); // nonce -> resolve

  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => fs.writeFile(QUEUE_FILE, JSON.stringify(queue, null, 1), () => {}), 300);
  };
  const changed = () => { save(); broadcastEvent('queue', publicView()); };

  function client() {
    // A key saved on the setup page wins over an inherited environment variable.
    const key = config.get().apiKey || process.env.ANTHROPIC_API_KEY;
    return new Anthropic(key ? { apiKey: key } : {});
  }

  function publicView() {
    const waiting = queue.filter((i) => ['queued', 'generating', 'testing', 'ready'].includes(i.status));
    return {
      items: queue.filter((i) => i.status !== 'removed').slice(-60).map((i) => ({
        id: i.id, title: i.title || null, by: i.by, status: i.status, playedAt: i.playedAt || null,
        position: waiting.indexOf(i) >= 0 ? waiting.indexOf(i) + 1 : null,
      })),
      avgSeconds: Math.round(lastGenMs / 1000),
    };
  }

  function adminView() {
    return { ...publicView(), items: queue.slice(-100).map((i) => ({ ...i, guest: undefined })) };
  }

  function submit({ prompt, by }, guest) {
    prompt = clean(prompt, 300);
    by = clean(by, 24) || 'A guest';
    if (prompt.length < 3) return { error: 'Describe an animation first.' };
    if (!getState().party.enabled) return { error: 'The show isn\'t taking requests right now.' };
    const pending = queue.filter((i) => i.guest === guest && ['queued', 'generating', 'testing', 'ready'].includes(i.status));
    if (pending.length >= MAX_PENDING_PER_GUEST) return { error: `You have ${pending.length} waiting already. Watch for them on the driveway!` };
    const item = { id: uid(), prompt, by, guest, status: 'queued', createdAt: Date.now(), attempts: 0 };
    queue.push(item);
    changed();
    pump();
    return { id: item.id };
  }

  // What Claude needs to know about the surface the animation will play on.
  function surfaceContext() {
    const s = getState(), surf = partySurface(s);
    if (!surf) return 'Surface: a rectangle with aspect ratio 16:9.';
    const aspect = surfaceAspect(surf, s.output);
    const lines = [
      `Surface "${surf.name}": ${surf.mode === 'mesh' ? 'a curved/irregular area (content is warped to fit)' : 'a flat area seen in perspective (the engine undoes the perspective)'}.`,
      `Its real shape is about ${aspect.toFixed(2)} : 1 (width : height), so u_res has that aspect.`,
      'The top edge (v_uv.y = 1) is the far side of the driveway from the house; people mostly view it from the bottom edge.',
    ];
    const masks = s.masks.filter((m) => m.enabled).map((m) => m.points.map((p) => {
      const [u, v] = outputToSurface(surf, p);
      return [Math.round(u * 100) / 100, Math.round((1 - v) * 100) / 100];
    })).filter((pts) => pts.some(([x, y]) => x > -0.1 && x < 1.1 && y > -0.1 && y < 1.1));
    if (masks.length) lines.push('Masked-off (blacked-out) areas, as polygons in v_uv coordinates: ' + masks.map((m) => JSON.stringify(m)).join('; ') + '.');
    else lines.push('No masked-off areas.');
    return lines.join('\n');
  }

  // Strip anything the engine already declares, so a redeclaration can't break the compile.
  function sanitize(fragment, params) {
    const keys = ['v_uv', 'u_time', 'u_res', ...params.map((p) => 'u_' + p.key)];
    return fragment
      .replace(/^\s*#\s*(version|extension).*$/gm, '')
      .replace(/^\s*precision\s+\w+\s+float\s*;\s*$/gm, '')
      .split('\n')
      .filter((line) => !keys.some((k) => new RegExp(`^\\s*(uniform|varying)\\s+\\w+\\s+${k}\\s*;`).test(line)))
      .join('\n');
  }

  function normalizeParams(params) {
    return (Array.isArray(params) ? params : []).slice(0, 3)
      .filter((p) => /^[a-z][a-z0-9_]{0,15}$/i.test(p.key) && !['time', 'res'].includes(p.key))
      .map((p) => p.type === 'color'
        ? { key: p.key, label: clean(p.label, 24) || p.key, type: 'color', default: /^#[0-9a-f]{6}$/i.test(p.default) ? p.default : '#ff7a00' }
        : { key: p.key, label: clean(p.label, 24) || p.key, type: 'range', min: +p.min || 0, max: +p.max || 1, step: 'any', default: Number.isFinite(+p.default) ? +p.default : 0.5 });
  }

  // Ask a connected player/setup page to compile the shader; null if nobody answered in time.
  function compileTest(fragment, params) {
    const nonce = uid() + uid();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { compileWaits.delete(nonce); resolve(null); }, COMPILE_WAIT_MS);
      compileWaits.set(nonce, (r) => { clearTimeout(timer); compileWaits.delete(nonce); resolve(r); });
      broadcastEvent('compile', { nonce, fragment, params });
    });
  }

  function compileResult({ nonce, ok, log }) {
    const done = compileWaits.get(nonce);
    if (done) done({ ok: !!ok, log: clean(log, 2000) });
  }

  async function generate(item) {
    const t0 = Date.now();
    item.status = 'generating';
    item.attempts++;
    changed();
    const messages = [{
      role: 'user',
      content: `${surfaceContext()}\n\nThe guest (${item.by}) asked for:\n<request>${item.prompt}</request>\n\nCreate the animation.`,
    }];
    try {
      for (let fix = 0; fix <= MAX_FIX_ATTEMPTS; fix++) {
        const msg = await client().beta.messages.stream({
          model: MODEL,
          max_tokens: 32000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
          messages,
        }).finalMessage();
        if (msg.stop_reason === 'refusal') throw new Error('Claude declined this one. Try a different idea!');
        if (msg.stop_reason === 'max_tokens') throw new Error('The animation came out too long.');
        const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        const out = JSON.parse(text);
        const params = normalizeParams(out.params);
        const fragment = sanitize(String(out.fragment || ''), params);
        if (!/void\s+main\s*\(/.test(fragment) || !/gl_FragColor/.test(fragment)) throw new Error('The shader had no main().');
        item.status = 'testing';
        item.title = clean(out.title, 40) || 'Mystery animation';
        changed();
        const test = await compileTest(fragment, params);
        if (test && !test.ok) {
          item.error = test.log;
          if (fix === MAX_FIX_ATTEMPTS) throw new Error('The shader did not compile: ' + test.log.slice(0, 300));
          messages.push({ role: 'assistant', content: msg.content });
          messages.push({ role: 'user', content: `That shader failed to compile in WebGL 1 with:\n${test.log}\n(Line numbers include the engine's header, about ${8 + params.length} lines before your code.) Fix it and return the complete JSON again.` });
          item.status = 'generating';
          changed();
          continue;
        }
        const sceneId = 'g-' + item.id.toLowerCase();
        const def = { id: sceneId, name: item.title, kind: 'shader', guest: true, prompt: item.prompt, by: item.by, params, fragment };
        await fsp.writeFile(path.join(USER_SCENES, sceneId + '.js'), `// Generated by ${MODEL} for "${item.prompt.replace(/\n/g, ' ')}"\nexport default ${JSON.stringify(def, null, 1)};\n`);
        item.sceneId = sceneId;
        item.status = 'ready';
        item.error = test ? null : 'Not compile-tested (no player was connected).';
        item.genSeconds = Math.round((Date.now() - t0) / 1000);
        lastGenMs = lastGenMs * 0.6 + (Date.now() - t0) * 0.4;
        changed();
        return;
      }
    } catch (e) {
      item.status = 'failed';
      item.error = e instanceof Anthropic.AuthenticationError ? 'No valid Claude API key on the server.'
        : e instanceof Anthropic.RateLimitError ? 'Claude is busy (rate limit). The host can retry it.'
        : e instanceof Anthropic.APIError ? `Claude API error ${e.status}: ${e.message}`
        : e.message || String(e);
      console.error('Generation failed for', item.id, e);
      changed();
    }
  }

  function pump() {
    while (active < CONCURRENT) {
      const next = queue.find((i) => i.status === 'queued');
      if (!next) return;
      active++;
      generate(next).finally(() => { active--; pump(); });
    }
  }

  // Playback: once a second, start the next ready animation when the current one has finished.
  function tick() {
    const s = getState(), now = Date.now();
    if (!s.party.enabled) { if (s.partyNow) updateState((st) => { st.partyNow = null; }); return; }
    if (s.partyNow && now < s.partyNow.until) return;
    if (s.partyNow) {
      const cur = queue.find((i) => i.id === s.partyNow.itemId);
      if (cur && cur.status === 'playing') { cur.status = 'played'; changed(); }
    }
    let next = queue.find((i) => i.status === 'ready');
    if (!next && s.party.replay) {
      next = queue.filter((i) => i.status === 'played' && i.sceneId).sort((a, b) => (a.playedAt || 0) - (b.playedAt || 0))[0];
    }
    if (!next) { if (s.partyNow) updateState((st) => { st.partyNow = null; }); return; }
    play(next);
  }

  function play(item) {
    const s = getState(), now = Date.now();
    for (const i of queue) if (i.status === 'playing' && i !== item) i.status = 'played';
    item.status = 'playing';
    item.playedAt = now;
    item.plays = (item.plays || 0) + 1;
    updateState((st) => {
      st.partyNow = { itemId: item.id, sceneId: item.sceneId, title: item.title, by: item.by, startedAt: now, until: now + (+s.party.seconds || 45) * 1000 };
    });
    changed();
  }

  function admin(action, id) {
    const item = queue.find((i) => i.id === id);
    if (action === 'skip') {
      updateState((st) => { if (st.partyNow) st.partyNow.until = Date.now(); });
      return { ok: true };
    }
    if (!item) return { error: 'No such item' };
    if (action === 'play' && item.sceneId) { play(item); return { ok: true }; }
    if (action === 'retry') { item.status = 'queued'; item.error = null; changed(); pump(); return { ok: true }; }
    if (action === 'remove') {
      item.status = 'removed';
      if (getState().partyNow?.itemId === id) updateState((st) => { st.partyNow.until = Date.now(); });
      changed();
      return { ok: true };
    }
    return { error: 'Unknown action' };
  }

  setInterval(tick, 1000);
  pump();
  return { submit, publicView, adminView, compileResult, admin, model: MODEL };
}
