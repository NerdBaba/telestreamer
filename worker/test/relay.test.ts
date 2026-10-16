import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import worker from '../src/index';
import { fixturesResponse, relayLive, relayStatus } from '../src/relay';


for (const state of [
  { paused: false, forced: null, ready: false, available: false, reason: 'no available source' },
  { paused: false, forced: null, ready: false, available: true, reason: 'explicit input' },
  { paused: false, forced: 'turbosportslive', ready: false, available: false, reason: 'native capture unavailable' },
  { paused: true, forced: null, ready: true, available: true, reason: 'explicit input' },
]) {
  test(`reachable daemon blocks official fallback: ${JSON.stringify(state)}`, async t => {
    const server = createServer((req, res) => {
      if (req.url !== '/api/stream-status' || req.headers.authorization !== 'Bearer private-test-token') {
        res.writeHead(404).end();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        paused: state.paused, forced: state.forced,
        playout: { ready: state.ready, source: state.available ? 'rwitc' : null },
        decision: { available: state.available, reason: state.reason, sources: {} }, fixtures: [],
      }));
    });
    t.after(() => { server.closeAllConnections(); server.close(); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await worker.fetch(new Request('https://worker.example/live/index.m3u8'), {
      RELAY_ORIGIN: `http://127.0.0.1:${address.port}`, RELAY_TOKEN: 'private-test-token',
      // A bypass tries this invalid origin instead of returning the daemon decision.
      RWITC_API: 'http://127.0.0.1:0', RWITC_ORIGIN: 'http://127.0.0.1:0',
    } as Parameters<typeof worker.fetch>[1]);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), { error: state.paused ? 'relay paused' : state.reason });
  });
}

test('only absent or unreachable daemon permits official fallback', async () => {
  assert.equal(await relayLive(new Request('https://worker.example/live/index.m3u8'), {}), null);
  assert.equal(await relayLive(new Request('https://worker.example/live/index.m3u8'), {
    RELAY_ORIGIN: 'http://127.0.0.1:0', RELAY_TOKEN: 'private-test-token',
  }), null);
});

test('Go deployment keeps pause authoritative and proxies authenticated output segments', async t => {
  let paused = true;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url || '');
    if (req.headers.authorization !== 'Bearer private-test-token') {
      res.writeHead(401).end(); return;
    }
    if (req.url === '/api/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ controls: { auto: true, paused, forced: '', fallbacks: ['mysore'] },
        sources: [{ id: 'mysore', title: 'Mysore Race Club', live: true, detail: 'Fresh media' }],
        phase: paused ? 'paused' : 'live', active: paused ? '' : 'mysore', error: '' }));
    } else if (req.url === '/output/index.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXTINF:2,\ns000000017.ts\n');
    } else if (req.url === '/output/s000000017.ts') {
      res.setHeader('Content-Type', 'video/mp2t'); res.end('segment-data');
    } else res.writeHead(404).end();
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const env = { RELAY_ORIGIN: `http://127.0.0.1:${address.port}`, RELAY_TOKEN: 'private-test-token', STREAMDESK_ENABLED: 'true' };
  const request = (name = 'index.m3u8') => relayLive(new Request(`https://worker.example/live/${name}`), env);
  const blocked = await request(); assert.equal(blocked?.status, 503);
  assert.deepEqual(await blocked?.json(), { error: 'relay paused' });
  assert.deepEqual(seen, ['/api/status']);
  paused = false;
  const status = await relayStatus(env);
  assert.equal(status?.playout.source, 'mysore'); assert.equal(status?.playout.ready, true);
  assert.equal(status?.publishing.running, true);
  const playlist = await request(); assert.equal(playlist?.status, 200);
  assert.match(await playlist!.text(), /\/live\/s000000017\.ts/);
  const segment = await request('s000000017.ts'); assert.equal(await segment!.text(), 'segment-data');
  assert.equal((await request('private.json'))?.status, 404);
});

test('Go deployment still fetches the official racing calendar', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    assert.equal(String(input), 'https://www.rwitc.com/rwitc_website_api/fetchCalendar_get_api.php');
    const start = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    return Response.json({ data: [{ start, title: 'Racing' }] });
  };
  try {
    const response = await fixturesResponse({ STREAMDESK_ENABLED: 'true', RELAY_ORIGIN: 'https://private.example', RELAY_TOKEN: 'test' });
    const body = await response.json() as { source: string; meetings: unknown[] };
    assert.equal(body.source, 'calendar'); assert.equal(body.meetings.length, 1);
  } finally { globalThis.fetch = original; }
});
