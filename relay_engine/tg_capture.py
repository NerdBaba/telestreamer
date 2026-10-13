"""Telegram group-call capture: join a channel's live call and serve it as HLS.

Telegram delivers RTMP broadcasts as ~1-second media parts over MTProto, not
as HLS. Each part is a BroadcastPart envelope: a 0xA12E810D signature, a
TL-string container name, an active mask, and stream events (offset +
endpoint + rotation + extra). The playable media starts at the first event's
offset into the trailing bytes. Joining the call supplies presence; parts are
pulled with upload.getFile using an InputGroupCallStream location, then
remuxed with stream copy onto one gapless MPEG-TS timeline.

This is the documented /api/group-calls chunk path. It requires an authorized
Telegram session that is a member of the channel. Nothing here fabricates
media: without a joined live call there is no stream and the caller is told so.
"""
from __future__ import annotations

import re
import struct
import subprocess

SIGNATURE = 0xA12E810D
PART_TIMEOUT_SECONDS = 8.0


# ---------------------------------------------------------------------------
# BroadcastPart framing
# ---------------------------------------------------------------------------

def _read_tl_string(data: bytes, offset: int) -> tuple[str, int]:
    """Read one TL-serialized string; returns (value, next offset)."""
    if offset >= len(data):
        raise ValueError("part ends inside a string header")
    first = data[offset]
    if first == 254:
        if offset + 4 > len(data):
            raise ValueError("part ends inside a long string header")
        length = data[offset + 1] | (data[offset + 2] << 8) | (data[offset + 3] << 16)
        start = offset + 4
    else:
        length = first
        start = offset + 1
    if length < 0 or start + length > len(data):
        raise ValueError("part string runs past the end of the part")
    value = data[start:start + length].decode("utf-8", "replace")
    padding = (4 - length % 4) % 4 if first == 254 else (4 - (length + 1) % 4) % 4
    return value, start + length + padding


def parse_part(data: bytes) -> tuple[str, bytes]:
    """Split a BroadcastPart into (container, media payload).

    Raises on an empty part, a bad signature, or a truncated header so the
    caller skips the part instead of publishing broken media.
    """
    if len(data) < 16:
        raise ValueError("group-call part is too short to contain media")
    signature = struct.unpack("<I", data[0:4])[0]
    if signature != SIGNATURE:
        raise ValueError(f"bad group-call part signature {signature:#x}")
    container, offset = _read_tl_string(data, 4)
    if offset + 8 > len(data):
        raise ValueError("group-call part ends inside its header")
    event_count = struct.unpack("<i", data[offset + 4:offset + 8])[0]
    offset += 8
    if event_count <= 0 or event_count > 64:
        raise ValueError("group-call part has no usable stream events")
    first_offset = None
    for _ in range(event_count):
        event_offset = struct.unpack("<i", data[offset:offset + 4])[0]
        if first_offset is None:
            first_offset = event_offset
        _, offset = _read_tl_string(data, offset + 4)
        offset += 8
    media = data[offset:]
    if first_offset is not None and 0 <= first_offset < len(media):
        media = media[first_offset:]
    if not media:
        raise ValueError("group-call part carries no media payload")
    return container or "mpegts", media


def chunk_payload(raw: bytes) -> bytes:
    """Return the playable media inside one upload.getFile reply part."""
    _, media = parse_part(raw)
    return media


def container_suffix(container: str) -> str:
    """File suffix ffmpeg needs to sniff an input container."""
    normalized = (container or "").strip().lower() or "mpegts"
    return {
        "mpegts": ".ts", "mp4": ".mp4", "mov": ".mov", "ogg": ".ogg",
        "webm": ".webm", "matroska": ".mkv", "h264": ".h264", "hevc": ".hevc",
        "3gp": ".3gp",
    }.get(normalized, ".bin")


def ffmpeg_input_args(container: str, path: str) -> list[str]:
    """Demux hints for containers ffmpeg cannot sniff from a pipe or suffix."""
    normalized = (container or "").strip().lower()
    if normalized in ("h264", "hevc", "mpegts"):
        return ["-f", normalized, "-i", path]
    return ["-i", path]


# ---------------------------------------------------------------------------
# Part remux to MPEG-TS segments
# ---------------------------------------------------------------------------

def remux_part(container: str, payload: bytes, video_payload: bytes | None,
               audio_container: str, offset: float) -> tuple[bytes, float]:
    """Copy one part's encoded packets into a one-second MPEG-TS segment.

    `video_payload` is None for unified (single) parts; otherwise it is the
    video half of an A/V pair with `payload` as the audio half. `offset`
    seconds shifts output timestamps so segments form one timeline.
    Raises on remux failure so the caller skips the part instead of
    publishing a broken segment.
    """
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory(prefix="tgpart-") as scratch:
        root = Path(scratch)
        primary = root / ("video" + container_suffix(container))
        primary.write_bytes(video_payload if video_payload is not None else payload)
        command = ["ffmpeg", "-hide_banner", "-loglevel", "error",
                   "-fflags", "+genpts+discardcorrupt"]
        command += ffmpeg_input_args(container, str(primary))
        if video_payload is not None:
            audio = root / ("audio" + container_suffix(audio_container))
            audio.write_bytes(payload)
            command += ffmpeg_input_args(audio_container, str(audio))
            command += ["-map", "0:v:0?", "-map", "1:a:0?"]
        else:
            command += ["-map", "0:v:0?", "-map", "0:a:0?"]
        command += ["-c:v", "copy", "-c:a", "copy", "-t", "1.0"]
        if offset > 0:
            command += ["-output_ts_offset", f"{offset:f}"]
        command += ["-mpegts_flags", "+resend_headers+initial_discontinuity",
                    "-f", "mpegts", "pipe:1"]
        try:
            result = subprocess.run(command, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, check=True,
                                    timeout=PART_TIMEOUT_SECONDS)
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            detail = getattr(exc, "stderr", b"").decode("utf-8", "replace")[:200]
            raise RuntimeError(f"part remux failed: {detail}") from None
        if not result.stdout:
            raise RuntimeError("part remux produced no output")
        return result.stdout, 1.0


def remux_chunk(mp4: bytes, offset: float) -> tuple[bytes, float]:
    """Compatibility wrapper: remux a bare payload as a unified part."""
    return remux_part("mpegts", mp4, None, "", offset)


def chunk_duration(payload: bytes) -> float:
    """Timeline advance for one part, in seconds."""
    return 1.0


def render_playlist(sequence: int, target_duration: int, segments: list[dict],
                    discontinuity: bool) -> str:
    """Build a live HLS media playlist for already-written segments.

    `segments` are ordered oldest to newest, each {name, duration,
    markers}.
    """
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        f"#EXT-X-TARGETDURATION:{max(1, target_duration)}",
        f"#EXT-X-MEDIA-SEQUENCE:{sequence}",
    ]
    if discontinuity:
        lines.append("#EXT-X-DISCONTINUITY")
    for segment in segments:
        markers = segment.get("markers") or {}
        if markers.get("discontinuity"):
            lines.append("#EXT-X-DISCONTINUITY")
        lines.append(f"#EXTINF:{segment['duration']:.3f},")
        lines.append(segment["name"])
    return "\n".join(lines) + "\n"


SEGMENT_NAME = re.compile(r"[A-Za-z0-9._-]{1,64}")


def safe_segment_name(name: str) -> str:
    """Reject anything that could escape the playout directory."""
    if not isinstance(name, str):
        raise ValueError("invalid segment name")
    # fullmatch: $ also matches before a trailing newline, which would let
    # "s1.ts\n" through and break playlist parsing downstream.
    if SEGMENT_NAME.fullmatch(name) is None or name in (".", ".."):
        raise ValueError("invalid segment name")
    return name


# ---------------------------------------------------------------------------
# Fetch planning
# ---------------------------------------------------------------------------

def plan_requests(last_timestamp_ms: int, scale: int, buffer_ms: int,
                  count: int) -> list[int]:
    """Timestamps to request, oldest first, aligned to the chunk grid.

    Aligning to the provider's own segment size is required: an unaligned
    time_ms returns TIME_TOO_SMALL or TIME_TOO_BIG rather than a chunk.
    """
    segment_ms = 1000 >> scale
    if segment_ms <= 0:
        raise ValueError("stream channel scale is not usable")
    start = (last_timestamp_ms // segment_ms) * segment_ms - buffer_ms
    if start < 0:
        start = 0
    return [start + index * segment_ms for index in range(max(1, count))]
