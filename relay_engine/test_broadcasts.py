"""Discovery must list every member channel without joining or posting."""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from relay_engine import broadcasts  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
