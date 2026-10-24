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
            server.MARKS.clear()
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.http.server_port}'

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join()

    def post(self, path, data, headers=None):
        req = Request(self.url + path, json.dumps(data).encode(),
                      {'content-type': 'application/json', **(headers or {})})
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

    def test_cross_origin_post_cannot_invoke_agent_or_stage_content(self):
        request = {'bundles': [], 'current_html': '<html></html>'}
        with patch.object(server, 'ANTHROPIC_KEY', 'test-only'), patch.object(server, 'claude_apply', return_value={'html': '<html></html>'}) as agent:
            code, _ = self.post('/api/apply', request, {'Origin': 'https://elsewhere.example'})
            self.assertEqual(code, 403)
            agent.assert_not_called()
            code, _ = self.post('/api/apply', request, {'Origin': 'null'})
            self.assertEqual(code, 403)
            agent.assert_not_called()
            code, _ = self.post('/api/apply', request, {'Host': 'evil.example', 'Origin': 'http://evil.example'})
            self.assertEqual(code, 403)
            agent.assert_not_called()
            code, _ = self.post('/api/apply', request, {'Content-Type': 'text/plain'})
            self.assertEqual(code, 415)
            agent.assert_not_called()
            code, _ = self.post('/api/apply', request, {'Origin': self.url})
            self.assertEqual(code, 200)
            agent.assert_called_once()
        with patch.object(server.Path, 'write_text') as write:
            code, _ = self.post('/api/publish', {'html': '<html></html>'}, {'Origin': 'https://elsewhere.example'})
            self.assertEqual(code, 403)
            write.assert_not_called()
        stroke = self.stroke()
        stroke['id'] = 'cross-origin-mark'
        code, _ = self.post('/api/strokes', stroke, {'Origin': 'https://elsewhere.example'})
        self.assertEqual(code, 403)
        with server.STROKES_LOCK:
            self.assertNotIn(stroke['id'], server.STROKES)

    def test_configured_proxy_origin_rejects_other_hosts_and_origins(self):
        with patch.object(server, 'STUDIO_ORIGIN', 'https://studio.example'):
            with patch.object(server, 'ANTHROPIC_KEY', 'test-only'), patch.object(server, 'claude_apply', return_value={'html': '<html></html>'}) as agent:
                request = {'bundles': [], 'current_html': '<html></html>'}
                code, _ = self.post('/api/apply', request, {'Host': 'studio.example', 'Origin': 'https://studio.example'})
                self.assertEqual(code, 200)
                agent.assert_called_once()
                code, _ = self.post('/api/apply', request, {'Host': 'studio.example', 'Origin': 'https://elsewhere.example'})
                self.assertEqual(code, 403)
                code, _ = self.post('/api/apply', request, {'Host': 'elsewhere.example', 'Origin': 'https://elsewhere.example'})
                self.assertEqual(code, 403)
                agent.assert_called_once()

    def test_shape_time_and_target_lead_agent_prompt(self):
        stroke = self.stroke()
        mark = {'id': stroke['id'], 'shape': stroke['shape'], 't': stroke['t'],
                't_end': stroke['t_end'], 'enclosed_element': stroke['enclosed_element'],
                'strokes': [stroke]}
        code, receipt = self.post('/api/marks', mark)
        self.assertEqual(code, 201)
        message = receipt['agent_message']
        self.assertIn('Circle drawn at 2026-10-24T12:00:00Z', message)
        self.assertIn('coordinates x 20–40, y 20–40', message)
        self.assertIn('around h1 "Draw together"', message)
        self.assertIn('touched h1', message)
        self.assertIn('preview-document-css-pixels', message)
        self.assertIn('949×2862', message)
        with patch.object(server.urllib.request, 'urlopen') as request:
            request.return_value.read.return_value = json.dumps({'content': [{'text': json.dumps({'reasoning': 'ok', 'html': '<html></html>'})}]}).encode()
            server.claude_apply([{'transcript': 'change this', 'strokes': [mark]}], '<html></html>')
            prompt = json.loads(request.call_args.args[0].data)['messages'][0]['content'][0]['text']
        self.assertIn(message, prompt)
        self.assertNotIn('SKETCH on:', prompt)

    def test_reference_points_to_identifiable_sketch(self):
        stroke = self.stroke()
        stroke['id'] = 'during'
        mark = {'id': stroke['id'], 'shape': stroke['shape'], 't': stroke['t'],
                't_end': stroke['t_end'], 'enclosed_element': stroke['enclosed_element'],
                'strokes': [stroke]}
        with patch.object(server.urllib.request, 'urlopen') as request:
            request.return_value.read.return_value = json.dumps({'content': [{'text': json.dumps({'reasoning': 'ok', 'html': '<html></html>'})}]}).encode()
            server.claude_apply([{'transcript':'make this green','strokes':[mark],
                                  'references':[{'word':'this','atMs':2750,'strokeId':'during'}]}],'<html></html>')
        prompt = json.loads(request.call_args.args[0].data)['messages'][0]['content'][0]['text']
        self.assertIn('SKETCH during:',prompt)
        self.assertIn('REFERENCE "this" -> during',prompt)

    def test_grouped_x_receipt_and_agent_gate(self):
        first = self.stroke()
        second = {**self.stroke(), 'id': 'crossing-second', 't': 21, 't_end': 35}
        mark = {'id': first['id'], 'shape': 'x', 't': 10, 't_end': 35,
                'enclosed_element': '', 'strokes': [first, second]}
        bundle = {'t_start': 10, 't_end': 35, 'transcript': 'remove this', 'strokes': [mark]}
        with patch.object(server, 'ANTHROPIC_KEY', 'test-only'), patch.object(server, 'claude_apply') as agent:
            code, _ = self.post('/api/apply', {'bundles': [bundle], 'current_html': '<html></html>'})
            self.assertEqual(code, 409)
            agent.assert_not_called()
            code, _ = self.post('/api/strokes', first)
            self.assertEqual(code, 201)
            code, _ = self.post('/api/apply', {'bundles': [bundle], 'current_html': '<html></html>'})
            self.assertEqual(code, 409)
            agent.assert_not_called()
            code, receipt = self.post('/api/marks', mark)
            self.assertEqual(code, 201)
            self.assertEqual(receipt['id'], mark['id'])
            message = receipt['agent_message']
            self.assertIn('touched h1', message)
            self.assertIn('coordinates x 20–40, y 20–40', message)
            code, readback = self.post('/api/marks/readback', {'id': mark['id']})
            self.assertEqual(code, 200)
            self.assertEqual(readback['mark'], mark)
            agent.return_value = {'html': '<html></html>', 'reasoning': 'ok'}
            code, _ = self.post('/api/apply', {'bundles': [bundle], 'current_html': '<html></html>'})
            self.assertEqual(code, 200)
            agent.assert_called_once()
        with patch.object(server.urllib.request, 'urlopen') as request:
            request.return_value.read.return_value = json.dumps({'content': [{'text': json.dumps({'reasoning': 'ok', 'html': '<html></html>'})}]}).encode()
            server.claude_apply([bundle], '<html></html>')
            prompt = json.loads(request.call_args.args[0].data)['messages'][0]['content'][0]['text']
        self.assertIn('X', prompt)
        self.assertIn(message, prompt)
        self.assertIn(first['path'], prompt)
        self.assertIn(second['path'], prompt)

    def test_invalid_group_cannot_be_accepted_or_applied(self):
        first = self.stroke()
        second = {**self.stroke(), 'id': 'other', 'pts': [{**self.stroke()['pts'][0], 'x': float('inf')}]}
        mark = {'id': first['id'], 'shape': 'x', 't': 10, 't_end': 20,
                'enclosed_element': '', 'strokes': [first, second]}
        code, _ = self.post('/api/marks', mark)
        self.assertEqual(code, 400)
        with patch.object(server, 'ANTHROPIC_KEY', 'test-only'), patch.object(server, 'claude_apply') as agent:
            code, _ = self.post('/api/apply', {'bundles': [{'strokes': [mark]}], 'current_html': '<html></html>'})
            self.assertEqual(code, 409)
            agent.assert_not_called()

    def test_invalid_dom_elements_leave_no_stored_mark(self):
        stroke = self.stroke()
        stroke['elements'] = [{'selector': 'h1'}]
        mark = {'id': stroke['id'], 'shape': stroke['shape'], 't': stroke['t'],
                't_end': stroke['t_end'], 'enclosed_element': stroke['enclosed_element'],
                'strokes': [stroke]}
        code, _ = self.post('/api/marks', mark)
        self.assertEqual(code, 400)
        code, _ = self.post('/api/marks/readback', {'id': mark['id']})
        self.assertEqual(code, 404)

    def test_apply_returns_the_exact_full_agent_message(self):
        stroke = self.stroke()
        mark = {'id': stroke['id'], 'shape': stroke['shape'], 't': stroke['t'],
                't_end': stroke['t_end'], 'enclosed_element': stroke['enclosed_element'],
                'strokes': [stroke]}
        _, receipt = self.post('/api/marks', mark)
        payload = {'bundles': [{'transcript': 'change this', 'strokes': [mark]}],
                   'current_html': '<html><body><h1>Draw together</h1></body></html>'}
        with patch.object(server, 'ANTHROPIC_KEY', ''):
            code, unavailable = self.post('/api/apply', payload)
        self.assertEqual(code, 503)
        self.assertIn(receipt['agent_message'], unavailable['agent_message'])
        self.assertIn(payload['current_html'], unavailable['agent_message'])
        with patch.object(server, 'ANTHROPIC_KEY', 'test-only'), patch.object(server.urllib.request, 'urlopen') as request:
            request.return_value.read.return_value = json.dumps({'content': [{'text': json.dumps({'reasoning': 'ok', 'html': '<html></html>'})}]}).encode()
            code, result = self.post('/api/apply', payload)
            sent = json.loads(request.call_args.args[0].data)['messages'][0]['content'][0]['text']
        self.assertEqual(code, 200)
        self.assertEqual(result['agent_message'], sent)
        self.assertIn(receipt['agent_message'], sent)

    def test_built_studio_available_and_classic_retired(self):
        with patch.dict(server.os.environ, {'CALLIOPE_REVIEW_MODE': '1'}):
            with urlopen(self.url + '/api/config') as response:
                self.assertFalse(json.load(response)['publishEnabled'])
            code, _ = self.post('/api/publish', {'html': '<html>not staged</html>'})
            self.assertEqual(code, 404)
        with urlopen(self.url + '/') as response:
            html = response.read().decode()
            self.assertIn("script-src 'self'", response.headers['content-security-policy'])
        self.assertRegex(html, r'/assets/[^" ]+\.js')
        with self.assertRaises(HTTPError) as error:
            urlopen(self.url + '/classic.html')
        self.assertEqual(error.exception.code, 404)
        for path in ('/src/App.svelte', '/assets/../server.py', '/assets/%2e%2e/server.py'):
            with self.subTest(path=path), self.assertRaises(HTTPError):
                urlopen(self.url + path)


if __name__ == '__main__':
    unittest.main()
