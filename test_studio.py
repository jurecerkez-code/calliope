"""Regression checks for Calliope's drawing handoff and built studio."""
import json
import re
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server


class StudioTest(unittest.TestCase):
    def setUp(self):
        with server.STROKES_LOCK:
            server.STROKES.clear()
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.http.server_port}'

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()

    def post(self, path, data):
        req = Request(self.url + path, json.dumps(data).encode(), {'content-type': 'application/json'})
        try:
            with urlopen(req) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def stroke(self):
        coords = [(20, 30), (30, 20), (40, 30), (30, 40), (20, 30)]
        return {
            'id': 'circle-example', 'tool': 'pen', 't': 10, 't_end': 20,
            'pts': [{'x': x, 'y': y, 'utc': '2026-10-24T12:00:00Z',
                     'selector': 'h1', 'text': 'Draw together', 'rect': None}
                    for x, y in coords],
            'elements': ['h1'], 'coordinate_space': 'preview-document-css-pixels',
            'viewport': {'width': 949, 'height': 2862}, 'viewBox': '0 0 949 2862',
            'style': {'color': '#00e05a', 'width': 3},
            'bbox': {'x': 20, 'y': 20, 'width': 20, 'height': 20},
            'path': 'M 20 30 L 30 20 L 40 30 L 30 40 L 20 30',
            'shape': 'circle', 'enclosed_element': 'h1 "Draw together"',
        }

    def test_stroke_receipt_readback_and_apply_gate(self):
        stroke = self.stroke()
        with patch.object(server, 'ANTHROPIC_KEY', 'test-only'), patch.object(server, 'claude_apply') as agent:
            code, _ = self.post('/api/apply', {'bundles': [{'strokes': [stroke]}], 'current_html': '<html></html>'})
            self.assertEqual(code, 409)
            agent.assert_not_called()
        code, receipt = self.post('/api/strokes', stroke)
        self.assertEqual(code, 201)
        self.assertEqual(receipt['id'], stroke['id'])
        code, readback = self.post('/api/strokes/readback', {'id': stroke['id']})
        self.assertEqual(code, 200)
        self.assertEqual(readback['stroke'], stroke)

    def test_shape_time_and_target_lead_agent_prompt(self):
        with patch.object(server.urllib.request, 'urlopen') as request:
            request.return_value.read.return_value = json.dumps({'content': [{'text': json.dumps({'reasoning': 'ok', 'html': '<html></html>'})}]}).encode()
            server.claude_apply([{'transcript': 'change this', 'strokes': [self.stroke()]}], '<html></html>')
            prompt = json.loads(request.call_args.args[0].data)['messages'][0]['content'][0]['text']
        self.assertIn('Circle drawn at 2026-10-24T12:00:00Z', prompt)
        self.assertIn('around h1 "Draw together"', prompt)
        self.assertNotIn('SKETCH on:', prompt)

    def test_openrouter_apply_uses_existing_studio_contract_without_anthropic_key(self):
        stroke = self.stroke()
        code, _ = self.post('/api/strokes', stroke)
        self.assertEqual(code, 201)
        with patch.object(server, 'AGENT_PROVIDER', 'openrouter', create=True), \
             patch.object(server, 'OPENROUTER_KEY', 'test-only', create=True), \
             patch.object(server, 'ANTHROPIC_KEY', ''), \
             patch.object(server.urllib.request, 'urlopen') as request:
            request.return_value.read.return_value = json.dumps({
                'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps({
                    'reasoning': 'enlarge headline', 'html': '<html><h1>Big</h1></html>'
                })}}]
            }).encode()
            code, out = self.post('/api/apply', {
                'bundles': [{'transcript': 'make this bigger', 'strokes': [stroke]}],
                'current_html': '<html><h1>Small</h1></html>'
            })
            self.assertEqual(code, 200, out)
            request.assert_called_once()
            req = request.call_args.args[0]
        self.assertEqual(out, {'reasoning': 'enlarge headline', 'html': '<html><h1>Big</h1></html>'})
        self.assertEqual(req.full_url, 'https://openrouter.ai/api/v1/chat/completions')
        self.assertEqual(req.get_header('Authorization'), 'Bearer test-only')
        body = json.loads(req.data)
        self.assertIn('make this bigger', body['messages'][1]['content'])
        self.assertIn('around h1 "Draw together"', body['messages'][1]['content'])

    def test_openrouter_missing_key_refuses_apply_before_network(self):
        with patch.object(server, 'AGENT_PROVIDER', 'openrouter', create=True), \
             patch.object(server, 'OPENROUTER_KEY', '', create=True), \
             patch.object(server, 'ANTHROPIC_KEY', 'test-only'), \
             patch.object(server.urllib.request, 'urlopen') as request:
            code, out = self.post('/api/apply', {'bundles': [], 'current_html': '<html></html>'})
        self.assertEqual(code, 503)
        self.assertIn('API key', out['error'])
        request.assert_not_called()

    def test_openrouter_rejects_incomplete_html_instead_of_replacing_preview(self):
        with patch.object(server, 'AGENT_PROVIDER', 'openrouter', create=True), \
             patch.object(server, 'OPENROUTER_KEY', 'test-only', create=True), \
             patch.object(server.urllib.request, 'urlopen') as request:
            request.return_value.read.return_value = json.dumps({
                'choices': [{'finish_reason': 'stop', 'message': {'content': '{"reasoning":"ok","html":"<h1>fragment</h1>"}'}}]
            }).encode()
            code, out = self.post('/api/apply', {'bundles': [], 'current_html': '<html>Original</html>'})
        self.assertEqual(code, 500)
        self.assertIn('complete HTML', out['error'])

    def test_openrouter_rejects_truncated_document_even_when_it_starts_with_html(self):
        with patch.object(server, 'OPENROUTER_KEY', 'test-only', create=True), \
             patch.object(server.urllib.request, 'urlopen') as request:
            request.return_value.read.return_value = json.dumps({
                'choices': [{'finish_reason': 'length', 'message': {'content': json.dumps({
                    'reasoning': 'ok', 'html': '<!DOCTYPE html><html><body><main>Partial'
                })}}]
            }).encode()
            with self.assertRaisesRegex(ValueError, 'incomplete'):
                server.openrouter_apply([], '<html>Original</html>')

    def test_openrouter_rejects_closing_tag_hidden_in_unterminated_comment(self):
        with patch.object(server, 'AGENT_PROVIDER', 'openrouter', create=True), \
             patch.object(server, 'OPENROUTER_KEY', 'test-only', create=True), \
             patch.object(server.urllib.request, 'urlopen') as request:
            request.return_value.read.return_value = json.dumps({
                'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps({
                    'reasoning': 'ok', 'html': '<html><body><main>Partial<!-- </html>'
                })}}]
            }).encode()
            code, out = self.post('/api/apply', {'bundles': [], 'current_html': '<html>Original</html>'})
        self.assertEqual(code, 500)
        self.assertIn('complete HTML', out['error'])

    def test_config_reports_selected_agent_provider(self):
        with patch.object(server, 'AGENT_PROVIDER', 'openrouter', create=True):
            with urlopen(self.url + '/api/config') as response:
                self.assertEqual(json.load(response)['agentProvider'], 'openrouter')

    def test_built_studio_and_original_loader_available(self):
        with urlopen(self.url + '/') as response:
            html = response.read().decode()
            self.assertIn("script-src 'self'", response.headers['content-security-policy'])
        self.assertRegex(html, r'/assets/[^" ]+\.js')
        with urlopen(self.url + '/classic.html') as response:
            self.assertIn('vd-loader', response.read().decode())
        for path in ('/src/App.svelte', '/assets/../server.py', '/assets/%2e%2e/server.py'):
            with self.subTest(path=path), self.assertRaises(HTTPError):
                urlopen(self.url + path)


if __name__ == '__main__':
    unittest.main()
