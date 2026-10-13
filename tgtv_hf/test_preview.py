"""Preview processing must remain useful when GPU allocation is denied."""
import unittest
from unittest.mock import patch

import numpy as np

from tgtv_hf import preview


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
