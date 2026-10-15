// Control page: live preview with drag handles for surfaces and masks, plus the settings panel.
// Every change is pushed to the server, which forwards it to the player(s) at once.
import { Engine, loadScene } from './engine.js';
import { uid, newSurface, newMask, normalizeState } from './model.js';
import { meshFromQuad, meshCorners, surfaceOutline, pointInPolygon, centroid } from './geometry.js';
import { showWindow, isShowTime } from './sun.js';

const $ = (s) => document.querySelector(s);
const clientId = uid();
let state = null;
const scenes = new Map();
let sceneIds = [], mediaFiles = [], layoutNames = [];
let sel = { type: null, id: null, point: null }; // point: handle index, or 'move'
let tab = 'surfaces', drag = null, connected = false;

const stage = $('#stage'), preview = $('#preview'), ov = $('#overlay'), c2 = ov.getContext('2d');
const engine = new Engine($('#gl'), { preview: true, contentLong: 512 });

// ---------- helpers ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'value') value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  if (value !== undefined) el.value = value;
  return el;
}
const btn = (label, onclick, cls, title) => h('button', { class: cls, onclick, title }, label);
const field = (label, ...ctl) => h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'ctl' }, ...ctl));
const fmt = (v) => (Math.abs(v) >= 10 || Number.isInteger(+v) ? String(+(+v).toFixed(1)) : (+v).toFixed(2));
const clone = (x) => JSON.parse(JSON.stringify(x));
const surface = (id = sel.id) => state.surfaces.find((s) => s.id === id);
const mask = (id = sel.id) => state.masks.find((m) => m.id === id);
const sceneName = (id) => scenes.get(id)?.name || id;
const timeStr = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// ---------- sync ----------
let sendTimer = null, sendPending = false;
function send() {
  fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, origin: clientId }) })
    .catch(() => { connected = false; renderStatus(); });
}
function scheduleSend() {
  if (sendTimer) { sendPending = true; return; }
  send();
  sendTimer = setTimeout(() => { sendTimer = null; if (sendPending) { sendPending = false; scheduleSend(); } }, 60);
}
// Apply a change: preview, projector, overlay; rebuild the panel only when the structure changed.
function commit(rebuild = false) {
  state.selected = sel.id ? { type: sel.type, id: sel.id } : null;
  engine.setState(state);
  scheduleSend();
  drawOverlay();
  if (rebuild) renderPanel();
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onopen = () => { connected = true; renderStatus(); };
  es.onerror = () => { connected = false; renderStatus(); };
  es.addEventListener('state', (e) => {
    const m = JSON.parse(e.data);
    if (m.origin === clientId || drag) return;
    const editing = document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    state = normalizeState(m.state);
    if (sel.id && !surface() && !mask()) sel = { type: null, id: null, point: null };
    engine.setState(state);
    drawOverlay();
    renderHeader();
    if (!editing) renderPanel();
  });
}

// ---------- selection and editing ----------
function select(type, id) {
  sel = { type, id, point: null };
  if (type === 'surface' && tab === 'masks') tab = 'surfaces';
  if (type === 'mask' && tab === 'surfaces') tab = 'masks';
  commit(true);
}

function itemPoints(type, item) {
  if (type === 'mask') return item.points;
  return item.mode === 'mesh' ? item.mesh.points : item.corners;
}

function snapshot() {
  const it = sel.type === 'mask' ? mask() : surface();
  return it ? clone(it) : null;
}

function applyDrag(d) {
  const it = drag.type === 'mask' ? mask(drag.id) : surface(drag.id);
  if (!it) return;
  const o = drag.orig, add = (p) => [p[0] + d[0], p[1] + d[1]];
  if (drag.point === 'move') {
    if (drag.type === 'mask') it.points = o.points.map(add);
    else {
      it.corners = o.corners.map(add);
      if (o.mesh) it.mesh = { ...o.mesh, points: o.mesh.points.map(add) };
    }
  } else {
    const i = drag.point;
    if (drag.type === 'mask') it.points[i] = add(o.points[i]);
    else if (it.mode === 'mesh') { it.mesh.points[i] = add(o.mesh.points[i]); it.corners = meshCorners(it.mesh); }
    else it.corners[i] = add(o.corners[i]);
  }
}

function nudge(dx, dy) {
  const it = sel.type === 'mask' ? mask() : surface();
  if (!it || sel.point === null) return;
  drag = { type: sel.type, id: sel.id, point: sel.point, orig: clone(it) };
  applyDrag([dx / state.output.width, dy / state.output.height]);
  drag = null;
  commit();
}

// ---------- preview stage ----------
function sizeStage() {
  const out = state ? state.output : { width: 16, height: 9 };
  const availW = stage.clientWidth - 24, availH = Math.max(200, window.innerHeight - preview.getBoundingClientRect().top - 70);
  let w = availW, hgt = (w * out.height) / out.width;
  if (window.innerWidth > 900 && hgt > availH) { hgt = availH; w = (hgt * out.width) / out.height; }
  preview.style.width = Math.floor(w) + 'px';
  preview.style.height = Math.floor(hgt) + 'px';
  const dpr = window.devicePixelRatio || 1;
  ov.width = Math.round(w * dpr); ov.height = Math.round(hgt * dpr);
  drawOverlay();
}

function evPoint(e) {
  const r = ov.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
}
function pxDist(a, b) {
  const r = ov.getBoundingClientRect();
  return Math.hypot((a[0] - b[0]) * r.width, (a[1] - b[1]) * r.height);
}

function handlesOf(type, it) {
  const pts = itemPoints(type, it).map((p, i) => ({ point: i, at: p }));
  const c = centroid(type === 'mask' ? it.points : surfaceOutline(it));
  return [...pts, { point: 'move', at: c }];
}

function hitHandle(p, radius) {
  const it = sel.type === 'mask' ? mask() : sel.type === 'surface' ? surface() : null;
  if (!it) return null;
  let best = null, bd = radius;
  for (const hd of handlesOf(sel.type, it)) {
    const d = pxDist(p, hd.at);
    if (d < bd || (d === bd && hd.point !== 'move')) { bd = d; best = hd; }
  }
  return best;
}

function hitBody(p) {
  for (const m of [...state.masks].reverse()) if (pointInPolygon(p, m.points)) return { type: 'mask', id: m.id };
  for (const s of [...state.surfaces].reverse()) if (pointInPolygon(p, surfaceOutline(s))) return { type: 'surface', id: s.id };
  return null;
}

function setupStage() {
  new ResizeObserver(sizeStage).observe(stage);
  addEventListener('resize', sizeStage);
  ov.addEventListener('pointerdown', (e) => {
    const p = evPoint(e), radius = e.pointerType === 'touch' ? 26 : 14;
    const hd = hitHandle(p, radius);
    let target = hd ? { type: sel.type, id: sel.id, point: hd.point } : null;
    if (!target) {
      const b = hitBody(p);
      if (!b) { if (sel.id) select(null, null); return; }
      if (b.id !== sel.id) { sel = { type: b.type, id: b.id, point: null }; if (b.type === 'mask') tab = 'masks'; else if (tab === 'masks') tab = 'surfaces'; renderPanel(); }
      target = { ...b, point: 'move' };
    }
    sel.point = target.point;
    drag = { ...target, start: p, orig: snapshot() };
    ov.setPointerCapture(e.pointerId);
    commit();
  });
  ov.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = evPoint(e);
    applyDrag([p[0] - drag.start[0], p[1] - drag.start[1]]);
    commit();
  });
  const end = () => { if (drag) { drag = null; commit(); } };
  ov.addEventListener('pointerup', end);
  ov.addEventListener('pointercancel', end);
  ov.addEventListener('dblclick', (e) => {
    const m = sel.type === 'mask' ? mask() : null;
    if (!m) return;
    const p = evPoint(e);
    let best = 0, bd = Infinity;
    m.points.forEach((a, i) => {
      const b = m.points[(i + 1) % m.points.length];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const d = pxDist(p, mid) + pxDist(p, a) * 0.2 + pxDist(p, b) * 0.2;
      if (d < bd) { bd = d; best = i; }
    });
    m.points.splice(best + 1, 0, p);
    sel.point = best + 1;
    commit(true);
  });
  addEventListener('keydown', (e) => {
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    const k = e.shiftKey ? 10 : 1;
    const moves = { ArrowLeft: [-k, 0], ArrowRight: [k, 0], ArrowUp: [0, -k], ArrowDown: [0, k] };
    if (moves[e.key]) { e.preventDefault(); nudge(...moves[e.key]); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.type === 'mask' && typeof sel.point === 'number') {
      const m = mask();
      if (m && m.points.length > 3) { m.points.splice(sel.point, 1); sel.point = null; commit(true); }
    }
  });
}

function drawOverlay() {
  if (!state) return;
  const W = ov.width, H = ov.height, dpr = window.devicePixelRatio || 1;
  c2.clearRect(0, 0, W, H);
  const P = (p) => [p[0] * W, p[1] * H];
  const poly = (pts, close = true) => {
    c2.beginPath();
    pts.forEach((p, i) => { const [x, y] = P(p); i ? c2.lineTo(x, y) : c2.moveTo(x, y); });
    if (close) c2.closePath();
  };
  const handle = (p, active, label, square) => {
    const [x, y] = P(p), r = (square ? 6 : 8) * dpr;
    c2.beginPath();
    if (square) c2.rect(x - r, y - r, 2 * r, 2 * r); else c2.arc(x, y, r, 0, Math.PI * 2);
    c2.fillStyle = active ? '#ffd400' : 'rgba(0,0,0,0.6)';
    c2.fill();
    c2.lineWidth = 2 * dpr; c2.strokeStyle = '#ffd400'; c2.stroke();
    if (label) { c2.fillStyle = active ? '#000' : '#ffd400'; c2.font = `${11 * dpr}px system-ui`; c2.textAlign = 'center'; c2.textBaseline = 'middle'; c2.fillText(label, x, y + 0.5); }
  };
  c2.font = `${12 * dpr}px system-ui`;
  for (const s of state.surfaces) {
    const isSel = sel.type === 'surface' && sel.id === s.id;
    poly(surfaceOutline(s, 16));
    c2.lineWidth = (isSel ? 2 : 1) * dpr;
    c2.setLineDash(s.enabled ? [] : [4 * dpr, 4 * dpr]);
    c2.strokeStyle = isSel ? '#ffd400' : 'rgba(255,255,255,0.55)';
    c2.stroke();
    c2.setLineDash([]);
    const [lx, ly] = P(s.mode === 'mesh' ? s.mesh.points[0] : s.corners[0]);
    c2.fillStyle = isSel ? '#ffd400' : 'rgba(255,255,255,0.8)';
    c2.textAlign = 'left'; c2.textBaseline = 'bottom';
    c2.fillText(s.name, lx + 4 * dpr, ly - 4 * dpr);
    if (!isSel) continue;
    if (s.mode === 'mesh') {
      const { cols, rows, points } = s.mesh, at = (i, j) => points[j * (cols + 1) + i];
      c2.lineWidth = 1 * dpr; c2.strokeStyle = 'rgba(255,212,0,0.45)';
      for (let j = 0; j <= rows; j++) { poly(Array.from({ length: cols + 1 }, (_, i) => at(i, j)), false); c2.stroke(); }
      for (let i = 0; i <= cols; i++) { poly(Array.from({ length: rows + 1 }, (_, j) => at(i, j)), false); c2.stroke(); }
      points.forEach((p, i) => handle(p, sel.point === i));
    } else {
      s.corners.forEach((p, i) => handle(p, sel.point === i, String(i + 1)));
    }
    handle(centroid(surfaceOutline(s)), sel.point === 'move', '', true);
  }
  for (const m of state.masks) {
    const isSel = sel.type === 'mask' && sel.id === m.id;
    poly(m.points);
    c2.fillStyle = m.enabled ? 'rgba(255,60,80,0.18)' : 'rgba(255,60,80,0.05)';
    c2.fill();
    c2.lineWidth = (isSel ? 2 : 1) * dpr;
    c2.setLineDash([6 * dpr, 4 * dpr]);
    c2.strokeStyle = isSel ? '#ffd400' : '#ff5a6a';
    c2.stroke();
    c2.setLineDash([]);
    if (isSel) {
      m.points.forEach((p, i) => handle(p, sel.point === i));
      handle(centroid(m.points), sel.point === 'move', '', true);
    }
  }
}

// ---------- header ----------
function renderHeader() {
  $('#btn-align').classList.toggle('on', !!state.align);
  $('#btn-blackout').classList.toggle('on', !!state.blackout);
}

function renderStatus() {
  const el = $('#status');
  el.textContent = '';
  el.append(h('span', { class: connected ? 'live' : 'off' }, connected ? '● Live' : '○ Offline'));
  if (!state) return;
  let txt = '';
  if (state.blackout) txt = ' · Blackout';
  else if (state.align) txt = ' · Align mode';
  else if (state.schedule.enabled) {
    const on = isShowTime(state.schedule);
    const w = showWindow(state.schedule, new Date());
    txt = ` · Schedule ${timeStr(w.start)}–${timeStr(w.end)} · projector ${on ? 'ON' : 'off now'}`;
  } else txt = ' · Projector on';
  el.append(txt);
}

// ---------- panel ----------
const TABS = [['surfaces', 'Surfaces'], ['masks', 'Masks'], ['show', 'Show'], ['layouts', 'Layouts'], ['schedule', 'Schedule']];

function renderPanel() {
  const nav = $('#tabs');
  nav.textContent = '';
  for (const [id, label] of TABS) nav.append(btn(label, () => { tab = id; renderPanel(); }, tab === id ? 'on' : ''));
  const body = $('#tab-body');
  const scroll = body.scrollTop;
  body.textContent = '';
  const content = { surfaces: surfacesTab, masks: masksTab, show: showTab, layouts: layoutsTab, schedule: scheduleTab }[tab]();
  body.append(...[content].flat(Infinity).filter(Boolean));
  body.scrollTop = scroll;
  renderHeader();
  renderStatus();
}

function addSurface(mode) {
  const s = newSurface(`Surface ${state.surfaces.length + 1}`, sceneIds.includes('magic-circle') ? 'magic-circle' : sceneIds[0], mode);
  state.surfaces.push(s);
  select('surface', s.id);
}

function surfacesTab() {
  const s = sel.type === 'surface' ? surface() : null;
  return [
    h('div', { class: 'row' },
      btn('+ Flat surface', () => addSurface('quad'), '', 'Four corner pins: driveway, garage door, wall'),
      btn('+ Curved surface', () => addSurface('mesh'), '', 'A grid of pins for curved or irregular shapes'),
      s && btn('Duplicate', () => {
        const c = clone(s); c.id = uid(); c.name = s.name + ' copy';
        const off = (p) => [p[0] + 0.03, p[1] + 0.03];
        c.corners = c.corners.map(off); if (c.mesh) c.mesh.points = c.mesh.points.map(off);
        state.surfaces.push(c); select('surface', c.id);
      }),
      s && btn('Delete', () => {
        if (!confirm(`Delete surface "${s.name}"?`)) return;
        state.surfaces = state.surfaces.filter((x) => x.id !== s.id); select(null, null);
      }, 'danger')),
    state.surfaces.length
      ? h('ul', { class: 'list' }, state.surfaces.map((x) => h('li', { class: x.id === sel.id ? 'sel' : '', onclick: () => select('surface', x.id) },
          h('input', { type: 'checkbox', checked: x.enabled, title: 'Show this surface', onclick: (e) => e.stopPropagation(), onchange: (e) => { x.enabled = e.target.checked; commit(); } }),
          h('span', { class: 'grow' }, x.name, ' ', h('span', { class: 'muted' }, x.playlist.map((p) => sceneName(p.scene)).join(' → '))))))
      : h('p', { class: 'note' }, 'No surfaces yet. Add one, then drag its corners onto the real surface while Align is on.'),
    s ? surfaceEditor(s) : h('p', { class: 'note' }, 'Select a surface in the list or on the preview to edit it.'),
  ];
}

function surfaceEditor(s) {
  return h('div', {},
    h('h3', {}, 'Surface'),
    field('Name', h('input', { type: 'text', value: s.name, oninput: (e) => { s.name = e.target.value; commit(); }, onchange: () => renderPanel() })),
    field('Shape', h('select', {
      value: s.mode,
      onchange: (e) => {
        s.mode = e.target.value;
        if (s.mode === 'mesh') s.mesh = meshFromQuad(s.corners, s.mesh?.cols || 3, s.mesh?.rows || 3);
        else if (s.mesh) s.corners = meshCorners(s.mesh);
        sel.point = null; commit(true);
      },
    }, h('option', { value: 'quad' }, 'Flat: 4 corner pins'), h('option', { value: 'mesh' }, 'Curved: grid of pins'))),
    s.mode === 'mesh' && field('Pins',
      h('input', { type: 'number', min: 1, max: 12, value: s.mesh.cols, style: 'width:4.5em', onchange: (e) => { s.mesh = meshFromQuad(meshCorners(s.mesh), Math.max(1, Math.min(12, +e.target.value || 1)), s.mesh.rows); commit(true); } }),
      '×',
      h('input', { type: 'number', min: 1, max: 12, value: s.mesh.rows, style: 'width:4.5em', onchange: (e) => { s.mesh = meshFromQuad(meshCorners(s.mesh), s.mesh.cols, Math.max(1, Math.min(12, +e.target.value || 1))); commit(true); } }),
      btn('Flatten', () => { s.mesh = meshFromQuad(meshCorners(s.mesh), s.mesh.cols, s.mesh.rows); commit(true); }, 'small', 'Reset the inner pins to a flat grid between the corners')),
    rangeField('Opacity', 0, 1, 0.01, s.opacity, (v) => { s.opacity = v; commit(); }),
    rangeField('Crossfade (s)', 0, 10, 0.5, s.crossfade, (v) => { s.crossfade = v; commit(); }),
    h('h3', {}, 'Playlist'),
    h('p', { class: 'note' }, s.playlist.length > 1 ? 'Plays in order and loops; all players stay in step.' : 'Add more scenes to rotate through them.'),
    s.playlist.map((p, i) => entryEditor(s, p, i)),
    btn('+ Add scene', () => { s.playlist.push({ scene: sceneIds.find((id) => id !== 'grid') || sceneIds[0], duration: 60, params: {} }); commit(true); }),
  );
}

function rangeField(label, min, max, step, value, set) {
  const out = h('span', { class: 'val' }, fmt(value));
  return field(label, h('input', { type: 'range', min, max, step, value, oninput: (e) => { set(+e.target.value); out.textContent = fmt(e.target.value); } }), out);
}

function entryEditor(s, p, i) {
  const def = scenes.get(p.scene);
  const moveEntry = (d) => { const j = i + d; if (j < 0 || j >= s.playlist.length) return; [s.playlist[i], s.playlist[j]] = [s.playlist[j], s.playlist[i]]; commit(true); };
  return h('div', { class: 'entry' },
    h('div', { class: 'row' },
      h('select', { value: p.scene, onchange: (e) => { p.scene = e.target.value; p.params = {}; commit(true); } },
        sceneIds.map((id) => h('option', { value: id }, sceneName(id)))),
      s.playlist.length > 1 && [
        h('input', { type: 'number', min: 1, value: p.duration, title: 'Seconds', style: 'width:5em', onchange: (e) => { p.duration = Math.max(1, +e.target.value || 1); commit(); } }), 's',
        btn('↑', () => moveEntry(-1), 'small'), btn('↓', () => moveEntry(1), 'small'),
        btn('✕', () => { s.playlist.splice(i, 1); commit(true); }, 'small danger'),
      ]),
    def ? (def.params || []).filter((prm) => prm.key !== 'highlight').map((prm) => paramControl(p, prm)) : h('p', { class: 'note' }, 'Scene not found.'));
}

function paramControl(entry, prm) {
  const val = entry.params[prm.key] ?? prm.default;
  const set = (v) => { entry.params[prm.key] = v; commit(); };
  if (prm.type === 'range') return rangeField(prm.label, prm.min, prm.max, prm.step || 'any', val, set);
  if (prm.type === 'color') return field(prm.label, h('input', { type: 'color', value: val, oninput: (e) => set(e.target.value) }));
  if (prm.type === 'select') return field(prm.label, h('select', { value: val, onchange: (e) => set(e.target.value) }, prm.options.map((o) => h('option', { value: o }, o))));
  if (prm.type === 'media') {
    const file = h('input', { type: 'file', accept: 'image/*,video/*', style: 'display:none', onchange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const name = f.name.replace(/[^A-Za-z0-9 _.()-]/g, '_');
      const up = h('span', { class: 'muted' }, ' Uploading…');
      e.target.parentElement.append(up);
      await fetch('/api/media/' + encodeURIComponent(name), { method: 'PUT', body: f });
      await refreshMedia();
      entry.params[prm.key] = name;
      commit(true);
    } });
    return field(prm.label,
      h('select', { value: val, onchange: (e) => set(e.target.value), style: 'flex:1;min-width:0' },
        h('option', { value: '' }, '(none)'), mediaFiles.map((m) => h('option', { value: m }, m))),
      file, btn('Upload…', () => file.click(), 'small'));
  }
  return field(prm.label, h('input', { type: 'text', value: val, onchange: (e) => set(e.target.value) }));
}

function masksTab() {
  const m = sel.type === 'mask' ? mask() : null;
  return [
    h('p', { class: 'note' }, 'Masks black out areas the projector must not light: windows, bushes, the car, people\'s faces at the door.'),
    h('div', { class: 'row' },
      btn('+ Mask', () => { const n = newMask(`Mask ${state.masks.length + 1}`); state.masks.push(n); select('mask', n.id); }),
      m && btn('Delete', () => { state.masks = state.masks.filter((x) => x.id !== m.id); select(null, null); }, 'danger')),
    state.masks.length ? h('ul', { class: 'list' }, state.masks.map((x) => h('li', { class: x.id === sel.id ? 'sel' : '', onclick: () => select('mask', x.id) },
      h('input', { type: 'checkbox', checked: x.enabled, onclick: (e) => e.stopPropagation(), onchange: (e) => { x.enabled = e.target.checked; commit(); } }),
      h('span', { class: 'grow' }, x.name, ' ', h('span', { class: 'muted' }, `${x.points.length} points`))))) : null,
    m && h('div', {},
      h('h3', {}, 'Mask'),
      field('Name', h('input', { type: 'text', value: m.name, oninput: (e) => { m.name = e.target.value; commit(); }, onchange: () => renderPanel() })),
      h('div', { class: 'row' },
        btn('Add point', () => {
          const i = typeof sel.point === 'number' ? sel.point : m.points.length - 1;
          const a = m.points[i], b = m.points[(i + 1) % m.points.length];
          m.points.splice(i + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
          sel.point = i + 1; commit(true);
        }),
        btn('Delete point', () => {
          if (typeof sel.point !== 'number' || m.points.length <= 3) return;
          m.points.splice(sel.point, 1); sel.point = null; commit(true);
        })),
      h('p', { class: 'note' }, 'Tip: double-click near an edge on the preview to add a point there.')),
  ];
}

function showTab() {
  const pick = h('select', {}, sceneIds.filter((id) => id !== 'grid').map((id) => h('option', { value: id }, sceneName(id))));
  return [
    h('h3', {}, 'Output'),
    rangeField('Brightness', 0, 1, 0.01, state.brightness, (v) => { state.brightness = v; commit(); }),
    h('div', { class: 'row' },
      btn(state.align ? 'Align: ON' : 'Align: off', () => { state.align = !state.align; commit(true); }, state.align ? 'on' : ''),
      btn(state.blackout ? 'Blackout: ON' : 'Blackout: off', () => { state.blackout = !state.blackout; commit(true); }, state.blackout ? 'on' : '')),
    h('p', { class: 'note' }, 'Align shows a numbered test grid on every surface. The preview here always shows the content; the projector follows Blackout, Brightness and the Schedule.'),
    h('h3', {}, 'Quick change'),
    h('div', { class: 'row' }, pick, btn('Put on all surfaces', () => {
      for (const s of state.surfaces) s.playlist = [{ scene: pick.value, duration: 60, params: {} }];
      commit(true);
    })),
    h('h3', {}, 'Projector'),
    field('Resolution', h('input', { type: 'number', value: state.output.width, style: 'width:6em', onchange: (e) => { state.output.width = +e.target.value || 1920; sizeStage(); commit(); } }), '×',
      h('input', { type: 'number', value: state.output.height, style: 'width:6em', onchange: (e) => { state.output.height = +e.target.value || 1080; sizeStage(); commit(); } })),
    h('p', { class: 'note' }, 'Coolid C2 reports 1920×1080 (EDID). This sets the preview shape and the arrow-key step.'),
  ];
}

async function refreshLayouts() { layoutNames = await (await fetch('/api/layouts')).json(); }
async function refreshMedia() { mediaFiles = await (await fetch('/api/media')).json(); }

function layoutsTab() {
  const name = h('input', { type: 'text', placeholder: 'e.g. Driveway Halloween', style: 'flex:1' });
  return [
    h('p', { class: 'note' }, 'A layout stores the surfaces, their scenes and the masks. Save one per spot (driveway, garage door) and switch between them.'),
    h('div', { class: 'row' }, name, btn('Save', async () => {
      const n = name.value.trim().replace(/[^A-Za-z0-9 _.()-]/g, '_');
      if (!n) return name.focus();
      await fetch('/api/layouts/' + encodeURIComponent(n), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ surfaces: state.surfaces, masks: state.masks, output: state.output }) });
      await refreshLayouts(); renderPanel();
    })),
    layoutNames.length ? h('ul', { class: 'list' }, layoutNames.map((n) => h('li', {},
      h('span', { class: 'grow' }, n),
      btn('Load', async () => {
        if (!confirm(`Replace the current surfaces and masks with "${n}"?`)) return;
        const l = await (await fetch('/api/layouts/' + encodeURIComponent(n))).json();
        state = normalizeState({ ...state, surfaces: l.surfaces, masks: l.masks, output: l.output || state.output });
        sel = { type: null, id: null, point: null };
        sizeStage(); commit(true);
      }, 'small'),
      btn('✕', async () => {
        if (!confirm(`Delete layout "${n}"?`)) return;
        await fetch('/api/layouts/' + encodeURIComponent(n), { method: 'DELETE' });
        await refreshLayouts(); renderPanel();
      }, 'small danger')))) : h('p', { class: 'note' }, 'No saved layouts yet.'),
  ];
}

function scheduleTab() {
  const sc = state.schedule;
  const w = showWindow(sc, new Date());
  const set = (fn) => (e) => { fn(e.target); commit(true); };
  return [
    h('p', { class: 'note' }, 'When on, the projector only lights up inside this window each night (it fades in and out). Align mode overrides it.'),
    field('Use schedule', h('input', { type: 'checkbox', checked: sc.enabled, onchange: set((t) => { sc.enabled = t.checked; }) })),
    field('Start', h('select', { value: sc.start.type, onchange: set((t) => { sc.start.type = t.value; }) },
      h('option', { value: 'sunset' }, 'At sunset'), h('option', { value: 'time' }, 'At a set time'))),
    sc.start.type === 'sunset'
      ? field('Offset (min)', h('input', { type: 'number', value: sc.start.offset, style: 'width:6em', onchange: set((t) => { sc.start.offset = +t.value || 0; }) }), h('span', { class: 'muted' }, '− before, + after'))
      : field('Start time', h('input', { type: 'time', value: sc.start.time, onchange: set((t) => { sc.start.time = t.value; }) })),
    field('End time', h('input', { type: 'time', value: sc.end, onchange: set((t) => { sc.end = t.value; }) })),
    field('Location', h('input', { type: 'number', step: 0.001, value: sc.lat, style: 'width:7em', title: 'Latitude', onchange: set((t) => { sc.lat = +t.value; }) }),
      h('input', { type: 'number', step: 0.001, value: sc.lon, style: 'width:7em', title: 'Longitude', onchange: set((t) => { sc.lon = +t.value; }) })),
    h('p', { class: 'note' }, `Tonight: ${timeStr(w.start)} to ${timeStr(w.end)}. Uses the player's clock.`),
  ];
}

// ---------- start ----------
async function init() {
  const ids = await (await fetch('/api/scenes')).json();
  await Promise.all(ids.map(async (id) => { const e = loadScene(id); await e.promise; if (e.def) scenes.set(id, e.def); }));
  sceneIds = ids.filter((id) => scenes.has(id));
  await Promise.all([refreshMedia(), refreshLayouts()]);
  state = normalizeState(await (await fetch('/api/state')).json());
  if (state.surfaces[0]) sel = { type: 'surface', id: state.surfaces[0].id, point: null };
  engine.setState(state);
  engine.start();
  setupStage();
  sizeStage();
  renderPanel();
  connectEvents();
  $('#btn-align').onclick = () => { state.align = !state.align; commit(true); };
  $('#btn-blackout').onclick = () => { state.blackout = !state.blackout; commit(true); };
  setInterval(renderStatus, 15000);
}

init().catch((e) => { document.body.prepend(h('p', { style: 'color:#ff4d5e;padding:8px' }, 'Failed to start: ' + e.message)); console.error(e); });
