// Glowing lava cracks that split open from the centre, then close again.
export default {
  id: 'ground-cracks',
  name: 'Ground cracks (lava)',
  kind: 'shader',
  params: [
    { key: 'color', label: 'Lava colour', type: 'color', default: '#ff4a00' },
    { key: 'cycle', label: 'Open/close cycle (s)', type: 'range', min: 4, max: 60, step: 1, default: 14 },
    { key: 'scale', label: 'Crack size', type: 'range', min: 1, max: 8, step: 0.1, default: 3 },
  ],
  fragment: `
vec2 hash2(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Distance to the nearest Voronoi edge (Inigo Quilez).
float edge(vec2 x){
  vec2 n = floor(x), f = fract(x), mg = vec2(0.0), mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j)), r = g + hash2(n + g) - f;
    float d = dot(r, r);
    if (d < md) { md = d; mr = r; mg = g; }
  }
  md = 8.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 g = mg + vec2(float(i), float(j)), r = g + hash2(n + g) - f;
    if (dot(mr - r, mr - r) > 0.00001) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
  }
  return md;
}
void main(){
  float s = min(u_res.x, u_res.y);
  vec2 p = (v_uv - 0.5) * u_res / s;
  float phase = 0.5 - 0.5 * cos(6.2831853 * u_time / u_cycle);
  vec2 q = p * u_scale + 0.35 * vec2(noise(p * 4.0), noise(p * 4.0 + 7.3));
  float e = edge(q);
  float e2 = edge(q * 2.3 + 11.0);
  float reach = phase * 1.1 + 0.1 * noise(p * 6.0 + u_time * 0.2);
  float open = 1.0 - smoothstep(reach - 0.15, reach, length(p));
  float width = (0.015 + 0.07 * phase) * open;
  float crack = 1.0 - smoothstep(0.0, width + 0.001, e);
  float small = (1.0 - smoothstep(0.0, width * 0.5 + 0.001, e2)) * smoothstep(0.4, 0.9, phase) * open;
  float glow = exp(-e * 18.0) * open * phase;
  float flick = 0.85 + 0.15 * noise(vec2(u_time * 3.0, e * 20.0));
  float k = max(crack, small * 0.7) * open;
  vec3 hot = mix(u_color, vec3(1.0, 0.9, 0.5), smoothstep(0.6, 1.0, k));
  vec3 col = hot * k * flick + u_color * glow * 0.6;
  gl_FragColor = vec4(col, 1.0);
}`,
};
