# Raspberry Pi 5 player ("spooky")

Raspberry Pi OS 64-bit (Trixie) desktop, user `jeff`, hostname `spooky` (`spooky.local`), Wi-Fi country US.
Claude logs in with its key (`~/.ssh/pi_projection` on VENGEANCE); sudo needs Jeff's password, so admin steps run on the Pi.

## Files (copy to the Pi)
| Repo file | On the Pi | What |
|---|---|---|
| `kiosk.sh` | `~/bin/kiosk.sh` | full-screen Chromium on `player.html?show=main` (profile `~/.config/chromium-kiosk`, DevTools on 127.0.0.1:9222 only), waits for Wi-Fi, clears the crash bar |
| `cdp.py` | `~/bin/cdp.py` | drives that Chromium (url / eval / reload / goto), stdlib Python |
| `labwc-autostart` | `~/.config/labwc/autostart` | kiosk session (no desktop/taskbar; delete the file to get them back) |
| `kanshi.config` | `~/.config/kanshi/config` | projector only on HDMI-A-1 at 1920x1080@60, HDMI-A-2 off |
| `setup-ssh.sh` | run once | installs Claude's key, SSH on, Wi-Fi country, hostname |

## No Google account on the Pi
The player runs the party rotation with its **own anonymous Firebase login** (uid `AIcstcOR6fZWu9qzewTaZvk7e773`,
kept in the kiosk profile). That uid is listed in `PLAYER_UIDS` (`js/cloud.js`) and `isPlayer()` (`firestore.rules`),
which allows only the rotation writes: set `live/now`, mark queue items playing/played. A stolen Pi can't change shows,
layouts or scenes. If the kiosk profile is ever wiped, the Pi gets a new uid: read it with `tools/pi.py status`, put it
in both lists, `firebase deploy --only firestore:rules`, push.

## Remote control (headless, up the pole)
`py -3 tools/pi.py <command>` from a PC with the key: `status` (temp, throttling, Wi-Fi signal, display, page,
host sign-in), `shot` (screenshot of the projector output), `url`, `eval '<js>'`, `reload [--hard]`, `goto <url>`,
`restart-player`, `push` (repo `pi/` files to the Pi), `sh '<cmd>'`, `reboot` (only with passwordless sudo).
Everything runs over SSH; nothing new listens on the network.

## Boot partition (`/boot/firmware`, edit from a PC)
- `cmdline.txt` ends with `video=HDMI-A-1:1920x1080@60D video=HDMI-A-2:1920x1080@60D` (forces output if the
  projector is late to wake). Forcing HDMI-A-2 put the desktop on a phantom screen (black projector); kanshi turns it off.
- `user-data` has a cloud-init `bootcmd` that re-installs Claude's key each boot; an empty `ssh` file turns SSH on.
- Projector = HDMI port 1 (next to USB-C power). Its EDID reads "WSX C2", preferred 1920x1080@60.
- Screen blanking: off (no swayidle running). Cursor: hidden by `player.html`.

## Gotchas (2026-10-15)
- No video after the first-run wizard + update: the micro-HDMI hot-plug dropped in and out; reseating the plug fixed it.
- Restart: `sudo reboot` on the Pi (remote `systemctl reboot` needs the password).
