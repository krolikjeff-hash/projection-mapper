#!/usr/bin/env python3
"""Drive the kiosk Chromium through DevTools on 127.0.0.1:9222 (stdlib only; runs on the Pi, called over SSH).

  cdp.py url                     current page URL and title
  cdp.py eval '<js>'             evaluate JS in the page, print the JSON result
  cdp.py reload [--hard]         reload (hard = bypass cache)
  cdp.py goto <url>              navigate the kiosk tab
"""
import base64, json, os, socket, struct, sys, urllib.request

PORT = 9222


def page_ws():
    tabs = json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list', timeout=5))
    pages = [t for t in tabs if t.get('type') == 'page']
    if not pages:
        sys.exit('no page tab')
    return pages[0]


class WS:
    """Minimal WebSocket client (text frames) for the DevTools endpoint."""
    def __init__(self, url):
        hostport, path = url[len('ws://'):].split('/', 1)
        host, port = hostport.split(':')
        self.s = socket.create_connection((host, int(port)), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f'GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                        f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        resp = b''
        while b'\r\n\r\n' not in resp:
            resp += self.s.recv(4096)
        if b' 101 ' not in resp.split(b'\r\n')[0]:
            sys.exit('websocket handshake failed: ' + resp.split(b'\r\n')[0].decode())
        self.buf = resp.split(b'\r\n\r\n', 1)[1]
        self.n = 0

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise EOFError
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, text):
        data = text.encode()
        head = bytes([0x81])
        n = len(data)
        head += bytes([0x80 | n]) if n < 126 else (bytes([0x80 | 126]) + struct.pack('>H', n) if n < 65536
                                                   else bytes([0x80 | 127]) + struct.pack('>Q', n))
        mask = os.urandom(4)
        self.s.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self):
        msg = b''
        while True:
            b0, b1 = self._read(2)
            n = b1 & 0x7f
            if n == 126:
                n = struct.unpack('>H', self._read(2))[0]
            elif n == 127:
                n = struct.unpack('>Q', self._read(8))[0]
            msg += self._read(n)
            if b0 & 0x80:
                return msg.decode()

    def call(self, method, **params):
        self.n += 1
        self.send(json.dumps({'id': self.n, 'method': method, 'params': params}))
        while True:
            r = json.loads(self.recv())
            if r.get('id') == self.n:
                if 'error' in r:
                    sys.exit(f"{method}: {r['error']}")
                return r.get('result', {})


def main(argv):
    if not argv:
        sys.exit(__doc__)
    tab = page_ws()
    cmd = argv[0]
    if cmd == 'url':
        print(tab['url']); print(tab['title']); return
    ws = WS(tab['webSocketDebuggerUrl'])
    if cmd == 'eval':
        r = ws.call('Runtime.evaluate', expression=argv[1], returnByValue=True, awaitPromise=True)
        if 'exceptionDetails' in r:
            sys.exit('JS error: ' + json.dumps(r['exceptionDetails'].get('exception', {}).get('description')))
        print(json.dumps(r['result'].get('value'), indent=1))
    elif cmd == 'reload':
        ws.call('Page.reload', ignoreCache='--hard' in argv)
        print('reloaded')
    elif cmd == 'goto':
        ws.call('Page.navigate', url=argv[1])
        print('navigating to', argv[1])
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
