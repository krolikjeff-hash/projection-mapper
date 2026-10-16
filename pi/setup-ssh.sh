#!/bin/bash
# One-time Pi setup so Claude can finish the configuration over SSH (key login only, no password shared).
# Run on the Pi:  curl -s https://krolikjeff-hash.github.io/projection-mapper/pi/setup-ssh.sh | bash
set -e
mkdir -p ~/.ssh && chmod 700 ~/.ssh
KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA5C7IBl8Ht5hjebC/wBs2Ea9P80ZVwUxrhjpbDAyTpd claude@VENGEANCE pi_projection'
grep -qF "$KEY" ~/.ssh/authorized_keys 2>/dev/null || echo "$KEY" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
echo "Now your Pi password (for sudo):"
sudo raspi-config nonint do_ssh 0            # SSH on
sudo raspi-config nonint do_wifi_country US
sudo raspi-config nonint do_hostname spooky
echo
echo "Done. This Pi's address: $(hostname -I)"
echo "Tell Claude the address above (it becomes spooky.local after the next restart)."
