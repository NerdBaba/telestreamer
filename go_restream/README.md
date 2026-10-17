# RRR Stream desk — combined Go capture and relay

A single Go service discovers joined Telegram RTMP broadcasts, captures them
through the bundled TGTV engine, and publishes one upload to **4347395930**
(`@RRRINDIALIVERACE`). Telegram handles viewer delivery. No Python daemon,
HF Space or Python relay is needed. Cloudflare Workers can host the private UI
and proxy its API; the combined backend runs on a Linux host.

## Behavior

- TurboSportsLive (`2961901881`) wins in automatic mode.
- Enable member-channel or RWITC fallbacks in the dashboard, in preferred order.
  They are opt-in: an unrelated joined channel never starts broadcasting merely
  because it appears in discovery. The output channel cannot become an input.
- **Use this feed** pins a source; if it ends, output ends. **Use automatic**
  restores primary/fallback selection. **Pause automation** ends the service's
  call while continuing source monitoring and previews.
- When no eligible feed remains, end the owned call; a subsequent live source
  creates a new one. Source switches keep the same Telegram call, with a short
  media buffering interruption. This is not a seamless mixer.
- Failed media retries after 2–32 seconds; failed sources yield to selected
  backups for 30 seconds before being retried. Source discovery errors retain
  the last running broadcast rather than treating a network error as an end.
- Controls and the exact owned call identity persist atomically. Unrelated
  existing calls are never adopted or discarded. If a process crashes between
  Telegram creating a call and the identity reaching disk, it fails closed;
  inspect/close that call in Telegram before retrying. Never delete the ownership
  journal while an owned call is running.

## Run the local demo

Requires Go 1.26 and FFmpeg with libx264; uses generated H.264/AAC video and
simulates Telegram. It never opens a Telegram session or contacts RWITC.

```sh
cd go_restream
go build -o /tmp/streamdesk ./cmd/tgtv
export ADMIN_TOKEN="$(openssl rand -hex 32)"
/tmp/streamdesk demo
```

Open [the demo](http://127.0.0.1:8180), enter the token, and use **Turbo live**,
**Fallback only**, **All offline**, pause/resume and feed-selection controls.
The demo persists controls in `.demo-data` (override with `DATA_DIR`). Its
outgoing preview is generated media; it is not Telegram viewer verification.

## VM deployment and session cutover

Production moved to the HostDZire VPS on 2026-10-17; Render is suspended. See
[the measured deployment report](../docs/GO_RESTREAM_VPS_2026-10-17.md). The steps
below describe a fresh deployment; preserve the single-session-holder rule.

1. Build the image first with `docker compose build`. Create the private data
   directory: `mkdir -p data/session data/config` and
   `sudo chown -R 10001:10001 data && sudo chmod -R go-rwx data`.
2. Copy `.env.example` to `.env`, set API ID/hash, and generate independent admin,
   path and CDN secrets using `openssl rand -hex 32`. Keep `.env` mode `0600`.
3. Choose **one** existing session for the combined application. Stop the old
   service holding that session **before** starting the new service. If using
   `rrr_relay.session`, stop the Render relay. If using HF's gotd JSON session,
   stop the HF capture. Never test either active session from your laptop.
   A local file lock cannot prevent a second host using the same auth key.
4. For an existing gotd JSON file, securely copy it to `data/session/tgtv.json`.
   For Telethon SQLite, export and convert **offline** on a trusted host:

   ```sh
   python3 deploy/export_session.py /secure/rrr_relay.session /secure/export.json --previous-holder-stopped
   # Use a locally built streamdesk binary, or the container with a bind mount.
   /tmp/streamdesk import-session /secure/export.json data/session/tgtv.json --previous-holder-stopped
   sudo chown 10001:10001 data/session/tgtv.json
   sudo chmod 600 data/session/tgtv.json
   ```

   The exporter uses only Python's SQLite standard library; no Telegram login
   or network request occurs. The deployed runtime is Go/native tools only.
   The account must already be a member of Turbo/fallback channels and have
   manage-call permissions in output channel 4347395930. Initial joined-dialog
   discovery can take time; the service waits and retries.
5. `docker compose up -d`. The panel binds to VM loopback by default. Access it
   through `ssh -L 8090:127.0.0.1:8090 your-vm`, then open
   [the panel](http://127.0.0.1:8090). For public remote administration, put an
   HTTPS reverse proxy in front; never expose the plain HTTP admin port.
   Capture is on a separate container-loopback port 8091. MediaMTX RTMP/HLS are
   loopback-only. No viewer should receive a private input HLS URL.
6. Enable selected fallbacks. Verify Turbo start → output starts, Turbo end →
   approved fallback or output ends, return to Turbo, pause/resume, container
   restart recovery, and playback from an independent Telegram viewer. Check
   `docker stats` for CPU/RAM/network at actual source bitrate. No synthetic
   viewer-count or CPU benchmark is claimed by this implementation.
7. Once new-host playback is verified, stop remaining obsolete services.
   Rollback: stop the VM container completely before restarting its former
   session holder. Never run them simultaneously.

The Compose service restarts on process failure. A MediaMTX exit terminates
and restarts the whole container. The image runs as UID 10001 with bounded
logs and a 96 MiB tmpfs for outgoing HLS. Three concurrent input captures allow
one outgoing feed, one selected preview and one source preparing to take over.
Each active preview adds input bandwidth; inactive cards do not decode video.

## Small VPS build and deployment

`deploy/compose.vps.yml` uses a locally cross-compiled Go binary so compiling the
large Telegram bindings does not consume the VPS's runtime memory. From this
directory, prepare the build context (never include private environment files):

```sh
mkdir -p deploy/prebuilt
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o deploy/prebuilt/streamdesk ./cmd/tgtv
tar --exclude=deploy/prebuilt --exclude='deploy/.env*' -czf deploy/prebuilt/source.tar.gz cmd internal deploy Dockerfile compose.yml go.mod go.sum LICENSE UPSTREAM.md README.md DESIGN.md .dockerignore .env.example
```

Securely transfer this directory to the server, including `deploy/prebuilt`.
Keep the private backend environment in `deploy/.env.vps` (mode 0600). Configure
`deploy/.env` with `STREAMDESK_PUBLIC_HOST=your-public-hostname`. The active
backend environment needs `HTTP_PORT=8090`, `STREAMDESK_STANDBY=false`,
`GOMAXPROCS=2`, `GOMEMLIMIT=768MiB` and `MAX_CONCURRENT_INGESTS=2`, in addition
to the existing Telegram credentials, admin token and hosted-state settings.

```sh
cd deploy
docker compose -p streamdesk -f compose.vps.yml build
# Stop the former session holder before activation, including during updates.
docker compose -p streamdesk -f compose.vps.yml up -d
```

Use Compose v2. The service has a 1.75 CPU / 2 GiB limit and persistent session
storage; Caddy has a separate 256 MiB limit. Caddy exposes HTTPS on 443 and port
80 for ACME. Its certificate state persists in named volumes. Only the backend's
loopback port 8090 is published. Set the Worker's `RELAY_ORIGIN` to the HTTPS
**hostname**; Worker fetch does not support direct IP origins. The current
SSLip hostname depends on public DNS; an owned domain can replace it.

For an update, pause the broadcast, build the image, then explicitly stop the
old backend before `up -d`. Do not run a second Telegram client to test the
session. Never remove the named data volumes during an update or rollback.

Unified H.264/AAC Telegram fragments without reordered frames use stream copy.
MP4/MOV video with B-frames (or an unavailable probe) uses the bounded
normalization path: independent Telegram fragments can otherwise produce
backwards decode timestamps in MediaMTX. Decoder/encoder work is limited to
two threads and filters to one. Separate native audio/video retains padding. The native sender rejects timestamp
jumps or accumulated publishing lag beyond five seconds, letting the controller
restart from live media instead of sleeping through a minute-long gap.

## Control/API and private state

- `GET /health`: lightweight process health, no private data.
- `GET /api/status`: source states, current choice, controls and recent events.
- `POST /api/control`: full JSON control object, e.g.
  `{"auto":true,"paused":false,"forced":"","fallbacks":["486d93b2faa0","rwitc"]}`.
- `GET /output/index.m3u8`: outgoing media preview, not independent confirmation
  that Telegram viewers are receiving the broadcast.
- `GET /preview/<id>/index.m3u8`: selected input preview, proxying all nested
  playlists and segments with same-origin authenticated links.
- `GET /source.tar.gz`: exact modified source and build scripts, in the container.

Use the sign-in form (HttpOnly, SameSite cookie), HTTP Basic user `admin`, or
`Authorization: Bearer <ADMIN_TOKEN>`. Controls require JSON and reject
cross-site requests. Secrets and source URLs are excluded from status JSON and
media stderr is not written into event logs. Runtime files under `/data` are
credentials/private state; do not commit them or display them in screenshots.
Cookie Secure is enabled under TLS or `X-Forwarded-Proto: https`; configure
that header only at your trusted reverse proxy.

`owned-call.json` contains call identity, `controls.json` operator preferences,
and `tgtv.json` the authorized Telegram session. Back up private persistent
state securely. A source that is a native phone call or scheduled broadcast is
shown as ineligible; this release captures RTMP broadcasts only.

## Verification

```sh
go test -race ./...
go vet ./...
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -o /tmp/streamdesk-linux ./cmd/tgtv
docker compose --env-file .env config --quiet
```

For provenance, source license, bundled player and third-party notices see
[UPSTREAM.md](UPSTREAM.md) and [LICENSE](LICENSE). Telegram lifecycle follows
[the official group-call publishing flow](https://core.telegram.org/api/group-calls#creating-and-publishing-an-rtmp-livestream).

## Render + Workers deployment

The Worker can host this UI through its assets binding; Render then serves only
its authenticated API and media. Set `STREAMDESK_ENABLED=true`, `RELAY_ORIGIN`
and `RELAY_TOKEN` in the Worker after the backend is ready. The existing private
`/admin/<secret>` URL opens the new desk and issues a private session cookie.
The Worker preserves its legacy routes and other source integrations.
Mysore appears as a separate optional fallback in the Go desk. Its resolver
uses the existing Worker's `/api/mysore/live` route and independently verifies
playlist timestamps and segment availability. `MYSORE_WORKER_ORIGIN` can
override that Worker's origin. Both official feeds are checked concurrently.

For Render's ephemeral filesystem, set `SESSION_JSON_B64` to the base64-encoded
offline-converted gotd JSON session. Startup restores it with mode 0600. Set
`STATE_URL=https://<worker>/api/streamdesk-state` and `STATE_TOKEN` to the
Worker's existing `ADMIN_TOKEN`. Apply `worker/migrations/0002_streamdesk_state.sql`
once; controls and owned call identity are then encrypted in D1. Telegram int64
call identities are preserved byte-for-byte rather than parsed into JS numbers.

Hosted instances acquire a 60-second D1 lease before connecting Telegram and
renew every 15 seconds. A renewal error disconnects that instance. **Suspend the
former session holder before starting the new Render release**: an active lease
is never forcibly stolen, and standard zero-downtime deploys may otherwise wait
for the old holder. Render resume can restart the previous image. For the
first cutover, deploy with `STREAMDESK_STANDBY=true`: this mode serves health
only and never reads or connects the Telegram session. After that deployment
is live and the previous image has stopped, set it to `false` and deploy again.
For later releases, use the same standby-then-activate sequence to let the
previous session holder disconnect before another instance acquires its lease.

The entrypoint maps Render `PORT` to the Go listener and accepts existing
`TG_API_ID` / `TG_API_HASH` variable names. Health checks support `/health` and
`/healthz`. The free Render instance is a constrained test target; no paid
upgrade is made automatically, and actual live-media resource use still needs
measurement. `MAX_CONCURRENT_INGESTS=2` limits capture concurrency for this target.

## Public live test inputs

Two real web-discovered feeds appear after the racing sources:

- Novyny.Live RTMP: `rtmp://95.67.11.153/klive/stream`
- Al Jazeera English HLS: `https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8`

Both decoded video/audio with FFmpeg on 2026-10-16. External feeds can change
or stop; the Test badge indicates a manual test input, not a continuous health
check. These IDs (`test-rtmp`, `test-hls`) are never automatic fallbacks, even
if mistakenly present in saved fallback settings. Use Open preview to inspect
one, or Use this feed to select it manually for your Telegram output.

The RTMP browser preview remuxes the actual incoming RTMP stream to private
HLS with `-c copy`, starting only on demand and stopping after 30 seconds
without preview activity. No generated replacement video is used. The normal
outgoing relay reads the original RTMP input directly. HLS preview requests
use the existing authenticated proxy; public input URLs are displayed on the
cards. Telegram input/provider credentials remain excluded from status JSON.

Opt-in network integration check (no Telegram session opened):

```sh
STREAMDESK_PUBLIC_FEED_TEST=1 go test ./internal/restream -run TestPublicRTMPPreviewIntegration -v -count=1
```

Source directory used to discover the current news playback URLs:
https://github.com/iptv-org/iptv

### Manual stream controls

Each source has **Start stream** and **Stop stream**. Start selects that feed for
the Telegram broadcast; Stop pauses automation, cancels further retries, clears
the manual selection, and closes the Telegram call owned by this service.
**Start automatic** restores Turbo priority and the enabled fallbacks. The global
**Stop broadcast** performs the same stop action from anywhere on the desk.
The status remains Starting or Retrying until the backend confirms Live.

**Stop preview** closes only the private source player; it does not stop the
Telegram broadcast. Calls created outside this service remain protected by the
existing ownership check.

### Bandwidth and remux budget

The dashboard includes an editable calculator for bitrate, streaming hours,
private preview copies, available bandwidth allowance, egress rate and fixed
compute cost. It is a scenario estimate, not a live billing meter.
See [the measured Mysore sample and pricing assumptions](../docs/GO_RESTREAM_COSTS_2026-10-16.md).

## Media recovery and source previews

Live input reads are paced at real time so an HLS download burst cannot
delete local segments before the RTMP sender consumes them.

Manual sources retry after the controller's short exponential backoff; they no
longer enter the automatic source cooldown and close the Telegram call merely
because the sender briefly exits. Automatic primary failures still yield to
approved fallbacks. Cold media preparation is bounded at 22 seconds inside the
25-second controller operation. Exact safe sender failure categories appear in
the dashboard; raw FFmpeg stderr and provider URLs remain private.

Every valid RTMP preview media request refreshes its activity timer. A player
can fetch the master once and keep fetching child playlists/segments without
being shut down at 30 seconds. Capture pipe writes now use the OS pipe deadline
so a blocked FFmpeg reader cannot hold recovery or shutdown indefinitely.
