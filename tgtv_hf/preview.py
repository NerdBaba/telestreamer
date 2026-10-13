"""Optional CUDA video thumbnails; no relay lifecycle or credentials here."""
import io
import logging
import subprocess

import numpy as np
from PIL import Image
import spaces
import torch
import torch.nn.functional as functional

LOG = logging.getLogger(__name__)


def capture_video_frame(url):
    """Decode one frame on CPU before requesting scarce GPU time."""
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-threads", "1",
         "-i", url, "-frames:v", "1", "-threads", "1", "-f", "image2pipe",
         "-c:v", "png", "pipe:1"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=25, check=True,
    )
    with Image.open(io.BytesIO(result.stdout)) as image:
        return np.array(image.convert("RGB"))


def resize_frame(frame, device):
    height, width = frame.shape[:2]
    scale = min(640 / width, 360 / height, 1)
    size = (max(1, round(height * scale)), max(1, round(width * scale)))
    with torch.inference_mode():
        pixels = torch.from_numpy(frame).permute(2, 0, 1).unsqueeze(0).to(device=device, dtype=torch.float32)
        pixels = functional.interpolate(pixels, size=size, mode="bilinear", align_corners=False, antialias=True)
        pixels = pixels.round().clamp_(0, 255).to(torch.uint8).squeeze(0).permute(1, 2, 0).cpu().numpy()
    return Image.fromarray(pixels)


@spaces.GPU(duration=10)
def gpu_preview(frame):
    """Produce the displayed video thumbnail using real CUDA interpolation."""
    return resize_frame(frame, "cuda")


def create_preview(frame):
    try:
        return gpu_preview(frame), "GPU video preview. Live streaming remains on CPU."
    except Exception as error:
        # Allocation/quota failures happen outside the decorated function body.
        # Do not log decorator messages, which can contain request metadata.
        LOG.warning("GPU preview unavailable (%s); rendering on CPU", type(error).__name__)
        return resize_frame(frame, "cpu"), "CPU video preview (GPU unavailable or quota exhausted). Live streaming is unaffected."
