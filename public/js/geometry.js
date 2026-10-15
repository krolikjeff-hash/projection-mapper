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
  return { cols, rows, points };
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
