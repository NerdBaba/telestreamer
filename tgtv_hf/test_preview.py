"""Preview processing must remain useful when GPU allocation is denied."""
import os
import unittest
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient
from gradio.routes import App

from tgtv_hf import app as hf_app
from tgtv_hf import preview

os.environ.setdefault("PATH_SECRET", "test-playback-token")


class WatchRouteTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(App())
        self.client.app.get("/p/{token}/watch")(hf_app.watch)
        self.client.app.get("/p/{token}/watch/{stream_id}")(hf_app.watch_selected)

    def test_dynamic_watch_uses_requested_stream_for_hls(self):
        response = self.client.get("/p/test-playback-token/watch/abcdef012345")

        self.assertEqual(response.status_code, 200)
        self.assertIn(
            "http://127.0.0.1:7860/p/test-playback-token/streams/abcdef012345/play.m3u8",
            response.text,
        )
        self.assertIn("hls.js", response.text)

    def test_dynamic_watch_rejects_malformed_stream_id(self):
        for stream_id in ("ABCDEF012345", "abcdef01234", "abcdef01234g", "abcdef0123456"):
            with self.subTest(stream_id=stream_id):
                response = self.client.get(f"/p/test-playback-token/watch/{stream_id}")
                self.assertEqual(response.status_code, 404)

    def test_legacy_watch_route_remains_available(self):
        response = self.client.get("/p/test-playback-token/watch")

        self.assertEqual(response.status_code, 200)
        self.assertIn("2631340b81ae", response.text)


class PreviewTests(unittest.TestCase):
    def test_gpu_quota_exhaustion_returns_resized_cpu_preview(self):
        frame = np.empty((720, 1280, 3), dtype=np.uint8)
        frame[:, :640] = [240, 30, 20]
        frame[:, 640:] = [10, 40, 230]
        # The external GPU allocator is unavailable; actual CPU image processing runs.
        with patch.object(preview, "gpu_preview", side_effect=RuntimeError("GPU quota exceeded")):
            image, status = preview.create_preview(frame)
        self.assertEqual(image.size, (640, 360))
        self.assertEqual(image.getpixel((64, 64)), (240, 30, 20))
        self.assertEqual(image.getpixel((576, 64)), (10, 40, 230))
        self.assertIn("CPU", status)





if __name__ == "__main__":
    unittest.main()
