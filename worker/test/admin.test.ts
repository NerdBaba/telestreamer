import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import worker from '../src/index';

const SECRET = 'a'.repeat(48);
const TOKEN = 'isolated-relay-admin-token';

/** Stand-in for the private daemon: only the relay API surface matters here. */
async function relayStub(t: { after(fn: () => void): void }, handler: (body: string | null) => number) {
  const seen: Array<{ method: string; url: string; auth: string; body: string | null }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: String(req.headers.authorization ?? ''),
        body: chunks.length ? Buffer.concat(chunks).toString('utf-8') : null,
      });
      const status = handler(chunks.length ? Buffer.concat(chunks).toString('utf-8') : null);
      if (status === 0) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(status).end(JSON.stringify({ ok: true }));
    });
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const env = {
    RWITC_API: 'https://api.rwitc.com/login', RWITC_ORIGIN: 'https://api.rwitc.com',
    ADMIN_TOKEN: TOKEN, ADMIN_SECRET: SECRET,
    RELAY_ORIGIN: `http://127.0.0.1:${address.port}`, RELAY_TOKEN: TOKEN,
  };
  return {
    seen, origin: `http://127.0.0.1:${address.port}`, env,
    fetch: (path: string, init?: RequestInit) => worker.fetch(
      new Request(`https://control.example${path}`, init), env),
  };
}

test('unknown or missing admin secret never reveals the panel', async t => {
  const relay = await relayStub(t, () => 200);
  for (const path of ['/admin', '/admin/', '/admin/' + 'b'.repeat(48),
                       '/admin/' + SECRET.slice(0, 20), '/admin/' + SECRET.toUpperCase()]) {
    const response = await relay.fetch(path);
    assert.equal(response.status, 404, path);
  }
  assert.deepEqual(relay.seen, [], 'no daemon request may be made for a bad secret');
});

test('admin secret serves a noindex panel and proxies status without leaking the token', async t => {
  const relay = await relayStub(t, () => 200);
  const page = await relay.fetch('/admin/' + SECRET);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Type') ?? '', /text\/html/);
  assert.match(page.headers.get('X-Robots-Tag') ?? '', /noindex/);
  const body = await page.text();
  // No channel, RTMP host, or relay origin belongs on a public page.
  assert.equal(body.includes('rrrliveindia'), false);
  assert.equal(body.includes('rtmp://'), false);
  assert.equal(body.includes(relay.origin), false);
  assert.equal(body.includes(TOKEN), false);

  const status = await relay.fetch('/admin/' + SECRET + '/status');
  assert.equal(status.status, 200);
  assert.deepEqual(relay.seen.map(entry => entry.method), ['GET']);
  assert.equal(relay.seen[0].url, '/api/stream-status');
  assert.equal(relay.seen[0].auth, `Bearer ${TOKEN}`);
  const pageBody = await relay.fetch('/admin/' + SECRET + '/status');
  assert.equal(pageBody.status, 200);
});

test('admin controls forward only canonical actions to the daemon', async t => {
  const relay = await relayStub(t, body => {
    const parsed = JSON.parse(body ?? '{}') as Record<string, unknown>;
    const valid = parsed.action === 'pause' || parsed.action === 'resume' || parsed.action === 'stop'
      || parsed.action === 'auto'
      || (parsed.action === 'force' && (parsed.source === 'rwitc' || parsed.source === 'turbosportslive'))
      || (parsed.action === 'auto_start' && typeof parsed.enabled === 'boolean');
    return valid ? 200 : 400;
  });
  const control = async (body: unknown) => relay.fetch('/admin/' + SECRET + '/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  for (const accepted of [{ action: 'pause' }, { action: 'resume' }, { action: 'stop' },
                          { action: 'auto' }, { action: 'force', source: 'turbosportslive' },
                          { action: 'auto_start', enabled: false }]) {
    assert.equal((await control(accepted)).status, 200, JSON.stringify(accepted));
  }
  for (const rejected of [{}, { action: 'delete' }, { action: 'force', source: 'other' },
                          { action: 'auto_start', enabled: 'yes' }, null]) {
    assert.equal((await control(rejected)).status, 400, JSON.stringify(rejected));
  }
  // Every forwarded body is canonical and the token is only in the header.
  assert.equal(relay.seen.every(entry => entry.auth === `Bearer ${TOKEN}`), true);
  assert.equal(relay.seen.some(entry => entry.body?.includes(TOKEN)), false);
});

test('method mismatch and unreachable daemon fail without exposing internals', async t => {
  const relay = await relayStub(t, () => 200);
  assert.equal((await relay.fetch('/admin/' + SECRET, { method: 'POST' })).status, 405);
  assert.equal((await relay.fetch('/admin/' + SECRET + '/status', { method: 'POST' })).status, 405);
  assert.equal((await relay.fetch('/admin/' + SECRET + '/control', { method: 'GET' })).status, 405);

  const offline = await relayStub(t, () => 0);
  const failed = await offline.fetch('/admin/' + SECRET + '/status');
  assert.equal(failed.status, 503);
  assert.deepEqual(Object.keys(await failed.json<object>()), ['error', 'paused']);
  const refused = await offline.fetch('/admin/' + SECRET + '/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"stop"}',
  });
  assert.equal(refused.status, 502);
});
