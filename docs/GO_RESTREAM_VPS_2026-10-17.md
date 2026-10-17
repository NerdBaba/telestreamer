# VPS migration and playback investigation — 17 October 2026

The combined Go backend now runs on the existing HostDZire Mumbai VPS. The
Cloudflare Workers frontend stays at https://rwitc-racing.curos282.workers.dev/.
Render service `telestreamer` is suspended. Its session was disconnected before
activating the VPS; no second Telegram login was opened locally.

## Findings and fixes

1. **Blank Telegram capture:** MediaMTX includes a reader `session` query in its
   child playlists and segments. Our HLS rewriting removed all query strings,
   and the capture proxy also omitted the incoming query when contacting
   MediaMTX. The master returned HTTP 200 while child requests failed with 401
   and became empty placeholder playlists. Original media-server links returned
   eight segments and downloadable Telegram video. Both query losses are fixed;
   regression tests failed before the fix and pass afterward.
2. **Unnecessary capture encoding:** Unified MP4 H.264 Telegram fragments used
   the padding/overlay path, invoking libx264 for every second of video. Unified
   fragments now use video copy; separate native audio/video retains its existing
   path. A real FFmpeg regression compares all 25 decoded frame hashes for a
   one-second input; the original path changed them, the corrected path preserves
   every frame. Unified video no longer gets the old thumbnail overlay.
3. **Unbounded sender wait:** A large timestamp jump could leave the native
   sender sleeping for minutes while the process appeared healthy. It now exits
   when pacing drift exceeds five seconds in either direction, allowing the
   controller to recover. A real local RTMP receiver test verifies ordinary video
   delivery and rejects a synthetic 60-second jump within eight seconds.

Stream copy does not decode/re-encode the video, as described in the
[FFmpeg documentation](https://www.ffmpeg.org/ffmpeg.html#Streamcopy). Telegram
publishing uses the [official RTMP group-call flow](https://core.telegram.org/api/group-calls).

These are proven defects, but they do not prove the cause of every Android
viewer's delay. The user reports mainly Android viewers. An original-link
Telegram readback sample was H.264 High, level 3.1, yuv420p, 1280×720 at 25 fps,
with AAC-LC audio. The user subsequently confirmed the new test broadcast joins quickly and works
well. They clarified yesterday's delay affected PCs too, and Android displayed
“currently not broadcasting livestream data to Telegram.” That is consistent
with an interruption before Telegram viewer delivery; it does not isolate which
upstream or publisher failure occurred yesterday. No timed device benchmark was
recorded. Turbo was offline during verification.

## Hosting and measured resource use

The portal reports two Intel Xeon Platinum 8269CY vCPUs, 4 GB RAM and a 40 GB
SSD, billed at **₹516.15/month**. Ubuntu 22.04 currently has Docker and Compose
v2.40.3. The backend has a 1.75-CPU quota, 2 GiB memory limit, GOMAXPROCS=2 and
GOMEMLIMIT=768MiB. Caddy has its own 256 MiB limit. These are limits, not usage.

A 45-second sample while the real Novyny.Live RTMP test was publishing, with an
outgoing browser preview open, produced:

| Container | Mean CPU, one core = 100% | Peak CPU | Peak reported RAM |
|---|---:|---:|---:|
| Go + media processes | 2.02% | 7.39% | 91.63 MiB |
| Caddy HTTPS | 0.27% | 1.22% | 17.03 MiB |

[Raw Docker samples](stress-results/2026-10-17/vps-rtmp-publishing.json) contain
87 observations per container. This is a short RTMP relay sample, not a sustained
Telegram-capture or worst-case transcoding benchmark. Docker CPU percentages
use one core as 100%; the VPS has 200% total nominal CPU capacity. Inactive
backend usage was approximately 0.1% CPU and 19 MiB RAM before the test.

The first RTMP start stalled once after roughly six seconds, then recovered and
remained live for over ten minutes until stopped for the update. Its initial
failure cause was not captured; do not interpret low CPU as proof of flawless
media delivery. The controller correctly surfaced the failure and retried.

A separate 45-second run with Telegram capture probes active measured **13.06%
mean / 75.25% peak of one CPU core**, and **101.8 MiB peak reported backend RAM**.
Caddy measured 0.27% mean / 0.71% peak and 17.19 MiB peak RAM. This includes capture
startup/recovery and probe shutdown; it is not a continuous capture soak test.
[Raw samples](stress-results/2026-10-17/vps-relay-with-capture-probes.json).

An initial **Go compiler build**, not a streaming workload, used most of the
server's RAM and some swap. Production images now use a locally cross-compiled
static Go binary, while the small native sender builds on the VPS. At the
storage check, 27 GB remained available.

Render's Free service showed a 0.1-CPU / 512-MB allocation in its dashboard.
That constrained service was useful for testing; the VPS has more headroom and
persistent storage. The measurements do not justify a further CPU upgrade.

## Bandwidth and costs

FFmpeg has no per-hour remux service charge. Hosting and transfer are the costs.
For planning, at total encoded bitrate **B Mbps**, each continuously delivered
copy uses about **0.45 × B GB/hour**, or **0.495 × B GB/hour** with 10% overhead.

At 4 Mbps and six hours/day for 30 days, one Telegram upload is about 356 GB
outbound/month including that overhead. One concurrent browser preview for all
those hours adds another 356 GB. The matching source download is inbound traffic;
if the VPS quota counts both directions, include it too. Telegram viewer count
does not multiply the VPS upload: Telegram distributes the broadcast.

The VPS plan's transfer allowance and overage policy were **not visible in the
verified portal view**. Do not assume unlimited transfer or free overage. The
dashboard calculator still contains clearly identified Render example rates;
those rates are not the VPS bill. The verified recurring compute price is
₹516.15/month, plus any provider transfer charges and existing Worker charges.

## Operations and rollback

Deployment directory: `/opt/streamdesk/source/deploy`. Use:

```sh
docker compose -p streamdesk -f compose.vps.yml ps
docker compose -p streamdesk -f compose.vps.yml logs --tail 100 streamdesk
docker stats
```

The backend is loopback-only on host port 8090; capture 8091 and MediaMTX ports
are private inside the container. Caddy publishes HTTPS on 443 and ACME on 80.
The Worker's `RELAY_ORIGIN` now points to
`https://streamdesk.103.181.176.105.sslip.io`. TLS verification is enabled. Caddy
persists ACME state and renews the short-lived certificate. SSLip is an external
DNS dependency; replace it with an owned hostname when available. Workers
[do not support fetch to direct IP origins](https://developers.cloudflare.com/workers/platform/known-issues/).

Private environment/session files and D1 encryption settings remain private.
Named volumes hold the session and certificate state. Never run `down -v` or
start another holder of this Telegram session. To roll back: pause output, stop
the VPS backend completely, resume the old Render service, then restore the
Worker origin to `https://telestreamer-unhc.onrender.com`. The old Render image
does not contain today's fixes.

Build and deployment instructions are in [the backend README](../go_restream/README.md).

## Post-deployment verification

- `go test -race ./...` and `go vet ./...` passed after the query fix.
- Native sender normal-delivery and timestamp-jump tests passed.
- Worker `/api/status` reaches the HTTPS VPS, controls persist, and browser output
  preview plays the real 1920×1080 RTMP test.
- [Protected Telegram readback](stress-results/2026-10-17/telegram-readback-retry.txt)
  returned a real child playlist and video segment. FFmpeg decoded 50 frames
  without errors; keyframes were one second apart and the playlist advanced.
  Its trailing direct-media requests intentionally omit the reader session;
  their 401 demonstrates why preserving the query matters. An initial startup
  request exceeded the diagnostic's 35-second timeout; the warm retry succeeded.
- The FREE channel was discovered as an open RTMP call, but its initial preview
  and bounded capture probe did not return playable media. This source remains
  unverified; an open Telegram call alone does not establish active video.
- Deployed Go binary SHA-256:
  `4d215e6f6752fda5ee8303f38e005afe297ff8bd4733a38bd9f6cd8d5d780624`.

The test broadcast is stopped after verification, restoring the previous paused
controls with RWITC and Mysore selected as fallbacks. Use **Start automatic**
to resume Turbo-first automation. The dashboard's Render pricing examples were
not redeployed over another chat's concurrent Worker changes.
