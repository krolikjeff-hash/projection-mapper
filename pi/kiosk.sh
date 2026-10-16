#!/bin/bash
# Projection Mapper kiosk: full-screen Chromium on the hosted player (Claude 2026-10-15).
# Remote control: DevTools on 127.0.0.1:9222 only (reached through SSH; see cdp.py / tools/pi.py).
URL="https://krolikjeff-hash.github.io/projection-mapper/player.html?show=main"
PROFILE=~/.config/chromium-kiosk   # Chromium 136+ refuses remote debugging on the default profile
P=$PROFILE/Default/Preferences
# Clear the "Chromium didn't shut down correctly" bar after a power cut.
[ -f "$P" ] && sed -i 's/"exit_type":"[^"]*"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' "$P"
# Wait for the network (Wi-Fi) before loading.
for i in $(seq 30); do ping -c1 -W1 8.8.8.8 >/dev/null 2>&1 && break; sleep 1; done
exec chromium --kiosk --noerrdialogs --disable-infobars --no-first-run --ozone-platform=wayland \
  --user-data-dir="$PROFILE" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --autoplay-policy=no-user-gesture-required --password-store=basic --disable-session-crashed-bubble \
  --check-for-update-interval=31536000 --disable-features=Translate "$URL"
