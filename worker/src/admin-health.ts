import type { RelayEnv } from './relay';

interface Check {
  state: 'ok' | 'error' | 'unknown';
  code: 'ok' | 'not_configured' | 'unreachable' | 'http_error' | 'invalid_response' | 'too_large';
  http_status?: number;
  stream_count?: number;
  stream_ids?: string[];
}

type Details = Pick<Check, 'stream_count' | 'stream_ids'>;
type Component = 'relay' | 'space' | 'playlist';
const MAX_BYTES = 64 * 1024;
const DEADLINE_MS = 5000;

class TooLarge extends Error {}
class InvalidResponse extends Error {}

function configuredUrl(value: string, component: Component): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new InvalidResponse();
  }
  if (component === 'playlist') {
    // Never let a misconfigured check start an ingest by requesting media.
    if (!/^\/p\/[^/]+\/playlist\.m3u$/.test(url.pathname) || url.search || url.hash) {
      throw new InvalidResponse();
    }
    return url;
  }
  return new URL(component === 'relay' ? '/healthz' : '/health', url);
}

/** Read at most 64 KiB, including chunked responses without a length header. */
async function boundedText(response: Response): Promise<string> {
  if (Number(response.headers.get('Content-Length')) > MAX_BYTES) {
    await response.body?.cancel();
    throw new TooLarge();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let size = 0;
  let text = '';
  let finished = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { finished = true; break; }
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) throw new TooLarge();
      try {
        text += decoder.decode(chunk.value, { stream: true });
      } catch {
        throw new InvalidResponse();
      }
    }
    try {
      return text + decoder.decode();
    } catch {
      throw new InvalidResponse();
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function healthDetails(text: string, component: 'relay' | 'space'): Details | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  // The Space proxies TGTV's {status:"ok"}; the relay uses {ok:true}.
  // HTTP 200 must not override an application-reported failure.
  if (body.error || (body.errors && (!Array.isArray(body.errors) || body.errors.length))
      || (component === 'relay' && body.status !== undefined && body.status !== 'ok')
      || (component === 'space' && body.ok !== undefined && body.ok !== true)) return null;
  return (component === 'relay' ? body.ok === true : body.status === 'ok') ? {} : null;
}

function playlistDetails(text: string, playlist: URL): Details | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.shift()?.trim() !== '#EXTM3U') return null;
  const prefix = playlist.pathname.slice(0, -'playlist.m3u'.length);
  const ids = new Set<string>();
  let awaitingUri = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      if (awaitingUri) return null;
      awaitingUri = true;
      continue;
    }
    if (line.startsWith('#')) continue;
    let url: URL;
    try { url = new URL(line, playlist); } catch { return null; }
    if (url.origin !== playlist.origin || url.username || url.password || url.search || url.hash
        || !url.pathname.startsWith(prefix)) return null;
    const match = /^streams\/([0-9a-f]{12})\/play\.m3u8$/.exec(url.pathname.slice(prefix.length));
    if (!match) return null;
    ids.add(match[1]);
    awaitingUri = false;
  }
  if (awaitingUri) return null;
  return { stream_count: ids.size, stream_ids: [...ids].sort() };
}

async function probe(value: string | undefined, component: Component): Promise<Check> {
  if (!value) return { state: 'unknown', code: 'not_configured' };
  let url: URL;
  try { url = configuredUrl(value, component); } catch {
    return { state: 'error', code: 'invalid_response' };
  }
  const controller = new AbortController();
  // Keep the deadline active until body reading and cancellation finish.
  const timeout = setTimeout(() => controller.abort(), DEADLINE_MS);
  let http_status: number | undefined;
  try {
    const response = await fetch(url, {
      method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { Accept: component === 'playlist' ? 'application/x-mpegurl, audio/mpegurl, text/plain' : 'application/json' },
    });
    http_status = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      return { state: 'error', code: 'http_error', http_status };
    }
    const text = await boundedText(response);
    const details = component === 'playlist' ? playlistDetails(text, url) : healthDetails(text, component);
    return details === null
      ? { state: 'error', code: 'invalid_response', http_status }
      : { state: 'ok', code: 'ok', http_status, ...details };
  } catch (error) {
    const code = error instanceof TooLarge ? 'too_large'
      : error instanceof InvalidResponse ? 'invalid_response' : 'unreachable';
    return { state: 'error', code, ...(http_status === undefined ? {} : { http_status }) };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

/** Independent health/list requests only; neither status nor media is fetched. */
export async function adminHealthChecks(env: RelayEnv): Promise<Response> {
  const [relay, video] = await Promise.all([relayCheck(env), videoChecks(env)]);
  return Response.json({ checked_at: new Date().toISOString(), checks: { ...relay, ...video } }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

/** Relay liveness only: safe to poll often, hits Render, never the video host. */
export async function adminRelayCheck(env: RelayEnv): Promise<Response> {
  return Response.json({ checked_at: new Date().toISOString(), checks: await relayCheck(env) }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

/** Video host checks only, polled less often than the relay. */
export async function adminVideoChecks(env: RelayEnv): Promise<Response> {
  return Response.json({ checked_at: new Date().toISOString(), checks: await videoChecks(env) }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function relayCheck(env: RelayEnv): Promise<{ relay: Check }> {
  return { relay: await probe(env.RELAY_ORIGIN, 'relay') };
}

async function videoChecks(env: RelayEnv): Promise<{ space: Check; playlist: Check }> {
  const [space, playlist] = await Promise.all([
    probe(env.CAPTURE_ORIGIN, 'space'),
    probe(env.CAPTURE_PLAYLIST_URL, 'playlist'),
  ]);
  return { space, playlist };
}
