// Spiders crawling across a pool of light. A projector can't make black on grey concrete, so the spiders are
// shadows in a coloured glow: keep the light colour bold and the spider colour black.
const TAU = Math.PI * 2;

function spawn(w, h) {
  return {
    x: Math.random() * w, y: Math.random() * h, a: Math.random() * TAU,
    v: 0, turn: 0, pause: Math.random() * 2, gait: Math.random() * 10, scale: 0.7 + Math.random() * 0.6,
  };
}

function drawSpider(ctx, s, L, p) {
  L *= s.scale;
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate(s.a);
  ctx.strokeStyle = p.spider;
  ctx.fillStyle = p.spider;
  ctx.lineWidth = Math.max(1, L * 0.065);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const phase = s.gait + (i % 2 ? Math.PI : 0) + (side > 0 ? Math.PI : 0);
      const ang = side * (Math.PI / 2 + (i - 1.5) * 0.5) + side * Math.sin(phase) * 0.28;
      const rx = L * (0.12 - 0.06 * i), ry = side * L * 0.06;
      const kx = rx + Math.cos(ang - side * 0.35) * L * 0.55, ky = ry + Math.sin(ang - side * 0.35) * L * 0.55;
      const fx = kx + Math.cos(ang + side * 0.4) * L * 0.6, fy = ky + Math.sin(ang + side * 0.4) * L * 0.6;
      ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(kx, ky); ctx.lineTo(fx, fy); ctx.stroke();
    }
  }
  ctx.beginPath(); ctx.ellipse(-L * 0.3, 0, L * 0.32, L * 0.24, 0, 0, TAU); ctx.fill();
  ctx.beginPath(); ctx.ellipse(L * 0.1, 0, L * 0.17, L * 0.14, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = p.eyes;
  ctx.shadowColor = p.eyes; ctx.shadowBlur = L * 0.15;
  for (const e of [-1, 1]) { ctx.beginPath(); ctx.arc(L * 0.22, e * L * 0.045, L * 0.028, 0, TAU); ctx.fill(); }
  ctx.restore();
}

export default {
  id: 'spiders',
  name: 'Crawling spiders',
  kind: 'canvas',
  params: [
    { key: 'count', label: 'Spiders', type: 'range', min: 1, max: 60, step: 1, default: 14 },
    { key: 'size', label: 'Size', type: 'range', min: 0.03, max: 0.3, step: 0.005, default: 0.1 },
    { key: 'speed', label: 'Speed', type: 'range', min: 0.1, max: 3, step: 0.1, default: 1 },
    { key: 'background', label: 'Light colour', type: 'color', default: '#5a1a8a' },
    { key: 'spider', label: 'Spider colour', type: 'color', default: '#000000' },
    { key: 'eyes', label: 'Eye colour', type: 'color', default: '#ff2a00' },
  ],
  create: () => ({ spiders: [] }),
  resize(st) { st.spiders = []; },
  draw(st, ctx, w, h, t, dt, p) {
    const S = Math.min(w, h), L = S * p.size;
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) * 0.55);
    g.addColorStop(0, p.background);
    g.addColorStop(0.7, p.background);
    g.addColorStop(1, '#000000');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const count = Math.round(p.count);
    while (st.spiders.length < count) st.spiders.push(spawn(w, h));
    st.spiders.length = count;
    const m = L * 1.5;
    for (const s of st.spiders) {
      if (s.pause > 0) { s.pause -= dt; s.v *= Math.max(0, 1 - dt * 8); }
      else {
        if (Math.random() < dt * 0.25) s.pause = 0.3 + Math.random() * 1.8;
        s.turn += (Math.random() - 0.5) * dt * 8;
        s.turn *= 0.96;
        s.a += s.turn * dt;
        s.v += (p.speed * S * 0.12 * s.scale - s.v) * Math.min(1, dt * 4);
      }
      s.x += Math.cos(s.a) * s.v * dt;
      s.y += Math.sin(s.a) * s.v * dt;
      s.gait += (s.v * dt) / (L * s.scale) * 5;
      if (s.x < -m) s.x = w + m; else if (s.x > w + m) s.x = -m;
      if (s.y < -m) s.y = h + m; else if (s.y > h + m) s.y = -m;
      drawSpider(ctx, s, L, p);
    }
  },
};
