"""Coverage for the Telegram chunk to HLS remux path.

Telegram chunks are real MPEG-4 parts with H.264 in AVCC form and a slightly
longer audio track, so tests use actual encoded media rather than bytes shaped
like a transcript expectation.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from relay_engine import tg_capture


@unittest.skipUnless(__import__("shutil").which("ffmpeg"), "FFmpeg required")
class ChunkRemuxTests(unittest.TestCase):
    def make_chunk(self, directory: Path, seconds: float, *, audio: bool = True) -> bytes:
        source = directory / "source.mp4"
        command = ["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                   "testsrc2=size=320x180:rate=25"]
        if audio:
            command += ["-f", "lavfi", "-i", "sine=sample_rate=48000"]
        command += ["-t", f"{seconds}", "-c:v", "libx264", "-preset",
                   "ultrafast", "-g", "25"]
        if audio:
            command += ["-c:a", "aac"]
        command += ["-movflags", "+faststart", "-f", "mp4", str(source)]
        subprocess.run(command, check=True, timeout=30)
        # Telegram wraps the chunk payload with a 32-byte header.
        return os.urandom(32) + source.read_bytes()

    def test_header_strip_and_planned_timestamps(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            raw = self.make_chunk(root, 1.0)
            mp4 = tg_capture.chunk_payload(raw)
            self.assertTrue(mp4.startswith(b"\x00\x00\x00"))
            with self.assertRaises(ValueError):
                tg_capture.chunk_payload(b"short")
            # A 4x scale means 62.5ms chunks; requests align to that grid.
            self.assertEqual(tg_capture.plan_requests(10_000, 4, 2000, 3),
                             [10_000 // 62 * 62 - 2000, 10_000 // 62 * 62 - 2000 + 62,
                              10_000 // 62 * 62 - 2000 + 124])
            with self.assertRaises(ValueError):
                tg_capture.plan_requests(1000, -1, 0, 1)

    def test_chunks_form_one_continuous_playable_timeline(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            first = tg_capture.chunk_payload(self.make_chunk(root, 1.0))
            second = tg_capture.chunk_payload(self.make_chunk(root, 1.0))
            first_segment, first_duration = tg_capture.remux_chunk(first, 0.0)
            self.assertGreater(first_duration, 0.9)
            second_segment, _ = tg_capture.remux_chunk(second, first_duration)
            playlist = tg_capture.render_playlist(0, 2, [
                {"name": "s0.ts", "duration": first_duration, "markers": {}},
                {"name": "s1.ts", "duration": first_duration, "markers": {}},
            ], discontinuity=True)
            self.assertIn("#EXT-X-DISCONTINUITY", playlist)
            self.assertIn(f"#EXTINF:{first_duration:.3f},", playlist)
            (root / "s0.ts").write_bytes(first_segment)
            (root / "s1.ts").write_bytes(second_segment)
            combined = root / "combined.ts"
            combined.write_bytes(first_segment + second_segment)
            probe = json.loads(subprocess.check_output([
                "ffprobe", "-v", "error", "-show_streams", "-show_format",
                "-of", "json", str(combined),
            ], timeout=15))
            self.assertEqual({s["codec_name"] for s in probe["streams"]},
                             {"h264", "aac"})
            decoded = subprocess.run([
                "ffmpeg", "-v", "error", "-xerror", "-i", str(combined),
                "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-",
            ], capture_output=True, timeout=15)
            self.assertEqual(decoded.returncode, 0, decoded.stderr.decode())
            self.assertGreater(float(probe["format"]["duration"]), 1.5)

    def test_video_only_chunk_still_remuxes(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            raw = self.make_chunk(root, 1.0, audio=False)
            segment, duration = tg_capture.remux_chunk(tg_capture.chunk_payload(raw), 0.0)
            self.assertEqual(duration, 1.0, "no audio track falls back to one second")
            (root / "s0.ts").write_bytes(segment)
            probe = json.loads(subprocess.check_output([
                "ffprobe", "-v", "error", "-show_streams", "-of", "json",
                str(root / "s0.ts"),
            ], timeout=15))
            self.assertEqual({s["codec_name"] for s in probe["streams"]}, {"h264"})

    def test_unusable_input_raises_instead_of_publishing_a_segment(self):
        with self.assertRaises(Exception):
            tg_capture.remux_chunk(b"\x00\x00\x00\x18ftypmp42" + os.urandom(64), 0.0)

    def test_segment_names_cannot_escape_the_playout_directory(self):
        self.assertEqual(tg_capture.safe_segment_name("s12.ts"), "s12.ts")
        for bad in ("../etc/passwd", "a/b", "", "s 1.ts", "s1.ts\n"):
            with self.assertRaises(ValueError):
                tg_capture.safe_segment_name(bad)


if __name__ == "__main__":
    unittest.main()
