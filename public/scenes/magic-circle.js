// A glowing summoning circle: rotating rune band, counter-rotating pentagram, pulsing glow.
export default {
  id: 'magic-circle',
  name: 'Magic circle',
  kind: 'shader',
  params: [
    { key: 'color', label: 'Colour', type: 'color', default: '#39ff6a' },
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 3, step: 0.05, default: 1 },
    { key: 'glow', label: 'Glow', type: 'range', min: 0, max: 2, step: 0.05, default: 1 },
    { key: 'size', label: 'Size', type: 'range', min: 0.3, max: 1, step: 0.01, default: 0.95 },
  ],
  fragment: `
#define PI 3.14159265
float band(float d, float w){ return 1.0 - smoothstep(0.0, w, abs(d)); }
float seg(vec2 p, vec2 a, vec2 b, float w){
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return 1.0 - smoothstep(0.0, w, length(pa - ba * h));
}
float hash(float n){ return fract(sin(n) * 43758.5453); }
void main(){
  float s = min(u_res.x, u_res.y);
  vec2 p = (v_uv - 0.5) * u_res / s * 2.0 / u_size;
  float t = u_time * u_speed;
  float r = length(p), a = atan(p.y, p.x);
  float w = 0.014;
  float v = band(r - 0.97, w) + band(r - 0.86, w * 0.7) + band(r - 0.64, w) + band(r - 0.58, w * 0.6) + band(r - 0.2, w);

  // Rune band between the two outer rings.
  float ar = a / (2.0 * PI) + 0.5 + t * 0.03;
  float n = 40.0, id = floor(ar * n), f = fract(ar * n);
  float y = (r - 0.875) / 0.085;
  if (y > 0.12 && y < 0.88 && f > 0.15 && f < 0.85) {
    float x = (f - 0.15) / 0.7, h = hash(id), k = 0.09;
    float g = step(0.35, h) * band(x - 0.5, k)
            + step(0.4, fract(h * 7.0)) * band(y - 0.5, k)
            + step(0.55, fract(h * 13.0)) * band(x - y, k)
            + step(0.6, fract(h * 29.0)) * band(x - (1.0 - y), k)
            + step(0.7, fract(h * 51.0)) * band(length(vec2(x, y) - 0.5) - 0.3, k);
    v += clamp(g, 0.0, 1.0);
  }

  // Pentagram, rotating the other way.
  for (int i = 0; i < 5; i++) {
    float a1 = -t * 0.12 + PI * 0.5 + float(i) * 2.0 * PI / 5.0;
    float a2 = a1 + 4.0 * PI / 5.0;
    v += seg(p, 0.64 * vec2(cos(a1), sin(a1)), 0.64 * vec2(cos(a2), sin(a2)), w);
  }

  // Inner ticks.
  float tk = fract((a / (2.0 * PI)) * 24.0 - t * 0.1);
  v += step(0.82, tk) * step(0.22, r) * step(r, 0.3);

  float pulse = 0.75 + 0.25 * sin(u_time * 2.2);
  float halo = exp(-abs(r - 0.8) * 5.0) * 0.18 * u_glow * pulse;
  float core = exp(-r * 6.0) * 0.25 * u_glow * pulse;
  v = clamp(v, 0.0, 1.0);
  vec3 col = u_color * (v * pulse * 1.3 + halo + core) + vec3(1.0) * v * 0.25 * pulse;
  col *= 1.0 - smoothstep(1.02, 1.1, r);
  gl_FragColor = vec4(col, 1.0);
}`,
};
