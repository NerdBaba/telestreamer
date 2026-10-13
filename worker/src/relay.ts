export interface RelayEnv {
  RELAY_ORIGIN?: string;
  RELAY_TOKEN?: string;
  /** Unguessable path segment for the admin page; absence disables the panel. */
  ADMIN_SECRET?: string;
}

interface RelayStatus {
  paused: boolean;
  forced: string | null;
  auto_start: boolean;
  selected_chat_id: number | null;
  pending_reason: string | null;
  playout: { ready: boolean; source: string | null; pid?: number | null };
  publishing: { state: string; running: boolean };
  decision: {
    available: boolean;
    reason: string;
    sources: Record<string, unknown>;
    chat_id?: number | null;
  };
  // Every broadcast channel the relay can see, minus its own output.
  broadcasts: Array<{
    chat_id: number;
    title: string;
    username: string | null;
    live: boolean;
    rtmp: boolean;
    scheduled: boolean;
    stream_id: string;
    preview_url?: string | null;
  }>;
  fixtures: Array<{ date: string; title: string }>;
}

export async function relayStatus(env: RelayEnv): Promise<RelayStatus | null> {
  if (!env.RELAY_ORIGIN || !env.RELAY_TOKEN) return null;
  const response = await fetch(new URL('/api/stream-status', env.RELAY_ORIGIN), {
    headers: { Authorization: `Bearer ${env.RELAY_TOKEN}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`relay status HTTP ${response.status}`);
  return response.json<RelayStatus>();
}

/**
 * Render's free plan stops a service after 15 minutes without inbound traffic,
 * and a stopped relay cannot notice a live Turbo broadcast, so the scheduled
 * trigger must generate traffic. `/healthz` is unauthenticated and reports
 * configuration presence only, so this neither sends nor exposes a secret.
 */
export async function wakeRelay(env: RelayEnv): Promise<boolean> {
  if (!env.RELAY_ORIGIN) return false;
  try {
    const response = await fetch(new URL('/healthz', env.RELAY_ORIGIN), {
      signal: AbortSignal.timeout(15000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Null means there is no reachable daemon; the caller can use official HLS. */
export async function relayLive(request: Request, env: RelayEnv): Promise<Response | null> {
  let status: RelayStatus | null;
  try {
    status = await relayStatus(env);
  } catch {
    return null;
  }
  if (!status) return null;
  if (status.paused || !status.playout.ready) {
    return Response.json({ error: status.paused ? 'relay paused' : status.decision.reason },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
  const path = new URL(request.url).pathname;
  const name = path.replace(/^\/live\/?/, '') || 'index.m3u8';
  if (!/^(?:index\.m3u8|\d+\.ts)$/.test(name)) {
    return Response.json({ error: 'not found' }, { status: 404 });
  }
  const upstream = new URL(`/live/${name}`, env.RELAY_ORIGIN);
  const response = await fetch(upstream, { signal: AbortSignal.timeout(15000) });
  const headers = {
    'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*',
    'Content-Type': response.headers.get('Content-Type') || 'video/mp2t',
  };
  if (!response.ok || !name.endsWith('.m3u8')) {
    return new Response(response.body, { status: response.status, headers });
  }
  const playlist = (await response.text()).split('\n').map(line => {
    if (!line || line.startsWith('#')) return line;
    const url = new URL(line, upstream);
    return `/live/${url.pathname.split('/').pop()}`;
  }).join('\n');
  return new Response(playlist, { headers });
}

export async function fixturesResponse(env: RelayEnv): Promise<Response> {
  try {
    const status = await relayStatus(env);
    if (status) return Response.json({ meetings: status.fixtures, source: 'relay' });
  } catch {
    // Calendar remains readable even while the playout daemon is offline.
  }
  const response = await fetch('https://www.rwitc.com/rwitc_website_api/fetchCalendar_get_api.php', {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; rrr-relay/1.0)' },
  });
  if (!response.ok) return Response.json({ error: 'calendar unavailable' }, { status: 502 });
  const payload = await response.json<{ data?: Array<{ start?: string; title?: string }> } | Array<{ start?: string; title?: string }>>();
  const rows = Array.isArray(payload) ? payload : payload.data || [];
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 19800000 + 14 * 86400000).toISOString().slice(0, 10);
  const seen = new Set<string>();
  const meetings = rows.flatMap(row => {
    const date = row.start;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > horizon) return [];
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return [];
    const title = row.title || 'Racing';
    const key = `${date}|${title}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ date, title }];
  }).sort((a, b) => a.date.localeCompare(b.date));
  return Response.json({ meetings, source: 'calendar' }, { headers: { 'Cache-Control': 'max-age=300' } });
}
