# Projection Mapper

Projection mapping for the driveway (and any other surface), with a party mode where guests' prompts become
animations written by Claude. Static pages on GitHub Pages + Firebase (Firestore, Auth, Storage, one Cloud Function).

**Live:** https://krolikjeff-hash.github.io/projection-mapper/

| Page | Who | What |
|---|---|---|
| `./` (index.html) | guests | live view of the projection, a prompt box, their requests' place in line |
| `setup.html` | host (Google sign-in) | surfaces, masks, playlists, Party tab (queue, skip, play, retry), layouts, schedule, show picker |
| `player.html` | the projector machine | full-screen WebGL output; compile-tests guests' shaders; runs the party rotation when signed in as host |
| `qr.html` | host | printable QR sign with the guest link |

Every page takes `?show=<id>` (default `main`). **One show per projector**: each has its own surfaces, playlists,
queue and QR code. New shows are made from the setup page's show picker.

## How it fits together

- **Firestore** (project `projection-mapper-jk`):
  - `shows/{show}`: the show's state as JSON text (`stateJson`; corners are nested arrays, which Firestore can't store),
    plus `partyOpen` for the security rules.
  - `shows/{show}/live/now`: the guest animation playing now (`itemId, sceneId, title, by, startedAt, until`).
  - `shows/{show}/queue/{item}`: guest prompts and their status (`queued → generating → testing → ready → playing → played`,
    or `failed` / `removed`).
  - `scenes/g-*`: generated shaders. `compileTests/*`: shaders waiting for a GPU compile check. `layouts/*`: saved layouts.
- **Storage** `media/`: images and videos for the "Image / video file" scene.
- **Auth**: guests are anonymous; hosts sign in with Google. Hosts are listed in `js/cloud.js` (`HOSTS`),
  `firestore.rules` and `storage.rules`; keep all three in step.
- **Cloud Function** `generateAnimation` (`functions/index.js`): runs when a queue item becomes `queued`; asks
  `claude-opus-5-5` for a WebGL-1 shader fitted to the party surface (aspect ratio, which edge is far, masked areas),
  has an open player or setup page compile it, sends compile errors back to Claude (up to 2 fixes), then saves the scene
  and marks the item `ready`. Max 3 waiting requests per guest. Refusals use the API's server-side fallback.
- **Family-friendly safeguards** (2026-10-15): every request is first screened by Claude (`screenRequest`, low effort):
  gore, violence against people or animals, sexual content, hate, harassment, drugs/alcohol, profanity, real people,
  self-harm, personal info and prompt manipulation are turned down (`status: rejected`, friendly message for the guest,
  category + reason for the host); rude display names become "A guest" (`byOriginal` keeps what was typed). The
  generator's own prompt also keeps output kid-appropriate. **Hold for my OK** (Party tab, `party.approve`): finished
  animations wait as `held` until the host taps Approve.
- **Party rotation**: a host-signed-in setup page or player moves `live/now` to the next ready item every N seconds
  (transactions, so several open pages don't fight). When the line is empty it replays earlier animations or shows the
  playlist.

## Deploy

```
cd functions && npm install && cd ..
firebase deploy --only firestore:rules,storage     # security rules
firebase functions:secrets:set ANTHROPIC_API_KEY   # once; paste the key from console.anthropic.com
firebase deploy --only functions                   # the generator
git push                                           # GitHub Pages serves the repo root
```

Local testing: serve the repo root on `localhost` (an authorized auth domain), e.g. `py -3 -m http.server 8080`.

## Engine

- **Surfaces**: flat (4 corner pins, perspective homography) or curved (grid of pins, Catmull-Rom mesh). With **Space
  evenly** on, drag only the outside pins and the inner ones re-space (Coons patch).
- **Masks**: any polygon, blacked out on top (stencil fill). **Align mode**: test grid with a circle on each surface.
- **Playlists** per surface with crossfades, timed by the wall clock so every screen stays in step.
- **Schedule**: fade in at sunset ± offset (or a set time), out at the end time. **Brightness**, **Blackout**.
- Normalised output coordinates; the projector resolution (1920×1080 for the Coolid C2) sets the preview shape and the
  nudge step.

Scenes (`scenes/*.js`, format in `scenes/README.md`): magic circle, ground cracks, fog, spiders, ghosts, solid colour,
image/video file, test grid. New built-in scenes also go in `BUILTIN_SCENES` in `js/engine.js`.

## Known gaps

- Video/image media from Storage needs a CORS rule on the bucket (`gs://projection-mapper-jk.firebasestorage.app`,
  GET from `https://krolikjeff-hash.github.io`) before it can be drawn into WebGL. Not set yet.

## Raspberry Pi 5

Chromium in kiosk mode on the HDMI output, pointed at the hosted player:
`chromium-browser --kiosk --noerrdialogs --disable-infobars --autoplay-policy=no-user-gesture-required "https://krolikjeff-hash.github.io/projection-mapper/player.html?show=main"`.
Sign the player in as host once (button bottom-left for 20 s after loading), so it runs the party rotation.
