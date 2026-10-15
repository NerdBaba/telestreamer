import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import test from 'node:test';
import worker from '../src/index';

const SECRET = 'c'.repeat(48);
const TOKEN = 'private-relay-check-token';
const PLAYBACK_SECRET = 'private-playback-check-token';
const PLAYLIST_PATH = `/p/${PLAYBACK_SECRET}/playlist.m3u`;

type Reply = { status?: number; body: string; headers?: Record<string, string>; leaveOpen?: boolean } | 'disconnect';
type Check = { state: string; code: string; http_status?: number; stream_count?: number; stream_ids?: string[] };
type Checks = { checked_at: string; checks: { relay: Check; space: Check; playlist: Check } };

async function upstream(t: { after(fn: () => void): void }) {
  const replies: Record<string, Reply> = {
    '/healthz': { body: '{"ok":true,"config":{"discover_channels":true}}' },
    '/health': { body: '{"status":"ok"}' },
    [PLAYLIST_PATH]: { body: '#EXTM3U\n' },
  };
  const seen: Array<{ method: string; path: string; auth: string }> = [];
  const closed: Promise<void>[] = [];
  const server = createServer((request, response: ServerResponse) => {
    const path = request.url ?? '';
    seen.push({ method: request.method ?? '', path, auth: String(request.headers.authorization ?? '') });
    closed.push(new Promise<void>(resolve => response.once('close', resolve)));
    const reply = replies[path];
    if (reply === 'disconnect') { response.destroy(); return; }
    if (!reply) { response.writeHead(500).end('Unexpected request: ingestion must never be started'); return; }
    response.writeHead(reply.status ?? 200, reply.headers);
    response.write(reply.body);
    if (!reply.leaveOpen) response.end();
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const env = {
    RWITC_API: 'https://api.rwitc.com/login', RWITC_ORIGIN: 'https://api.rwitc.com',
    ADMIN_TOKEN: TOKEN, ADMIN_SECRET: SECRET, RELAY_TOKEN: TOKEN,
    RELAY_ORIGIN: origin, CAPTURE_ORIGIN: origin, CAPTURE_PLAYLIST_URL: origin + PLAYLIST_PATH,
  };
  const fetchChecks = (overrides = {}, path = `/admin/${SECRET}/checks`, method = 'GET') =>
    worker.fetch(new Request(`https://control.example${path}`, { method }), { ...env, ...overrides });
  const checks = async (overrides = {}): Promise<Checks> => {
    const response = await fetchChecks(overrides);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const text = await response.text();
    for (const secret of [SECRET, TOKEN, PLAYBACK_SECRET, origin, 'https://']) {
      assert.equal(text.includes(secret), false, 'checks must contain no secrets or URLs');
    }
    const result = JSON.parse(text) as Checks;
    assert.ok(Number.isFinite(Date.parse(result.checked_at)));
    return result;
  };
  return { origin, replies, seen, closed, fetchChecks, checks };
}

test('component checks remain independent when relay, Space, or playlist fails', async t => {
  const host = await upstream(t);
  host.replies['/healthz'] = 'disconnect';
  let result = await host.checks();
  assert.deepEqual(result.checks.relay, { state: 'error', code: 'unreachable' });
  assert.equal(result.checks.space.state, 'ok');
  assert.deepEqual(result.checks.playlist, { state: 'ok', code: 'ok', http_status: 200, stream_count: 0, stream_ids: [] });

  host.replies['/healthz'] = { body: '{"ok":true}' };
  host.replies['/health'] = { body: '{"status":"relay_process_exited","error":"https://private.invalid/secret"}' };
  result = await host.checks();
  assert.equal(result.checks.relay.state, 'ok');
  assert.deepEqual(result.checks.space, { state: 'error', code: 'invalid_response', http_status: 200 });
  assert.equal(result.checks.playlist.state, 'ok');

  host.replies['/health'] = { body: '{"status":"ok"}' };
  host.replies[PLAYLIST_PATH] = { status: 503, body: `https://private.invalid/${PLAYBACK_SECRET}` };
  result = await host.checks();
  assert.equal(result.checks.space.state, 'ok');
  assert.deepEqual(result.checks.playlist, { state: 'error', code: 'http_error', http_status: 503 });
  assert.equal(host.seen.every(row => row.method === 'GET' && !row.auth), true);
  assert.equal(host.seen.every(row => ['/healthz', '/health', PLAYLIST_PATH].includes(row.path)), true,
    'health and list checks must never request a media or ingestion route');
});

test('relay and video checks split so the page polls them at different rates', async t => {
  const host = await upstream(t);
  const relayOnly = await host.fetchChecks({}, `/admin/${SECRET}/checks/relay`);
  assert.equal(relayOnly.status, 200);
  const relayBody = await relayOnly.json() as { checks: Record<string, unknown> };
  assert.deepEqual(Object.keys(relayBody.checks).sort(), ['relay']);
  assert.equal(host.seen.every(row => row.path === '/healthz'), true);

  host.seen.length = 0;
  const videoOnly = await host.fetchChecks({}, `/admin/${SECRET}/checks/video`);
  assert.equal(videoOnly.status, 200);
  const videoBody = await videoOnly.json() as { checks: Record<string, unknown> };
  assert.deepEqual(Object.keys(videoBody.checks).sort(), ['playlist', 'space']);
  assert.equal(host.seen.some(row => row.path === '/healthz'), false);
  for (const method of ['POST', 'HEAD', 'OPTIONS']) {
    assert.equal((await host.fetchChecks({}, `/admin/${SECRET}/checks/relay`, method)).status, 405);
    assert.equal((await host.fetchChecks({}, `/admin/${SECRET}/checks/video`, method)).status, 405);
  }
});

test('healthy HTTP requires the actual relay and Space success JSON', async t => {
  const host = await upstream(t);
  for (const body of ['{"ok":false}', '{"ok":"true"}', '{}', 'null', '<html>loading</html>', '{"ok":true,"error":"broken"}']) {
    host.replies['/healthz'] = { body };
    assert.deepEqual((await host.checks()).checks.relay, { state: 'error', code: 'invalid_response', http_status: 200 });
  }
  for (const body of ['{"ok":true}', '{"status":"configuration_required"}', '{"status":"ok","error":"broken"}']) {
    host.replies['/health'] = { body };
    assert.deepEqual((await host.checks()).checks.space, { state: 'error', code: 'invalid_response', http_status: 200 });
  }
});

test('playlist reports only validated IDs and distinguishes an empty list from malformed content', async t => {
  const host = await upstream(t);
  host.replies[PLAYLIST_PATH] = { body: `\uFEFF#EXTM3U\r\n#EXTINF:-1,First\r\n${host.origin}/p/${PLAYBACK_SECRET}/streams/2631340b81ae/play.m3u8\r\n#EXTINF:-1,Second\n/p/${PLAYBACK_SECRET}/streams/486d93b2faa0/play.m3u8\n#EXTINF:-1,Duplicate\n/p/${PLAYBACK_SECRET}/streams/2631340b81ae/play.m3u8\n` };
  assert.deepEqual((await host.checks()).checks.playlist, {
    state: 'ok', code: 'ok', http_status: 200, stream_count: 2, stream_ids: ['2631340b81ae', '486d93b2faa0'],
  });
  host.replies[PLAYLIST_PATH] = { body: '#EXTM3U\n' };
  assert.equal((await host.checks()).checks.playlist.stream_count, 0);
  for (const body of ['', '<html>waking up</html>', '#EXTM3U-not-a-header\n', '#EXTM3U\n#EXTINF:-1,Missing URI\n',
    `#EXTM3U\n/p/${PLAYBACK_SECRET}/streams/not-an-id/play.m3u8\n`, '#EXTM3U\nvideo.ts\n']) {
    host.replies[PLAYLIST_PATH] = { body };
    assert.deepEqual((await host.checks()).checks.playlist, { state: 'error', code: 'invalid_response', http_status: 200 });
  }
  assert.equal(host.seen.some(row => /\/streams\/|\/hls\//.test(row.path)), false);
});

test('secret and method protection make no upstream calls; missing configuration stays unknown', async t => {
  const host = await upstream(t);
  for (const method of ['GET', 'POST', 'OPTIONS']) {
    assert.equal((await host.fetchChecks({}, `/admin/${'d'.repeat(48)}/checks`, method)).status, 404);
  }
  for (const method of ['POST', 'HEAD', 'OPTIONS']) {
    assert.equal((await host.fetchChecks({}, `/admin/${SECRET}/checks`, method)).status, 405);
  }
  assert.deepEqual(host.seen, []);
  const result = await host.checks({ RELAY_ORIGIN: undefined, CAPTURE_ORIGIN: undefined, CAPTURE_PLAYLIST_URL: undefined });
  for (const check of Object.values(result.checks)) assert.deepEqual(check, { state: 'unknown', code: 'not_configured' });
  assert.deepEqual(host.seen, []);

  const invalid = await host.checks({ CAPTURE_PLAYLIST_URL: `${host.origin}/p/${PLAYBACK_SECRET}/streams/2631340b81ae/play.m3u8` });
  assert.deepEqual(invalid.checks.playlist, { state: 'error', code: 'invalid_response' });
  assert.equal(host.seen.some(row => row.path.includes('/streams/')), false);
});

test('oversized and redirected responses are rejected without consuming or following media', { timeout: 12000 }, async t => {
  const host = await upstream(t);
  for (const headers of [{ 'Content-Length': '1000000' }, { 'Transfer-Encoding': 'chunked' }]) {
    host.replies[PLAYLIST_PATH] = { body: '#EXTM3U\n' + 'x'.repeat(65536), headers, leaveOpen: true };
    assert.deepEqual((await host.checks()).checks.playlist, { state: 'error', code: 'too_large', http_status: 200 });
  }
  host.replies[PLAYLIST_PATH] = {
    status: 302, body: PLAYBACK_SECRET,
    headers: { Location: `${host.origin}/p/${PLAYBACK_SECRET}/streams/2631340b81ae/play.m3u8` }, leaveOpen: true,
  };
  assert.deepEqual((await host.checks()).checks.playlist, { state: 'error', code: 'http_error', http_status: 302 });
  assert.equal(host.seen.some(row => row.path.includes('/streams/')), false);
  await Promise.all(host.closed);
});

test('the response deadline includes a body that stalls after healthy headers', { timeout: 12000 }, async t => {
  const host = await upstream(t);
  host.replies['/health'] = { body: '{"status":', leaveOpen: true };
  const started = Date.now();
  const result = await host.checks();
  assert.deepEqual(result.checks.space, { state: 'error', code: 'unreachable', http_status: 200 });
  assert.ok(Date.now() - started < 9000, 'a stalled body must not hold the control page indefinitely');
  assert.equal(result.checks.relay.state, 'ok');
  assert.equal(result.checks.playlist.state, 'ok');
  await Promise.all(host.closed);
});
