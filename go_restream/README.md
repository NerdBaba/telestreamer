# RRR Stream desk — combined Go capture and relay

A single Go service discovers joined Telegram RTMP broadcasts, captures them
through the bundled TGTV engine, and publishes one upload to **4347395930**
(`@RRRINDIALIVERACE`). Telegram handles viewer delivery. No Python daemon,
HF Space, Render relay or Cloudflare Worker is needed in the new deployment.

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

The application is prepared for a Linux VM. These steps are for cutover when
that VM is connected; this branch does not change the existing hosted services.

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
