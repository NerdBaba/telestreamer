# Deployed racing Worker

**Origin:** https://rwitc-racing.curos282.workers.dev

**Verified deployment:** `22643738-0adb-4b01-a8d1-dded86181b20` — plain-language
stream controls with independent component checks, 2026-10-15.

**D1:** `rwitc-telegram`, database `b96437ce-2fb6-4a97-9ec4-9b3e720634c5`.
The fresh schema includes `relay_state.selected_chat_id`. Existing relay
controls were copied through the authenticated state API: paused, forced Turbo,
auto-start enabled, no selected member chat. No edge Telegram session was
migrated; edge API credentials were not available in the previous deployment.

Production secrets configure admin authentication, session encryption, and the
existing private Render relay. The new private panel URL is stored locally in
ignored `.relay/admin-url`; production secrets are in ignored
`worker/.dev.vars.release.json`, both mode `0600`. Do not commit either.

## Dashboard verification, 2026-10-15

| Check | Observed result |
|---|---|
| New `/checks` endpoint, production | Relay and Space healthy; valid stream list loaded |
| Chrome testing, deployed page | “Your stream is paused”; Incoming video Paused; Sending Off — paused; no browser errors |
| Isolated Chrome scenarios | Space unreachable, playlist failure, empty list, relay unreachable, incoming-only video, missing sender data, running sender, blocked call, legacy live-state fields |
| Isolated command feedback | Refused command leaves state unchanged; selection accepted; feedback survives refresh |
| Keyboard and mobile | Source focus/node preserved across polling, 3px focus outline; 320px without overflow or undersized visible targets |
| Worker preflight | Typecheck, 54 tests, dry-run passed |

No production pause/resume/source-selection action was sent during these checks.
The current relay remains paused. Component checks do not establish viewer
playback or automatically restart a stopped service.

## Migration verification, 2026-10-15

| Check | Observed result |
|---|---|
| `/healthz` | 200, `ok: true` |
| Authenticated `/api/relay-state` PUT and GET | Existing controls preserved |
| Unauthenticated `/api/relay-state` | 401 |
| Incorrect private admin path | 404 |
| New private panel `/status` | 200 from the existing Render relay |
| Browser-rendered panel | Paused, auto-start On, current live source with Preview/Start |
| Actual Python relay state client against the new Worker | Saved controls loaded successfully; health 200 |
| Relay checks after updating its default Worker origin | All 70 tests passed |
| Worker preflight | Typecheck, 48 tests, dry-run passed |
| Scheduled trigger | Every ten minutes, registered by Wrangler |

### Pending Render cutover

The running Render service still uses its previous Worker/state URLs and relay
code. Chrome relay access was unavailable during this migration. Repository
defaults and `render.yaml` now target the new origin, but an existing service
must also set these environment values and deploy the latest relay commit:

```text
WORKER_URL=https://rwitc-racing.curos282.workers.dev
RELAY_STATE_URL=https://rwitc-racing.curos282.workers.dev/api/relay-state
```

Until that cutover, the new panel controls the existing relay, which persists
changes through the previous state endpoint. Re-copy the latest controls into
the new D1 immediately before changing Render's endpoint, so subsequent control
changes are not lost. Do not delete the previous Worker before cutover.

## Prior verification, 2026-10-13
| Path | Observed result |
|---|---|
| Production `/healthz` after latest deployment | 200, `{"ok":true,"date":"2026-10-13"}` |
| Public `/live` | FFmpeg decoded five seconds, exit 0 |
| Public `/api/stream-status` | `source: rwitc`, `live: true`, lag approximately 4 seconds at observation |
| Public `/api/fixtures` | 200, upcoming meetings with invalid placeholder dates removed |
| Public `/mtproto/probe?dc=2` | Real `resPQ`, matching nonce, server fingerprints returned |
| Anonymous DH and encrypted RPC, local Workers runtime | Server-confirmed key exchange; encrypted `CONNECTION_API_ID_INVALID` for API id 0; queued ACKs drained from 2 to 0, no user login or persisted key |
| Public `/telegram/status`, without token | 401 |
| Public `/telegram/status`, correct private token | 503 `setup_required`, missing API id/hash |
| Login page, controlled expired-code response in Chromium | Phone form restored, code form hidden, code cleared; no OTP retried or real login performed |
| Remote D1 inspection | Primary row, null ciphertext, released lease |
| Local dashboard | Real race video decoded; pause/resume exercised; 390px viewport without horizontal overflow |
| Local daemon → HLS → private-pipe native sender → RTMP receiver | h264 + aac, 5.24 seconds received and decoded |
| Local Worker → daemon → HLS | Real decoded media; pause preserved as 503 rather than bypassed with fallback |
| Python checks | 20 offline checks plus 12 publisher/recovery tests passed, including video-only RTMP |
| Worker checks for this deploy | Typecheck passed; all 48 Worker tests passed |
| Private admin `…/status` against the live Render relay | 200 with real broadcasts, `auto_start: true`, `paused: false` |
| Relay `publishing` after clearing an ended output call | `ready` — genuine Telegram RTMP credentials obtained |
| Relay selection of a live member channel | Selection recorded and media started; the Space answered 404 for that stream's HLS, so no media was produced |
| Worker `scheduled` trigger | Reaches the relay `/healthz`, which is what stops Render Free from spinning down |

These observations do **not** establish a native Telegram broadcast, completed
OTP/2FA login, or authorized-session persistence. Those require user credentials.
Native Turbo media extraction also remains blocked on authenticated chunk
samples. The public preview detector is not a substitute for decoded media.
A live row in the Space playlist does not prove that its media is captured; the
Space must answer both `/watch/<id>` and `/streams/<id>/play.m3u8`.

## Configuration behavior

- `/api/live` resolves published player HTML and re-signs playlist/segment
  requests. CDN token paths survive relative URL resolution.
- `/live` uses a configured reachable daemon even when its decision is 503;
  only an absent/unreachable daemon permits official fallback. `RELAY_ORIGIN`
  is now set to the private Render relay.
- The private admin panel needs a reachable `RELAY_ORIGIN` and matching
  `RELAY_TOKEN`; both are set, and real source selection is exercised against
  the live relay. Publishing was blocked until an ended output call was cleared,
  which the panel now reports and can discard.
- The calendar endpoint needs a User-Agent. An explicit descriptive agent fixed
  the observed upstream 403/Worker 502 failure.
- Telegram login routes are bearer-protected; session payloads are AES-GCM
  encrypted before D1 storage and sockets belong to individual requests.
- Local channel publishing uses a user session with creator/manage-call rights
  or separately supplied Telegram RTMP credentials. Neither is currently set.

## Operate

See `README.md` for edge setup and `../TELEGRAM_SETUP.md` for local publishing.

```bash
npm run check
node --import tsx --test test/*.test.ts
npx wrangler deploy --dry-run
npm run deploy
```

Do not replace the session-encryption key while retaining encrypted state.
A local daemon must stay running for local playout/publishing. A deployed Worker
cannot reach a Mac loopback URL; configure a protected reachable origin if edge
playout needs to pull from that daemon.
