#!/usr/bin/env python3
"""Fetch the current RWITC live HLS stream, no account or subscription required.

Chain the official player itself uses, all of it unauthenticated:

  1. GET api.rwitc.com/login/stream
        -> meeting records (newest may have no published player).
  2. GET <player page>                      (e.g. /player/punelive_code.html)
        -> HTML containing the signed-cookie Lambda URL and the m3u8 path.
  3. GET the Lambda with "Origin: https://api.rwitc.com"
        -> CloudFront key pair + encoded policy + signature. This is the only
           auth check, and it is an Origin header, not a credential.
  4. GET cfs.rwitc.com/.../index.m3u8 with the three signed cookies
        -> master playlist -> media playlist -> .ts segments. Real live HLS.

Availability is established from recent media timestamps and readable segments.

Usage:
    python3 rwitc_live.py                       # print master + media playlist
    python3 rwitc_live.py --play                # play in ffmpeg (live, stdout)
    python3 rwitc_live.py --record 60 out.mp4   # record 60 s to file
    python3 rwitc_live.py --url                 # print the signed master URL
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urljoin

API = "https://api.rwitc.com"
STREAM_RECORD = f"{API}/login/stream"
ORIGIN = API  # the Lambda trusts this Origin header only


STALE_AFTER_SECONDS = 300
IST = timezone(timedelta(hours=5, minutes=30))


def parse_stream_records(payload) -> list[dict]:
    """Normalize the public API response without treating malformed rows as records."""
    rows = payload.get("data") if isinstance(payload, dict) else None
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def latest_record(rows: list[dict], *, published: bool = False,
                  today: bool = False) -> dict | None:
    """Choose meeting metadata or an active nonempty player independently.

    A player's record date is not a media-liveness signal: the same player can
    continue serving a new broadcast after a newer empty meeting is published.
    """
    candidates = rows
    if today:
        day = datetime.now(IST).date().isoformat()
        candidates = [row for row in candidates
                      if str(row.get("race_date") or "")[:10] == day]
    if published:
        candidates = [row for row in candidates
                      if row.get("status") == "active"
                      and isinstance(row.get("stream_url"), str)
                      and row["stream_url"].strip()]
    return max(enumerate(candidates),
               key=lambda item: (str(item[1].get("race_date") or "")[:10], item[0]),
               default=(0, None))[1]

# --------------------------------------------------------------------------
# Step 1-2: separate meeting metadata from the latest published player
# --------------------------------------------------------------------------

@dataclass
class Stream:
    race_date: str
    venue: str
    status: str
    paid: str
    iframe: str
    player_page: str

    @classmethod
    def fetch(cls) -> "Stream | None":
        with urllib.request.urlopen(
            urllib.request.Request(STREAM_RECORD,
                                   headers={"Accept": "application/json"}),
            timeout=20,
        ) as r:
            rows = parse_stream_records(json.loads(r.read()))
        rec = latest_record(rows, today=True)
        return cls.from_record(rec) if rec else None

    @classmethod
    def from_record(cls, rec: dict) -> "Stream":
        return cls(
            race_date=str(rec.get("race_date") or "")[:10],
            venue=rec.get("venue_name") or "",
            status=rec.get("status") or "",
            paid=rec.get("paid_status") or "",
            iframe=rec.get("iframe_flag") or "",
            player_page=urljoin(API + "/", (rec.get("stream_url") or "").strip()),
        )


# --------------------------------------------------------------------------
# Step 3: CloudFront signed cookies from the player's Lambda
# --------------------------------------------------------------------------

@dataclass
class Signing:
    key_pair_id: str
    policy: str
    signature: str

    @classmethod
    def fetch(cls, lambda_url: str) -> "Signing":
        req = urllib.request.Request(lambda_url)
        req.add_header("Origin", ORIGIN)
        with urllib.request.urlopen(req, timeout=20) as r:
            d = json.loads(r.read())
        if d.get("status") != "success":
            raise RuntimeError(f"signing failed: {d}")
        return cls(d["keyPairId"], d["encodedPolicy"], d["encodedSignature"])

    @property
    def cookie(self) -> str:
        return (f"CloudFront-Key-Pair-Id={self.key_pair_id}; "
                f"CloudFront-Policy={self.policy}; "
                f"CloudFront-Signature={self.signature}")

    def cookie_file(self, path: str) -> str:
        """Write a Netscape-format cookie file for mpv/IINA.

        Query-string signing (Key-Pair-Id/Policy/Signature params) is lost when
        a player resolves the playlist's RELATIVE segment URLs, so segments
        403. Cookies survive that resolution; players send them for every
        request in the same domain.
        """
        lines = ["# Netscape HTTP Cookie File",
                 "# RWITC live stream - CloudFront signed cookies"]
        for name, val in (("CloudFront-Key-Pair-Id", self.key_pair_id),
                          ("CloudFront-Policy", self.policy),
                          ("CloudFront-Signature", self.signature)):
            lines.append(f"cfs.rwitc.com\tFALSE\t/\tFALSE\t0\t{name}\t{val}")
        with open(path, "w") as f:
            f.write("\n".join(lines) + "\n")
        return path

    def get(self, url: str) -> str:
        req = urllib.request.Request(url)
        req.add_header("Cookie", self.cookie)
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode()


# --------------------------------------------------------------------------
# Step 4: playlist resolution
# --------------------------------------------------------------------------

LAMBDA_RE = re.compile(r"""fetch\(\s*['"](https://[^'"]*lambda-url[^'"]*)['"]""")
M3U8_RE = re.compile(r"""['"]([^'"]*index\.m3u8(?:\?[^'"]*)?)['"]""")


def player_references(html: str, player_url: str) -> tuple[str, str]:
    """Resolve the signing endpoint and current master URL from the player."""
    lam = LAMBDA_RE.search(html)
    master = M3U8_RE.search(html)
    if not (lam and master):
        raise ValueError("player page missing lambda/m3u8 references")
    return lam.group(1), urljoin(player_url, master.group(1))


def playlist_urls(playlist: str, base_url: str) -> list[str]:
    """Resolve HLS URI lines, including root/absolute URLs and escaped spaces."""
    return [quote(urljoin(base_url, line.strip()), safe=":/?&=%+#@!$'()*+,;~")
            for line in playlist.splitlines()
            if line.strip() and not line.strip().startswith("#")]


def media_lag(media: str, now: datetime | None = None) -> float | None:
    """Newest segment timestamp lag; malformed, future, and ended media reject."""
    if (not media.lstrip().startswith("#EXTM3U")
            or "#EXT-X-ENDLIST" in media or "#EXTINF:" not in media
            or not any(line.strip() and not line.strip().startswith("#")
                       for line in media.splitlines())):
        return None
    stamps = re.findall(r"#EXT-X-PROGRAM-DATE-TIME:\s*(\S+)", media)
    if not stamps:
        return None
    try:
        newest = datetime.fromisoformat(stamps[-1].replace("Z", "+00:00"))
        if newest.tzinfo is None:
            return None
        lag = ((now or datetime.now(timezone.utc)) - newest).total_seconds()
    except (TypeError, ValueError, OverflowError):
        return None
    return lag if math.isfinite(lag) and lag >= 0 else None


@dataclass
class LiveStream:
    signing: Signing
    master_url: str

    @classmethod
    def fetch(cls) -> "LiveStream":
        with urllib.request.urlopen(STREAM_RECORD, timeout=20) as response:
            rows = parse_stream_records(json.loads(response.read()))
        record = latest_record(rows, published=True)
        if record is None:
            raise RuntimeError("no active published player")
        player = Stream.from_record(record).player_page
        with urllib.request.urlopen(player, timeout=20) as response:
            html = response.read().decode("utf-8", "replace")
        lambda_url, master_url = player_references(html, player)
        stream = cls(signing=Signing.fetch(lambda_url), master_url=master_url)
        media_url = stream.variants()[0][1]
        media = stream.signing.get(media_url)
        lag = media_lag(media)
        if lag is None or lag > STALE_AFTER_SECONDS:
            raise RuntimeError("published player is not serving recent live media")
        segment = playlist_urls(media, media_url)[-1]
        request = urllib.request.Request(segment, headers={"Cookie": stream.signing.cookie})
        with urllib.request.urlopen(request, timeout=20) as response:
            if not response.read(1):
                raise RuntimeError("live media segment is empty")
        return stream

    @property
    def master(self) -> str:
        return self.signing.get(self.master_url)

    def variants(self) -> list[tuple[str, str]]:
        """[(description, media playlist url)] from the master playlist."""
        master = self.master
        if not master.lstrip().startswith("#EXTM3U"):
            raise ValueError("upstream did not return an HLS playlist")
        if "#EXTINF:" in master:
            return [("media", self.master_url)]
        out = []
        description = "?"
        for line in master.splitlines():
            line = line.strip()
            if line.startswith("#EXT-X-STREAM-INF"):
                match = re.search(r"RESOLUTION=([^,\s]+)", line)
                description = match.group(1) if match else "?"
            elif line and not line.startswith("#"):
                out.append((description, playlist_urls(line, self.master_url)[0]))
        return out

    def media(self, variant: int = 0) -> str:
        return self.signing.get(self.variants()[variant][1])

    def lag_seconds(self, variant: int = 0) -> float | None:
        return media_lag(self.media(variant))

    def signed_url(self, variant: int = 0) -> str:
        """Master URL usable by any player via query params instead of cookies."""
        v = self.variants()[variant][1]
        s = self.signing
        return (f"{v}?Key-Pair-Id={s.key_pair_id}"
                f"&Policy={s.policy}&Signature={s.signature}")

    # -- output actions ----------------------------------------------------

    def launch_iina(self, cookie_path: str | None = None,
                    variant: int = 0) -> int:
        """Open the live stream in IINA (or mpv) with working auth.

        Uses cookies, not query params: HLS players resolve relative segment
        URLs against the playlist URL and drop the query string, which signs
        only the playlist and leaves every .ts at 403.
        """
        ck = cookie_path or "/tmp/rwitc_cookies.txt"
        self.signing.cookie_file(ck)
        iina_cli = ("/Applications/IINA.app/Contents/MacOS/iina-cli")
        import shutil
        exe = iina_cli if os.path.exists(iina_cli) else shutil.which("iina-cli")
        if exe:
            return subprocess.run(
                [exe, "--keep-running", "--no-stdin",
                 f"--mpv-cookies-file={ck}", self.master_url],
                start_new_session=True,
            ).returncode
        fallback = shutil.which("mpv")
        if fallback:
            return subprocess.run(
                [fallback, f"--cookies-file={ck}", self.master_url],
                start_new_session=True,
            ).returncode
        print("neither IINA nor mpv found; playing via ffmpeg", file=sys.stderr)
        return self.play(variant)

    def play(self, variant: int = 0, duration: int | None = None) -> int:
        cmd = ["ffmpeg", "-loglevel", "warning",
               "-headers", f"Cookie: {self.signing.cookie}",
               "-i", self.master_url]
        if duration:
            cmd += ["-t", str(duration)]
        cmd += ["-f", "matroska", "-"]  # stream to a player that reads stdin
        return subprocess.run(cmd).returncode

    def record(self, path: str, duration: int, variant: int = 0) -> int:
        cmd = ["ffmpeg", "-y", "-loglevel", "warning",
               "-headers", f"Cookie: {self.signing.cookie}",
               "-i", self.master_url,
               "-t", str(duration), "-c", "copy", path]
        return subprocess.run(cmd).returncode


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--play", action="store_true", help="stream live to stdout")
    ap.add_argument("--record", nargs=2, metavar=("SECONDS", "OUTPUT"),
                    help="record N seconds to a file")
    ap.add_argument("--url", action="store_true",
                    help="print signed master URL")
    ap.add_argument("--iina", action="store_true",
                    help="open the live stream in IINA (cookies, not query params)")
    ap.add_argument("--cookies", default="/tmp/rwitc_cookies.txt",
                    help="cookie file path for --iina")
    ap.add_argument("--variant", type=int, default=0)
    args = ap.parse_args()

    ls = LiveStream.fetch()

    st = Stream.fetch()
    if st:
        print(f"venue={st.venue} date={st.race_date} status={st.status}", file=sys.stderr)
    else:
        print("no meeting record for today; using verified published player", file=sys.stderr)

    print(f"master: {ls.master_url}", file=sys.stderr)
    for desc, url in ls.variants():
        print(f"variant {desc}: {url}", file=sys.stderr)
    lag = ls.lag_seconds(args.variant)
    if lag is not None:
        print(f"live lag: {lag:.0f}s", file=sys.stderr)

    if args.url:
        print(ls.signed_url(args.variant))
    elif args.iina:
        rc = ls.launch_iina(args.cookies, args.variant)
        print(f"launched IINA (rc={rc}); stream={ls.master_url}",
              file=sys.stderr)
    elif args.record:
        secs, out = int(args.record[0]), args.record[1]
        rc = ls.record(out, secs, args.variant)
        print(f"recorded {secs}s -> {out} (rc={rc})", file=sys.stderr)
    elif args.play:
        return ls.play(args.variant)
    else:
        print(ls.master)
        print(ls.media(args.variant))
    return 0


if __name__ == "__main__":
    sys.exit(main())
