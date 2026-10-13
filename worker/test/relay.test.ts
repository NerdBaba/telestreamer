import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import worker from '../src/index';
import { relayLive } from '../src/relay';


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
