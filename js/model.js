// State model shared by the server, the player and the control page (no DOM).
import { meshFromQuad } from './geometry.js';

export const uid = () => Math.random().toString(36).slice(2, 9);

export function newSurface(name = 'Surface', scene = 'magic-circle', mode = 'quad') {
  const corners = [[0.3, 0.25], [0.7, 0.25], [0.7, 0.75], [0.3, 0.75]];
  return {
    id: uid(), name, enabled: true, mode, corners,
    mesh: mode === 'mesh' ? meshFromQuad(corners, 3, 3) : null,
    opacity: 1, crossfade: 2,
    playlist: [{ scene, duration: 60, params: {} }],
  };
}

export function newMask(name = 'Mask') {
  return { id: uid(), name, enabled: true, points: [[0.45, 0.45], [0.55, 0.45], [0.55, 0.55], [0.45, 0.55]] };
}

export function defaultState() {
  return {
    version: 0,
    output: { width: 1920, height: 1080 },
    align: false,
    blackout: false,
    brightness: 1,
    selected: null,
    surfaces: [newSurface('Driveway')],
    masks: [],
    // Campbell, CA by default; start can follow sunset.
    schedule: { enabled: false, start: { type: 'sunset', offset: -10, time: '18:00' }, end: '22:00', lat: 37.287, lon: -121.95 },
    // Party mode: guests' generated animations take over one surface in turn (functions/index.js, cloud.js).
    // approve: "Hold for my OK" - finished animations wait for the host's Approve before they can play.
    party: { enabled: false, surfaceId: null, seconds: 45, replay: true, approve: false },
    partyNow: null, // { itemId, sceneId, title, by, startedAt, until } while a guest animation plays
  };
}

export function normalizeSurface(s) {
  const d = newSurface();
  const out = { ...d, ...s };
  if (!Array.isArray(out.corners) || out.corners.length !== 4) out.corners = d.corners;
  if (out.mode === 'mesh' && !out.mesh) out.mesh = meshFromQuad(out.corners, 3, 3);
  if (!Array.isArray(out.playlist) || !out.playlist.length) out.playlist = d.playlist;
  out.playlist = out.playlist.map((p) => ({ scene: p.scene || 'magic-circle', duration: Math.max(1, +p.duration || 60), params: p.params || {} }));
  return out;
}

export function normalizeState(s) {
  const d = defaultState();
  s = { ...d, ...(s || {}) };
  s.output = { ...d.output, ...(s.output || {}) };
  const sc = s.schedule || {};
  s.schedule = { ...d.schedule, ...sc, start: { ...d.schedule.start, ...(sc.start || {}) } };
  s.party = { ...d.party, ...(s.party || {}) };
  s.surfaces = (Array.isArray(s.surfaces) ? s.surfaces : []).map(normalizeSurface);
  s.masks = (Array.isArray(s.masks) ? s.masks : []).filter((m) => Array.isArray(m.points) && m.points.length >= 3);
  return s;
}

// The surface guests' animations play on: the chosen one, else the first enabled one.
export function partySurface(s) {
  return s.surfaces.find((x) => x.id === s.party.surfaceId) || s.surfaces.find((x) => x.enabled) || s.surfaces[0] || null;
}
