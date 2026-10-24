"""Anonymous audio admission and resource limits, without provider traffic."""
import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class Socket:
    def __init__(self, messages=(), origin=None, path='/audio'):
        self.messages = messages
        self.request = type('Request', (), {'headers': {'Origin': origin} if origin else {}, 'path': path})()
        self.sent = []

    async def send(self, data):
        self.sent.append(data)

    async def close(self, code, reason):
        self.sent.append((code, reason))

    def __aiter__(self):
        async def items():
            for message in self.messages:
                yield message
        return items()


class PublicAudioTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        budget = patch.object(server, 'PUBLIC_BUDGET_DB', Path(root.name) / 'budget.sqlite3')
        budget.start()
        self.addCleanup(budget.stop)

    async def test_audio_session_budget_survives_calls(self):
        with tempfile.TemporaryDirectory() as root, \
             patch.object(server, 'PUBLIC_BUDGET_DB', Path(root) / 'budget.sqlite3'), \
             patch.object(server, 'PUBLIC_AUDIO_SESSION_LIMIT', 1, create=True), \
             patch.object(server, 'PUBLIC_MODE', True), \
             patch.object(server, 'STUDIO_ORIGIN', 'https://demo.example'), \
             patch.object(server, 'RESON8_KEY', 'synthetic'), \
             patch.object(server, '_relay') as relay:
            await server.audio_ws(Socket(origin='https://demo.example'))
            second = Socket(origin='https://demo.example')
            await server.audio_ws(second)
            self.assertEqual(relay.call_count, 1)
            self.assertTrue(second.sent)

    async def test_mismatched_origin_and_path_rejected_before_relay(self):
        with patch.object(server, 'PUBLIC_MODE', True), patch.object(server, 'STUDIO_ORIGIN', 'https://demo.example'), \
             patch.object(server, 'RESON8_KEY', 'synthetic'), patch.object(server, '_relay') as relay:
            for origin, path in [('https://elsewhere.example', '/audio'), ('https://demo.example', '/other'), (None, '/audio')]:
                socket = Socket(origin=origin, path=path)
                await server.audio_ws(socket)
                relay.assert_not_called()

    async def test_public_audio_caps_bytes_without_forwarding_excess(self):
        upstream = Socket()
        socket = Socket([b'a' * 8, b'b' * 8], 'https://demo.example')
        class Connection:
            async def __aenter__(self): return upstream
            async def __aexit__(self, *args): pass
        with patch.object(server, 'PUBLIC_MODE', True), patch.object(server, 'PUBLIC_AUDIO_BYTES', 10, create=True), \
             patch.object(server.websockets, 'connect', return_value=Connection()):
            with self.assertRaises(ValueError):
                await server._relay(socket)
        self.assertEqual(upstream.sent, [b'a' * 8])

    async def test_public_audio_deadline_and_concurrent_admission(self):
        blocker = asyncio.Event()
        entered = asyncio.Event()
        async def waiting(_):
            entered.set()
            await blocker.wait()
        with patch.object(server, 'PUBLIC_MODE', True), patch.object(server, 'STUDIO_ORIGIN', 'https://demo.example'), \
             patch.object(server, 'RESON8_KEY', 'synthetic'), patch.object(server, 'PUBLIC_AUDIO_SECONDS', .02, create=True), \
             patch.object(server, 'PUBLIC_AUDIO_SLOTS', asyncio.Semaphore(1), create=True), \
             patch.object(server, '_relay', side_effect=waiting) as relay:
            first = asyncio.create_task(server.audio_ws(Socket(origin='https://demo.example')))
            await asyncio.wait_for(entered.wait(), .5)
            second = Socket(origin='https://demo.example')
            await asyncio.wait_for(server.audio_ws(second), .1)
            self.assertEqual(relay.call_count, 1)
            self.assertTrue(second.sent)
            await asyncio.wait_for(first, .1)
            self.assertFalse(blocker.is_set())
