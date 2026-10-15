# RWITC racing and Telegram transport Worker

Deployed at **https://rwitc-racing.curos282.workers.dev**.
The official HLS proxy runs independently of the local relay. The optional
local daemon owns FFmpeg/channel publishing; the optional edge login owns a
separate encrypted MTProto session in D1.

## Endpoints

| Endpoint | Behavior |
|---|---|
| `/api/live` | Latest published active official HLS player, signed server-side |
| `/api/live/<token>/<path>` | Re-signed media playlists and streamed segments |
| `/live` | Daemon playout when configured/reachable, otherwise official HLS |
| `/api/stream-status` | Daemon status or official media timestamp/lag |
| `/api/fixtures` | Upcoming calendar meetings within 14 days, placeholders dropped |
| `/api/races?date=YYYY-MM-DD` | Race cards with runners, jockeys, silks and times |
| `/api/replays?date=YYYY-MM-DD` | Published replay URLs and pending race numbers |
| `/mtproto/probe?dc=2` | Anonymous req_pq_multi → nonce-validated resPQ proof |
| `/telegram-login` | Browser login form; does not itself publish a broadcast |
| `/telegram/status` | Bearer-protected edge authorization status |
| `/telegram/send-code` | Bearer-protected POST with `{ "phone": "+countrydigits" }` |
| `/telegram/sign-in` | POST with `{ "code": "digits" }`, or `{ "password": "…" }` after 2FA is requested |
| `/telegram/logout` | POST `{}`; remote logout then remove saved edge authorization |
| `/healthz` | Worker liveness and current IST date |

All Telegram API routes require `Authorization: Bearer ADMIN_TOKEN` and return
`setup_required` if required bindings/secrets are absent. No successful user
login or native Telegram broadcast has been verified without user credentials.
The public stream-status endpoint is a media freshness signal, not proof of a
Telegram viewer receiving video.

## Development and deployment

```bash
npm ci
npx wrangler types
npm run check
node --import tsx --test test/*.test.ts
npx wrangler d1 execute rwitc-telegram --local --file=src/mtproto/schema.sql
npm run dev
```

The configured D1 database `rwitc-telegram` has been provisioned. For a clean
remote installation, apply the schema before enabling login:

```bash
npx wrangler d1 execute rwitc-telegram --remote --file=src/mtproto/schema.sql
npx wrangler deploy --dry-run
npm run deploy
```

Wrangler-generated runtime types replace the old workers-types dependency.
`nodejs_compat` is required by the core dependency's event emitter.

## Private edge login configuration

Required secrets:

- `ADMIN_TOKEN`: high-entropy bearer secret. A private local value is already
  generated in `rrr_config.json` and copied to ignored `worker/.dev.vars`.
- `SESSION_ENCRYPTION_KEY`: 32 random bytes encoded as standard base64; already
  generated locally. Keep the same key across deployments that reuse a session.
- `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`: your application credentials from
  https://my.telegram.org. These are **not** supplied by a channel invite.

The admin token and encryption key were uploaded for the deployed Worker.
Telegram API credentials are still missing. Set secrets through Wrangler's
interactive secret input or a private ignored dotenv file; never commit or put
values in command arguments. A private file can be uploaded with:

```bash
npx wrangler secret bulk .dev.vars
```

After supplying app credentials, use `/telegram-login` and enter OTP/2FA there,
not in assistant chat. The code hash, auth key, user state, and pending phone
number are AES-GCM encrypted before D1 storage. OTPs and passwords are not
persisted. Session access is serialized with a D1 lease; expired leases recover
without an isolate-global socket. Keep the encryption key backed up privately.

Telegram transport 404 invalidates the saved key and durably resets login to
signed out; ordinary connectivity failures preserve the saved session. A
server-expired OTP clears the pending code immediately and restores the
phone-number form. Wrong codes do not discard the pending login. Server RPC
results, including errors, are acknowledged before request-owned sockets close.

Full DH key exchange was observed with a throwaway anonymous client, including
server confirmation. This proves more than a WebSocket upgrade or resPQ reply,
but does not prove `auth.sendCode`, OTP, 2FA login, or authorized-session recovery.
Those require real API/account credentials. Cryptographic login work may exceed
free-tier Worker CPU allowances; check the account's limits before enabling it.
No paid-plan upgrade is performed automatically.

## Daemon playout

Configure `RELAY_ORIGIN` with a reachable HTTPS origin for the local daemon and
`RELAY_TOKEN` with its private admin token. A deployed Worker cannot reach your
Mac's `127.0.0.1`. The current deployment points to the private Render relay.

Daemon playlists are rewritten to `/live/<segment>` and segments stream without
whole-body buffering. A reachable daemon's pause, unavailable-source decision,
or startup state returns 503 instead of bypassing the control with official
fallback. Only an absent or unreachable daemon permits official fallback.
Source changes require a player to reload the master playlist.

Local setup and channel publishing are documented in `../TELEGRAM_SETUP.md`.
Edge login does not generate a local Telethon session, and a bot token does not
start native Telegram channel live streams.

## Official sources

Player HTML discovers both the signing Lambda and current CDN master token.
Signed-cookie renewal survives hourly signature expiry. Playlist URLs retain
the CDN token through relative resolution. An empty newest stream record is not
sufficient evidence that older published media has stopped; freshness is checked
in stream status and the local source controller.

The calendar requires a User-Agent; the Worker sends the same descriptive agent
convention as the public preview watcher. Replays use the public archive/CDN and
can be pending during a meeting; they never substitute for live relay output.

This is a personal tool. Publicly accessible source video does not itself grant
permission to redistribute it; use only broadcasts you are authorized to relay.
