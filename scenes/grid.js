// Alignment test pattern: grid, border, centre cross and a circle (a circle that looks round on the
// ground means the corners are right). Used for every surface in Align mode.
export default {
  id: 'grid',
  name: 'Test grid',
  kind: 'shader',
  params: [
    { key: 'color', label: 'Colour', type: 'color', default: '#00c8ff' },
    { key: 'highlight', label: 'Highlight', type: 'range', min: 0, max: 1, step: 1, default: 0 },
  ],
  fragment: `
float lineAA(float d, float w){ return 1.0 - smoothstep(w, w + 1.5, d); }
void main(){
  vec2 px = v_uv * u_res;
  float cell = u_res.y / 8.0;
  vec2 g = abs(fract(px / cell + 0.5) - 0.5) * cell;
  float grid = lineAA(min(g.x, g.y), 0.6);
  vec2 e = min(px, u_res - px);
  float border = lineAA(min(e.x, e.y), 3.0 + u_highlight * 3.0);
  vec2 c = abs(px - u_res * 0.5);
  float cross = lineAA(min(c.x, c.y), 1.2) * step(max(c.x, c.y), cell * 0.6);
  float circ = lineAA(abs(length(px - u_res * 0.5) - min(u_res.x, u_res.y) * 0.45), 1.2);
  vec3 col = u_color * (0.12 + 0.18 * u_highlight) + u_color * grid * 0.7 + vec3(1.0) * clamp(border + cross + circ, 0.0, 1.0);
  gl_FragColor = vec4(col, 1.0);
}`,
};
