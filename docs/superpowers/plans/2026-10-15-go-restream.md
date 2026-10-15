# Go auto-restream implementation plan

**Goal:** Combined Go capture and relay with a simple preview dashboard.
**Architecture:** Extend bundled TGTV in `go_restream`; share its client, registry and supervisor. Add serialized controller with discovery, destination and media interfaces.
**Tech stack:** Go 1.25+, gotd, MediaMTX, FFmpeg/libav, embedded HTML/CSS/JS.
**Spec:** `docs/superpowers/specs/2026-10-15-go-restream-design.md`.

## Constraints

One session holder; no local active-session connections. Turbo first; destination 4347395930 excluded. Only owned calls discarded. Private atomic state, authenticated previews, bounded retries. Existing deployment untouched until VM cutover.

## Inline execution

- [x] Test and implement arbitration, explicit fallback eligibility, lifecycle, pause and capped retry.
- [x] Integrate gotd destination ownership and crash recovery with existing capture.
- [x] Port official RWITC discovery, signing and freshness validation; test with local HTTP fixtures.
- [x] Embed dashboard and authenticated control/media routes; test unauthorized and invalid requests.
- [x] Add session import utility, single-host container, demo mode and VM cutover runbook.
- [x] Run unit/race/upstream tests, vet/build and demo browser checks; record limits.

Verification evidence and remaining deployment checks: `docs/GO_RESTREAM_VERIFICATION.md`.
