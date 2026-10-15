// Slow swirling witch's fog in two colours.
export default {
  id: 'fog',
  name: 'Swirling fog',
  kind: 'shader',
  params: [
    { key: 'color', label: 'Colour 1', type: 'color', default: '#2bff6a' },
    { key: 'color2', label: 'Colour 2', type: 'color', default: '#7a2bff' },
    { key: 'density', label: 'Density', type: 'range', min: 0.2, max: 2, step: 0.05, default: 1 },
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 3, step: 0.05, default: 1 },
  ],
  fragment: `
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}
void main(){
  float s = min(u_res.x, u_res.y);
  vec2 p = (v_uv - 0.5) * u_res / s * 3.0;
  float t = u_time * u_speed;
  vec2 q = vec2(fbm(p + t * 0.05), fbm(p + vec2(5.2, 1.3) - t * 0.04));
  float f = fbm(p + 3.0 * q + t * 0.03);
  float d = smoothstep(0.35, 0.95, f) * u_density;
  vec3 col = mix(u_color, u_color2, smoothstep(0.3, 0.7, q.x)) * d;
  vec2 e = min(v_uv, 1.0 - v_uv);
  col *= smoothstep(0.0, 0.12, min(e.x, e.y));
  gl_FragColor = vec4(col, 1.0);
}`,
};
