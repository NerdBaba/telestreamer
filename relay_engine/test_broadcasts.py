"""Discovery must list every member channel without joining or posting."""
from __future__ import annotations

import asyncio
import json
import sys
import threading
import tempfile
import time
from unittest.mock import AsyncMock, patch
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from relay_engine import broadcasts, daemon, tgtv  # noqa: E402


def channel(chat_id, title, username=None, call=None, **extra):
    payload = dict(id=chat_id, title=title, username=username, broadcast=True, **extra)
    if call is not None:
        payload["call"] = call
    return SimpleNamespace(**payload)


def call(rtmp=False, scheduled=False):
    return SimpleNamespace(rtmp_stream=rtmp,
                           schedule_date=SimpleNamespace() if scheduled else None)


def client_for(entities):
    """A client whose dialog iteration yields the given entities."""
    client = SimpleNamespace()

    async def iter_dialogs():
        for entity in entities:
            yield SimpleNamespace(entity=entity)

    client.iter_dialogs = iter_dialogs
    return client


class DiscoveryTests(unittest.TestCase):
    def discover(self, entities):
        return asyncio.run(broadcasts.discover_broadcasts(client_for(entities)))

    def pick(self, entities, exclude):
        return asyncio.run(broadcasts.pick_live(client_for(entities), exclude))

    def test_lists_every_member_channel_including_idle_ones(self):
        # An idle channel must still be listed, otherwise "no feed" is
        # indistinguishable from "not a channel at all".
        rows = self.discover([
            channel(1, "Turbo", call=call(rtmp=True)),
            channel(2, "Turf Warriors"),
            channel(3, "RRR output"),
            SimpleNamespace(id=4, title="a private group", broadcast=False),
            SimpleNamespace(id=5, title="a saved message", broadcast=False),
        ])
        # Live first, then idle channels in title order.
        self.assertEqual([row["chat_id"] for row in rows], [1, 3, 2])
        self.assertEqual([row["live"] for row in rows], [True, False, False])
        self.assertEqual(rows[0]["rtmp"], True)

    def test_live_channels_are_reported_first(self):
        rows = self.discover([
            channel(2, "Zulu offline"),
            channel(1, "Alpha live", call=call(rtmp=True)),
        ])
        self.assertEqual([row["title"] for row in rows], ["Alpha live", "Zulu offline"])

    def test_scheduled_calls_are_not_treated_as_live(self):
        rows = self.discover([channel(7, "Scheduled", call=call(rtmp=True, scheduled=True))])
        self.assertEqual(rows[0]["live"], False)
        self.assertEqual(rows[0]["scheduled"], True)

    def test_channels_without_a_username_are_still_discoverable(self):
        rows = self.discover([channel(8, "No username", call=call(rtmp=True))])
        self.assertEqual(rows[0]["username"], None)
        self.assertTrue(rows[0]["live"])

    def test_pick_live_skips_the_relay_own_channel(self):
        # The relay publishes into one channel it can see, so that channel must
        # never be restreamed back into itself.
        entities = [
            channel(10, "My RRR channel", call=call(rtmp=True)),
            channel(11, "Turbo source", call=call(rtmp=True)),
            channel(12, "Another idle"),
        ]
        self.assertEqual(self.pick(entities, {10})["chat_id"], 11)
        self.assertIsNone(self.pick(entities, {10, 11}))
        self.assertEqual(self.pick([entities[1]], set())["chat_id"], 11)
        self.assertIsNone(self.pick(entities[:1], {10}))

    def test_live_only_helper_returns_just_broadcasting_channels(self):
        entities = [channel(1, "Live one", call=call(rtmp=True)), channel(2, "Idle one")]
        rows = asyncio.run(broadcasts.live_broadcasts(client_for(entities)))
        self.assertEqual([row["chat_id"] for row in rows], [1])


class DiscoveryExclusionTests(unittest.TestCase):
    """The relay's own output channel must never be offered as a source."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        # session_path() resolves to <base>/<session>.session.
        (self.base / "rrr_live.session").write_bytes(
            b"SQLite format 3\x00" + b"\x00" * 2048)
        self.rows = [
            {"chat_id": 4347395930, "title": "RRR output", "username": None,
             "live": False, "rtmp": False, "scheduled": False},
            {"chat_id": 2961901881, "title": "Turbo", "username": "TurboSportsLive",
             "live": True, "rtmp": True, "scheduled": False},
        ]
        # A live loop is required: Relay.__init__ captures the running loop and
        # discovery schedules to_thread work on it.
        self.loop = asyncio.new_event_loop()
        self.ready = threading.Event()
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()
        self.assertTrue(self.ready.wait(5), "test loop did not start")

    def tearDown(self):
        self.loop.call_soon_threadsafe(self.stopped.set)
        self.thread.join(timeout=10)

    def _serve(self):
        asyncio.set_event_loop(self.loop)

        async def run():
            self.ready.set()
            while not self.stopped.is_set():
                await asyncio.sleep(0.02)

        self.loop.run_until_complete(run())
        self.loop.run_until_complete(self.loop.shutdown_asyncgens())
        self.loop.close()

    def schedule(self, coroutine):
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result(10)

    def relay(self, own):
        async def build():
            return daemon.Relay({
                "admin_token": "t" * 32,
                "state_path": str(self.base / "state.json"),
                "session": "rrr_live",
                "discover_channels": True,
                "discovery_interval": 30,
            }, self.base)
        source = asyncio.run_coroutine_threadsafe(build(), self.loop).result(10)
        async def discover(_operation):
            return self.rows, own
        source._with_telegram = discover
        source.decision = {"chosen": None, "available": False}
        return source

    def test_resolved_output_channel_is_excluded(self):
        source = self.relay(4347395930)
        self.schedule(source.refresh_discoveries(None))
        self.assertEqual([row["title"] for row in source.broadcasts], ["Turbo"])
        self.assertEqual(source.discovery_error, "TGTV live playlist is not configured")

    def test_unresolved_output_channel_publishes_no_sources(self):
        # Failing open here would offer the relay's own channel as a source.
        source = self.relay(None)
        self.schedule(source.refresh_discoveries(None))
        self.assertEqual(source.broadcasts, [])
        self.assertIsNotNone(source.discovery_error)

    def test_disabled_discovery_lists_nothing(self):
        source = self.relay(4347395930)
        source.config["discover_channels"] = False
        self.schedule(source.refresh_discoveries(None))
        self.assertEqual(source.broadcasts, [])

    def test_hf_playlist_is_live_authority_and_output_remains_excluded(self):
        template = "https://space.example/p/private-token/streams/2631340b81ae/play.m3u8"
        rows = [
            {"chat_id": 4347395930, "title": "RRR output", "username": None,
             "live": True, "rtmp": False, "scheduled": False},
            {"chat_id": 2961901881, "title": "Turbo", "username": "TurboSportsLive",
             "live": False, "rtmp": False, "scheduled": False},
            {"chat_id": 2184200485, "title": "Turf Warriors", "username": None,
             "live": True, "rtmp": False, "scheduled": False},
        ]
        source = self.relay(4347395930)
        source.config["input_url"] = template

        async def discover(_operation):
            return rows, 4347395930
        source._with_telegram = discover
        with patch("relay_engine.daemon.tgtv.fetch_live_stream_ids",
                   return_value={tgtv.stream_id(4347395930), tgtv.stream_id(2961901881)}):
            self.schedule(source.refresh_discoveries(None))

        self.assertEqual([row["chat_id"] for row in source.broadcasts], [2961901881, 2184200485])
        self.assertTrue(source.broadcasts[0]["live"])
        self.assertFalse(source.broadcasts[1]["live"])
        self.assertEqual(source.broadcasts[0]["preview_url"],
                         "https://space.example/p/private-token/watch/2631340b81ae")

    def test_hf_liveness_refreshes_between_telegram_scans(self):
        template = "https://space.example/p/private-token/streams/2631340b81ae/play.m3u8"
        first_id, second_id = 2961901881, 2184200485
        source = self.relay(4347395930)
        source.config["input_url"] = template
        source.broadcasts = [
            {"chat_id": first_id, "title": "Turbo", "live": True, "scheduled": False,
             "stream_id": tgtv.stream_id(first_id),
             "preview_url": tgtv.preview_url(template, first_id)},
            {"chat_id": second_id, "title": "Turf Warriors", "live": False, "scheduled": False,
             "stream_id": tgtv.stream_id(second_id)},
        ]
        source.next_discovery = time.monotonic() + 120

        with patch("relay_engine.daemon.tgtv.fetch_live_stream_ids",
                   return_value={tgtv.stream_id(second_id)}):
            self.schedule(source.refresh_discoveries(None))

        self.assertEqual([row["live"] for row in source.broadcasts], [False, True])
        self.assertNotIn("preview_url", source.broadcasts[0])
        self.assertEqual(source.broadcasts[1]["preview_url"],
                         tgtv.preview_url(template, second_id))

    def test_missing_hf_input_fails_closed_for_existing_sources(self):
        source = self.relay(4347395930)
        source.broadcasts = [{
            "chat_id": 2961901881, "title": "Turbo", "live": True,
            "stream_id": tgtv.stream_id(2961901881),
            "preview_url": "https://space.example/p/private-token/watch/2631340b81ae",
        }]
        source.next_discovery = time.monotonic() + 120

        self.schedule(source.refresh_discoveries(None))

        self.assertFalse(source.broadcasts[0]["live"])
        self.assertNotIn("preview_url", source.broadcasts[0])

    def test_unavailable_hf_playlist_fails_closed_without_leaking_url(self):
        source = self.relay(4347395930)
        source.config["input_url"] = "https://space.example/p/private-token/streams/2631340b81ae/play.m3u8"
        with patch("relay_engine.daemon.tgtv.fetch_live_stream_ids", side_effect=RuntimeError("private-token")):
            self.schedule(source.refresh_discoveries(None))
        self.assertTrue(all(not row["live"] for row in source.broadcasts))
        self.assertNotIn("private-token", source.discovery_error)

    def schedule(self, coroutine):
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result(10)


class ChannelSelectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_starting_a_live_member_channel_records_selection(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            chat_id = 2291644480
            stream_id = "486d93b2faa0"
            input_url = "https://example.invalid/p/token/streams/2631340b81ae/play.m3u8"
            relay = daemon.Relay({
                "admin_token": "isolated-channel-selection-token",
                "state_path": str(base / "state.json"),
                "session": "rrr_live",
                "input_url": input_url,
                "output_chat_id": 4347395930,
                "channel": "https://t.me/+-UyRaC_GVSw3NTU1",
            }, base)
            relay.broadcasts = [{
                "chat_id": chat_id, "title": "FREE LIVE INDIA RACING",
                "live": True, "stream_id": stream_id,
            }]

            with patch("relay_engine.daemon.tgtv.fetch_live_stream_ids", return_value={stream_id}):
                status = await relay.control({"action": "select_channel", "chat_id": chat_id})

            self.assertEqual(status["selected_chat_id"], chat_id)
            self.assertEqual(relay.selected_chat_id, chat_id)
            self.assertEqual(relay.manual_start_chat_id, None)
            self.assertFalse(relay.paused)
            self.assertEqual(relay.source_input_url(), tgtv.stream_url(input_url, chat_id))
            saved = json.loads((base / "state.json").read_text())
            self.assertEqual(saved["selected_chat_id"], chat_id)

    async def test_switching_live_member_changes_the_hls_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            template = "https://example.invalid/p/token/streams/2631340b81ae/play.m3u8"
            relay = daemon.Relay({
                "admin_token": "isolated-channel-selection-token",
                "state_path": str(base / "state.json"),
                "input_url": template,
                "output_chat_id": 4347395930,
            }, base)
            relay.broadcasts = [
                {"chat_id": 2291644480, "title": "India Racing", "live": True,
                 "stream_id": "486d93b2faa0"},
                {"chat_id": 2961901881, "title": "Turbo", "live": True,
                 "stream_id": "2631340b81ae"},
            ]
            with patch("relay_engine.daemon.tgtv.fetch_live_stream_ids",
                       return_value={"486d93b2faa0", "2631340b81ae"}):
                await relay.control({"action": "select_channel", "chat_id": 2291644480})
                first_input = relay.source_input_url()
                await relay.control({"action": "select_channel", "chat_id": 2961901881})
            self.assertEqual(first_input, tgtv.stream_url(template, 2291644480))
            self.assertEqual(relay.source_input_url(), tgtv.stream_url(template, 2961901881))

    async def test_reconcile_launches_selected_tgtv_stream(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            chat_id = 2291644480
            stream_id = "486d93b2faa0"
            template = "https://example.invalid/p/token/streams/2631340b81ae/play.m3u8"
            relay = daemon.Relay({
                "admin_token": "isolated-channel-selection-token",
                "state_path": str(base / "state.json"),
                "input_url": template,
                "output_chat_id": 4347395930,
            }, base)
            relay.broadcasts = [{
                "chat_id": chat_id, "title": "FREE LIVE INDIA RACING",
                "live": True, "stream_id": stream_id,
            }]
            with patch("relay_engine.daemon.tgtv.fetch_live_stream_ids", return_value={stream_id}):
                await relay.control({"action": "select_channel", "chat_id": chat_id})

            process = SimpleNamespace(poll=lambda: None)
            with patch.object(relay, "resolve_destination", new=AsyncMock()), \
                    patch("relay_engine.daemon.subprocess.Popen", return_value=process) as popen:
                await relay.reconcile()

            command = popen.call_args.args[0]
            self.assertEqual(command[command.index("-i") + 1],
                             tgtv.stream_url(template, chat_id))

    async def test_explicit_start_works_when_auto_start_is_disabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            chat_id = 2291644480
            relay = daemon.Relay({
                "admin_token": "isolated-channel-selection-token",
                "state_path": str(base / "state.json"),
                "input_url": "https://example.invalid/p/token/streams/2631340b81ae/play.m3u8",
                "output_chat_id": 4347395930,
                "auto_start": False,
            }, base)
            relay.broadcasts = [{
                "chat_id": chat_id, "title": "FREE LIVE INDIA RACING",
                "live": True, "stream_id": "486d93b2faa0",
            }]
            with patch("relay_engine.daemon.tgtv.fetch_live_stream_ids",
                       return_value={"486d93b2faa0"}):
                await relay.control({"action": "select_channel", "chat_id": chat_id})
            self.assertEqual(relay.manual_start_chat_id, chat_id)
            self.assertTrue(relay.should_start_media())

    async def test_idle_or_output_channels_cannot_be_selected(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            relay = daemon.Relay({
                "admin_token": "isolated-channel-selection-token",
                "state_path": str(base / "state.json"),
                "input_url": "https://example.invalid/p/token/streams/2631340b81ae/play.m3u8",
                "output_chat_id": 4347395930,
            }, base)
            relay.broadcasts = [
                {"chat_id": 2291644480, "title": "Idle", "live": False,
                 "stream_id": "486d93b2faa0"},
                {"chat_id": 4347395930, "title": "Output", "live": True,
                 "stream_id": "e2d856492dff"},
            ]
            with self.assertRaisesRegex(ValueError, "not currently live"):
                await relay.control({"action": "select_channel", "chat_id": 2291644480})
            with self.assertRaisesRegex(ValueError, "output channel"):
                await relay.control({"action": "select_channel", "chat_id": 4347395930})


class TgtvRoutingTests(unittest.TestCase):
    def test_upstream_ids_and_selected_hls_and_preview_urls_are_stable(self):
        template = "https://space.example/p/private-token/streams/2631340b81ae/play.m3u8"
        self.assertEqual(tgtv.stream_id(2961901881), "2631340b81ae")
        self.assertEqual(tgtv.stream_id(2291644480), "486d93b2faa0")
        self.assertEqual(tgtv.stream_url(template, 2291644480),
                         "https://space.example/p/private-token/streams/486d93b2faa0/play.m3u8")
        self.assertEqual(tgtv.preview_url(template, 2291644480),
                         "https://space.example/p/private-token/watch/486d93b2faa0")

    def test_playlist_only_accepts_tgtv_hls_uri_lines(self):
        playlist = """#EXTM3U
#EXTINF:-1 tvg-id="486d93b2faa0",FREE LIVE INDIA RACING
https://space.example/p/private-token/streams/486d93b2faa0/play.m3u8
#EXTINF:-1 tvg-id="bad",Other
https://other.example/streams/2631340b81ae/play.m3u8
"""
        self.assertEqual(tgtv.parse_live_stream_ids(playlist), {"486d93b2faa0"})


if __name__ == "__main__":
    unittest.main()
