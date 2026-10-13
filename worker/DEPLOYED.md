# Deployed racing Worker

**Origin:** https://rwitc-racing.kristopherreed0227-1etlk.workers.dev

**Verified deployment:** `1f48abbe-f7d4-4736-b96d-27156ac265f3`

**D1:** `rwitc-telegram`, database `d9010546-1b5c-45cd-b901-3c3308654b33`.
Schema applied remotely. The primary row is present and empty; no authorized
Telegram account is stored yet. Admin and session-encryption secrets are set.
Telegram API credentials are still absent.

## Observed verification

| Path | Observed result |
|---|---|
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
| Worker checks | Typecheck and 34 player-rotation/protocol/login/SRP/relay tests passed |

These observations do **not** establish a native Telegram broadcast, completed
OTP/2FA login, or authorized-session persistence. Those require user credentials.
Native Turbo media extraction also remains blocked on authenticated chunk
samples. The public preview detector is not a substitute for decoded media.

## Configuration behavior

- `/api/live` resolves published player HTML and re-signs playlist/segment
  requests. CDN token paths survive relative URL resolution.
- `/live` uses a configured reachable daemon even when its decision is 503;
  only an absent/unreachable daemon permits official fallback. There is
  currently no public `RELAY_ORIGIN`; production therefore uses official HLS.
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
