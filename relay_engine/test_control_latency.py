"""Admin control must not wait behind a busy reconcile loop."""
from __future__ import annotations

import asyncio
import contextlib
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from relay_engine import daemon  # noqa: E402


class RelayLoopTests(unittest.TestCase):
    """Drive a real relay loop in a thread, as the running service does."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.loop = asyncio.new_event_loop()
        self.ready = threading.Event()
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        self.assertTrue(self.ready.wait(5), "relay loop did not start")

    def tearDown(self):
        self.loop.call_soon_threadsafe(self.stopped.set)
        self.thread.join(timeout=10)
        # The loop closes itself on its own thread once stopped.

    def _run(self):
        asyncio.set_event_loop(self.loop)

        async def serve():
            self.ready.set()
            # Stay alive and pumping callbacks until stopped, so tests can
            # schedule work on this loop from other threads.
            while not self.stopped.is_set():
                await asyncio.sleep(0.02)

        self.loop.run_until_complete(serve())
        self.loop.run_until_complete(self.loop.shutdown_asyncgens())
        self.loop.close()

    def relay(self):
        async def build():
            return daemon.Relay({"admin_token": "t" * 32,
                                 "state_path": str(Path(self.tmp.name) / "state.json")},
                                Path(self.tmp.name))
        return asyncio.run_coroutine_threadsafe(build(), self.loop).result(10)

    def schedule(self, coroutine, timeout=10):
        return asyncio.run_coroutine_threadsafe(coroutine, self.loop).result(timeout)

    def test_control_completes_while_reconcile_holds_the_lock(self):
        # reconcile() takes self.lock across its whole body, including slow
        # to_thread work. control() must not queue behind it, or an admin
        # pause during a busy cycle never lands.
        relay = self.relay()
        entered = threading.Event()
        release = asyncio.Event()
        self.loop.call_soon_threadsafe(release.clear)

        async def slow_reconcile():
            async with relay.lock:
                entered.set()
                await release.wait()

        holder = asyncio.run_coroutine_threadsafe(slow_reconcile(), relay.loop)
        self.assertTrue(entered.wait(5), "reconcile did not take the lock")
        started = time.monotonic()
        control = asyncio.run_coroutine_threadsafe(relay.control({"action": "pause"}), relay.loop)
        try:
            control.result(timeout=5)
        except TimeoutError:
            self.loop.call_soon_threadsafe(release.set)
            with contextlib.suppress(Exception):
                holder.result(timeout=5)
            self.fail("control() blocked behind reconcile(); admin pause never landed")
        self.loop.call_soon_threadsafe(release.set)
        with contextlib.suppress(Exception):
            holder.result(timeout=5)
        self.assertTrue(relay.paused)
        self.assertLess(time.monotonic() - started, 5, "control waited behind a media cycle")

    def test_pause_applies_while_media_is_idle(self):
        relay = self.relay()
        result = self.schedule(relay.control({"action": "pause"}))
        self.assertTrue(result["paused"])
        self.assertTrue(relay.paused)


if __name__ == "__main__":
    unittest.main()
