#!/usr/bin/env python3
"""Remote control of the headless projector Pi ("spooky") over SSH. Run from VENGEANCE (or any PC with the key).

  py -3 tools/pi.py status               health: uptime, temp, throttling, Wi-Fi, display, player page, host sign-in
  py -3 tools/pi.py shot [out.png]       screenshot of what the projector shows (half size; --full for 1920x1080)
  py -3 tools/pi.py url                  player page URL and title
  py -3 tools/pi.py eval '<js>'          run JS in the player page
  py -3 tools/pi.py reload [--hard]      reload the player
  py -3 tools/pi.py goto <url>           point the kiosk at another page (e.g. ?show=garage)
  py -3 tools/pi.py close-others         close stray browser windows (popups) on the kiosk
  py -3 tools/pi.py restart-player      restart Chromium (the kiosk respawns it)
  py -3 tools/pi.py push                 copy pi/kiosk.sh, cdp.py, kanshi.config, labwc-autostart to the Pi
  py -3 tools/pi.py sh '<command>'       any shell command as jeff
  py -3 tools/pi.py reboot               reboot the Pi
  py -3 tools/pi.py shutdown             power it off (only a power cycle brings it back)

Host: PI_HOST env (default spooky.local, fallback 192.168.50.48). Key: ~/.ssh/pi_projection.
"""
import os, subprocess, sys, time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
KEY = Path.home() / '.ssh' / 'pi_projection'
HOSTS = [os.environ.get('PI_HOST', 'spooky.local'), '192.168.50.48']
WAYLAND = 'XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0'
_host = None


def host():
    global _host
    if _host is None:
        for h in HOSTS:
            if subprocess.run(['ssh', *opts(), f'jeff@{h}', 'true'], capture_output=True).returncode == 0:
                _host = h
                break
        else:
            sys.exit(f'Pi not reachable at {", ".join(HOSTS)} (powered? on Wi-Fi?)')
    return _host


def opts():
    return ['-i', str(KEY), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new']


def ssh(cmd, capture=False, stdin=None):
    r = subprocess.run(['ssh', *opts(), f'jeff@{host()}', cmd], input=stdin,
                       capture_output=capture)
    if capture:
        return r.stdout
    return r.returncode


def cdp(*args):
    quoted = ' '.join("'" + a.replace("'", "'\\''") + "'" for a in args)
    return ssh(f'~/bin/cdp.py {quoted}')


STATUS = r'''
echo "host:     $(hostname) $(hostname -I | cut -d' ' -f1), $(uptime -p)"
echo "temp:     $(vcgencmd measure_temp | cut -d= -f2), throttled=$(vcgencmd get_throttled | cut -d= -f2) (0x0 = OK)"
echo "wifi:     $(nmcli -t -f ACTIVE,SSID,SIGNAL dev wifi list --rescan no | grep '^yes' | cut -d: -f2-3 | sed 's/:/ signal /')%"
echo "disk:     $(df -h / | awk 'NR==2{print $4" free of "$2}'), mem $(free -m | awk 'NR==2{print $7" MB available"}')"
echo "display:  $(WAYLANDENV wlr-randr | awk '/^HDMI/{o=$1} /Enabled: yes/{print o}' | paste -sd' ')  HDMI-A-1 $(cat /sys/class/drm/card1-HDMI-A-1/status)"
echo "chromium: $(pgrep -c -x chromium) processes"
~/bin/cdp.py eval '(() => { const p = window.playerStatus || {}; return `${location.search}, login ${p.user || "-"} uid ${p.uid || "-"}, party rotation ${p.driver ? "RUN HERE" : "not here"}, ${document.visibilityState}`; })()' 2>&1 | sed 's/^/player:   /'
'''.replace('WAYLANDENV', WAYLAND)


def main(argv):
    if not argv or argv[0] in ('-h', '--help'):
        sys.exit(__doc__)
    cmd, rest = argv[0], argv[1:]
    if cmd == 'status':
        sys.exit(ssh(STATUS))
    if cmd == 'shot':
        full = '--full' in rest
        rest = [a for a in rest if a != '--full']
        out = Path(rest[0]) if rest else REPO.parent / f'pi-shot-{time.strftime("%Y%m%d-%H%M%S")}.png'
        png = ssh(f'{WAYLAND} grim -l 6 {"" if full else "-s 0.5"} -', capture=True)
        if not png.startswith(b'\x89PNG'):
            sys.exit('screenshot failed')
        out.write_bytes(png)
        print(out)
        return
    if cmd in ('url', 'eval', 'reload', 'goto', 'close-others'):
        sys.exit(cdp(cmd, *rest))
    if cmd == 'restart-player':
        # pkill -x matches the process name only, so it never kills this SSH session's own shell.
        sys.exit(ssh('pkill -x chromium; sleep 12; echo "chromium: $(pgrep -c -x chromium) processes"'))
    if cmd == 'push':
        files = {'kiosk.sh': '~/bin/kiosk.sh', 'cdp.py': '~/bin/cdp.py',
                 'kanshi.config': '~/.config/kanshi/config', 'labwc-autostart': '~/.config/labwc/autostart'}
        for src, dst in files.items():
            data = (REPO / 'pi' / src).read_bytes().replace(b'\r\n', b'\n')
            ssh(f'mkdir -p $(dirname {dst}) && cat > {dst} && chmod +x {dst} 2>/dev/null; echo "  {dst}"', stdin=data)
        print('pushed; run restart-player to apply kiosk changes')
        return
    if cmd == 'sh':
        sys.exit(ssh(' '.join(rest)))
    if cmd in ('reboot', 'shutdown'):
        # Allowed without a password by /etc/sudoers.d/020_jeff-power (reboot and poweroff only).
        verb = 'reboot' if cmd == 'reboot' else 'poweroff'
        sys.exit(ssh(f'sudo -n /usr/bin/systemctl {verb} && echo "{verb} sent" || echo "not allowed: see pi/README.md"'))
    sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
