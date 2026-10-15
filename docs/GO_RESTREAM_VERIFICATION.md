# Go stream desk verification — 2026-10-15

Branch: `codex/go-auto-restream`. Application: `go_restream/`.

Passed locally on macOS:

- `go test -race ./...`: all retained TGTV packages and 27 new restream tests.
  New tests cover Turbo priority, fallback eligibility, output exclusion,
  pinned unavailable source, end/pause/restart behavior, failure cooldown,
  startup deadline, FloodWait delay, ownership recovery and unrelated-call
  protection, source metadata isolation, native/scheduled call rejection,
  RWITC signing/freshness, private state, auth/CSRF, preview URL rewriting,
  status credential redaction and offline session conversion.
- `go vet ./...` and JavaScript syntax validation.
- Native macOS build and statically linked Linux amd64 cross-build.
- Existing C RTMP sender compiled against installed FFmpeg libraries.
- Four-second local media round trip: generated live HLS → native sender →
  localhost RTMP receiver → saved FLV. FFprobe confirmed H.264 960×540 and AAC,
  duration 4.010 seconds. Receiver intentionally stopped after four seconds;
  sender's subsequent connection-closed diagnostic was expected.
- Offline SQLite exporter: format, mode 0600, refusal to overwrite, all using
  a synthetic session. Go importer loaded through gotd's real session loader.
- Compose schema/config validation, using a temporary override making the
  absent production `.env` optional. No real environment secrets supplied.
- In-app browser at mobile and desktop widths: sign-in, playing outgoing and
  input videos simultaneously, enabling a fallback, Turbo → fallback,
  pause/resume, persisted pause after process restart, all-offline → idle,
  and automatic restart. Actual video currentTime advanced at 960×540.
  Screenshot: `docs/screenshots/go-streamdesk-demo.jpg`.

Not exercised:

- Docker image build/run: local Docker engine socket is unavailable.
- Live Telegram session login, publishing, call creation/discard and Render
  cutover: existing active sessions have not been connected locally.
- Production source bitrates, CPU/RAM/network measurements or viewer-load
  claims. The demo is generated media and simulates the Telegram destination.

Use the cutover checklist in `go_restream/README.md` when the VM is connected.
Stop the old session holder before starting the new one, then verify actual
playback from an independent Telegram viewer.

## Hosted deployment preparation

- Added encrypted D1 controls/owned-call storage and a single-holder lease.
  Go renews every 15 seconds and disconnects if renewal fails. Raw JSON preserves
  Telegram int64 call identities exactly through Workers storage.
- Full Go race suite and vet passed after the hosting changes; Linux amd64
  cross-build passed. Worker TypeScript check passed.
- Applied only additive migration `0002_streamdesk_state.sql` to the existing
  D1 database. Legacy migration 0001 was already applied outside migration
  tracking and must not be blindly re-applied.
- Deployed Worker version `d32bc2ab-930b-45c4-9902-af8f2b31926c`. The frontend
  feature flag is still off pending a healthy Go backend; existing admin routes
  continue serving the previous panel.
- Live authenticated state API test passed: encrypted controls round trip,
  anonymous request rejected (401), second lease owner rejected (409), and
  release allowed the second owner. Initial Go cutover controls are paused.
- Render settings are readable through the user's Chrome session, but browser
  input is currently blocked by two running Chrome installations sharing a
  bundle ID. No Render source/environment/session cutover has been performed.
