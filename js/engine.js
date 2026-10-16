// WebGL projection-mapping engine, used by the player (full screen) and by the control page's preview.
// Each surface's scene renders into its own texture, which is drawn warped onto the output through the
// surface's corner-pin homography or smooth mesh. Masks then black out polygons (stencil fill, any shape).
import { surfaceMap } from './geometry.js';
import { isShowTime } from './sun.js';
import { partySurface } from './model.js';

const VS_WARP = `attribute vec2 a_pos; attribute vec2 a_uv; varying vec2 v_uv;
void main(){ v_uv = a_uv; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const FS_WARP = `precision mediump float; varying vec2 v_uv; uniform sampler2D u_tex; uniform float u_alpha;
void main(){ gl_FragColor = vec4(texture2D(u_tex, v_uv).rgb, u_alpha); }`;
const VS_SOLID = `attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const FS_SOLID = `precision mediump float; uniform vec4 u_color; void main(){ gl_FragColor = u_color; }`;
const VS_SCENE = `attribute vec2 a_pos; varying vec2 v_uv;
void main(){ v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const SCENE_HEADER = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv; uniform float u_time; uniform vec2 u_res;
`;

// Align-mode grid colours, one per surface.
const ALIGN_COLORS = ['#00c8ff', '#ff3cc8', '#7dff3c', '#ffb000', '#a070ff', '#ff5040', '#30ffd0', '#ffffff'];

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

export function sceneParams(def, params) {
  const out = {};
  for (const p of def.params || []) out[p.key] = params && params[p.key] !== undefined ? params[p.key] : p.default;
  return out;
}

// Built-in scenes are modules in /scenes; guests' generated scenes ("g-…") come from a loader the backend sets.
let externalLoader = null;
export function setSceneLoader(fn) { externalLoader = fn; }

// The built-in scenes, for the setup page's pickers (GitHub Pages can't list a folder).
export const BUILTIN_SCENES = ['magic-circle', 'ground-cracks', 'fog', 'spiders', 'ghosts', 'solid', 'media', 'grid'];

const sceneModules = new Map();
export function loadScene(id) {
  if (!sceneModules.has(id)) {
    const entry = { def: null, error: null };
    const load = id.startsWith('g-') && externalLoader
      ? externalLoader(id)
      : import(new URL(`../scenes/${id}.js`, import.meta.url).href).then((m) => m.default);
    entry.promise = load.then((def) => { entry.def = def; }).catch((e) => { entry.error = e; console.warn('Scene failed to load:', id, e); });
    sceneModules.set(id, entry);
  }
  return sceneModules.get(id);
}

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) + '\n' + src);
  return sh;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.bindAttribLocation(p, 1, 'a_uv');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const u = gl.getActiveUniform(p, i); uniforms[u.name] = gl.getUniformLocation(p, u.name); }
  return { p, u: uniforms };
}

function newTexture(gl, w, h) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (w) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return t;
}

// A GLSL scene rendered into a framebuffer texture.
class ShaderInstance {
  constructor(eng, def, w, h) {
    this.eng = eng; this.def = def; this.prog = eng.sceneProgram(def);
    this.resize(w, h);
  }
  resize(w, h) {
    const gl = this.eng.gl;
    this.dispose();
    this.w = w; this.h = h;
    this.tex = newTexture(gl, w, h);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  render(t, dt, params) {
    const gl = this.eng.gl, { p, u } = this.prog;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.BLEND); gl.disable(gl.STENCIL_TEST);
    gl.useProgram(p);
    if (u.u_time) gl.uniform1f(u.u_time, t % 3600);
    if (u.u_res) gl.uniform2f(u.u_res, this.w, this.h);
    for (const prm of this.def.params || []) {
      const loc = u['u_' + prm.key];
      if (!loc) continue;
      if (prm.type === 'color') gl.uniform3fv(loc, hexToRgb(params[prm.key]));
      else gl.uniform1f(loc, +params[prm.key] || 0);
    }
    this.eng.drawFullscreen();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  dispose() {
    const gl = this.eng.gl;
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    this.tex = this.fbo = null;
  }
}

// A Canvas 2D scene (sprites, video, images) uploaded as a texture every frame.
class CanvasInstance {
  constructor(eng, def, w, h) {
    this.eng = eng; this.def = def;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.state = def.create ? def.create() : {};
    this.tex = newTexture(eng.gl);
    this.resize(w, h);
  }
  resize(w, h) {
    this.w = this.canvas.width = w;
    this.h = this.canvas.height = h;
    if (this.def.resize) this.def.resize(this.state, w, h);
  }
  render(t, dt, params) {
    const gl = this.eng.gl;
    this.def.draw(this.state, this.ctx, this.w, this.h, t, dt, params);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }
  dispose() {
    if (this.def.dispose) this.def.dispose(this.state);
    if (this.tex) this.eng.gl.deleteTexture(this.tex);
    this.tex = null;
  }
}

export class Engine {
  // opts: preview (ignore schedule/blackout), contentLong (scene texture size, long side), maxDpr,
  // antialias (MSAA on the output), fps (cap: render only every Nth display refresh, for steady pacing on slow GPUs)
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = { contentLong: 1024, maxDpr: 2, antialias: true, fps: 0, ...opts };
    const gl = canvas.getContext('webgl', { stencil: true, antialias: this.opts.antialias, alpha: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL is not available in this browser.');
    this.gl = gl;
    this.warp = program(gl, VS_WARP, FS_WARP);
    this.solid = program(gl, VS_SOLID, FS_SOLID);
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    this.dynBuf = gl.createBuffer();
    this.sceneProgs = new Map();
    this.instances = new Map();
    this.geoms = new Map();
    this.state = null;
    this.master = 0;
    this.scale = 1;   // adaptive shader resolution (see start())
    this.t0 = performance.now();
    this.lastT = 0;
    this.errors = new Map();
  }

  setState(s) { this.state = s; }

  start() {
    let last = -1e9;
    this.stats = { frames: 0, since: performance.now(), worst: 0, prev: 0 };
    const gov = { t0: performance.now(), n: 0, good: 0, wait: 3, upAt: -1e9 };
    const loop = (ts) => {
      this.raf = requestAnimationFrame(loop);
      // With an fps cap, skip refreshes so frames land on an even beat (e.g. every 2nd vsync at 60 Hz = steady 30).
      if (this.opts.fps && ts - last < 1000 / this.opts.fps - 4) return;
      last = ts;
      try { this.frame(ts); } catch (e) { console.error(e); }
      const st = this.stats;
      if (st.prev) st.worst = Math.max(st.worst, ts - st.prev);
      st.prev = ts; st.frames++;
      // Adaptive resolution: heavy shaders are fill-rate bound on slow GPUs (Pi 5: Bat Burst 12 fps at 1024 px,
      // 33 at 512), so each second the shader texture scale moves to hold the target rate (the cap, else 60).
      gov.n++;
      const span = ts - gov.t0;
      if (span >= 1000) {
        const target = this.opts.fps || 60, fps = gov.n * 1000 / span;
        if (fps < target * 0.96) {
          // A step up that failed right away means we're at this scene's limit: wait longer before trying again.
          // A big drop (new heavy scene) starts the patience over.
          gov.wait = fps < target * 0.75 ? 3 : (ts - gov.upAt < 2500 ? Math.min(30, gov.wait * 2) : gov.wait);
          this.scale = Math.max(0.25, this.scale * Math.max(0.7, Math.sqrt(fps / target) * 0.97)); gov.good = 0;
        } else if (fps >= target * 0.95 && this.scale < 1 && ++gov.good >= gov.wait) {
          this.scale = Math.min(1, this.scale * 1.1); gov.good = 0; gov.upAt = ts;
        }
        st.fps = +fps.toFixed(1); st.scale = +this.scale.toFixed(2);
        gov.t0 = ts; gov.n = 0;
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() { cancelAnimationFrame(this.raf); }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.opts.maxDpr);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr)), h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  sceneProgram(def) {
    let p = this.sceneProgs.get(def.id);
    if (!p) {
      const decl = (def.params || []).filter((x) => x.type === 'color' || x.type === 'range')
        .map((x) => (x.type === 'color' ? `uniform vec3 u_${x.key};` : `uniform float u_${x.key};`)).join('\n');
      p = program(this.gl, VS_SCENE, SCENE_HEADER + decl + '\n' + def.fragment);
      this.sceneProgs.set(def.id, p);
    }
    return p;
  }

  // Compile a generated shader without using it: { ok, log }.
  testCompile(fragment, params = []) {
    try {
      const prog = this.sceneProgram({ id: 'test-' + Math.random(), params, fragment });
      this.gl.deleteProgram(prog.p);
      return { ok: true, log: '' };
    } catch (e) {
      return { ok: false, log: String(e.message || e).split('\n#ifdef')[0] };
    } finally {
      for (const k of [...this.sceneProgs.keys()]) if (k.startsWith('test-')) this.sceneProgs.delete(k);
    }
  }

  drawFullscreen() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Warp grid for a surface, rebuilt only when its corners/mesh change.
  geometry(surf) {
    const key = surf.mode + JSON.stringify(surf.mode === 'mesh' ? surf.mesh : surf.corners);
    let g = this.geoms.get(surf.id);
    if (g && g.key === key) return g;
    const gl = this.gl, f = surfaceMap(surf);
    const nu = surf.mode === 'mesh' ? surf.mesh.cols * 8 : 24, nv = surf.mode === 'mesh' ? surf.mesh.rows * 8 : 24;
    const verts = new Float32Array((nu + 1) * (nv + 1) * 4);
    let k = 0;
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
      const u = i / nu, v = j / nv, [x, y] = f(u, v);
      verts[k++] = x * 2 - 1; verts[k++] = 1 - y * 2; verts[k++] = u; verts[k++] = 1 - v;
    }
    const idx = new Uint16Array(nu * nv * 6);
    k = 0;
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      idx[k++] = a; idx[k++] = b; idx[k++] = c; idx[k++] = c; idx[k++] = b; idx[k++] = d;
    }
    // Surface aspect in output pixels, for the scene texture size.
    const out = (this.state && this.state.output) || { width: 1920, height: 1080 };
    const len = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot((p[0] - pts[i][0]) * out.width, (p[1] - pts[i][1]) * out.height), 0);
    const line = (fn) => Array.from({ length: 9 }, (_, i) => fn(i / 8));
    const wpx = (len(line((t) => f(t, 0))) + len(line((t) => f(t, 1)))) / 2;
    const hpx = (len(line((t) => f(0, t))) + len(line((t) => f(1, t)))) / 2;
    if (!g) g = { vbo: gl.createBuffer(), ibo: gl.createBuffer() };
    g.key = key; g.count = idx.length; g.aspect = Math.max(0.05, Math.min(20, wpx / Math.max(hpx, 1)));
    gl.bindBuffer(gl.ARRAY_BUFFER, g.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    this.geoms.set(surf.id, g);
    return g;
  }

  contentSize(aspect) {
    const L = this.opts.contentLong;
    const r16 = (x) => Math.max(16, Math.round(x / 16) * 16);
    return aspect >= 1 ? [L, r16(L / aspect)] : [r16(L * aspect), L];
  }

  instance(key, sceneId, w, h) {
    const entry = loadScene(sceneId);
    if (!entry.def) return null;
    const def = entry.def;
    let inst = this.instances.get(key);
    if (inst && inst.def !== def) { inst.dispose(); inst = null; }
    if (!inst) {
      try {
        inst = def.kind === 'shader' ? new ShaderInstance(this, def, w, h) : new CanvasInstance(this, def, w, h);
      } catch (e) {
        if (!this.errors.has(sceneId)) { this.errors.set(sceneId, e); console.error('Scene', sceneId, e); }
        return null;
      }
      this.instances.set(key, inst);
    }
    if (Math.abs(inst.w - w) > inst.w * 0.08 || Math.abs(inst.h - h) > inst.h * 0.08) inst.resize(w, h);
    inst.lastUsed = performance.now();
    return inst;
  }

  // Which playlist entries are visible now, their opacity and their local clock. Timing follows the wall
  // clock, so every player and preview shows the same entry; the next entry fades in during the crossfade.
  layers(surf, nowMs, t) {
    const list = surf.playlist;
    if (list.length === 1) return [{ idx: 0, entry: list[0], alpha: 1, time: t }];
    const total = list.reduce((s, e) => s + e.duration, 0);
    let pos = (nowMs / 1000) % total, i = 0;
    while (pos >= list[i].duration) { pos -= list[i].duration; i++; }
    const cur = list[i], cf = Math.min(surf.crossfade || 0, cur.duration * 0.5);
    const out = [{ idx: i, entry: cur, alpha: 1, time: pos + cf }];
    if (cf > 0 && pos > cur.duration - cf) {
      const n = (i + 1) % list.length;
      out.push({ idx: n, entry: list[n], alpha: (pos - (cur.duration - cf)) / cf, time: pos - (cur.duration - cf) });
    }
    return out;
  }

  frame(ts) {
    const gl = this.gl, s = this.state;
    this.resize();
    const t = (ts - this.t0) / 1000, elapsed = Math.max(0, t - this.lastT), dt = Math.min(0.1, elapsed);
    this.lastT = t;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1); gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    if (!s) return;

    const nowMs = Date.now();
    const on = s.align || this.opts.preview || (!s.blackout && isShowTime(s.schedule, new Date(nowMs)));
    // 2 s fade, timed by the real clock so it also completes when frames are throttled.
    this.master += Math.sign((on ? 1 : 0) - this.master) * Math.min(Math.abs((on ? 1 : 0) - this.master), Math.min(elapsed, 1) / 2);
    const level = s.align ? 1 : this.master * (this.opts.preview ? 1 : s.brightness ?? 1);
    if (level <= 0.001) { this.gc(); return; }

    const used = new Set();
    s.surfaces.forEach((surf, si) => {
      if (!surf.enabled) return;
      const g = this.geometry(surf);
      const [cw, ch] = this.contentSize(g.aspect);
      const layers = s.align
        ? [{ idx: 'align', entry: { scene: 'grid', params: { color: ALIGN_COLORS[si % ALIGN_COLORS.length], highlight: s.selected && s.selected.id === surf.id ? 1 : 0 } }, alpha: 1, time: t }]
        : this.layers(surf, nowMs, t);
      // A guest's animation plays over the party surface, fading in and out over 1.5 s.
      const pn = s.partyNow, partyOn = s.party && s.party.enabled && pn && pn.sceneId && nowMs < pn.until;
      if (!s.align && partyOn && surf.id === partySurface(s)?.id) {
        const fade = Math.min(1, (nowMs - pn.startedAt) / 1500, (pn.until - nowMs) / 1500);
        // Keep the playlist underneath until the guest scene has loaded (or if it fails to compile).
        if (fade >= 1 && loadScene(pn.sceneId).def && !this.errors.has(pn.sceneId)) layers.length = 0;
        layers.push({ idx: 'party:' + pn.itemId, entry: { scene: pn.sceneId, params: {} }, alpha: Math.max(0, fade), time: (nowMs - pn.startedAt) / 1000 });
      }
      for (const L of layers) {
        const key = surf.id + '|' + L.idx;
        // Shader scenes follow the adaptive scale; canvas scenes keep their size (resizing resets their sprites).
        const sc = loadScene(L.entry.scene).def?.kind === 'shader' ? this.scale : 1;
        const inst = this.instance(key, L.entry.scene, Math.max(16, Math.round(cw * sc)), Math.max(16, Math.round(ch * sc)));
        if (!inst) continue;
        used.add(key);
        inst.render(L.time, dt, sceneParams(inst.def, L.entry.params));
        this.drawWarp(g, inst.tex, L.alpha * (s.align ? 1 : surf.opacity ?? 1));
      }
    });

    for (const m of s.masks) if (m.enabled) this.drawMask(m.points, s.align ? [1, 0.1, 0.1, 0.45] : [0, 0, 0, 1]);
    if (level < 0.999) this.drawSolidFullscreen([0, 0, 0, 1 - level]);
    this.gc(used);
  }

  drawWarp(g, tex, alpha) {
    const gl = this.gl, { p, u } = this.warp;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.STENCIL_TEST);
    gl.useProgram(p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u.u_tex, 0);
    gl.uniform1f(u.u_alpha, Math.max(0, Math.min(1, alpha)));
    gl.bindBuffer(gl.ARRAY_BUFFER, g.vbo);
    gl.enableVertexAttribArray(0); gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.ibo);
    gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_SHORT, 0);
  }

  // Even-odd stencil fill, so masks can be any (concave) polygon.
  drawMask(points, color) {
    const gl = this.gl, { p, u } = this.solid;
    const v = new Float32Array(points.length * 2);
    points.forEach((pt, i) => { v[i * 2] = pt[0] * 2 - 1; v[i * 2 + 1] = 1 - pt[1] * 2; });
    gl.useProgram(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.disableVertexAttribArray(1);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.STENCIL_TEST);
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 0, 1);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, points.length);
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.EQUAL, 1, 1);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform4fv(u.u_color, color);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, points.length);
    gl.disable(gl.STENCIL_TEST);
  }

  drawSolidFullscreen(color) {
    const gl = this.gl, { p, u } = this.solid;
    gl.useProgram(p);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform4fv(u.u_color, color);
    this.drawFullscreen();
  }

  // Free scene instances that haven't been drawn for a few seconds.
  gc(used = new Set()) {
    const now = performance.now();
    for (const [k, inst] of this.instances) {
      if (!used.has(k) && now - inst.lastUsed > 5000) { inst.dispose(); this.instances.delete(k); }
    }
  }
}
