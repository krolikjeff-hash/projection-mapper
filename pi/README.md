# Raspberry Pi 5 player ("spooky")

Raspberry Pi OS 64-bit (Trixie) desktop, user `jeff`, hostname `spooky` (`spooky.local`), Wi-Fi country US.
Claude logs in with its key (`~/.ssh/pi_projection` on VENGEANCE); sudo needs Jeff's password, so admin steps run on the Pi.

## Files (copy to the Pi)
| Repo file | On the Pi | What |
|---|---|---|
| `kiosk.sh` | `~/bin/kiosk.sh` | full-screen Chromium on `player.html?show=main`, waits for Wi-Fi, clears the crash bar |
| `labwc-autostart` | `~/.config/labwc/autostart` | kiosk session (no desktop/taskbar; delete the file to get them back) |
| `kanshi.config` | `~/.config/kanshi/config` | projector only on HDMI-A-1 at 1920x1080@60, HDMI-A-2 off |
| `setup-ssh.sh` | run once | installs Claude's key, SSH on, Wi-Fi country, hostname |

## Boot partition (`/boot/firmware`, edit from a PC)
- `cmdline.txt` ends with `video=HDMI-A-1:1920x1080@60D video=HDMI-A-2:1920x1080@60D` (forces output if the
  projector is late to wake). Forcing HDMI-A-2 put the desktop on a phantom screen (black projector); kanshi turns it off.
- `user-data` has a cloud-init `bootcmd` that re-installs Claude's key each boot; an empty `ssh` file turns SSH on.
- Projector = HDMI port 1 (next to USB-C power). Its EDID reads "WSX C2", preferred 1920x1080@60.
- Screen blanking: off (no swayidle running). Cursor: hidden by `player.html`.

## Gotchas (2026-10-15)
- No video after the first-run wizard + update: the micro-HDMI hot-plug dropped in and out; reseating the plug fixed it.
- Restart: `sudo reboot` on the Pi (remote `systemctl reboot` needs the password).
