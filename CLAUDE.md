# Projection Mapper — project instructions for Claude

## Where things live
- Code: this repo, `C:\Users\kroli\source\projection-mapper` (git; no GitHub remote yet; ask Jeff before creating one).
- Project home (spec, decisions, projector notes, photos): `%OneDriveConsumer%\Claude\Home Projects\Projection Mapping\`
  (`START-HERE.md`, `SPEC.md`, `PROJECTOR-ACCESS.md`). Read START-HERE first.
- Runtime data: `data/` (state, layouts, media, uploaded scenes), git-ignored.

## Current state
See the project home's START-HERE "Next steps". Deadline: Halloween, Sat 2026-10-31. Hardware: Coolid C2 projector
(1920×1080 input over HDMI, no ADB) driven by a Raspberry Pi 5 running the player in Chromium kiosk mode.

## How to run
- `node server.js` (port 8080). Control `http://localhost:8080/`, player `/player`.
- In the Claude desktop app: the `projection-mapper` entry in the project home's `.claude/launch.json` starts it in the
  browser pane.

## Working rules
- No npm packages: Node built-ins on the server, plain ES modules in the browser (the Pi and the projector's Android should
  run it as is).
- WebGL 1 / GLSL ES 1.00 for compatibility.
- Scene format: `public/scenes/README.md`. Test new scenes in Align off, on a black background, at 1920×1080.

## Gotchas learned
- Background browser tabs throttle requestAnimationFrame: time fades with the real clock, not the per-frame step.
- GLSL `smoothstep` with reversed edges is undefined; use `1.0 - smoothstep(...)`.
