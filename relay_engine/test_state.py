"""Relay state boundary tests against a real temporary HTTP service."""
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from relay_engine.state import load_state, save_state


class StateTests(unittest.TestCase):
    def setUp(self):
        self.state = {"paused": False, "forced": None, "auto_start": True, "selected_chat_id": None}
        self.status = 200
        self.response = None
        self.requests = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.respond()

            def do_PUT(self):
                data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                if owner.status == 200 and self.headers.get('Authorization') == 'Bearer private-token':
                    owner.state = data
                self.respond()

            def respond(self):
                owner.requests.append((self.command, self.headers.get('Authorization')))
                status = owner.status if self.headers.get('Authorization') == 'Bearer private-token' else 401
                body = owner.response if owner.response is not None else json.dumps(owner.state).encode()
                self.send_response(status)
                self.send_header('Content-Length', str(len(body)))
                if status == 302:
                    self.send_header('Location', '/api/relay-state')
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/api/relay-state'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_roundtrip_independent_requests(self):
        self.assertEqual(load_state(self.url, 'private-token'), self.state)
        state = {'paused': True, 'forced': 'turbosportslive', 'auto_start': True,
                 'selected_chat_id': 2961901881}
        self.assertIsNone(save_state(self.url, 'private-token', state))
        self.assertEqual(load_state(self.url, 'private-token'), state)
        self.assertEqual([method for method, _ in self.requests], ['GET', 'PUT', 'GET'])

    def test_invalid_input_never_reaches_service(self):
        valid = {'paused': False, 'forced': None, 'auto_start': True, 'selected_chat_id': None}
        for state in [None, {}, {'paused': 1, 'forced': None, 'auto_start': True, 'selected_chat_id': None},
                      {'paused': False, 'forced': 'bad', 'auto_start': True, 'selected_chat_id': None},
                      {**valid, 'selected_chat_id': True},
                      {**valid, 'selected_chat_id': 0},
                      {**valid, 'selected_chat_id': 9007199254740992},
                      {**valid, 'secret': 'private-token'}]:
            with self.subTest(state=state), self.assertRaises(ValueError):
                save_state(self.url, 'private-token', state)
        self.assertEqual(self.requests, [])

    def test_bad_responses_fail_without_defaults_or_secret_details(self):
        for response in [b'private-token rtmp-key', b'{}', b'null',
                         b'{"paused":1,"forced":null,"auto_start":true,"selected_chat_id":null}',
                         b'{"paused":false,"forced":null,"auto_start":true,"selected_chat_id":"1"}',
                         b'{"paused":false,"forced":null,"auto_start":true,"selected_chat_id":1.5}',
                         b'{"paused":false,"forced":null,"auto_start":true,"selected_chat_id":0}',
                         b'{"paused":false,"forced":null,"auto_start":true,"selected_chat_id":9007199254740992}',
                         b'{"paused":false,"forced":null,"auto_start":true,"selected_chat_id":null,"extra":0}',
                         b'{"paused":false,"forced":null,"auto_start":true}', b'x' * 4097]:
            self.response = response
            with self.subTest(response=response[:40]), self.assertRaises(RuntimeError) as error:
                load_state(self.url, 'private-token')
            self.assertNotIn('private-token', str(error.exception))
            self.assertNotIn('rtmp-key', str(error.exception))
        self.response = b'private-token rtmp-key'
        self.status = 503
        for operation in [lambda: load_state(self.url, 'private-token'),
                          lambda: save_state(self.url, 'private-token', self.state)]:
            with self.assertRaises(RuntimeError) as error:
                operation()
            self.assertNotIn('private-token', str(error.exception))
            self.assertNotIn('rtmp-key', str(error.exception))

    def test_save_requires_canonical_confirmation(self):
        for response in [b'{}', b'{"paused":false,"forced":null,"auto_start":true}']:
            self.response = response
            with self.subTest(response=response), self.assertRaises(RuntimeError):
                save_state(self.url, 'private-token', {
                    'paused': True, 'forced': 'rwitc', 'auto_start': True,
                    'selected_chat_id': None,
                })

    def test_unauthorized_and_unavailable_do_not_fake_defaults(self):
        with self.assertRaises(RuntimeError):
            load_state(self.url, 'wrong-token')
        self.server.shutdown()
        self.server.server_close()
        with self.assertRaises(RuntimeError):
            load_state(self.url, 'private-token')


    def test_redirects_are_not_followed_with_authorization(self):
        self.status = 302
        with self.assertRaises(RuntimeError):
            load_state(self.url, 'private-token')
        self.assertEqual(len(self.requests), 1)


if __name__ == '__main__':
    unittest.main()
