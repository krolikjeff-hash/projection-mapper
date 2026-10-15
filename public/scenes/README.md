# Scene format

A scene is an ES module whose default export describes it. The player loads it from `/scenes/<id>.js` (built-ins here,
uploads in `data/scenes/`). Each surface renders its scene into its own texture, sized to the surface's shape (1024 px on
the long side in the player), which is then warped onto the projector image.

Common fields:

```js
export default {
  id: 'my-scene',            // same as the file name
  name: 'My scene',          // shown in the control page
  kind: 'shader' | 'canvas',
  params: [                  // controls shown in the playlist editor
    { key: 'color', label: 'Colour', type: 'color', default: '#ff6a00' },
    { key: 'speed', label: 'Speed', type: 'range', min: 0, max: 3, step: 0.1, default: 1 },
    { key: 'fit', label: 'Fit', type: 'select', options: ['a', 'b'], default: 'a' },   // canvas scenes
    { key: 'src', label: 'File', type: 'media', default: '' },                         // canvas scenes
  ],
};
```

## `kind: 'shader'`

`fragment` is GLSL ES 1.00 (WebGL 1) without a header. The engine declares:

```glsl
varying vec2 v_uv;       // 0..1 across the surface, y up
uniform float u_time;    // seconds since this playlist entry started (wraps hourly)
uniform vec2 u_res;      // texture size in pixels (use it to keep circles round)
uniform vec3 u_<key>;    // each colour param
uniform float u_<key>;   // each range param
```

Write `void main(){ ... gl_FragColor = vec4(col, 1.0); }`. Black is "no light", which is the projector's background.
Don't use `smoothstep` with reversed edges (undefined in GLSL); use `1.0 - smoothstep(a, b, x)`.

## `kind: 'canvas'`

```js
create() { return {}; },                       // per-surface state
resize(st, w, h) {},                           // optional, texture size changed
draw(st, ctx, w, h, t, dt, params) {},         // Canvas 2D, every frame; t = entry seconds, dt = frame seconds
dispose(st) {},                                // optional, e.g. stop a video
```

Projection tips: bold, saturated colours on a black background read best on grey concrete. Dark shapes only show
where there's light around them (see `spiders.js`).
