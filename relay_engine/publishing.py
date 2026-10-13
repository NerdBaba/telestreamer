"""Launch the native remuxer without exposing the publishing URL in process arguments."""
from __future__ import annotations

import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile


_SOURCE = Path(__file__).with_name("rtmp_sender.c")


def media_environment() -> dict[str, str]:
    """Child media/compiler processes do not need hosting or account credentials."""
    private = {
        "ADMIN_TOKEN", "RTMP_URL", "RTMP_KEY", "TG_API_ID", "TG_API_HASH",
        "TELEGRAM_API_ID", "TELEGRAM_API_HASH", "SESSION_ENCRYPTION_KEY",
        "RELAY_TOKEN", "RENDER_API_KEY", "RENDER_API_TOKEN", "GITHUB_TOKEN", "GH_TOKEN",
    }
    return {name: value for name, value in os.environ.items() if name not in private}


def _sender_binary(runtime: Path) -> Path:
    runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(runtime, 0o700)
    binary = runtime / "rtmp_sender"
    if binary.exists() and binary.stat().st_mtime_ns >= _SOURCE.stat().st_mtime_ns:
        return binary
    temporary = None
    try:
        flags = subprocess.run(
            ["pkg-config", "--cflags", "--libs", "libavformat", "libavcodec", "libavutil"],
            check=True, capture_output=True, text=True, env=media_environment(),
        ).stdout
        descriptor, name = tempfile.mkstemp(prefix=".rtmp_sender-", dir=runtime)
        os.close(descriptor)
        temporary = Path(name)
        compiler = ["xcrun", "--sdk", "macosx", "cc"] if sys.platform == "darwin" else ["cc"]
        subprocess.run(
            [*compiler, "-std=c11", "-O2", "-Wall", "-Wextra", str(_SOURCE), "-o", str(temporary),
             *shlex.split(flags)], check=True, capture_output=True, text=True, env=media_environment(),
        )
        temporary.chmod(0o700)
        temporary.replace(binary)
    except (OSError, subprocess.CalledProcessError) as error:
        detail = error.stderr if isinstance(error, subprocess.CalledProcessError) else str(error)
        raise RuntimeError(
            "Cannot build native RTMP sender; install cc, pkg-config and FFmpeg development "
            "libraries (libavformat, libavcodec, libavutil). " + (detail or "")
        ) from error
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return binary


def launch_publisher(playlist: Path, destination: str, runtime: Path) -> subprocess.Popen:
    """The destination travels only over the child's private stdin pipe."""
    if not destination.startswith(("rtmp://", "rtmps://")) or any(c in destination for c in "\r\n\x00"):
        raise ValueError("Publishing destination must be a single RTMP(S) URL")
    secret = bytearray(destination, "utf-8")
    if len(secret) >= 8191:
        secret[:] = b"\x00" * len(secret)
        raise ValueError("Publishing destination is too long")
    process = None
    try:
        binary = _sender_binary(Path(runtime))
        process = subprocess.Popen(
            [str(binary.resolve()), str(Path(playlist).resolve())],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            env=media_environment(),
        )
        assert process.stdin is not None
        process.stdin.write(secret)
        process.stdin.close()
        # communicate() must not attempt to flush the already closed private pipe.
        process.stdin = None
        return process
    except BaseException:
        if process is not None:
            if process.stdin is not None:
                process.stdin.close()
                process.stdin = None
            process.kill()
            process.wait()
        raise
    finally:
        secret[:] = b"\x00" * len(secret)
