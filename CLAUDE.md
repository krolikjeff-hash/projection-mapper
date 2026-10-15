# Projection Mapper — project instructions for Claude

## Where things live
- Code: this repo, `C:\Users\kroli\source\projection-mapper`, GitHub `krolikjeff-hash/projection-mapper` (public;
  GitHub Pages serves the repo root at https://krolikjeff-hash.github.io/projection-mapper/).
- Backend: Firebase project `projection-mapper-jk` (Blaze plan, Jeff's billing): Firestore (nam5), Auth (Google +
  Anonymous; `krolikjeff-hash.github.io` authorized), Storage, Cloud Function `generateAnimation` (secret
  `ANTHROPIC_API_KEY`).
- Project home (spec, decisions, projector notes): `%OneDriveConsumer%\Claude\Home Projects\Projection Mapping\`
  (`START-HERE.md`, `SPEC.md`, `PROJECTOR-ACCESS.md`). Read START-HERE first.

## How to run / deploy
- Firebase CLI: `C:\Users\kroli\AppData\Roaming\npm\firebase.cmd` (run it in a real terminal tab; installs made from
  Claude's sandboxed Bash don't reach the user's system). Signed in as krolikjeff@gmail.com.
- Rules: `firebase deploy --only firestore:rules,storage`. Function: `firebase deploy --only functions`
  (predeploy copies `js/geometry.js` and `js/model.js` into `functions/shared/`).
- Pages: `git push` to main. Local: serve the repo root on localhost (`.claude/launch.json` entry `projection-mapper`).

## Working rules
- No build step: plain ES modules; Firebase JS SDK from gstatic (version pinned in `js/cloud.js`). WebGL 1 / GLSL ES 1.00.
- Hosts list in three places: `js/cloud.js` HOSTS, `firestore.rules`, `storage.rules`.
- Built-in scenes must be listed in `BUILTIN_SCENES` (`js/engine.js`); GitHub Pages can't list a folder.
- Don't spend Jeff's API money in tests without asking; test the party flow with a hand-made scene doc (`scenes/g-test…`)
  and a `ready` queue item, or ask first.
- Signing in to Google, entering keys, and billing are Jeff's steps; drive the console in Chrome for the rest.

## Gotchas learned
- Background tabs throttle requestAnimationFrame: fades are timed with the real clock.
- GLSL `smoothstep` with reversed edges is undefined; use `1.0 - smoothstep(...)`.
- Firestore can't store arrays of arrays, so show state is stored as JSON text.
