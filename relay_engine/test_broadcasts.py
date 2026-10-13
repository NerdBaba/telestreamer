"""Discovery must list every member channel without joining or posting."""
from __future__ import annotations

import asyncio
import sys
import threading
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from relay_engine import broadcasts, daemon  # noqa: E402


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
        source._list_broadcasts = lambda _session: self.rows
        source._own_channel_id = lambda _session: own
        source.decision = {"chosen": None, "available": False}
        return source

    def test_resolved_output_channel_is_excluded(self):
        source = self.relay(4347395930)
        self.schedule(source.refresh_discoveries(None))
        self.assertEqual([row["title"] for row in source.broadcasts], ["Turbo"])
        self.assertIsNone(source.discovery_error)

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

    def schedule(self, coroutine):
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result(10)


if __name__ == "__main__":
    unittest.main()
