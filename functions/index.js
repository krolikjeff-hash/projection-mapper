// Cloud Function: turns each guest prompt (shows/{show}/queue/{item}, status "queued") into a GLSL scene with Claude,
// fitted to the show's party surface. A connected player or setup page compile-tests it on a real GPU first
// (compileTests/{id}); failures go back to Claude with the error, up to MAX_FIX_ATTEMPTS times.
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { defineSecret } from 'firebase-functions/params';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import Anthropic from '@anthropic-ai/sdk';
import { normalizeState, partySurface } from './shared/model.js';
import { surfaceAspect, outputToSurface } from './shared/geometry.js';

initializeApp();
const db = getFirestore();
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const MODEL = 'claude-opus-5-5';
const MAX_PENDING_PER_GUEST = 3;
const COMPILE_WAIT_MS = 12000;
const MAX_FIX_ATTEMPTS = 2;
const PENDING = ['queued', 'generating', 'testing', 'ready'];

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

// What Claude needs to know about the surface the animation will play on.
function surfaceContext(state) {
  const surf = partySurface(state);
  if (!surf) return 'Surface: a rectangle with aspect ratio 16:9.';
  const aspect = surfaceAspect(surf, state.output);
  const lines = [
    `Surface "${surf.name}": ${surf.mode === 'mesh' ? 'a curved/irregular area (content is warped to fit)' : 'a flat area seen in perspective (the engine undoes the perspective)'}.`,
    `Its real shape is about ${aspect.toFixed(2)} : 1 (width : height), so u_res has that aspect.`,
    'The top edge (v_uv.y = 1) is the far side from the house; people mostly view it from the bottom edge.',
  ];
  const masks = state.masks.filter((m) => m.enabled).map((m) => m.points.map((p) => {
    const [u, v] = outputToSurface(surf, p);
    return [Math.round(u * 100) / 100, Math.round((1 - v) * 100) / 100];
  })).filter((pts) => pts.some(([x, y]) => x > -0.1 && x < 1.1 && y > -0.1 && y < 1.1));
  lines.push(masks.length
    ? 'Masked-off (blacked-out) areas, as polygons in v_uv coordinates: ' + masks.map((m) => JSON.stringify(m)).join('; ') + '.'
    : 'No masked-off areas.');
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

// Ask any connected player/setup page to compile the shader; null if nobody answered in time.
async function compileTest(show, fragment, params) {
  const ref = db.collection('compileTests').doc();
  await ref.set({ show, fragment, params, status: 'pending', createdAt: Date.now() });
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => { off(); resolve(null); }, COMPILE_WAIT_MS);
    const off = ref.onSnapshot((snap) => {
      const d = snap.data();
      if (d && d.status === 'done') { clearTimeout(timer); off(); resolve({ ok: !!d.ok, log: clean(d.log, 2000) }); }
    });
  });
  await ref.delete().catch(() => {});
  return result;
}

export const generateAnimation = onDocumentWritten(
  { document: 'shows/{show}/queue/{item}', secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 540, memory: '512MiB', maxInstances: 10 },
  async (event) => {
    const after = event.data?.after?.data(), before = event.data?.before?.data();
    if (!after || after.status !== 'queued' || (before && before.status === 'queued' && before.retry === after.retry)) return;
    const { show, item } = event.params;
    const itemRef = event.data.after.ref;
    const t0 = Date.now();

    // Per-guest limit on waiting requests.
    const mine = await itemRef.parent.where('uid', '==', after.uid || '-').get();
    const waiting = mine.docs.filter((d) => d.id !== item && PENDING.includes(d.data().status)).length;
    if (waiting >= MAX_PENDING_PER_GUEST) {
      await itemRef.update({ status: 'failed', error: `You have ${waiting} waiting already. Watch for them on the driveway!` });
      return;
    }

    // Claim it (triggers can be delivered twice).
    const claimed = await db.runTransaction(async (tx) => {
      const cur = await tx.get(itemRef);
      if (!cur.exists || cur.data().status !== 'queued') return false;
      tx.update(itemRef, { status: 'generating', attempts: FieldValue.increment(1), error: null });
      return true;
    });
    if (!claimed) return;
    const showSnap = await db.collection('shows').doc(show).get();
    let state;
    try { state = normalizeState(JSON.parse(showSnap.data()?.stateJson || 'null')); } catch { state = normalizeState(null); }

    // Legacy workspace keys (sk-ant-api…) go in x-api-key; identity-linked personal/service-account keys
    // (e.g. sk-ant-usr…) go in Authorization: Bearer.
    const key = ANTHROPIC_API_KEY.value().trim();
    const client = new Anthropic(key.startsWith('sk-ant-api') ? { apiKey: key } : { apiKey: null, authToken: key });
    const messages = [{
      role: 'user',
      content: `${surfaceContext(state)}\n\nThe guest (${clean(after.by, 24)}) asked for:\n<request>${clean(after.prompt, 300)}</request>\n\nCreate the animation.`,
    }];
    try {
      for (let fix = 0; fix <= MAX_FIX_ATTEMPTS; fix++) {
        const msg = await client.beta.messages.stream({
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
        const out = JSON.parse(msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
        const params = normalizeParams(out.params);
        const fragment = sanitize(String(out.fragment || ''), params);
        if (!/void\s+main\s*\(/.test(fragment) || !/gl_FragColor/.test(fragment)) throw new Error('The shader had no main().');
        const title = clean(out.title, 40) || 'Mystery animation';
        await itemRef.update({ status: 'testing', title });

        const test = await compileTest(show, fragment, params);
        if (test && !test.ok) {
          if (fix === MAX_FIX_ATTEMPTS) throw new Error('The shader did not compile: ' + test.log.slice(0, 300));
          messages.push({ role: 'assistant', content: msg.content });
          messages.push({ role: 'user', content: `That shader failed to compile in WebGL 1 with:\n${test.log}\n(Line numbers include the engine's header, about ${8 + params.length} lines before your code.) Fix it and return the complete JSON again.` });
          await itemRef.update({ status: 'generating', error: test.log.slice(0, 500) });
          continue;
        }

        const sceneId = 'g-' + item.toLowerCase();
        await db.collection('scenes').doc(sceneId).set({
          name: title, kind: 'shader', params, fragment, prompt: clean(after.prompt, 300), by: clean(after.by, 24), show, model: MODEL,
          createdAt: FieldValue.serverTimestamp(), usage: { input: msg.usage.input_tokens, output: msg.usage.output_tokens },
        });
        await itemRef.update({
          status: 'ready', sceneId, genSeconds: Math.round((Date.now() - t0) / 1000),
          error: test ? null : 'Not compile-tested (no player or setup page was open).',
        });
        return;
      }
    } catch (e) {
      logger.error('Generation failed', { show, item, error: String(e) });
      const error = e instanceof Anthropic.AuthenticationError ? 'The Claude API key is missing or invalid.'
        : e instanceof Anthropic.RateLimitError ? 'Claude is busy (rate limit). The host can retry it.'
        : e instanceof Anthropic.APIError ? `Claude API error ${e.status}: ${e.message}`
        : e.message || String(e);
      await itemRef.update({ status: 'failed', error: clean(error, 500) });
    }
  },
);
