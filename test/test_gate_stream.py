"""The owner-only gateway must forward edits while the agent is still working."""
import http.client
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from ops.tailnet_https_gate import make_handler


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


class GateStreamTest(unittest.TestCase):
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
