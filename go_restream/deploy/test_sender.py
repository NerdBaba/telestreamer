"""Real FFmpeg/RTMP regression checks. Set RTMP_SENDER_TEST_BIN to the compiled sender."""
import os
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


class SenderTimingTest(unittest.TestCase):
    def publish(self, jump):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = ["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                    "testsrc2=size=160x90:rate=10:duration=4"]
            if jump:
                args += ["-vf", "setpts=PTS+60/TB*gte(T\\,2)"]
            args += ["-fps_mode", "passthrough", "-c:v", "libx264", "-preset", "ultrafast",
                     "-g", "10", "-bf", "0", "-an", "-f", "hls", "-hls_time", "1",
                     "-hls_list_size", "0", str(root / "index.m3u8")]
            subprocess.run(args, check=True, capture_output=True)
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            url = f"rtmp://127.0.0.1:{port}/live/test"
            receiver = subprocess.Popen(["ffmpeg", "-v", "error", "-listen", "1", "-i", url,
                                         "-c", "copy", "-y", str(root / "received.mkv")],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            sender = None
            try:
                time.sleep(.3)
                sender = subprocess.Popen([os.environ["RTMP_SENDER_TEST_BIN"], str(root / "index.m3u8")],
                                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    _, error = sender.communicate(url.encode(), timeout=8)
                except subprocess.TimeoutExpired:
                    self.fail("sender waited more than 8 seconds for a 60-second timestamp jump")
                if jump:
                    self.assertNotEqual(sender.returncode, 0)
                    self.assertIn(b"timestamp discontinuity or publishing lag", error)
                else:
                    self.assertEqual(sender.returncode, 0, error.decode())
                    receiver.wait(timeout=5)
                    probe = subprocess.run(["ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0",
                                            "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0",
                                            str(root / "received.mkv")], capture_output=True, check=True)
                    self.assertGreaterEqual(int(probe.stdout.strip()), 30)
            finally:
                for process in (sender, receiver):
                    if process is not None:
                        if process.poll() is None:
                            process.kill()
                        process.communicate()

    def test_normal_video_is_published(self):
        self.publish(False)

    def test_timestamp_jump_cannot_stall_publishing_for_a_minute(self):
        self.publish(True)


if __name__ == "__main__":
    unittest.main()
