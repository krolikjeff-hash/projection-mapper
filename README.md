# Projection Mapper

A low-cost, Wi-Fi-controlled projection mapper with a party mode where guests' prompts become animations. A small
Node server (one package: `@anthropic-ai/sdk`) serves:

- **`/`**: the **guest page**, for party guests' phones (share it with `/qr`). It shows a live view of the projection
  and a prompt box. Each prompt joins a queue; Claude (`claude-opus-5-5`) writes a GLSL animation for it, fitted to
  the party surface's shape and masks; it's compile-tested on the player's GPU (and fixed if needed), then plays.
- **`/setup`**: the host's **setup page** (PIN-locked), for a phone, iPad or PC on the home Wi-Fi. It has a live
  preview with drag handles, surfaces, masks, playlists, the Party tab (queue, skip, play, retry, API key, PIN),
  layouts and the schedule.
- **`/player`**: the full-screen WebGL output that goes to the projector over HDMI (Raspberry Pi 5 in Chromium kiosk
  mode, or any browser).
- **`/qr`**: a printable QR-code sign with the guest link.

Every change on the control page reaches every open player at once (Server-Sent Events).

## Run

```
npm install               # once: the Anthropic SDK
node server.js            # PORT=8080 by default; PM_DATA=<folder> moves the data folder
```

First run: open `/setup` and choose a PIN (banner at the top), then paste a Claude API key from
console.anthropic.com in the Party tab (stored in `data/config.json`, never sent to browsers; a saved key wins over
`ANTHROPIC_API_KEY`). `PM_PIN=<digits>` in the environment overrides the saved PIN.

It also serves **https on port 8443** with a self-signed certificate it makes once with openssl (`data/cert.pem`), for
phones that refuse plain http: accept the browser warning once. Delete `data/*.pem` to remake it after the PC's IP changes.

Then open `http://<host>:8080/` (or `https://<host>:8443/`) to control it and `http://<host>:8080/player` on the projector machine. Double-click
the player to go full screen on a PC.

## Concepts

- **Surface**: a region of the projector image that shows one scene, warped to fit the real object.
  - *Flat* surfaces have four corner pins (a perspective homography), for the driveway, garage door or a wall.
  - *Curved* surfaces have a grid of pins with a smooth (Catmull-Rom) mesh, for irregular or curved shapes.
  - Each surface has a **playlist** of scenes with durations and a crossfade. Timing follows the wall clock, so all
    players stay in step.
- **Mask**: a polygon (any shape, concave is fine) blacked out on top of everything, e.g. windows, bushes, the front
  door.
- **Align mode**: every surface shows a coloured test grid with a circle. Drag the corners until the circle looks round on
  the ground.
- **Layouts**: saved sets of surfaces and masks (one per spot).
- **Schedule**: the projector fades in at sunset ± offset (or a set time) and out at the end time. The preview ignores it.
- **Output**: normalised coordinates (0–1); the projector resolution (1920×1080 for the Coolid C2) only sets the preview
  shape and the arrow-key nudge step.

## Scenes

`public/scenes/*.js` are ES modules; see `public/scenes/README.md` for the format. Built in: magic circle, ground
cracks (lava), swirling fog, crawling spiders, drifting ghosts, solid colour, image/video file, test grid. Scenes
uploaded through `PUT /api/scenes/<id>` go to `data/scenes/` and override built-ins with the same id.

## Party mode

- Party tab: **Take requests** on, pick the surface it plays on, seconds per animation, and what to do when the line is
  empty (replay guests' animations, or the normal playlist).
- Up to 3 waiting requests per guest; 2 generate at once (`party-server.js` constants). Generated scenes are saved as
  `data/scenes/g-<id>.js` and the queue as `data/queue.json`; both survive restarts.
- Claude gets the surface's real aspect ratio, which edge is "far", and the masked areas in the shader's own
  coordinates. The system prompt sets the rules: WebGL 1 GLSL, Pi-5-friendly cost, black background, bold shapes,
  kid-appropriate (it turns unsuitable requests into a harmless Halloween alternative).
- A shader that fails to compile goes back to Claude with the GPU's error message (up to 2 fixes). If no player or setup
  page is open to test it, it's queued untested.
- Refused requests use the API's server-side fallback first; a refusal shows as "Fizzled" for the guest.

## Curved surfaces

A curved surface has a grid of pins. With **Space evenly** on (the default), you drag only the outside pins and the
inside ones re-space evenly between them (a Coons patch); turn it off to place every pin by hand. Changing the pin count
keeps the curved outline.

## HTTP API (home network only)

Changes need the setup cookie (`POST /api/auth { pin }`), except guest prompts and compile results.

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/state` | the whole show state |
| PUT | `/api/state` | `{ state, origin }`, replaces the state and broadcasts it |
| GET | `/api/events` | SSE stream: `event: state` with `{ state, origin }` |
| GET | `/api/scenes` | scene ids |
| PUT | `/api/scenes/<id>` | scene module source (JavaScript) |
| GET / PUT / DELETE | `/api/media[/<file>]` | list, upload (raw body), delete media files (`data/media/`, served at `/media/`) |
| GET / PUT / DELETE | `/api/layouts[/<name>]` | list, save `{ surfaces, masks, output }`, delete |
| GET / POST | `/api/auth` | `{ host, pinSet, lan, port }` / log in `{ pin }` or first-run `{ newPin }` |
| GET / POST | `/api/queue` | public queue view (`?admin=1` with the cookie: prompts, errors) / guest prompt `{ prompt, by }` |
| POST | `/api/queue/<id>/<play\|retry\|remove\|skip>` | host queue actions |
| POST | `/api/compile` | compile-test result from a player `{ nonce, ok, log }` |
| GET / POST | `/api/config` | API-key status / save `{ apiKey }` or `{ newPin }` |

## Files

- `server.js`: HTTP server, state persistence (`data/state.json`), SSE.
- `public/js/engine.js`: WebGL renderer (scene textures, warp, stencil masks, crossfades, schedule fade).
- `public/js/geometry.js`: homography, mesh interpolation, polygon helpers.
- `public/js/model.js`: state defaults and normalisation, shared with the server.
- `public/js/sun.js`: sunset time and the show window.
- `public/js/control.js`, `public/control.html`, `public/css/control.css`: the control page.
- `public/player.html`: the player.
- `data/`: runtime data (state, layouts, media, uploaded scenes); not in git.

## Raspberry Pi 5 (to do when it arrives)

1. Raspberry Pi OS (64-bit, desktop) with Raspberry Pi Imager: set the hostname (`spooky`), Wi-Fi, SSH and user.
2. `sudo apt install -y nodejs git`, clone this repo, and run `server.js` as a systemd service.
3. Autostart Chromium in kiosk mode on the HDMI output:
   `chromium-browser --kiosk --noerrdialogs --disable-infobars --autoplay-policy=no-user-gesture-required http://localhost:8080/player`.
4. Check the projector's modes with `kmsprint`; set 1920×1080 at 60 Hz.
