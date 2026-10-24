"""Owner-only loopback proxy for Calliope behind Tailscale Serve HTTPS.

Serve strips spoofed Tailscale-User-Login headers and supplies the real user's
identity. Never expose this listener outside loopback or through Funnel.
"""
import http.client
import json
import os
import re
import select
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

GET_PATHS = {'/', '/index.html', '/jamie-mock.html', '/api/config'}
POST_PATHS = {'/api/import', '/api/strokes', '/api/strokes/readback',
              '/api/marks', '/api/marks/readback', '/api/apply', '/api/trace'}
BUNDLE = re.compile(r'/assets/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,}\.(?:js|css)\Z')
IMAGE = re.compile(r'/assets/[A-Za-z0-9_.-]+\.(?:svg|png)\Z')
WS_KEY = re.compile(r'[A-Za-z0-9+/]{22}==\Z')


def make_handler(owner, http_port, audio_port, origin='', serve_audio_port=None, role='page'):
    class Gate(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, format, *args):
            pass

        def reply(self, status):
            body = b'{"error":"not found"}'
            # A rejected POST may still have an unread body on this connection.
            self.close_connection = True
            self.send_response(status)
            self.send_header('content-type', 'application/json')
            self.send_header('cache-control', 'no-store')
            self.send_header('connection', 'close')
            self.send_header('content-length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def forward(self):
            if self.client_address[0] != '127.0.0.1' or self.headers.get('Tailscale-User-Login') != owner:
                return self.reply(403)
            is_audio = (self.command == 'GET' and self.path == '/' and
                        self.headers.get('Upgrade', '').lower() == 'websocket')
            if role == 'audio':
                return self.audio() if is_audio else self.reply(404)
            if self.headers.get('Upgrade'):
                return self.reply(404)
            allowed = (self.path in GET_PATHS or bool(BUNDLE.fullmatch(self.path) or IMAGE.fullmatch(self.path))) if self.command == 'GET' else self.path in POST_PATHS
            if not allowed:
                return self.reply(404)
            sent = False
            try:
                length = int(self.headers.get('content-length', '0')) if self.command == 'POST' else 0
                if length < 0 or length > 512_000:
                    return self.reply(413)
                body = self.rfile.read(length) if length else None
                headers = {'Host': urlsplit(origin).netloc} if origin else {}
                if body:
                    headers['content-type'] = self.headers.get('content-type', '')
                if self.headers.get('Origin'):
                    headers['Origin'] = self.headers['Origin']
                conn = http.client.HTTPConnection('127.0.0.1', http_port, timeout=120)
                try:
                    conn.request(self.command, self.path, body, headers=headers)
                    response = conn.getresponse()
                    stream = (self.command == 'POST' and self.path == '/api/apply' and
                              response.getheader('content-type', '').startswith('application/x-ndjson'))
                    data = b'' if stream else response.read()
                    if not stream and self.path == '/api/config' and response.status == 200:
                        config = json.loads(data)
                        config['audioPort'] = serve_audio_port or audio_port
                        data = json.dumps(config).encode()
                    self.send_response(response.status)
                    for key in ('content-type', 'content-security-policy', 'cache-control'):
                        value = response.getheader(key)
                        if value:
                            self.send_header(key, value)
                    self.send_header('x-content-type-options', 'nosniff')
                    if stream:
                        self.close_connection = True
                        self.send_header('connection', 'close')
                    else:
                        self.send_header('content-length', str(len(data)))
                    self.end_headers()
                    sent = True
                    if stream:
                        # A line is one complete edit; do not wait for the provider's final turn.
                        while line := response.readline(2_100_000):
                            self.wfile.write(line)
                            self.wfile.flush()
                    else:
                        self.wfile.write(data)
                finally:
                    conn.close()
            except (OSError, ValueError, http.client.HTTPException):
                if not sent:
                    self.reply(502)

        def audio(self):
            key = self.headers.get('Sec-WebSocket-Key')
            if not key or not WS_KEY.fullmatch(key) or self.headers.get('Sec-WebSocket-Version') != '13':
                return self.reply(400)
            try:
                with socket.create_connection(('127.0.0.1', audio_port), timeout=10) as upstream:
                    upstream.sendall((
                        'GET / HTTP/1.1\r\n'
                        f'Host: 127.0.0.1:{audio_port}\r\n'
                        'Connection: Upgrade\r\nUpgrade: websocket\r\n'
                        f'Sec-WebSocket-Key: {key}\r\n'
                        'Sec-WebSocket-Version: 13\r\n\r\n'
                    ).encode('ascii'))
                    # Tunnel the upstream handshake and frames without buffering audio.
                    self.close_connection = True
                    self.connection.settimeout(None)
                    upstream.settimeout(None)
                    while True:
                        ready, _, _ = select.select([self.connection, upstream], [], [], 120)
                        if not ready:
                            break
                        for source in ready:
                            data = source.recv(65536)
                            if not data:
                                return
                            (upstream if source is self.connection else self.connection).sendall(data)
            except (OSError, ValueError):
                if not self.close_connection:
                    self.reply(502)

        do_GET = forward
        do_POST = forward

    return Gate


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', int(os.environ['GATE_PORT'])),
                        make_handler(os.environ['TAILNET_LOGIN'], int(os.environ['HTTP_PORT']),
                                     int(os.environ['AUDIO_PORT']),
                                     os.environ.get('STUDIO_ORIGIN', ''),
                                     int(os.environ.get('SERVE_AUDIO_PORT', os.environ['AUDIO_PORT'])),
                                     os.environ.get('GATE_ROLE', 'page'))).serve_forever()
