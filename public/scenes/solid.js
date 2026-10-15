// Plain colour, optionally pulsing. Handy for brightness checks and simple washes.
export default {
  id: 'solid',
  name: 'Solid colour',
  kind: 'shader',
  params: [
    { key: 'color', label: 'Colour', type: 'color', default: '#ff6a00' },
    { key: 'pulse', label: 'Pulse', type: 'range', min: 0, max: 1, step: 0.05, default: 0 },
    { key: 'rate', label: 'Pulse rate', type: 'range', min: 0.1, max: 4, step: 0.1, default: 1 },
  ],
  fragment: `
void main(){
  float k = 1.0 - u_pulse * (0.5 + 0.5 * sin(u_time * u_rate * 6.2831853));
  gl_FragColor = vec4(u_color * k, 1.0);
}`,
};
