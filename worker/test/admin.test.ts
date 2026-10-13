import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import worker from '../src/index';

const SECRET = 'a'.repeat(48);
const TOKEN = 'isolated-relay-admin-token';

/** Stand-in for the private daemon: only the relay API surface matters here. */
async function relayStub(
  t: { after(fn: () => void): void },
  handler: (body: string | null) => number,
  statusPayload: Record<string, unknown> = { ok: true },
) {
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
      // The status route echoes the relay's real payload; control routes
      // confirm the write. The worker asks the daemon at /api/stream-status.
      const isStatus = /stream-status$/.test(req.url ?? '');
      res.writeHead(status).end(JSON.stringify(isStatus ? statusPayload : { ok: true }));
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

test('selecting a member channel is forwarded only as a well-formed body', async t => {
  // The worker's job is transport: it validates the shape and forwards it.
  // The daemon owns whether selection is currently available.
  const relay = await relayStub(t, body => {
    const parsed = JSON.parse(body ?? '{}') as Record<string, unknown>;
    return parsed.action === 'select_channel' && typeof parsed.chat_id === 'number'
      && Number.isSafeInteger(parsed.chat_id) && parsed.chat_id > 0 ? 200 : 400;
  });
  const select = async (body: unknown) => relay.fetch(`/admin/${SECRET}/control`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await select({ action: 'select_channel', chat_id: 2961901881 })).status, 200);
  for (const rejected of [{ action: 'select_channel' }, { action: 'select_channel', chat_id: '1' },
                          { action: 'select_channel', chat_id: 1.5 },
                          { action: 'select_channel', chat_id: 0 },
                          { action: 'select_channel', chat_id: -1 },
                          { action: 'select_channel', chat_id: -1002291644480 }]) {
    assert.equal((await select(rejected)).status, 400, JSON.stringify(rejected));
  }
  assert.equal(relay.seen.every(entry => entry.auth === `Bearer ${TOKEN}`), true);
  assert.equal(relay.seen.some(entry => entry.body?.includes(TOKEN)), false);
  // Only the well-formed body reaches the daemon.
  assert.equal(relay.seen.filter(e => e.body?.includes('select_channel')).length, 1);
});

test('admin status carries the discovered member channels and no output channel', async t => {
  const channels = [
    { chat_id: 2961901881, title: 'Turbo Sports Hd Live', username: 'TurboSportsLive', live: true, rtmp: true, scheduled: false },
    { chat_id: 2291644480, title: 'Free live india racing', username: null, live: false, rtmp: false, scheduled: false },
  ];
  const relay = await relayStub(t, () => 200, {
    paused: false, forced: null, auto_start: true,
    decision: { chosen: 'turbosportslive', available: true, reason: 'live in Turbo', sources: {}, chat_id: 2961901881 },
    playout: { source: 'turbosportslive', ready: true, url: '/live/index.m3u8', pid: 4242 },
    publishing: { state: 'publishing process running', running: true },
    broadcasts: channels, last_error: null, fixtures: [],
  });
  const page = await relay.fetch(`/admin/${SECRET}`);
  assert.match(await page.text(), /Live sources from your channels/);
  const status = await (await relay.fetch(`/admin/${SECRET}/status`)).json<any>();
  assert.equal(status.broadcasts.length, 2);
  // The panel offers a button only for a live channel.
  assert.equal(status.broadcasts[0].live, true);
  assert.equal(status.broadcasts[1].live, false);
  assert.equal(status.broadcasts.some(row => row.title === 'RRR INDIA LIVE HORSE RACE'), false);
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
