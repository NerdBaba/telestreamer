"""HLS playout and private RTMP publisher, with authenticated controls.

Run locally: python -m relay_engine.daemon --config rrr_config.json
Hosted launch: python -m relay_engine.daemon (credentials supplied by environment).
Credentials belong in private configuration or environment, never command arguments.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.request
from urllib.parse import unquote, urlsplit

from relay_engine import fixtures, sources, state as durable_state, tgtv, turbo_events
from relay_engine.publishing import launch_publisher, media_environment
from relay_engine.session_restore import restore_session

WORKER = "https://rwitc-racing.kristopherreed0227-1etlk.workers.dev"


def media_failure_detail(path: Path) -> str:
    """Last line of a failed media process, with any long token redacted.

    FFmpeg's error names the input playlist, which carries the Space path
    secret, so the detail is redacted before it can reach a status document.
    """
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return ""
    lines = [line.strip() for line in text.strip().splitlines() if line.strip()]
    if not lines:
        return ""
    return re.sub(r"[A-Za-z0-9_-]{32,}", "[redacted]", lines[-1])[:300]


def save_private(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(data, stream, indent=2)
        stream.write("\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def load_config(raw_path: str | None) -> tuple[dict, Path]:
    """Load local JSON or hosted environment without writing environment secrets."""
    variables = {
        "ADMIN_TOKEN": "admin_token", "RTMP_URL": "rtmp_url", "RTMP_KEY": "rtmp_key",
        "WORKER_URL": "worker_url", "RELAY_STATE_URL": "state_url",
        "RELAY_MEDIA_MODE": "media_mode", "RELAY_HOST": "host", "PORT": "port",
        "RELAY_INPUT_URL": "input_url", "RELAY_DISCOVER_CHANNELS": "discover_channels",
        "RELAY_DISCOVERY_INTERVAL": "discovery_interval", "RELAY_CHANNEL": "channel",
        "RELAY_OUTPUT_CHAT_ID": "output_chat_id",
    }
    render = os.environ.get("RENDER", "").lower() == "true"
    environment_only = raw_path is None and (
        render or any(name in os.environ for name in (*variables, "RELAY_LOOP_INPUT"))
    )
    if environment_only:
        config, base = {}, Path.cwd()
    else:
        config_path = Path(raw_path or "rrr_config.json").expanduser().resolve()
        if not config_path.exists():
            if render:
                raise ValueError("Render launch requires environment configuration or an existing config")
            save_private(config_path, {"admin_token": secrets.token_urlsafe(32), "worker_url": WORKER})
            print(f"Created private configuration: {config_path}", flush=True)
        config = json.loads(config_path.read_text())
        if not isinstance(config, dict):
            raise ValueError("config must be a JSON object")
        base = config_path.parent
    for name, key in variables.items():
        if name in os.environ:
            config[key] = os.environ[name]
    if "RELAY_DISCOVER_CHANNELS" in os.environ:
        value = os.environ["RELAY_DISCOVER_CHANNELS"].lower()
        if value not in ("true", "false", "1", "0"):
            raise ValueError("RELAY_DISCOVER_CHANNELS must be true or false")
        config["discover_channels"] = value in ("true", "1")
    if "RELAY_DISCOVERY_INTERVAL" in os.environ:
        try:
            config["discovery_interval"] = float(os.environ["RELAY_DISCOVERY_INTERVAL"])
        except ValueError:
            raise ValueError("RELAY_DISCOVERY_INTERVAL must be a number") from None
        if config["discovery_interval"] < 30:
            raise ValueError("RELAY_DISCOVERY_INTERVAL must be at least 30 seconds")
    if "RELAY_OUTPUT_CHAT_ID" in os.environ:
        try:
            config["output_chat_id"] = int(os.environ["RELAY_OUTPUT_CHAT_ID"])
        except ValueError:
            raise ValueError("RELAY_OUTPUT_CHAT_ID must be a positive integer") from None
        if config["output_chat_id"] <= 0:
            raise ValueError("RELAY_OUTPUT_CHAT_ID must be a positive integer")
    if "RELAY_LOOP_INPUT" in os.environ:
        value = os.environ["RELAY_LOOP_INPUT"].lower()
        if value not in ("true", "false", "1", "0"):
            raise ValueError("RELAY_LOOP_INPUT must be true or false")
        config["loop_input"] = value in ("true", "1")
    if render and not os.environ.get("ADMIN_TOKEN"):
        raise ValueError("Render requires a stable ADMIN_TOKEN in the environment")
    if render:
        # The container filesystem is empty; the authorized session must be
        # restored from a private secret before any publishing is attempted.
        config["session"] = str(restore_session(config, base))
        # Render only reads render.yaml when a service is created, so these
        # defaults are baked in rather than relying on variables that an
        # existing service never received.
        config.setdefault("host", "0.0.0.0")
        config.setdefault("media_mode", "copy")
        config.setdefault("discover_channels", True)
        config.setdefault("discovery_interval", 120)
        # Keep the private invite as the publishing destination; the numeric
        # id is only used to exclude that output channel from source discovery.
        config.setdefault("channel", "https://t.me/+-UyRaC_GVSw3NTU1")
        config.setdefault("output_chat_id", 4347395930)
    if not isinstance(config.get("admin_token"), str) or len(config["admin_token"]) < 16:
        raise ValueError("an admin token of at least 16 characters is required")
    config.setdefault("worker_url", WORKER)
    config.setdefault("host", "0.0.0.0" if render else "127.0.0.1")
    config.setdefault("media_mode", "copy" if render else "transcode")
    if render and not config.get("state_url"):
        config["state_url"] = config["worker_url"].rstrip("/") + "/api/relay-state"
    return config, base


class Relay:
    def __init__(self, config: dict, base: Path):
        self.config = config
        self.base = base
        self.token = config["admin_token"]
        self.media_mode = config.get("media_mode", "transcode")
        if self.media_mode not in ("copy", "transcode"):
            raise ValueError("media_mode must be copy or transcode")
        self.state_url = config.get("state_url")
        self.state_loaded = not bool(self.state_url)
        self.output = self.path(config.get("output_dir", ".relay/hls"))
        self.output.mkdir(parents=True, exist_ok=True)
        os.chmod(self.output, 0o700)
        self.state_path = self.path(config.get("state_path", "relay_state.json"))
        if self.state_url:
            # No ephemeral default is permitted to start media before durable state loads.
            saved = {"paused": True, "forced": None, "selected_chat_id": None}
        else:
            try:
                saved = json.loads(self.state_path.read_text())
            except (OSError, ValueError):
                saved = {}
        self.paused = bool(saved.get("paused", False))
        self.forced = saved.get("forced") if saved.get("forced") in ("rwitc", "turbosportslive") else None
        selected = saved.get("selected_chat_id")
        self.selected_chat_id = selected if type(selected) is int and selected > 0 else None
        self.manual_start_chat_id: int | None = None
        self.auto_start = bool(config.get("auto_start", True))
        self.decision = {"chosen": None, "available": False, "reason": "checking sources", "sources": {}}
        self.meetings = fixtures.load_cached_meetings(str(self.path("fixtures_cache.json")))
        self.desired = None
        self.media = None
        self.media_started = None
        self.media_log = self.output.parent / "media.log"
        self.push = None
        self.current = None
        self.publisher = None
        self.destination = None
        self.publishing = "blocked: Telegram session or RTMP destination required"
        self._own_chat_id: int | None = None
        self.broadcasts: list[dict] = []
        self.next_discovery = 0.0
        self.discovery_error: str | None = None
        self.discovered_at = 0.0
        self.last_error = None
        self.next_start = 0.0
        self.next_publish = 0.0
        self.lock = asyncio.Lock()
        self.telegram_lock = asyncio.Lock()
        # Control must answer before a media cycle finishes. reconcile() holds
        # self.lock across slow to_thread work, so control takes this lock
        # instead and never queues behind it. Both are only ever taken in this
        # order, so there is no second deadlock.
        self.control_lock = asyncio.Lock()
        self.stopping = asyncio.Event()
        self.recheck = asyncio.Event()
        self.loop = asyncio.get_running_loop()
        self.tasks = []

    def path(self, raw: str) -> Path:
        value = Path(raw).expanduser()
        return value if value.is_absolute() else self.base / value

    async def initialize_state(self) -> None:
        async with self.lock:
            if not self.state_loaded:
                saved = await asyncio.to_thread(durable_state.load_state, self.state_url, self.token)
                self.paused, self.forced = saved["paused"], saved["forced"]
                self.auto_start = saved.get("auto_start", self.auto_start)
                selected = saved.get("selected_chat_id")
                self.selected_chat_id = selected if type(selected) is int and selected > 0 else None
                self.state_loaded = True

    def ready(self) -> bool:
        playlist = self.output / "index.m3u8"
        media = self.media
        try:
            return (not self.paused and self.decision.get("available")
                    and self.current == self.decision.get("chosen")
                    and media is not None and media.poll() is None
                    and time.time() - playlist.stat().st_mtime < 20
                    and "#EXTINF:" in playlist.read_text())
        except OSError:
            return False

    def snapshot(self) -> dict:
        return {
            "paused": self.paused, "forced": self.forced, "auto_start": self.auto_start,
            "selected_chat_id": self.selected_chat_id,
            "pending_reason": self.pending_reason(),
            "decision": self.decision,
            "playout": {"source": self.current, "ready": self.ready(),
                        "url": "/live/index.m3u8", "pid": self.media.pid if self.media else None},
            "publishing": {"state": self.publishing, "running": self.push is not None and self.push.poll() is None},
            "broadcasts": self.broadcasts,
            "discovery": {
                "enabled": bool(self.config.get("discover_channels")),
                "error": self.discovery_error,
                "last_found": self.discovered_at,
            },
            "last_error": self.last_error,
            "fixtures": [{"date": meeting.iso, "title": meeting.title} for meeting in self.meetings],
        }

    async def monitor(self) -> None:
        while not self.stopping.is_set():
            self.recheck.clear()
            forced = self.forced
            try:
                if self.selected_chat_id is not None and not forced:
                    await self.refresh_discoveries(None)
                    row = next((item for item in self.broadcasts
                                if item["chat_id"] == self.selected_chat_id), None)
                    live = bool(row and row.get("live")
                                and tgtv.is_playback_url(self.config.get("input_url")))
                    self.decision = {
                        "chosen": f"telegram:{self.selected_chat_id}",
                        "available": live,
                        "reason": (f"live in {row['title']}" if live
                                   else "selected member channel is not live or unavailable"),
                        "sources": {},
                        "forced": False,
                        "chat_id": self.selected_chat_id,
                    }
                elif self.config.get("input_url"):
                    # The configured TGTV URL remains the automatic fallback.
                    self.decision = {
                        "chosen": forced or "turbosportslive",
                        "available": bool(self.config.get("loop_input") or self.hf_input_ok()),
                        "reason": "explicit input",
                        "sources": {},
                        "forced": bool(forced),
                    }
                    await self.refresh_discoveries(forced)
                else:
                    live = await asyncio.to_thread(turbo_events.live_state)
                    decision = await asyncio.to_thread(sources.resolve, live, forced)
                    if forced == self.forced:
                        self.decision = decision
                    await self.refresh_discoveries(forced)
            except Exception as exc:
                self.decision = {"chosen": None, "available": False,
                                 "reason": f"source check failed: {type(exc).__name__}", "sources": {}}
            if forced != self.forced:
                continue
            try:
                await asyncio.wait_for(self.recheck.wait(), float(self.config.get("poll_interval", 30)))
            except asyncio.TimeoutError:
                pass

    async def refresh_discoveries(self, forced: str | None) -> None:
        """Refresh member channels slowly and TGTV liveness every poll cycle."""
        if forced or not self.config.get("discover_channels"):
            return
        input_url = self.config.get("input_url")
        refresh_membership = time.monotonic() >= self.next_discovery
        if refresh_membership:
            self.next_discovery = time.monotonic() + float(
                self.config.get("discovery_interval", 120))
            session = self.session_path()
            if session is None or not os.path.isfile(session):
                self.discovery_error = "no restored Telegram session to discover from"
                return
            try:
                rows, own = await self._with_telegram(self._discover_broadcasts)
            except Exception as exc:
                self.discovery_error = f"Telegram discovery failed ({type(exc).__name__})"
                return
            self.discovered_at = time.time()
            if own is None:
                self.broadcasts = []
                self.discovery_error = "output channel not resolved; no sources published"
                return
            self.broadcasts = []
            for row in rows:
                if row["chat_id"] == own:
                    continue
                item = dict(row)
                item["stream_id"] = tgtv.stream_id(item["chat_id"])
                item.pop("preview_url", None)
                self.broadcasts.append(item)
        if not input_url:
            for item in self.broadcasts:
                item["live"] = False
                item.pop("preview_url", None)
            self.discovery_error = "TGTV live playlist is not configured"
            return
        try:
            active_ids = await asyncio.to_thread(tgtv.fetch_live_stream_ids, input_url)
        except Exception as exc:
            active_ids = set()
            self.discovery_error = f"TGTV live playlist unavailable ({type(exc).__name__})"
        else:
            self.discovery_error = None

        for item in self.broadcasts:
            stream_id = item.get("stream_id") or tgtv.stream_id(item["chat_id"])
            item["stream_id"] = stream_id
            item["live"] = stream_id in active_ids
            if item["live"]:
                item["scheduled"] = False
                item["preview_url"] = tgtv.preview_url_for_id(input_url, stream_id)
            else:
                item.pop("preview_url", None)

    def session_path(self) -> str | None:
        target = str(self.path(str(self.config.get("session", "rrr_live"))))
        return target if target.endswith(".session") else target + ".session"

    async def _discover_broadcasts(self, client) -> tuple[list[dict], int | None]:
        from relay_engine import broadcasts

        rows = await broadcasts.discover_broadcasts(client)
        own = await self._own_channel_id(client)
        return rows, own

    async def _own_channel_id(self, client) -> int | None:
        """Resolve the output ID once; it must never appear as a source."""
        if self._own_chat_id is not None:
            return self._own_chat_id
        configured = self.config.get("output_chat_id")
        if type(configured) is int and configured > 0:
            self._own_chat_id = configured
            return configured
        if isinstance(configured, str) and configured.isdecimal() and int(configured) > 0:
            self._own_chat_id = int(configured)
            return self._own_chat_id
        if self.publisher and self.publisher._entity is not None:
            self._own_chat_id = self.publisher._entity.id
            return self._own_chat_id
        target = self.config.get("channel")
        if not target:
            return None
        from relay_engine import telegram

        try:
            if isinstance(target, str) and target.lstrip("-").isdigit():
                entity = await client.get_entity(int(target))
            else:
                entity, _ = await telegram.resolve_channel(client, target)
        except Exception:
            return None
        self._own_chat_id = entity.id
        return self._own_chat_id

    async def _with_telegram(self, operation):
        """Serialize access to the authorized SQLite session and reuse publisher."""
        from telethon import TelegramClient

        async with self.telegram_lock:
            publisher = self.publisher
            if (publisher and publisher.client is not None
                    and publisher.client.is_connected()):
                return await operation(publisher.client)
            if publisher and publisher.client is not None:
                with contextlib.suppress(Exception):
                    await publisher.close()
            session = self.session_path()
            if session is None:
                raise RuntimeError("Telegram session unavailable")
            client = TelegramClient(
                session,
                int(self.config.get("tg_api_id") or os.environ.get("TG_API_ID", "0")),
                str(self.config.get("tg_api_hash") or os.environ.get("TG_API_HASH", "")))
            await client.connect()
            try:
                return await operation(client)
            finally:
                await client.disconnect()

    async def calendar(self) -> None:
        if self.config.get("input_url"):
            return
        while not self.stopping.is_set():
            meetings = await asyncio.to_thread(fixtures.fetch_meetings)
            self.meetings = meetings
            await asyncio.to_thread(fixtures.cache_meetings, meetings, str(self.path("fixtures_cache.json")))
            await asyncio.sleep(86400)

    @staticmethod
    async def terminate(process) -> None:
        if process is None:
            return
        if process.poll() is None:
            process.terminate()
            try:
                await asyncio.wait_for(asyncio.to_thread(process.wait), 5)
            except asyncio.TimeoutError:
                process.kill()
                await asyncio.to_thread(process.wait)

    async def stop_media(self) -> None:
        await self.terminate(self.push)
        self.push = None
        await self.terminate(self.media)
        self.media = None
        self.current = None
        self.media_started = None
        if self.destination:
            self.publishing = "idle"
        # Never expose the previous feed while switching or paused.
        for file in self.output.iterdir():
            if file.suffix in (".m3u8", ".ts", ".tmp"):
                file.unlink(missing_ok=True)

    def telegram_credentials(self) -> tuple[str, str] | None:
        """API id/hash from config or environment; absent means no publishing."""
        api_id = self.config.get("tg_api_id") or os.environ.get("TG_API_ID")
        api_hash = self.config.get("tg_api_hash") or os.environ.get("TG_API_HASH")
        return (api_id, api_hash) if api_id and api_hash else None

    async def resolve_destination(self) -> None:
        if self.destination or time.monotonic() < self.next_publish:
            return
        self.next_publish = time.monotonic() + 30
        rtmp = self.config.get("rtmp_url")
        key = self.config.get("rtmp_key")
        if rtmp:
            destination = rtmp.rstrip("/") + "/" + key if key else rtmp
            if urlsplit(destination).scheme not in ("rtmp", "rtmps"):
                self.publishing = "blocked: destination must use RTMP or RTMPS"
                return
            self.destination = destination
            self.next_publish = 0
            self.publishing = "ready"
            return
        credentials = self.telegram_credentials()
        if credentials is None:
            return
        api_id, api_hash = credentials
        try:
            from relay_engine.telegram import TelegramPublisher
            async with self.telegram_lock:
                self.publisher = TelegramPublisher(
                    api_id=int(api_id), api_hash=api_hash,
                    session=str(self.path(self.config.get("session", "rrr_live"))),
                    channel=self.config.get("channel", "https://t.me/+-UyRaC_GVSw3NTU1"),
                )
                try:
                    await self.publisher.connect()
                    self.destination = await self.publisher.destination()
                except Exception:
                    with contextlib.suppress(Exception):
                        await self.publisher.close()
                    self.publisher = None
                    raise
            self.next_publish = 0
            self.publishing = "ready"
        except Exception as exc:
            self.publishing = f"blocked: {type(exc).__name__}"
            seconds = getattr(exc, "seconds", None)
            if type(exc).__name__ == "FloodWaitError" and type(seconds) is int and seconds > 0:
                self.next_publish = time.monotonic() + seconds
                self.last_error = f"destination retry delayed by Telegram flood wait ({seconds} seconds)"
            elif type(exc).__name__ == "TelegramAccessError":
                self.last_error = f"destination blocked: {exc}"
            else:
                self.last_error = f"destination resolution failed: {type(exc).__name__}"
            if self.publisher:
                with contextlib.suppress(Exception):
                    await self.publisher.close()
                self.publisher = None

    def hf_input_ok(self) -> bool:
        """Whether the pinned input URL is currently serving a live playlist.

        The pinned input replaces source arbitration with one fixed feed, but
        the relay must not start media against a dead input. A HEAD against the
        playlist is enough: a 200 means the feed is reachable. Failures are
        reported, never silently treated as available.
        """
        url = self.config.get("input_url")
        if not url:
            return False
        try:
            request = urllib.request.Request(url, method="GET", headers={
                "User-Agent": "Mozilla/5.0 (compatible; rrr-relay/1.0)"})
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status == 200
        except Exception:
            return False


    def source_input_url(self) -> str:
        chat_id = self.decision.get("chat_id")
        if (chat_id is not None and chat_id == self.selected_chat_id
                and self.decision.get("chosen") == f"telegram:{chat_id}"):
            return tgtv.stream_url(self.config["input_url"], chat_id)
        return (self.config.get("input_url")
                or self.config.get("worker_url", WORKER).rstrip("/") + "/api/live")

    def should_start_media(self) -> bool:
        """Whether the current source and admin state permit starting playout.

        A live source opens the restream on its own, which is the whole point
        of the relay: nobody has to be watching the dashboard at 2 pm. An
        explicit pause or stop is still an override that outranks the source,
        and `auto_start` off means the operator wants to press start.
        """
        if self.paused:
            return False
        if (not self.auto_start and (self.selected_chat_id is None
                                    or self.manual_start_chat_id != self.selected_chat_id)):
            return False
        return bool(self.decision.get("chosen")) and bool(self.decision.get("available"))

    def pending_reason(self) -> str | None:
        """Why the relay is not streaming, for the dashboard and status API."""
        if self.media:
            return None
        if self.paused:
            return "paused by admin"
        if (not self.auto_start and (self.selected_chat_id is None
                                    or self.manual_start_chat_id != self.selected_chat_id)):
            return "waiting for manual start"
        if self.decision.get("forced"):
            return None
        if not self.decision.get("chosen"):
            return self.decision.get("reason") or "no source available"
        return None

    async def reconcile(self) -> None:
        async with self.lock:
            selected = self.decision.get("chosen") if self.decision.get("available") and not self.paused else None
            if self.desired != selected:
                self.desired = selected
                await self.stop_media()
                self.next_start = 0
            # Destination credentials are prepared before a live source so output
            # is ready at start, but pause is a hard override of all Telegram calls.
            if not self.paused:
                await self.resolve_destination()
            if not selected:
                return
            if self.media and self.media.poll() is not None:
                detail = media_failure_detail(self.media_log)
                self.last_error = (
                    f"media process exited ({self.media.returncode}); restarting"
                    + (f": {detail}" if detail else "")
                )
                await self.stop_media()
                self.next_start = time.monotonic() + 3
            elif self.media:
                try:
                    stalled = time.time() - (self.output / "index.m3u8").stat().st_mtime >= 20
                except FileNotFoundError:
                    stalled = self.media_started is not None and time.monotonic() - self.media_started >= 20
                if stalled:
                    self.last_error = "media output stalled; restarting"
                    await self.stop_media()
                    self.next_start = time.monotonic() + 3
            if not self.media and self.should_start_media() and time.monotonic() >= self.next_start:
                input_url = self.source_input_url()
                command = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error"]
                if self.config.get("loop_input"):
                    command += ["-stream_loop", "-1", "-re"]
                command += ["-i", input_url, "-map", "0:v:0", "-map", "0:a:0?"]
                if self.media_mode == "copy":
                    command += ["-c:v", "copy", "-c:a", "copy"]
                else:
                    command += [
                        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                        "-r", "25", "-g", "50", "-sc_threshold", "0", "-c:a", "aac", "-b:a", "128k",
                    ]
                command += ["-f", "hls", "-hls_time", "2", "-hls_list_size", "6",
                            "-hls_flags", "delete_segments+independent_segments+program_date_time+temp_file",
                            "-hls_start_number_source", "epoch_us", "-hls_segment_filename",
                            str(self.output / "%020d.ts"), str(self.output / "index.m3u8")]
                with open(self.media_log, "wb") as media_errors:
                    self.media = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                                  stdout=subprocess.DEVNULL, stderr=media_errors,
                                                  env=media_environment())
                self.media_started = time.monotonic()
                self.current = selected
                self.last_error = None
            if not self.ready():
                return
            if self.push and self.push.poll() is not None:
                self.last_error = f"publishing process exited ({self.push.returncode}); reconnecting"
                await self.terminate(self.push)
                self.push = None
                self.next_publish = time.monotonic() + 3
            if self.destination and not self.push and time.monotonic() >= self.next_publish:
                try:
                    self.push = await asyncio.to_thread(
                        launch_publisher, self.output / "index.m3u8", self.destination,
                        self.output.parent / "runtime",
                    )
                except (OSError, RuntimeError, ValueError) as exc:
                    self.last_error = f"publisher launch failed: {type(exc).__name__}"
                    self.publishing = "publisher launch failed; check RTMP prerequisites"
                    self.next_publish = time.monotonic() + 3
                    return
                self.publishing = "connecting"
                if self.publisher:
                    try:
                        await self.publisher.announce("Live relay output is connecting. Open the channel live stream to check playback.")
                    except Exception as exc:
                        self.last_error = f"channel announcement failed: {type(exc).__name__}"
            elif self.push and self.push.poll() is None:
                self.publishing = "publishing process running"

    async def control(self, body: dict) -> dict:
        action = body.get("action")
        if action not in ("pause", "resume", "stop", "force", "auto", "auto_start",
                          "select_channel", "release_call"):
            raise ValueError("action must be pause, resume, stop, force, auto, "
                             "auto_start, select_channel, or release_call")
        if action == "force" and body.get("source") not in ("rwitc", "turbosportslive"):
            raise ValueError("source must be rwitc or turbosportslive")
        if action == "auto_start" and not isinstance(body.get("enabled"), bool):
            raise ValueError("auto_start requires a boolean enabled field")
        chat_id = None
        if action == "select_channel":
            chat_id = body.get("chat_id")
            if (type(chat_id) is not int or chat_id <= 0
                    or chat_id > 9007199254740991):
                raise ValueError("select_channel requires a positive safe integer chat_id")
            row = next((item for item in self.broadcasts if item["chat_id"] == chat_id), None)
            if row is None or not row.get("live"):
                raise ValueError("channel is not currently live")
            output_id = self.config.get("output_chat_id")
            if isinstance(output_id, str) and output_id.isdecimal():
                output_id = int(output_id)
            if chat_id == output_id or chat_id == self._own_chat_id:
                raise ValueError("the output channel cannot be selected as a source")
            input_url = self.config.get("input_url")
            if not tgtv.is_playback_url(input_url):
                raise ValueError("TGTV playback input is not configured")
            stream_id = tgtv.stream_id(chat_id)
            if row.get("stream_id") != stream_id:
                raise ValueError("channel stream identity is invalid")
            try:
                active_ids = await asyncio.to_thread(tgtv.fetch_live_stream_ids, input_url)
            except Exception:
                raise ValueError("TGTV live sources are unavailable; refresh and retry") from None
            if stream_id not in active_ids:
                raise ValueError("channel is no longer live; refresh and retry")

        if action == "release_call":
            credentials = self.telegram_credentials()
            if credentials is None:
                raise ValueError("Telegram API credentials are required to release an output call")
            api_id, api_hash = credentials
            from relay_engine.telegram import TelegramPublisher
            async with self.control_lock, self.telegram_lock:
                publisher = TelegramPublisher(
                    api_id=int(api_id), api_hash=api_hash,
                    session=str(self.path(self.config.get("session", "rrr_live"))),
                    channel=self.config.get("channel", "https://t.me/+-UyRaC_GVSw3NTU1"),
                )
                try:
                    await publisher.connect()
                    released = await publisher.release_ended_call()
                finally:
                    with contextlib.suppress(Exception):
                        await publisher.close()
                # The discarded call invalidates any cached destination.
                self.destination = None
                self.publishing = "idle"
                self.next_publish = 0
                self.last_error = released
                self.recheck.set()
            return self.snapshot()

        async with self.control_lock:
            updated = {
                "paused": self.paused,
                "forced": self.forced,
                "auto_start": self.auto_start,
                "selected_chat_id": self.selected_chat_id,
            }
            if action in ("pause", "stop", "resume"):
                updated["paused"] = action != "resume"
            elif action in ("force", "auto"):
                updated["forced"] = body["source"] if action == "force" else None
                updated["selected_chat_id"] = None
            elif action == "auto_start":
                updated["auto_start"] = body["enabled"]
            elif action == "select_channel":
                updated["paused"] = False
                updated["forced"] = None
                updated["selected_chat_id"] = chat_id
            if self.state_url:
                await asyncio.to_thread(durable_state.save_state, self.state_url, self.token, updated)
            else:
                await asyncio.to_thread(save_private, self.state_path, updated)

            self.paused = updated["paused"]
            self.forced = updated["forced"]
            self.auto_start = updated["auto_start"]
            self.selected_chat_id = updated["selected_chat_id"]
            if action == "select_channel":
                row = next(item for item in self.broadcasts if item["chat_id"] == chat_id)
                self.manual_start_chat_id = chat_id if not self.auto_start else None
                self.decision = {
                    "chosen": f"telegram:{chat_id}",
                    "available": True,
                    "reason": f"live in {row['title']}",
                    "sources": {},
                    "forced": False,
                    "chat_id": chat_id,
                }
            elif action in ("force", "auto"):
                self.manual_start_chat_id = None
                reason = "checking forced source" if action == "force" else "checking automatic source"
                self.decision = dict(self.decision, chosen=None, available=False, reason=reason)
                self.decision.pop("chat_id", None)
            elif action == "stop":
                self.manual_start_chat_id = None
            elif action == "auto_start" and not self.auto_start:
                self.manual_start_chat_id = None

            if action in ("pause", "stop"):
                await self.stop_media()
            elif action == "resume":
                self.recheck.set()
            if action in ("force", "auto", "select_channel", "auto_start"):
                self.recheck.set()
            if action == "stop" and self.publisher:
                async with self.telegram_lock:
                    await self.publisher.close(stop_call=True)
                    self.publisher = None
                self.destination = None
                self.next_publish = 0
            return self.snapshot()

    async def run(self) -> None:
        await self.initialize_state()
        self.tasks = [asyncio.create_task(self.monitor()), asyncio.create_task(self.calendar())]
        try:
            while not self.stopping.is_set():
                await self.reconcile()
                await asyncio.sleep(0.5)
        finally:
            for task in self.tasks:
                task.cancel()
            await asyncio.gather(*self.tasks, return_exceptions=True)
            await self.stop_media()
            if self.publisher:
                await self.publisher.close()


def handler(relay: Relay):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def respond(self, code: int, payload, content_type="application/json"):
            if isinstance(payload, dict):
                payload = json.dumps(payload).encode()
            if isinstance(payload, str):
                payload = payload.encode()
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                self.wfile.write(payload)

        def authorized(self):
            supplied = self.headers.get("Authorization", "")
            return hmac.compare_digest(supplied, "Bearer " + relay.token)

        def do_GET(self):
            path = unquote(urlsplit(self.path).path)
            if path == "/":
                page = Path(__file__).with_name("dashboard.html").read_bytes()
                return self.respond(200, page, "text/html; charset=utf-8")
            if path == "/healthz":
                # Report only presence, never values: a health endpoint is
                # unauthenticated, so a secret value here would leak it.
                return self.respond(200, {
                    "ok": True,
                    "config": {
                        "discover_channels": bool(relay.config.get("discover_channels")),
                        "discovery_interval": relay.config.get("discovery_interval"),
                        "channel_set": bool(relay.config.get("channel")),
                        "input_url_set": bool(relay.config.get("input_url")),
                        "session_set": bool(relay.config.get("session")),
                        "render": os.environ.get("RENDER", "").lower() == "true",
                    },
                })
            if path in ("/api/status", "/api/stream-status", "/api/fixtures"):
                if not self.authorized():
                    return self.respond(401, {"error": "admin token required"})
                status = relay.snapshot()
                if path == "/api/fixtures":
                    status = {"meetings": status["fixtures"]}
                return self.respond(200, status)
            if path in ("/live", "/live/"):
                path = "/live/index.m3u8"
            if path.startswith("/live/"):
                name = path.removeprefix("/live/")
                if "/" in name or "\\" in name or name in (".", ".."):
                    return self.respond(404, {"error": "not found"})
                if not relay.ready():
                    return self.respond(503, {"error": "no live playout"})
                file = relay.output / name
                if file.suffix not in (".m3u8", ".ts") or not file.is_file():
                    return self.respond(404, {"error": "not found"})
                try:
                    payload = file.read_bytes()
                except FileNotFoundError:
                    return self.respond(404, {"error": "segment expired"})
                content_type = "application/vnd.apple.mpegurl" if file.suffix == ".m3u8" else "video/mp2t"
                return self.respond(200, payload, content_type)
            return self.respond(404, {"error": "not found"})

        def do_POST(self):
            if urlsplit(self.path).path != "/api/control":
                return self.respond(404, {"error": "not found"})
            if not self.authorized():
                return self.respond(401, {"error": "admin token required"})
            origin = self.headers.get("Origin")
            if origin and urlsplit(origin).netloc != self.headers.get("Host"):
                return self.respond(403, {"error": "cross-origin controls refused"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 4096:
                    raise ValueError("invalid request size")
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError("request must be a JSON object")
                future = asyncio.run_coroutine_threadsafe(relay.control(body), relay.loop)
                result = future.result(timeout=60)
                self.respond(200, result)
            except (ValueError, json.JSONDecodeError) as exc:
                self.respond(400, {"error": str(exc)})
            except Exception as exc:
                self.respond(500, {"error": type(exc).__name__})
    return Handler


async def main(args) -> None:
    config, base = load_config(args.config)
    relay = Relay(config, base)
    await relay.initialize_state()
    host = config.get("host", "127.0.0.1")
    port = int(config.get("port", 8800))
    server = ThreadingHTTPServer((host, port), handler(relay))
    server.daemon_threads = True
    import threading
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    for sig in (signal.SIGINT, signal.SIGTERM):
        relay.loop.add_signal_handler(sig, relay.stopping.set)
    print(f"Relay dashboard ready: http://{host}:{server.server_port}/", flush=True)
    try:
        await relay.run()
    finally:
        await asyncio.to_thread(server.shutdown)
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", help="private JSON config (local default: rrr_config.json)")
    try:
        asyncio.run(main(parser.parse_args()))
    except Exception as exc:
        # Remote and destination errors may contain credential-bearing URLs.
        print(f"Relay startup failed: {type(exc).__name__}", file=sys.stderr, flush=True)
        raise SystemExit(1) from None
