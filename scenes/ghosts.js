// Friendly glowing ghosts drifting across and bobbing.
const TAU = Math.PI * 2;

function spawn(w, h, S, p, anywhere) {
  const dir = Math.random() < 0.5 ? -1 : 1, s = 0.7 + Math.random() * 0.6, R = (S * p.size * s) / 2;
  return {
    dir, s, phase: Math.random() * TAU,
    x: anywhere ? Math.random() * w : dir > 0 ? -R * 2 : w + R * 2,
    y: h * (0.15 + Math.random() * 0.7),
    v: (0.5 + Math.random() * 0.5) * S * 0.08,
  };
}

export default {
  id: 'ghosts',
  name: 'Drifting ghosts',
  kind: 'canvas',
  params: [
    { key: 'count', label: 'Ghosts', type: 'range', min: 1, max: 20, step: 1, default: 5 },
    { key: 'size', label: 'Size', type: 'range', min: 0.08, max: 0.6, step: 0.01, default: 0.25 },
    { key: 'speed', label: 'Speed', type: 'range', min: 0.1, max: 3, step: 0.1, default: 1 },
    { key: 'color', label: 'Colour', type: 'color', default: '#dff4ff' },
    { key: 'glow', label: 'Glow', type: 'range', min: 0, max: 1, step: 0.05, default: 0.6 },
  ],
  create: () => ({ ghosts: [] }),
  resize(st) { st.ghosts = []; },
  draw(st, ctx, w, h, t, dt, p) {
    const S = Math.min(w, h);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const count = Math.round(p.count);
    while (st.ghosts.length < count) st.ghosts.push(spawn(w, h, S, p, true));
    st.ghosts.length = count;
    st.ghosts.forEach((g, i) => {
      const R = (S * p.size * g.s) / 2;
      g.x += g.dir * g.v * p.speed * dt;
      if ((g.dir > 0 && g.x > w + R * 2.5) || (g.dir < 0 && g.x < -R * 2.5)) { st.ghosts[i] = spawn(w, h, S, p, false); return; }
      const y = g.y + Math.sin(t * 1.3 + g.phase) * R * 0.25;
      ctx.save();
      ctx.translate(g.x, y);
      ctx.scale(g.dir, 1);
      ctx.rotate(0.08 + Math.sin(t * 1.3 + g.phase + 1) * 0.05);
      ctx.globalAlpha = 0.85 + 0.15 * Math.sin(t * 2 + g.phase);
      ctx.shadowColor = p.color;
      ctx.shadowBlur = R * 0.8 * p.glow;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.moveTo(-R, 0);
      ctx.arc(0, 0, R, Math.PI, 0);
      ctx.lineTo(R, R * 1.4);
      const n = 16;
      for (let k = 1; k <= n; k++) {
        const x = R - (2 * R * k) / n;
        ctx.lineTo(x, R * 1.4 + Math.sin((k / n) * TAU * 2 + t * 5 + g.phase) * R * 0.14);
      }
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      for (const e of [-1, 1]) { ctx.beginPath(); ctx.ellipse(R * 0.32 + e * R * 0.22, -R * 0.1, R * 0.11, R * 0.17, 0, 0, TAU); ctx.fill(); }
      ctx.beginPath(); ctx.ellipse(R * 0.36, R * 0.35, R * 0.1, R * 0.14 + Math.sin(t * 3 + g.phase) * R * 0.04, 0, 0, TAU); ctx.fill();
      ctx.restore();
    });
  },
};
