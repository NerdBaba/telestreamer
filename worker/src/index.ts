/**
 * RWITC Racing API
 *
 * Endpoints:
 *   /api/live                 live HLS master playlist (plays in any player)
 *   /api/live/<path>          media playlists and .ts segments, re-signed
 *   /api/races?date=          race card for a date (default today)
 *   /api/replays?date=        published replays for a date (default today)
 *
 * The upstream live stream is gated by CloudFront signed cookies that the
 * official player obtains from a Lambda using only an Origin header. The
 * signature expires hourly and the m3u8 path rotates per meeting, so the
 * Worker re-resolves the record and re-signs on every request instead of
 * caching credentials.
 */

export type Env = Cloudflare.Env & TelegramEnv & RelayEnv;

import { handleProbe } from "./mtproto/probe";
import { handleTelegram, type TelegramEnv } from "./mtproto/telegram";
import { adminPage, adminRelayControl } from "./admin";
import { adminHealthChecks } from "./admin-health";
import { fixturesResponse, relayLive, relayStatus, wakeRelay, type RelayEnv } from "./relay";
import { telegramLoginPage } from "./telegram-login";
import { handleRelayState } from "./relay-state";

// --------------------------------------------------------------------------
// Upstream RWITC plumbing
// --------------------------------------------------------------------------

/** Resolve a published active player; meeting date is not proof of liveness. */
async function fetchStreamRecord(api: string): Promise<StreamRecord | null> {
  const res = await fetch(`${api}/stream`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`stream record HTTP ${res.status}`);
  }
  const body = await res.json<{ data?: StreamRecord[] }>();
  if (!body.data?.length) return null;
  let latest: StreamRecord | null = null;
  for (const record of body.data) {
    if (record.status !== "active" || !record.stream_url?.trim()) continue;
    if (!latest || record.race_date > latest.race_date
        || (record.race_date === latest.race_date
            && ((record.createdAt || "") > (latest.createdAt || "")
                || ((record.createdAt || "") === (latest.createdAt || "")
                    && (record.id || 0) >= (latest.id || 0))))) {
      latest = record;
    }
  }
  return latest;
}

/**
 * Mint CloudFront signed cookies using the same Origin-only check the
 * official player satisfies. A 403 here means the gate changed.
 */
async function fetchSigning(lambdaUrl: string, origin: string): Promise<Signing> {
  const res = await fetch(lambdaUrl, { headers: { Origin: origin } });
  const body = await res.json<Record<string, unknown>>();
  if (!res.ok || body.status !== "success") {
    throw new Error(`signing failed: ${body.msg ?? res.status}`);
  }
  return body as unknown as Signing;
}

/**
 * Fetch a CDN URL with signed cookies. Re-signs once on 403 so an expiring
 * signature is invisible to the caller.
 */
async function fetchWithSigning(
  url: string,
  signing: Signing,
  lambdaUrl: string,
  origin: string,
): Promise<Response> {
  let s = signing;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      headers: {
        Cookie:
          `CloudFront-Key-Pair-Id=${s.keyPairId}; ` +
          `CloudFront-Policy=${s.encodedPolicy}; ` +
          `CloudFront-Signature=${s.encodedSignature}`,
      },
    });
    if (res.status !== 403) return res;
    if (attempt === 1) return res;
    s = await fetchSigning(lambdaUrl, origin);
  }
  /* c8 ignore next */
  throw new Error("unreachable");
}

// --------------------------------------------------------------------------
// Live HLS relay
// --------------------------------------------------------------------------

const MASTER_RE = /https:\/\/cfs\.rwitc\.com\/[A-Za-z0-9]+\/index\.m3u8/;
const LAMBDA_RE = /fetch\("(https:\/\/[^"]*lambda-url[^"]*)"\)/;

/** Everything needed to serve one live request. */
async function loadLive(env: Env): Promise<LiveContext> {
  const record = await fetchStreamRecord(env.RWITC_API);
  if (!record || record.status !== "active") {
    throw new OffDayError("no active stream for today");
  }

  const page = await fetch(record.stream_url);
  const html = await page.text();
  const lambda = LAMBDA_RE.exec(html)?.[1];
  const master = MASTER_RE.exec(html)?.[0];
  if (!lambda || !master) {
    throw new Error("player page missing lambda or m3u8 reference");
  }

  return { master, lambda, signing: await fetchSigning(lambda, env.RWITC_ORIGIN) };
}

async function handleLiveStatus(env: Env): Promise<Response> {
  try {
    const daemon = await relayStatus(env);
    if (daemon) {
      return json({
        source: daemon.playout.source, live: daemon.playout.ready,
        paused: daemon.paused, forced: daemon.forced, sources: daemon.decision.sources,
        reason: daemon.decision.reason, next_meeting: daemon.fixtures[0] || null,
      }, { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
    }
  } catch {
    // The official source is independent of the local daemon.
  }
  try {
    const ctx = await loadLive(env);
    const master = await fetchWithSigning(ctx.master, ctx.signing, ctx.lambda, env.RWITC_ORIGIN);
    if (!master.ok) throw new Error(`master HTTP ${master.status}`);
    let media = await master.text();
    if (!media.includes("#EXTINF:")) {
      const variant = media.split("\n").find(line => line && !line.startsWith("#"));
      if (!variant) throw new Error("no variant");
      const response = await fetchWithSigning(new URL(variant, ctx.master).href, ctx.signing, ctx.lambda, env.RWITC_ORIGIN);
      if (!response.ok) throw new Error(`variant HTTP ${response.status}`);
      media = await response.text();
    }
    const stamps = [...media.matchAll(/#EXT-X-PROGRAM-DATE-TIME:([^\r\n]+)/g)];
    const timestamp = stamps.length ? Date.parse(stamps[stamps.length - 1][1]) : NaN;
    const lag = (Date.now() - timestamp) / 1000;
    const live = Number.isFinite(lag) && lag >= 0 && lag <= 300 && !media.includes("#EXT-X-ENDLIST");
    return json({ source: live ? "rwitc" : null, live, lag_seconds: Number.isFinite(lag) ? lag : null,
      reason: live ? "fresh official HLS" : "official media is stale or lacks a live timestamp" },
      { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  } catch (error) {
    return json({ source: null, live: false, reason: error instanceof Error ? error.message : "source unavailable" },
      { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  }
}

/**
 * Rewrite a playlist so every URL stays on this Worker.
 *
 * Upstream paths look like
 *   /<token>/index.m3u8                     (master)
 *   /<token>/RWITC-LIVE-TRANSCODING/….m3u8  (variant, relative in master)
 *   /<token>/RWITC-LIVE-TRANSCODING-…/N.ts  (segment, relative in variant)
 * so the CDN token must survive as the first path segment. We emit absolute
 * /api/live/<token>/<rest> paths: a player resolving a relative segment
 * against the variant URL keeps the token and stays on this Worker.
 */
function rewritePlaylist(text: string, baseUrl: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line || line.startsWith("#")) return line;
      try {
        const absolute = new URL(line, baseUrl);
        const parts = absolute.pathname.split("/").filter(Boolean);
        if (parts.length < 2) return line;
        const [token, ...rest] = parts;
        return `/api/live/${token}/${rest.join("/")}${absolute.search}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

async function handleLive(
  env: Env,
  subPath: string,
): Promise<Response> {
  // Never cache: signatures expire hourly and paths rotate per meeting.
  const headers = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Access-Control-Allow-Origin": "*",
  };

  let ctx: LiveContext;
  try {
    ctx = await loadLive(env);
  } catch (err) {
    if (err instanceof OffDayError) {
      return json({ error: err.message }, { status: 503, headers });
    }
    console.error("live resolve failed", err);
    return json({ error: String(err) }, { status: 502, headers });
  }

  // Requests under /api/live carry "<token>/<rest>" (e.g. the variant or a
  // segment); a bare /api/live is the master playlist.
  const cdn = new URL(ctx.master).origin;
  let remoteUrl: string;
  if (!subPath) {
    remoteUrl = ctx.master;
  } else {
    // The path arrives percent-encoded (spaces are %20 upstream). Decode only
    // for the fetch; a malformed escape must not throw an unhandled 500.
    let decoded: string;
    try {
      decoded = decodeURIComponent(subPath);
    } catch {
      return json({ error: "malformed path encoding" }, { status: 400, headers });
    }
    remoteUrl = `${cdn}/${decoded}`;
  }

  const res = await fetchWithSigning(
    remoteUrl,
    ctx.signing,
    ctx.lambda,
    env.RWITC_ORIGIN,
  );

  if (!res.ok) {
    console.error("live upstream", res.status, remoteUrl);
    return new Response(await res.text(), {
      status: res.status,
      headers,
    });
  }

  const type = res.headers.get("Content-Type") ?? "";
  if (!type.includes("mpegurl")) {
    // .ts segment: stream straight through, never buffer.
    return new Response(res.body, {
      status: 200,
      headers: { ...headers, "Content-Type": type || "video/mp2t" },
    });
  }

  const text = await res.text();
  const rewritten = rewritePlaylist(text, remoteUrl);
  return new Response(rewritten, {
    status: 200,
    headers: { ...headers, "Content-Type": "application/vnd.apple.mpegurl" },
  });
}

// --------------------------------------------------------------------------
// Race cards
// --------------------------------------------------------------------------

async function handleRaces(api: string, rawDate: string | null): Promise<Response> {
  const parsed = parseDate(rawDate);
  if ("error" in parsed) {
    return json({ error: parsed.error }, { status: 400 });
  }

  const res = await fetch(`${api}/data/raw_racecard.json`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    return json({ error: `racecard HTTP ${res.status}` }, { status: res.status });
  }
  const card = await res.json<RawRacecard>();

  if (parsed.date !== card.raceDate) {
    return json(
      {
        requested: parsed.date,
        available: card.raceDate,
        note: "no card published for the requested date",
      },
      { status: 404 },
    );
  }

  const races = (card.races ?? []).map((r) => ({
    number: r.race_number,
    name: r.name,
    time: r.startTime,
    distance: r.distance,
    runners: (r.runners ?? []).map((n) => ({
      number: n.position,
      draw: n.drawNumber,
      horse: n.horseName,
      jockey: n.jockeyName,
      trainer: n.trainerName,
      sireDam: n.sireDam,
      rating: n.rating,
      form: n.horseForm,
      description: n.horseDesc,
      weight: n.weight,
      allowance: n.allowance === "null" ? null : n.allowance,
      silk: n.silkImage,
    })),
  }));

  if (races.length === 0) {
    return json(
      {
        date: card.raceDate,
        venue: card.venueName,
        venueCode: card.venueCode,
        races: [],
        note: "card published but contains no races",
      },
      { status: 404 },
    );
  }

  return json(
    {
      date: card.raceDate,
      venue: card.venueName,
      venueCode: card.venueCode,
      races,
    },
    {
      headers: {
        // Cards change as withdrawals and jockey changes land.
        "Cache-Control": "public, max-age=60",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

// --------------------------------------------------------------------------
// Replays
// --------------------------------------------------------------------------

const REPLAY_BASE =
  "https://f000.backblazeb2.com/file/b2cloudvideo/racevideos/Bombay";
const ARCHIVE_PAGE = "https://www.rwitcraces.com/RaceArchives.aspx";

/**
 * Two different date encodings, both from one YYYY-MM-DD:
 *   stamp  (DDMMYY)    -> CDN path segment and mp4 filename, e.g. 101026
 *   archive (DDMMYYYY) -> archive page query, e.g. 10102026
 */
function dateParts(date: string): { stamp: string; archive: string } {
  const [y, m, d] = date.split("-");
  return { stamp: `${d}${m}${y.slice(2)}`, archive: `${d}${m}${y}` };
}

/**
 * Validate a ?date= query param before it reaches any upstream formatter.
 * Unvalidated input allowed things like "garbage" and "2026-1-1" to build a
 * malformed archive URL, surfacing as an upstream HTTP 500.
 */
function parseDate(raw: string | null): { date: string } | { error: string } {
  if (!raw) return { date: todayIst() };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { error: `invalid date ${JSON.stringify(raw)}; expected YYYY-MM-DD` };
  }
  // Reject structurally valid but impossible dates (2026-13-45).
  const probe = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== raw) {
    return { error: `invalid date ${JSON.stringify(raw)}; no such calendar day` };
  }
  return { date: raw };
}

/**
 * Discover which races exist for a date by scraping the archive page, then
 * HEAD each mp4 for its size. Races still uploading are reported as pending.
 */
async function handleReplays(rawDate: string | null): Promise<Response> {
  const parsed = parseDate(rawDate);
  if ("error" in parsed) {
    return json({ error: parsed.error }, { status: 400 });
  }
  const target = parsed.date;
  const { stamp, archive } = dateParts(target);

  const page = await fetch(`${ARCHIVE_PAGE}?d=${archive}`);
  if (!page.ok) {
    return json(
      { error: `archive page HTTP ${page.status}`, date: target },
      { status: page.status >= 500 ? 502 : page.status },
    );
  }
  const html = await page.text();

  // Static lookup table: race number -> name, from the archive's header links.
  const nameByRace: Record<number, string> = {};
  for (const m of html.matchAll(/Race no\. (\d+)\s+-\s+([^<"]+)/g)) {
    nameByRace[Number(m[1])] = m[2].trim();
  }

  // The archive lists rno links for every race, published or not.
  const numbers = new Set<number>();
  for (const m of html.matchAll(/RaceArchives\.aspx\?d=\d+&rno=(\d+)/g)) {
    numbers.add(Number(m[1]));
  }
  const raceNumbers = [...numbers].sort((a, b) => a - b);

  // Probe in parallel but pair each result with its race number, so the
  // response order is race order rather than network completion order.
  const probed = await Promise.all(
    raceNumbers.map(async (race) => {
      const url = `${REPLAY_BASE}/${stamp}/${stamp}-Race${race}.mp4`;
      try {
        const head = await fetch(url, { method: "HEAD" });
        if (head.ok) {
          return {
            race,
            name: nameByRace[race],
            url,
            bytes: Number(head.headers.get("Content-Length") ?? 0),
          };
        }
      } catch {
        // treat a failed probe as "not published yet"
      }
      return null;
    }),
  );

  const replays: Replay[] = [];
  const pending: number[] = [];
  raceNumbers.forEach((race, i) => {
    const result = probed[i];
    if (result) replays.push(result);
    else pending.push(race);
  });

  return json(
    { date: target, count: replays.length, replays, pending },
    {
      headers: {
        // Uploads land 30-50 min after each race, so keep this fresh.
        "Cache-Control": "public, max-age=30",
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}

/** Current date in IST (UTC+5:30), the venue's timezone. */
function todayIst(): string {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/relay-state") return await handleRelayState(request, env);

    // Control plane. The secret path segment keeps the entry unguessable; the
    // relay token never leaves the worker, so the browser only sees proxied
    // status and never the channel or RTMP origin it forwards to.
    const admin = url.pathname.match(/^\/admin\/([0-9a-f]{32,64})(?:\/(control|status|checks))?$/);
    if (admin) {
      if (!env.ADMIN_SECRET || admin[1] !== env.ADMIN_SECRET) {
        return json({ error: "not found" }, { status: 404 });
      }
      if (admin[2] === "checks") {
        if (request.method !== "GET") return json({ error: "method_not_allowed" }, { status: 405 });
        return await adminHealthChecks(env);
      }
      if (admin[2] === "status") {
        if (request.method !== "GET") return json({ error: "method_not_allowed" }, { status: 405 });
        try {
          const status = await relayStatus(env);
          if (!status) return json({ error: "relay_unconfigured" }, { status: 503 });
          return json(status);
        } catch {
          return json({ error: "relay_unreachable", paused: null }, { status: 503 });
        }
      }
      if (admin[2] === "control") {
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });
        return await adminRelayControl(request, env);
      }
      // The bare secret path serves the self-contained panel.
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, { status: 405 });
      return adminPage();
    }
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      return json({ error: "not found" }, { status: 404 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    try {
      if (url.pathname.startsWith("/telegram/")) {
        const response = await handleTelegram(request, env);
        if (response) return response;
      }

      if (url.pathname === "/telegram-login") return telegramLoginPage();
      if (url.pathname === "/api/fixtures") return await fixturesResponse(env);
      if (url.pathname === "/api/stream-status") return await handleLiveStatus(env);
      if (url.pathname === "/live" || url.pathname.startsWith("/live/")) {
        const response = await relayLive(request, env);
        if (response) return response;
        return await handleLive(env, url.pathname.replace(/^\/live\/?/, ""));
      }

      if (url.pathname === "/api/live" || url.pathname.startsWith("/api/live/")) {
        return await handleLive(env, url.pathname.replace(/^\/api\/live\/?/, ""));
      }

      if (url.pathname === "/api/races") {
        return await handleRaces(env.RWITC_API, url.searchParams.get("date"));
      }

      if (url.pathname === "/api/replays") {
        return await handleReplays(url.searchParams.get("date"));
      }

      if (url.pathname === "/mtproto/probe") {
        return await handleProbe(url);
      }

      if (url.pathname === "/healthz") {
        return json({ ok: true, date: todayIst() });
      }

      return json({ error: "not found" }, { status: 404 });
    } catch (err) {
      console.error("unhandled", err);
      return json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }
  },

  /**
   * Runs every 10 minutes. Render's free plan stops the relay after 15 minutes
   * without inbound traffic, which would hide a live Turbo broadcast from it,
   * so the trigger keeps the relay awake between source checks.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(wakeRelay(env).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;

// --------------------------------------------------------------------------
// Response helper (used by every JSON route: uniform content type + indent)
// --------------------------------------------------------------------------

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

class OffDayError extends Error {}

interface StreamRecord {
  race_date: string;
  id?: number;
  createdAt?: string;
  venue_name: string;
  status: string;
  paid_status: string;
  iframe_flag: string;
  stream_url: string;
}

interface Signing {
  keyPairId: string;
  encodedPolicy: string;
  encodedSignature: string;
}

interface LiveContext {
  master: string;
  lambda: string;
  signing: Signing;
}

interface RawRunner {
  position: string;
  drawNumber: string;
  horseName: string;
  jockeyName: string;
  trainerName: string;
  sireDam: string;
  rating: string;
  horseForm: string;
  horseDesc: string;
  weight: string;
  allowance: string;
  silkImage: string;
}

interface RawRace {
  race_number: string;
  name: string;
  startTime: string;
  distance: string;
  runners: RawRunner[];
}

interface RawRacecard {
  raceDate: string;
  venueName: string;
  venueCode: string;
  streamUrl: string | null;
  races: RawRace[];
}

interface Replay {
  race: number;
  name?: string;
  url: string;
  bytes: number;
}
