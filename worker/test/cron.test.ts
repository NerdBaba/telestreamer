import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import worker from '../src/index';

/**
 * Render Free stops a service after 15 minutes without inbound traffic, and a
 * stopped relay cannot notice a live Turbo broadcast. The scheduled trigger
 * must therefore reach the relay, and must stay quiet when unconfigured.
 */
async function healthStub(t: { after(fn: () => void): void }) {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? '');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { seen, env: { RELAY_ORIGIN: `http://127.0.0.1:${address.port}`, RELAY_TOKEN: 't'.repeat(24) } };
}

const CRON = { cron: '*/10 * * * *', scheduledTime: Date.now(), noRetry: () => {} };

test('scheduled trigger reaches the relay so a live broadcast can auto-start', async t => {
  const relay = await healthStub(t);
  const pending: Promise<unknown>[] = [];
  await worker.scheduled!(CRON, relay.env, { waitUntil: promise => pending.push(promise) });
  await Promise.all(pending);
  assert.deepEqual(relay.seen, ['/healthz']);
});

test('scheduled trigger is a no-op without a configured relay', async () => {
  const pending: Promise<unknown>[] = [];
  await worker.scheduled!(
    CRON,
    { RELAY_ORIGIN: undefined, RELAY_TOKEN: undefined } as never,
    { waitUntil: promise => pending.push(promise) },
  );
  await Promise.all(pending);
});
