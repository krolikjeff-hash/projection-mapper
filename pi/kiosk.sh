#!/bin/bash
# Projection Mapper kiosk: full-screen Chromium on the hosted player (Claude 2026-10-15).
URL="https://krolikjeff-hash.github.io/projection-mapper/player.html?show=main"
P=~/.config/chromium/Default/Preferences
# Clear the "Chromium didn't shut down correctly" bar after a power cut.
[ -f "$P" ] && sed -i 's/"exit_type":"[^"]*"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' "$P"
# Wait for the network (Wi-Fi) before loading.
for i in $(seq 30); do ping -c1 -W1 8.8.8.8 >/dev/null 2>&1 && break; sleep 1; done
exec chromium --kiosk --noerrdialogs --disable-infobars --no-first-run --ozone-platform=wayland \
  --autoplay-policy=no-user-gesture-required --password-store=basic --disable-session-crashed-bubble \
  --check-for-update-interval=31536000 --disable-features=Translate "$URL"
