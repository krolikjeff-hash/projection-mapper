# Projection Mapper

A low-cost, Wi-Fi-controlled projection mapper. A small Node server (no packages) serves:

- **`/player`**: the full-screen WebGL output that goes to the projector over HDMI (Raspberry Pi 5 in Chromium kiosk
  mode, or any browser).
- **`/`**: the control page, for a phone, iPad or PC on the home Wi-Fi. It has a live preview with drag handles,
  surfaces, masks, playlists, layouts and the schedule.

Every change on the control page reaches every open player at once (Server-Sent Events).

## Run

```
node server.js            # PORT=8080 by default; PM_DATA=<folder> moves the data folder
```

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

## HTTP API (home network only, no login)

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/state` | the whole show state |
| PUT | `/api/state` | `{ state, origin }`, replaces the state and broadcasts it |
| GET | `/api/events` | SSE stream: `event: state` with `{ state, origin }` |
| GET | `/api/scenes` | scene ids |
| PUT | `/api/scenes/<id>` | scene module source (JavaScript) |
| GET / PUT / DELETE | `/api/media[/<file>]` | list, upload (raw body), delete media files (`data/media/`, served at `/media/`) |
| GET / PUT / DELETE | `/api/layouts[/<name>]` | list, save `{ surfaces, masks, output }`, delete |

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
