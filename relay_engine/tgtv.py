"""Stable TGTV stream routing and active-playlist discovery."""
from __future__ import annotations

import hashlib
import re
from urllib.parse import urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

_STREAM_ID = re.compile(r"[0-9a-f]{12}\Z")
_PLAYLIST_STREAM = re.compile(r"^/p/[^/]+/streams/([0-9a-f]{12})/play\.m3u8\Z")
_MAX_PLAYLIST_BYTES = 64 * 1024


def stream_id(chat_id: int) -> str:
    """Match upstream tgtv's MakeStreamID(chatID) stable identifier."""
    if type(chat_id) is not int or chat_id <= 0:
        raise ValueError("chat_id must be a positive integer")
    return hashlib.sha256(str(chat_id).encode("ascii")).hexdigest()[:12]


def _prefix(input_url: str) -> str:
    parsed = urlsplit(input_url)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise ValueError("invalid TGTV playback URL")
    match = re.fullmatch(r"(/p/([^/]+)/)streams/[0-9a-f]{12}/play\.m3u8", parsed.path)
    if not match or match.group(2) in (".", ".."):
        raise ValueError("invalid TGTV playback URL")
    return urlunsplit((parsed.scheme, parsed.netloc, match.group(1).rstrip("/"), "", ""))


def is_playback_url(input_url: str | None) -> bool:
    if not isinstance(input_url, str):
        return False
    try:
        _prefix(input_url)
        return True
    except ValueError:
        return False


def playlist_url(input_url: str) -> str:
    return _prefix(input_url) + "/playlist.m3u"


def stream_url(input_url: str, chat_id: int) -> str:
    return stream_url_for_id(input_url, stream_id(chat_id))


def stream_url_for_id(input_url: str, selected_stream_id: str) -> str:
    if not isinstance(selected_stream_id, str) or not _STREAM_ID.fullmatch(selected_stream_id):
        raise ValueError("invalid TGTV stream id")
    return _prefix(input_url) + f"/streams/{selected_stream_id}/play.m3u8"


def preview_url(input_url: str, chat_id: int) -> str:
    return preview_url_for_id(input_url, stream_id(chat_id))


def preview_url_for_id(input_url: str, selected_stream_id: str) -> str:
    if not isinstance(selected_stream_id, str) or not _STREAM_ID.fullmatch(selected_stream_id):
        raise ValueError("invalid TGTV stream id")
    return _prefix(input_url) + f"/watch/{selected_stream_id}"


def parse_live_stream_ids(playlist: str) -> set[str]:
    """Extract stream IDs from TGTV's M3U URI lines, ignoring metadata text."""
    if not isinstance(playlist, str) or not playlist.lstrip("\ufeff").startswith("#EXTM3U"):
        raise ValueError("invalid TGTV playlist")
    found: set[str] = set()
    for line in playlist.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = _PLAYLIST_STREAM.fullmatch(urlsplit(line).path)
        if match:
            found.add(match.group(1))
    return found


class _SameOriginRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        source, target = urlsplit(req.full_url), urlsplit(newurl)
        if (source.scheme, source.hostname, source.port) != (target.scheme, target.hostname, target.port):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_live_stream_ids(input_url: str) -> set[str]:
    """Fetch the private TGTV availability playlist without exposing URL errors."""
    request = Request(playlist_url(input_url), headers={
        "Accept": "application/vnd.apple.mpegurl, audio/mpegurl, text/plain",
        "User-Agent": "Mozilla/5.0 (compatible; rrr-relay/1.0)",
    })
    try:
        with build_opener(_SameOriginRedirect()).open(request, timeout=10) as response:
            payload = response.read(_MAX_PLAYLIST_BYTES + 1)
        if len(payload) > _MAX_PLAYLIST_BYTES:
            raise ValueError("oversized TGTV playlist")
        return parse_live_stream_ids(payload.decode("utf-8"))
    except Exception:
        # The URL includes a private playback token; never propagate its value.
        raise RuntimeError("TGTV live playlist unavailable or invalid") from None
