"""The owner-only gateway must forward edits while the agent is still working."""
import http.client
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from ops.tailnet_https_gate import GET_PATHS, make_handler


class SlowUpstream(BaseHTTPRequestHandler):
    first_sent = threading.Event()
    release = threading.Event()

    def log_message(self, format, *args):
        pass

    def do_POST(self):
        length = int(self.headers['content-length'])
        self.rfile.read(length)
        self.send_response(200)
        self.send_header('content-type', 'application/x-ndjson; charset=utf-8')
        self.end_headers()
        self.wfile.write(b'{"type":"edit","html":"<html>partial</html>"}\n')
        self.wfile.flush()
        self.first_sent.set()
        if self.release.wait(3):
            self.wfile.write(b'{"type":"done","html":"<html>partial</html>"}\n')
            self.wfile.flush()


class OriginUpstream(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        body = json.dumps({'audioPort': 8081, 'publishEnabled': False}).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.rfile.read(int(self.headers['content-length']))
        allowed = (self.headers['Host'] == 'studio.example.test:443' and
                   self.headers.get('Origin') == 'https://studio.example.test:443')
        body = json.dumps({'accepted': allowed}).encode()
        self.send_response(200 if allowed else 403)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class GateStreamTest(unittest.TestCase):
    def test_removed_3d_paths_are_not_allowlisted(self):
        self.assertNotIn('/loader3d.js', GET_PATHS)
        self.assertNotIn('/assets/logos.glb', GET_PATHS)

    def test_https_config_and_origin_survive_page_gate(self):
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), OriginUpstream)
        gate = ThreadingHTTPServer(('127.0.0.1', 0),
                                   make_handler('owner@example.test', upstream.server_port, 8081,
                                                'https://studio.example.test:443', 8443, 'page'))
        workers = [threading.Thread(target=instance.serve_forever, daemon=True)
                   for instance in (upstream, gate)]
        for worker in workers:
            worker.start()
        client = http.client.HTTPConnection('127.0.0.1', gate.server_port, timeout=2)
        headers = {'Tailscale-User-Login': 'owner@example.test',
                   'Origin': 'https://studio.example.test:443',
                   'content-type': 'application/json'}
        try:
            client.request('GET', '/api/config', headers=headers)
            response = client.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read())['audioPort'], 8443)
            client.request('POST', '/api/trace', b'{}', headers)
            response = client.getresponse()
            self.assertEqual(response.status, 200)
            self.assertTrue(json.loads(response.read())['accepted'])
        finally:
            client.close()
            for instance in (gate, upstream):
                instance.shutdown()
                instance.server_close()
            for worker in workers:
                worker.join()

    def test_audio_gate_rejects_page_requests(self):
        gate = ThreadingHTTPServer(('127.0.0.1', 0),
                                   make_handler('owner@example.test', 1, 8081,
                                                'https://studio.example.test:443', 8443, 'audio'))
        worker = threading.Thread(target=gate.serve_forever, daemon=True)
        worker.start()
        client = http.client.HTTPConnection('127.0.0.1', gate.server_port, timeout=2)
        try:
            client.request('GET', '/', headers={'Tailscale-User-Login': 'owner@example.test'})
            self.assertEqual(client.getresponse().status, 404)
        finally:
            client.close()
            gate.shutdown()
            gate.server_close()
            worker.join()

    def test_first_edit_arrives_before_upstream_finishes(self):
        SlowUpstream.first_sent.clear()
        SlowUpstream.release.clear()
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), SlowUpstream)
        gate = ThreadingHTTPServer(('127.0.0.1', 0),
                                   make_handler('owner@example.test', upstream.server_port, 1))
        workers = [threading.Thread(target=instance.serve_forever, daemon=True)
                   for instance in (upstream, gate)]
        for worker in workers:
            worker.start()
        client = http.client.HTTPConnection('127.0.0.1', gate.server_port, timeout=2)
        try:
            body = json.dumps({'stream': True}).encode()
            client.request('POST', '/api/apply', body,
                           {'content-type': 'application/json', 'Tailscale-User-Login': 'owner@example.test'})
            response = client.getresponse()
            self.assertTrue(SlowUpstream.first_sent.wait(1))
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.readline())['type'], 'edit')
            self.assertFalse(SlowUpstream.release.is_set())
            SlowUpstream.release.set()
            self.assertEqual(json.loads(response.readline())['type'], 'done')
        finally:
            SlowUpstream.release.set()
            client.close()
            for instance in (gate, upstream):
                instance.shutdown()
                instance.server_close()
            for worker in workers:
                worker.join()
