"""Auto-start behaviour: a live source alone must open the restream."""
from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from relay_engine import daemon  # noqa: E402


def relay(tmp: str, **config):
    async def build():
        return daemon.Relay(dict({"admin_token": "t" * 32,
                                  "state_path": str(Path(tmp) / "state.json")}, **config),
                            Path(tmp))
    return asyncio.run(build())


class AutoStartTests(unittest.TestCase):
    def test_live_source_with_auto_start_starts_media_without_a_control_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = relay(tmp, auto_start=True)
            source.decision = {"chosen": "turbosportslive", "available": True,
                               "reason": "turbo live", "sources": {}}
            self.assertTrue(source.should_start_media())
            self.assertEqual(source.pending_reason(), None)

    def test_stopped_admin_blocks_auto_start_even_when_source_is_live(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = relay(tmp, auto_start=True)
            source.paused = True
            source.decision = {"chosen": "turbosportslive", "available": True,
                               "reason": "turbo live", "sources": {}}
            self.assertFalse(source.should_start_media())
            self.assertEqual(source.pending_reason(), "paused by admin")

    def test_auto_start_disabled_waits_for_a_manual_control_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = relay(tmp, auto_start=False)
            source.decision = {"chosen": "turbosportslive", "available": True,
                               "reason": "turbo live", "sources": {}}
            self.assertFalse(source.should_start_media())
            self.assertEqual(source.pending_reason(), "waiting for manual start")

    def test_source_loss_stops_media(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = relay(tmp, auto_start=True)
            source.decision = {"chosen": None, "available": False,
                               "reason": "no source", "sources": {}}
            self.assertFalse(source.should_start_media())


if __name__ == "__main__":
    unittest.main()
