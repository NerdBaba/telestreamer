"""Replay real local media through the relay; never use a user session or network feed."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from relay_engine.telegram import TelegramAccessError


from relay_engine import daemon
from relay_engine.daemon import Relay

ROOT = Path(__file__).resolve().parent.parent


class RelayProcessHarness:
    def stop(self):
        if self.process:
            self.process.terminate()
            try:
                stdout, stderr = self.process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                stdout, stderr = self.process.communicate()
            self.logs = (stdout or b"") + (stderr or b"")
            self.process = None

    def request(self, path, body=None, authorized=True):
        headers = {"Authorization": "Bearer " + self.token} if authorized else {}
        if body is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}", headers=headers,
            data=json.dumps(body).encode() if body is not None else None,
        )
        try:
            with urllib.request.urlopen(req, timeout=3) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            with error:
                return error.code, error.read()

    def status(self):
        return json.loads(self.request("/api/status")[1])

    def until(self, condition):
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            if self.process and self.process.poll() is not None:
                self.fail("relay exited: " + self.process.stderr.read().decode())
            try:
                if condition():
                    return
            except (OSError, ValueError):
                pass
            time.sleep(0.1)
        self.fail("relay transition timed out")


@unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required for media replay")
class RelayRecoveryTests(RelayProcessHarness, unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        video = self.directory / "input.mp4"
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
            "testsrc2=size=320x180:rate=25", "-f", "lavfi", "-i", "sine=sample_rate=48000",
            "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-g", "50", "-c:a", "aac", str(video),
        ], check=True, timeout=20)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        self.token = "isolated-media-replay-token"
        self.config = self.directory / "config.json"
        self.config.write_text(json.dumps({
            "input_url": str(video), "loop_input": True, "admin_token": self.token,
            "port": self.port, "output_dir": str(self.directory / "hls"),
            "state_path": str(self.directory / "state.json"), "poll_interval": 0.25,
        }))
        self.process = None
        self.addCleanup(self.stop)
        self.start()

    def start(self):
        self.process = subprocess.Popen(
            [sys.executable, "-m", "relay_engine.daemon", "--config", str(self.config)],
            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        self.until(lambda: self.request("/api/status")[0] == 200)

    def test_copy_mode_preserves_source_frame_timing(self):
        self.stop()
        video = self.directory / "copy.mp4"
        subprocess.run([
            "ffmpeg", "-v", "error", "-f", "lavfi", "-i",
            "testsrc2=size=320x180:rate=15", "-f", "lavfi", "-i", "sine=sample_rate=48000",
            "-t", "6", "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-c:a", "aac", str(video),
        ], check=True, timeout=20)
        config = json.loads(self.config.read_text())
        config.update(input_url=str(video), media_mode="copy")
        self.config.write_text(json.dumps(config))
        self.start()
        self.until(lambda: self.status()["playout"]["ready"])
        probe = json.loads(subprocess.check_output([
            "ffprobe", "-v", "error", "-show_streams", "-of", "json",
            str(self.directory / "hls" / "index.m3u8"),
        ], timeout=15))
        streams = probe["streams"]
        self.assertEqual({stream["codec_name"] for stream in streams}, {"h264", "aac"})
        self.assertEqual(next(stream["r_frame_rate"] for stream in streams
                              if stream["codec_type"] == "video"), "15/1")
        decoded = subprocess.run([
            "ffmpeg", "-v", "error", "-xerror", "-i", str(self.directory / "hls" / "index.m3u8"),
            "-t", "2", "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-",
        ], capture_output=True, timeout=15)
        self.assertEqual(decoded.returncode, 0, decoded.stderr.decode())

    def test_stopped_media_is_replaced_without_serving_stale_hls(self):
        self.until(lambda: self.status()["playout"]["ready"])
        previous_pid = self.status()["playout"]["pid"]
        os.kill(previous_pid, signal.SIGSTOP)
        playlist = self.directory / "hls" / "index.m3u8"
        stale = time.time() - 30
        os.utime(playlist, (stale, stale))
        self.assertEqual(self.request("/live/index.m3u8")[0], 503)
        self.until(lambda: self.status()["playout"]["ready"]
                   and self.status()["playout"]["pid"] != previous_pid)
        with self.assertRaises(ProcessLookupError):
            os.kill(previous_pid, 0)
        decoded = subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-i",
            f"http://127.0.0.1:{self.port}/live/index.m3u8", "-t", "2", "-f", "null", "-",
        ], capture_output=True, timeout=20)
        self.assertEqual(decoded.returncode, 0, decoded.stderr.decode())

    def test_media_crash_recovers_and_pause_survives_daemon_restart(self):
        self.until(lambda: self.status()["playout"]["ready"])
        previous_pid = self.status()["playout"]["pid"]
        os.kill(previous_pid, signal.SIGTERM)
        self.until(lambda: self.status()["playout"]["ready"]
                   and self.status()["playout"]["pid"] != previous_pid)
        decoded = subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-i",
            f"http://127.0.0.1:{self.port}/live/index.m3u8", "-t", "2", "-f", "null", "-",
        ], capture_output=True, timeout=20)
        self.assertEqual(decoded.returncode, 0, decoded.stderr.decode())
        self.assertEqual(self.request("/api/control", {"action": "pause"}, authorized=False)[0], 401)
        self.assertFalse(self.status()["paused"])
        self.assertEqual(self.request("/api/control", {"action": "pause"})[0], 200)
        self.assertEqual(self.request("/live/index.m3u8")[0], 503)
        self.stop()
        self.start()
        self.assertTrue(self.status()["paused"])
        self.assertEqual(self.request("/live/index.m3u8")[0], 503)
        self.assertEqual(self.request("/api/control", {"action": "resume"})[0], 200)
        self.until(lambda: self.status()["playout"]["ready"])
        self.assertEqual(self.request("/live/index.m3u8")[0], 200)
        # A forced override must switch the source, never silently keep the
        # previous feed. Under Turbo-first, forcing rwitc selects the alternate
        # source, so the playout is rebuilt from the chosen one rather than
        # the pinned input.
        response, body = self.request("/api/control", {"action": "force", "source": "rwitc"})
        self.assertEqual(response, 200)
        self.assertEqual(json.loads(body)["forced"], "rwitc")
        self.assertEqual(self.request("/live/index.m3u8")[0], 503)
        self.request("/api/control", {"action": "auto"})
        self.until(lambda: self.status()["playout"]["ready"])
        self.assertEqual(self.request("/live/index.m3u8")[0], 200)


@unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required for media replay")
class RelayEnvironmentTests(RelayProcessHarness, unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.video = self.directory / "input.mp4"
        subprocess.run([
            "ffmpeg", "-v", "error", "-f", "lavfi", "-i",
            "testsrc2=size=320x180:rate=15", "-t", "6", "-c:v", "libx264",
            "-preset", "ultrafast", "-g", "30", str(self.video),
        ], check=True, timeout=20)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        self.token = "isolated-render-admin-token"
        self.remote_state = {"paused": False, "forced": None, "auto_start": True, "selected_chat_id": None}
        self.remote_reads_fail = False
        self.remote_writes_fail = False
        owner = self

        class StateHandler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def respond(self, status, body):
                payload = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def authorized(self):
                return (self.path == "/api/relay-state"
                        and self.headers.get("Authorization") == "Bearer " + owner.token)

            def do_GET(self):
                if not self.authorized():
                    return self.respond(401, {"error": "unauthorized"})
                if owner.remote_reads_fail:
                    return self.respond(503, {"error": "storage unavailable"})
                self.respond(200, owner.remote_state)

            def do_PUT(self):
                if not self.authorized():
                    return self.respond(401, {"error": "unauthorized"})
                if owner.remote_writes_fail:
                    return self.respond(503, {"error": "storage unavailable"})
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if (set(body) != {"paused", "forced", "auto_start", "selected_chat_id"}
                        or type(body["paused"]) is not bool
                        or type(body["auto_start"]) is not bool
                        or body["forced"] not in (None, "rwitc", "turbosportslive")
                        or (body["selected_chat_id"] is not None
                            and (type(body["selected_chat_id"]) is not int or body["selected_chat_id"] <= 0))):
                    return self.respond(400, {"error": "invalid state"})
                owner.remote_state = body
                self.respond(200, body)

        self.remote = ThreadingHTTPServer(("127.0.0.1", 0), StateHandler)
        threading.Thread(target=self.remote.serve_forever, daemon=True).start()
        self.addCleanup(self.remote.server_close)
        self.addCleanup(self.remote.shutdown)
        contract_vars = {
            "RENDER", "ADMIN_TOKEN", "RTMP_URL", "RTMP_KEY", "WORKER_URL",
            "RELAY_STATE_URL", "RELAY_MEDIA_MODE", "RELAY_HOST", "PORT",
            "RELAY_INPUT_URL", "RELAY_OUTPUT_CHAT_ID", "RELAY_LOOP_INPUT",
            "TG_API_ID", "TG_API_HASH",
        }
        self.environment = {key: value for key, value in os.environ.items() if key not in contract_vars}
        self.environment.update({
            "PYTHONPATH": str(ROOT), "RENDER": "true", "ADMIN_TOKEN": self.token,
            "PORT": str(self.port), "RELAY_INPUT_URL": str(self.video), "RELAY_LOOP_INPUT": "true",
            "WORKER_URL": f"http://127.0.0.1:{self.remote.server_port}",
        })
        self.process = None
        self.addCleanup(self.stop)

    def launch(self):
        self.process = subprocess.Popen(
            [sys.executable, "-m", "relay_engine.daemon"], cwd=self.directory,
            env=self.environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )

    def start(self):
        self.launch()
        self.until(lambda: self.request("/api/status")[0] == 200)

    def test_render_environment_boots_without_config_and_copies_video_only_timing(self):
        self.start()
        self.until(lambda: self.status()["playout"]["ready"])
        self.assertEqual(self.request("/api/status", authorized=False)[0], 401)
        self.assertFalse((self.directory / "rrr_config.json").exists())
        probe = json.loads(subprocess.check_output([
            "ffprobe", "-v", "error", "-show_streams", "-of", "json",
            str(self.directory / ".relay" / "hls" / "index.m3u8"),
        ], timeout=15))
        self.assertEqual(len(probe["streams"]), 1)
        video = probe["streams"][0]
        self.assertEqual((video["codec_name"], video["r_frame_rate"], video["width"], video["height"]),
                         ("h264", "15/1", 320, 180))
        self.assertEqual(self.request("/healthz")[0], 200)

    @unittest.skipUnless(all(shutil.which(name) for name in ("ffprobe", "cc", "pkg-config", "ps")),
                         "Native publisher prerequisites required")
    def test_render_environment_publishes_rtmp_secrets_without_argument_or_output_leaks(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            rtmp_port = listener.getsockname()[1]
        key = "isolated-render-private-rtmp-key"
        rtmp_url = f"rtmp://127.0.0.1:{rtmp_port}/live"
        self.environment.update(RTMP_URL=rtmp_url, RTMP_KEY=key,
                                TG_API_HASH="isolated-render-private-api-hash")
        capture = self.directory / "received.flv"
        receiver = subprocess.Popen([
            "ffmpeg", "-v", "error", "-listen", "1", "-i", rtmp_url + "/" + key,
            "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-f", "flv", str(capture),
        ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            time.sleep(0.5)
            self.assertIsNone(receiver.poll(), "local RTMP receiver failed to start")
            self.start()
            self.until(lambda: self.status()["publishing"]["running"])
            processes = subprocess.check_output(["ps", "-axo", "pid=,ppid=,command="], text=True)
            children = [row for row in processes.splitlines()
                        if len(row.split(None, 2)) == 3
                        and row.split(None, 2)[1] == str(self.process.pid)]
            self.assertTrue(children)
            self.assertNotIn(key, "\n".join(children))
            child_ids = ",".join(row.split(None, 2)[0] for row in children)
            child_environments = subprocess.check_output(
                ["ps", "eww", "-p", child_ids, "-o", "command="], text=True,
            )
            for secret in (key, self.token, "isolated-render-private-api-hash"):
                self.assertNotIn(secret, child_environments)
            self.assertNotIn(key, self.request("/api/status")[1].decode())
            self.until(lambda: capture.exists() and capture.stat().st_size > 65536)
            self.stop()
            self.assertNotIn(key.encode(), self.logs)
            self.assertNotIn(self.token.encode(), self.logs)
            receiver.communicate(timeout=15)
            probe = json.loads(subprocess.check_output([
                "ffprobe", "-v", "error", "-show_streams", "-of", "json", str(capture),
            ], timeout=15))
            self.assertEqual(probe["streams"][0]["codec_name"], "h264")
            self.assertEqual(probe["streams"][0]["r_frame_rate"], "15/1")
        finally:
            self.stop()
            if receiver.poll() is None:
                receiver.terminate()
            try:
                receiver.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                receiver.kill()
                receiver.communicate()

    def test_remote_pause_and_source_survive_ephemeral_disk_loss(self):
        self.start()
        self.until(lambda: self.status()["playout"]["ready"])
        self.assertEqual(self.request("/api/control", {"action": "force", "source": "rwitc"})[0], 200)
        self.assertEqual(self.request("/api/control", {"action": "pause"})[0], 200)
        self.stop()
        (self.directory / "relay_state.json").unlink(missing_ok=True)
        shutil.rmtree(self.directory / ".relay")
        self.start()
        restored = self.status()
        self.assertTrue(restored["paused"])
        self.assertEqual(restored["forced"], "rwitc")
        self.assertIsNone(restored["playout"]["pid"])
        self.assertEqual(self.request("/live/index.m3u8")[0], 503)
        self.assertEqual(self.request("/api/control", {"action": "resume"})[0], 200)
        self.until(lambda: self.status()["playout"]["ready"])

    def test_remote_write_failure_does_not_claim_resume_or_change_source(self):
        self.remote_state = {"paused": True, "forced": "rwitc", "auto_start": True, "selected_chat_id": None}
        self.start()
        self.remote_writes_fail = True
        self.assertEqual(self.request("/api/control", {"action": "resume"})[0], 500)
        self.assertEqual(self.request("/api/control", {"action": "auto"})[0], 500)
        self.assertTrue(self.status()["paused"])
        self.assertEqual(self.status()["forced"], "rwitc")
        self.assertEqual(self.request("/live/index.m3u8")[0], 503)
        self.remote_writes_fail = False
        self.assertEqual(self.request("/api/control", {"action": "resume"})[0], 200)
        self.until(lambda: self.status()["playout"]["ready"])

    def test_unavailable_remote_state_fails_closed_without_local_default_fallback(self):
        self.remote_reads_fail = True
        (self.directory / "relay_state.json").write_text(
            '{"paused":false,"forced":null,"auto_start":true,"selected_chat_id":null}')
        self.launch()
        stdout, stderr = self.process.communicate(timeout=15)
        self.assertNotEqual(self.process.returncode, 0)
        self.assertFalse((self.directory / ".relay" / "hls" / "index.m3u8").exists())
        self.assertNotIn(self.token.encode(), stdout + stderr)
        self.assertFalse(self.remote_state["paused"])
        self.process = None

    def test_render_requires_stable_environment_token_and_rejects_unknown_media_mode(self):
        for changes in ({"ADMIN_TOKEN": ""}, {"RELAY_MEDIA_MODE": "unsafe"}):
            with self.subTest(changes=changes):
                environment = self.environment.copy()
                environment.update(changes)
                result = subprocess.run(
                    [sys.executable, "-m", "relay_engine.daemon"], cwd=self.directory,
                    env=environment, capture_output=True, timeout=15,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.directory / "rrr_config.json").exists())
                self.assertNotIn(self.token.encode(), result.stdout + result.stderr)


class DestinationDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def test_destination_access_error_reports_safe_detail(self):
        with tempfile.TemporaryDirectory() as directory:
            relay = Relay({
                "admin_token": "isolated-destination-token",
                "tg_api_id": 1,
                "tg_api_hash": "isolated-api-hash",
            }, Path(directory))
            publisher = SimpleNamespace(
                connect=AsyncMock(side_effect=TelegramAccessError(
                    "The target requires creator or manage_call administrator rights.")),
                close=AsyncMock(),
            )

            with patch("relay_engine.telegram.TelegramPublisher", return_value=publisher):
                await relay.resolve_destination()

            self.assertEqual(relay.publishing, "blocked: TelegramAccessError")
            self.assertEqual(
                relay.last_error,
                "destination blocked: The target requires creator or manage_call administrator rights.",
            )

    async def test_destination_unknown_error_hides_message(self):
        with tempfile.TemporaryDirectory() as directory:
            relay = Relay({
                "admin_token": "isolated-destination-token",
                "tg_api_id": 1,
                "tg_api_hash": "isolated-api-hash",
            }, Path(directory))
            publisher = SimpleNamespace(
                connect=AsyncMock(side_effect=RuntimeError("private-token")),
                close=AsyncMock(),
            )

            with patch("relay_engine.telegram.TelegramPublisher", return_value=publisher):
                await relay.resolve_destination()

            self.assertEqual(relay.last_error, "destination resolution failed: RuntimeError")
            self.assertNotIn("private-token", relay.last_error)

    async def test_destination_flood_wait_delays_next_retry(self):
        class FloodWaitError(RuntimeError):
            seconds = 90

        with tempfile.TemporaryDirectory() as directory:
            relay = Relay({
                "admin_token": "isolated-destination-token",
                "tg_api_id": 1,
                "tg_api_hash": "isolated-api-hash",
            }, Path(directory))
            publisher = SimpleNamespace(
                connect=AsyncMock(side_effect=FloodWaitError("retry after 90")),
                close=AsyncMock(),
            )
            before = time.monotonic()

            with patch("relay_engine.telegram.TelegramPublisher", return_value=publisher):
                await relay.resolve_destination()

            self.assertGreaterEqual(relay.next_publish, before + 89)
            self.assertEqual(
                relay.last_error,
                "destination retry delayed by Telegram flood wait (90 seconds)",
            )

    async def test_paused_reconcile_does_not_resolve_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            relay = Relay({"admin_token": "isolated-pause-token"}, Path(directory))
            relay.paused = True
            relay.resolve_destination = AsyncMock()

            await relay.reconcile()

            relay.resolve_destination.assert_not_awaited()

    async def test_release_call_requires_telegram_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            relay = Relay({"admin_token": "isolated-release-token"}, Path(directory))
            with patch.dict(os.environ, {"TG_API_ID": "", "TG_API_HASH": ""}):
                with self.assertRaisesRegex(ValueError, "credentials"):
                    await relay.control({"action": "release_call"})

    async def test_release_call_discards_the_call_and_clears_the_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            relay = Relay({
                "admin_token": "isolated-release-token",
                "tg_api_id": 1,
                "tg_api_hash": "isolated-api-hash",
            }, Path(directory))
            relay.destination = "rtmp://example.invalid/app/key"
            relay.publishing = "blocked: TelegramAccessError"
            publisher = SimpleNamespace(
                connect=AsyncMock(),
                release_ended_call=AsyncMock(return_value="discarded an ended call"),
                close=AsyncMock(),
            )

            with patch("relay_engine.telegram.TelegramPublisher", return_value=publisher):
                await relay.control({"action": "release_call"})

            publisher.release_ended_call.assert_awaited_once()
            self.assertEqual(relay.destination, None)
            self.assertEqual(relay.publishing, "idle")
            self.assertEqual(relay.last_error, "discarded an ended call")
            self.assertEqual(relay.next_publish, 0)

class PublishRefreshTests(unittest.IsolatedAsyncioTestCase):
    """A cached stream key must not fail forever if Telegram rotates it."""

    async def relay_ready_to_publish(self):
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, ignore_errors=True)
        relay = Relay({"admin_token": "isolated-publish-token", "output_dir": "hls"}, Path(directory))
        (relay.output / "index.m3u8").write_text("#EXTM3U\n#EXTINF:1.0,\nseg.ts\n")
        relay.decision = {"chosen": "rwitc", "available": True}
        relay.desired = relay.current = "rwitc"
        relay.media = SimpleNamespace(poll=lambda: None)
        relay.destination = "rtmp://example.invalid/app/stale-key"
        relay.publisher = SimpleNamespace(close=AsyncMock())
        return relay

    async def test_repeated_publish_failures_request_fresh_credentials(self):
        relay = await self.relay_ready_to_publish()
        running = SimpleNamespace(poll=lambda: None)

        with patch("relay_engine.daemon.launch_publisher", return_value=running):
            for _ in range(daemon.PUBLISH_FAILURES_BEFORE_REFRESH):
                relay.push = SimpleNamespace(poll=lambda: 1, returncode=1)
                await relay.reconcile()

        self.assertIsNone(relay.destination, "a stale key must be re-resolved")
        self.assertIsNone(relay.publisher)
        self.assertEqual(relay.push_failures, 0)
        self.assertEqual(relay.next_publish, 0, "credentials are fetched immediately")

    async def test_a_single_publish_failure_keeps_the_cached_key(self):
        relay = await self.relay_ready_to_publish()
        running = SimpleNamespace(poll=lambda: None)

        with patch("relay_engine.daemon.launch_publisher", return_value=running):
            relay.push = SimpleNamespace(poll=lambda: 1, returncode=1)
            await relay.reconcile()

        self.assertEqual(relay.destination, "rtmp://example.invalid/app/stale-key")
        self.assertEqual(relay.push_failures, 1)

    async def test_a_healthy_push_resets_the_failure_count(self):
        relay = await self.relay_ready_to_publish()
        relay.push = SimpleNamespace(poll=lambda: None)
        relay.push_failures = 2

        await relay.reconcile()

        self.assertEqual(relay.push_failures, 0)
        self.assertEqual(relay.destination, "rtmp://example.invalid/app/stale-key")


class PinnedAvailabilityTests(unittest.IsolatedAsyncioTestCase):
    """Availability must come from the playlist, never from an ingest request."""

    def relay(self, **extra):
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, ignore_errors=True)
        config = {
            "admin_token": "isolated-pinned-token",
            "input_url": "https://space.example/p/token/streams/2631340b81ae/play.m3u8",
            # Hosted defaults; discovery is what publishes playlist liveness.
            "discover_channels": True,
        }
        config.update(extra)
        return Relay(config, Path(directory))

    async def test_playlist_membership_decides_without_requesting_the_stream(self):
        relay = self.relay()
        relay.active_stream_ids = {"2631340b81ae"}
        self.assertTrue(relay.pinned_source_available())
        relay.active_stream_ids = set()
        self.assertFalse(relay.pinned_source_available())

    async def test_discovery_disabled_still_uses_the_tgtv_playlist(self):
        relay = self.relay(discover_channels=False)
        relay.active_stream_ids = {"2631340b81ae"}
        self.assertTrue(relay.pinned_source_available())
        relay.active_stream_ids = set()
        self.assertFalse(relay.pinned_source_available())

    async def test_loop_input_is_always_available(self):
        relay = self.relay(loop_input=True, input_url="/tmp/loop.mp4")
        relay.active_stream_ids = set()
        self.assertTrue(relay.pinned_source_available())


class MediaDiagnosticTests(unittest.TestCase):
    """A media crash must explain itself without exposing the private input URL."""

    def test_restart_delay_grows_and_is_capped(self):
        # A remote capture is flood-limited by Telegram when a failing source is
        # retried every few seconds, so the delay must grow and then hold.
        self.assertEqual(daemon.restart_delay(1), 3.0)
        self.assertEqual(daemon.restart_delay(2), 6.0)
        self.assertEqual(daemon.restart_delay(3), 12.0)
        self.assertEqual(daemon.restart_delay(6), 60.0)
        self.assertEqual(daemon.restart_delay(50), 60.0)

    def test_detail_keeps_the_last_line_and_redacts_long_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "media.log"
            log.write_text(
                "frame= 1 fps=0.0\n"
                "https://space.example/p/" + "a" * 96 + "/streams/2631340b81ae/play.m3u8: "
                "Server returned 404 Not Found\n"
            )
            detail = daemon.media_failure_detail(log)
            self.assertIn("404 Not Found", detail)
            self.assertNotIn("a" * 96, detail)

    def test_detail_is_empty_without_a_log(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(daemon.media_failure_detail(Path(directory) / "missing.log"), "")


@unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required for media replay")
class RelayStartupTests(unittest.IsolatedAsyncioTestCase):
    async def media_without_playlist(self, age):
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, ignore_errors=True)
        base = Path(directory)
        relay = Relay({"admin_token": "isolated-startup-token", "output_dir": "hls"}, base)
        process = subprocess.Popen([
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-re", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25",
            "-f", "null", "-",
        ], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(self.terminate, process)
        relay.media = process
        relay.media_started = time.monotonic() - age
        relay.current = relay.desired = "rwitc"
        relay.decision = {"chosen": "rwitc", "available": True}
        return relay, process

    @staticmethod
    def terminate(process):
        if process.poll() is None:
            process.kill()
            process.wait()

    async def test_a_bootstrapping_capture_is_given_time_to_produce_its_first_segment(self):
        # The pinned capture answers its playlist with no segments while ingest
        # bootstraps, which was measured to last well over a minute. Killing
        # media at 20 seconds restarted the ingest and prevented any start.
        relay, process = await self.media_without_playlist(daemon.MEDIA_START_GRACE - 10)
        try:
            await relay.reconcile()
            self.assertIsNone(process.poll(), "media must survive the capture bootstrap window")
            self.assertIsNotNone(relay.media)
        finally:
            await relay.stop_media()

    async def test_alive_media_without_first_playlist_has_finite_startup_timeout(self):
        relay, process = await self.media_without_playlist(daemon.MEDIA_START_GRACE + 1)
        try:
            self.assertIsNone(process.poll())
            self.assertFalse((relay.output / "index.m3u8").exists())
            await relay.reconcile()
            self.assertIsNotNone(process.poll(), "alive media must not wait forever for its first playlist")
            self.assertIsNone(relay.media)
            self.assertFalse(relay.ready())
            self.assertGreater(relay.next_start, time.monotonic(), "startup failures retain restart backoff")
        finally:
            await relay.stop_media()


if __name__ == "__main__":
    unittest.main()
