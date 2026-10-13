"""Exercise real local RTMP media and process-argument secrecy, without accounts."""
from __future__ import annotations

import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest

from relay_engine.publishing import launch_publisher


@unittest.skipUnless(all(shutil.which(x) for x in ("ffmpeg", "ffprobe", "cc", "pkg-config", "ps")),
                     "FFmpeg, compiler, pkg-config and ps required")
class PublishingTests(unittest.TestCase):
    def test_private_destination_and_decodable_av(self):
        self.receive(with_audio=True)

    def test_video_only_source_still_publishes(self):
        self.receive(with_audio=False)

    def receive(self, with_audio):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            playlist = root / "index.m3u8"
            inputs = ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25"]
            if with_audio:
                inputs += ["-f", "lavfi", "-i", "sine=sample_rate=48000"]
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", *inputs,
                "-t", "8", "-c:v", "libx264", "-preset", "ultrafast", "-g", "25",
                "-c:a", "aac", "-f", "hls", "-hls_time", "1", "-hls_list_size", "0",
                str(playlist),
            ], check=True, timeout=30)
            with socket.socket() as port_picker:
                port_picker.bind(("127.0.0.1", 0))
                port = port_picker.getsockname()[1]
            key = "private-local-key-6fd380c5"
            destination = f"rtmp://127.0.0.1:{port}/live/{key}"
            capture = root / "received.flv"
            receiver = subprocess.Popen([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-listen", "1",
                "-i", destination, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
                "-f", "flv", str(capture),
            ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            sender = None
            try:
                # Do not probe the listener with TCP: that consumes its single RTMP accept.
                time.sleep(0.5)
                self.assertIsNone(receiver.poll(), "local RTMP receiver failed to start")
                sender = launch_publisher(playlist, destination, root / "runtime")
                time.sleep(0.5)
                self.assertIsNone(sender.poll(), "sender exited before media transmission")
                argv = subprocess.check_output(["ps", "-p", str(sender.pid), "-o", "command="], text=True)
                self.assertNotIn(key, argv)
                self.assertNotIn(destination, argv)
                self.assertEqual(sender.wait(timeout=25), 0)
                _, errors = receiver.communicate(timeout=15)
                # FFmpeg's listening RTMP protocol can return I/O error on publisher disconnect.
                self.assertTrue(capture.exists(), errors.decode(errors="replace"))
                probe = json.loads(subprocess.check_output([
                    "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(capture),
                ], timeout=10))
                self.assertEqual({s["codec_name"] for s in probe["streams"]},
                                 {"h264", "aac"} if with_audio else {"h264"})
                self.assertGreater(float(probe["format"]["duration"]), 6)
                decoded = subprocess.run([
                    "ffmpeg", "-v", "error", "-xerror", "-i", str(capture),
                    "-map", "0:v:0", "-map", "0:a:0?", "-f", "null", "-",
                ], capture_output=True, timeout=15)
                self.assertEqual(decoded.returncode, 0, decoded.stderr.decode(errors="replace"))
            finally:
                for process in (sender, receiver):
                    if process is not None:
                        if process.poll() is None:
                            process.terminate()
                        try:
                            process.communicate(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.communicate()


if __name__ == "__main__":
    unittest.main()
