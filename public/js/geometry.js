// Geometry shared by the engine, the control page and the server (no DOM).
// Output coordinates are normalised: (0,0) top-left, (1,1) bottom-right of the projector image.
// Surface coordinates (u,v): (0,0) = corner 1 (top-left of the content), (1,1) = corner 3.

// Homography mapping the unit square onto quad q = [p00, p10, p11, p01] (Heckbert).
export function squareToQuad(q) {
  const [x0, y0] = q[0], [x1, y1] = q[1], [x2, y2] = q[2], [x3, y3] = q[3];
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(sx) > 1e-12 || Math.abs(sy) > 1e-12) {
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    const den = dx1 * dy2 - dx2 * dy1 || 1e-12;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

// Inverse of a homography from squareToQuad: output point -> (u,v).
export function invertH(H) {
  const [a, b, c, d, e, f, g, h] = H;
  const A = e - f * h, B = c * h - b, C = b * f - c * e;
  const D = f * g - d, E = a - c * g, F = c * d - a * f;
  const G = d * h - e * g, Hh = b * g - a * h, I = a * e - b * d;
  return [A / I, B / I, C / I, D / I, E / I, F / I, G / I, Hh / I];
}

// Width / height of a surface in output pixels.
export function surfaceAspect(s, out = { width: 1920, height: 1080 }) {
  const f = surfaceMap(s);
  const len = (fn) => {
    let L = 0, prev = fn(0);
    for (let i = 1; i <= 8; i++) { const p = fn(i / 8); L += Math.hypot((p[0] - prev[0]) * out.width, (p[1] - prev[1]) * out.height); prev = p; }
    return L;
  };
  const w = (len((t) => f(t, 0)) + len((t) => f(t, 1))) / 2, h = (len((t) => f(0, t)) + len((t) => f(1, t))) / 2;
  return w / Math.max(h, 1);
}

// Output point -> surface (u,v) (exact for flat surfaces, corner-based approximation for meshes).
export function outputToSurface(s, p) {
  const corners = s.mode === 'mesh' && s.mesh ? meshCorners(s.mesh) : s.corners;
  return applyH(invertH(squareToQuad(corners)), p[0], p[1]);
}

export function applyH(H, u, v) {
  const [a, b, c, d, e, f, g, h] = H;
  const w = g * u + h * v + 1;
  return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
}

// Mesh control point (i = column, j = row), extrapolated linearly past the edges.
function meshPoint(m, i, j) {
  const ext = (a, b) => [2 * a[0] - b[0], 2 * a[1] - b[1]];
  if (j < 0) return ext(meshPoint(m, i, 0), meshPoint(m, i, 1));
  if (j > m.rows) return ext(meshPoint(m, i, m.rows), meshPoint(m, i, m.rows - 1));
  if (i < 0) return ext(meshPoint(m, 0, j), meshPoint(m, 1, j));
  if (i > m.cols) return ext(meshPoint(m, m.cols, j), meshPoint(m, m.cols - 1, j));
  return m.points[j * (m.cols + 1) + i];
}

const cr = (p0, p1, p2, p3, t) =>
  0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);

// Smooth (Catmull-Rom) surface through the mesh control points.
export function meshEval(m, u, v) {
  const fu = Math.min(Math.max(u, 0), 1) * m.cols, fv = Math.min(Math.max(v, 0), 1) * m.rows;
  const i = Math.min(Math.floor(fu), m.cols - 1), j = Math.min(Math.floor(fv), m.rows - 1);
  const tu = fu - i, tv = fv - j;
  const col = [];
  for (let k = -1; k <= 2; k++) {
    const a = meshPoint(m, i - 1, j + k), b = meshPoint(m, i, j + k), c = meshPoint(m, i + 1, j + k), d = meshPoint(m, i + 2, j + k);
    col.push([cr(a[0], b[0], c[0], d[0], tu), cr(a[1], b[1], c[1], d[1], tu)]);
  }
  return [cr(col[0][0], col[1][0], col[2][0], col[3][0], tv), cr(col[0][1], col[1][1], col[2][1], col[3][1], tv)];
}

export function meshFromQuad(corners, cols, rows) {
  const H = squareToQuad(corners), points = [];
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) points.push(applyH(H, i / cols, j / rows));
  return { cols, rows, points, auto: true };
}

const isEdge = (m, i, j) => i === 0 || j === 0 || i === m.cols || j === m.rows;

// Re-space the inner pins evenly between the outer ones (a Coons patch over the edge pins).
export function fillInner(m) {
  const at = (i, j) => m.points[j * (m.cols + 1) + i];
  const c00 = at(0, 0), c10 = at(m.cols, 0), c01 = at(0, m.rows), c11 = at(m.cols, m.rows);
  for (let j = 1; j < m.rows; j++) for (let i = 1; i < m.cols; i++) {
    const u = i / m.cols, v = j / m.rows, p = [0, 0];
    for (const k of [0, 1]) {
      p[k] = (1 - v) * at(i, 0)[k] + v * at(i, m.rows)[k] + (1 - u) * at(0, j)[k] + u * at(m.cols, j)[k]
        - ((1 - u) * (1 - v) * c00[k] + u * (1 - v) * c10[k] + (1 - u) * v * c01[k] + u * v * c11[k]);
    }
    m.points[j * (m.cols + 1) + i] = p;
  }
  return m;
}

export function isEdgePin(m, index) { return isEdge(m, index % (m.cols + 1), Math.floor(index / (m.cols + 1))); }

// New pin count, keeping the outline: edge pins are resampled along the current curved edges.
export function resampleMesh(m, cols, rows) {
  const points = [];
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
    points.push(isEdge({ cols, rows }, i, j) ? meshEval(m, i / cols, j / rows) : [0, 0]);
  }
  return fillInner({ cols, rows, points, auto: m.auto });
}

export function meshCorners(m) {
  const at = (i, j) => [...m.points[j * (m.cols + 1) + i]];
  return [at(0, 0), at(m.cols, 0), at(m.cols, m.rows), at(0, m.rows)];
}

// (u,v) -> output point for a surface.
export function surfaceMap(s) {
  if (s.mode === 'mesh' && s.mesh) return (u, v) => meshEval(s.mesh, u, v);
  const H = squareToQuad(s.corners);
  return (u, v) => applyH(H, u, v);
}

// Closed outline of a surface (clockwise from corner 1).
export function surfaceOutline(s, n = 12) {
  if (!(s.mode === 'mesh' && s.mesh)) return s.corners.map((p) => [...p]);
  const f = surfaceMap(s), out = [];
  for (let k = 0; k < n; k++) out.push(f(k / n, 0));
  for (let k = 0; k < n; k++) out.push(f(1, k / n));
  for (let k = 0; k < n; k++) out.push(f(1 - k / n, 1));
  for (let k = 0; k < n; k++) out.push(f(0, 1 - k / n));
  return out;
}

export function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}
