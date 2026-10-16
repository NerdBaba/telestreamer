# Stream desk stress test — 2026-10-16

Branch: `codex/go-auto-restream`. Production backend: `de5403a`.
Production Worker: `cb92be2b-dc0e-48b1-a68e-79c9ee4fced1`.

The user confirmed that FREE's own Telegram video is blank. This source cannot
currently establish successful capture playback. The pasted logs show repeated
stream-DC-5 metadata backoff; the `gaps` startup message means user-state recovery
is fetching from Telegram and does not, by itself, establish a startup failure.
These tests use generated media and read-only hosted requests instead.

## Local media and dashboard stress

Used production `Controller`, `Dashboard`, `ProcessMedia` in stream-copy mode,
and the existing native C RTMP sender. Source: a looping generated H.264/AAC
1920×1080, 30 fps clip. FFprobe measured 5.180 Mbps video, 69.3 kbps audio,
5.259 Mbps including MP4 overhead. A separate FFmpeg RTMP receiver actually
decoded the outgoing video and audio.

Local platform: macOS arm64, FFmpeg 8.1.2. `GOMAXPROCS=1`,
`GOMEMLIMIT=256MiB`; no CPU quota. Approximately 75 seconds of measured load,
25 seconds per stage, plus startup and shutdown. Each client waits 50 ms
between requests. Mixed traffic: 60% status, 20% output playlist, 10% input
preview playlist, 10% output playlist plus latest media segment. These are
synthetic HTTP load clients, not Telegram viewers or browser decoders.

| Concurrent clients | Requests | Failures | Requests/s | p95 latency | Relay CPU, one core | Peak relay RSS |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 449 | 0 | 17.69 | 3.07 ms | 4.45% | 75.75 MiB |
| 8 | 3,638 | 0 | 143.81 | 3.61 ms | 7.43% | 71.03 MiB |
| 32 | 14,594 | 0 | 580.36 | 4.90 ms | 14.36% | 68.84 MiB |

18,681 requests completed without failures. The controller stayed `live` in all
stages. The receiver decoded 2,398 video frames without reported decode errors.
The final pause completed and the harness exited successfully; all fixture,
relay and receiver processes were stopped.

CPU is interval CPU time divided by wall time (100% = one core). RSS is sampled
every 0.5 seconds. Measurements include the Go harness, its outgoing FFmpeg
copy process, and native RTMP sender. They **exclude** the source generator,
source HTTP server, RTMP decoder, load generator, Telegram capture and MediaMTX.
RSS can shrink across stages because the Go runtime and OS reclaim pages.
These are short-run samples, not long-term leak or endurance results.

## Hosted API bursts

Targets were the existing Render `/health` and authenticated `/api/status`,
and the Workers `/api/stream-status` adapter. Each stage submitted requests
for ten seconds at concurrency 1, 5, 10, then 20, with an overall cap of
20 requests/s shared across all targets. Timing includes draining in-flight
requests and WAN/TLS overhead from the local machine. Every response body was
checked for the expected JSON shape; no control or media-start request was sent.

Initial run: 542 requests, one Worker connection failure (`URLError`), no received HTTP error
response. The original harness recorded only the exception type, so the exact
transport failure cause is unknown. The service's controls remained unchanged.
Do not erase this failure because a repeat passed.

Added exception-reason logging and stricter scheduling to prevent queued
requests from catching up in bursts, then repeated all four stages:

| Concurrency | Requests | Failures | Requests/s | Render status p95 | Worker status p95 |
|---:|---:|---:|---:|---:|---:|
| 1 | 29 | 0 | 2.90 | 336.82 ms | 733.48 ms |
| 5 | 148 | 0 | 14.35 | 277.81 ms | 713.31 ms |
| 10 | 200 | 0 | 19.46 | 277.11 ms | 588.09 ms |
| 20 | 200 | 0 | 19.22 | 268.50 ms | 682.47 ms |

Repeat: 577/577 passed. Across both runs: 1,119 requests, one connection failure.
Render remained responsive and controls remained unchanged, paused with
Turbo → RWITC → Mysore configured. These read-only tests did not retry capture,
create or discard a Telegram output call, or reuse a session locally.

## What the results support

The copy relay and admin HTTP paths handled this short synthetic workload.
They do not prove sustained operation under Render's 0.15-CPU/512-MB limits:
the local CPU architecture and FFmpeg version differ, and Telegram capture,
MediaMTX and any required transcoding are excluded from local resource figures.
Render's actual CPU/RAM usage was not observable from its free-plan metrics UI.
Telegram viewer capacity is also untested; viewers receive Telegram's output
and do not each create a request to this relay.

## Repeat the tests

Requires installed Go, FFmpeg/FFprobe, a C compiler, pkg-config, and FFmpeg
development libraries. Both scripts use only Python's standard library.

```sh
python3 go_restream/deploy/stress_backend.py --out /tmp/streamdesk-stress --seconds 25
python3 go_restream/deploy/stress_hosted.py --secrets-file worker/.dev.vars.release.json --out /tmp/hosted-stress.json
```

The Go harness is behind the `stress` build tag and never starts a Telegram
client. Its generated token is local and temporary. The hosted script reads
the existing token locally, sends it only to the configured Render service,
and does not log it. Raw, credential-free results are in
`docs/stress-results/2026-10-16/`.
