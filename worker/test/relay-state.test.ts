import test from 'node:test';
import assert from 'node:assert/strict';
import { getPlatformProxy } from 'wrangler';
import worker from '../src/index';

const token = 'isolated-relay-state-admin-token';

test('saved controls and selected_chat_id survive independent Worker requests', async () => {
  const platform = await getPlatformProxy<{ DB: D1Database }>({ configPath: 'wrangler.jsonc', persist: false });
  try {
    const env = { ...platform.env, ADMIN_TOKEN: token, RWITC_API: 'https://api.rwitc.com/login', RWITC_ORIGIN: 'https://api.rwitc.com' };
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS relay_state (id TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)), forced TEXT CHECK (forced IN ('rwitc', 'turbosportslive') OR forced IS NULL), auto_start INTEGER NOT NULL DEFAULT 1 CHECK (auto_start IN (0, 1)), selected_chat_id INTEGER CHECK (selected_chat_id IS NULL OR selected_chat_id > 0), updated_at INTEGER NOT NULL DEFAULT 0)`).run();
    await env.DB.prepare("INSERT OR IGNORE INTO relay_state (id) VALUES ('primary')").run();
    const saved = await worker.fetch(new Request('https://relay.test/api/relay-state', {
      method: 'PUT', headers: { Authorization: 'Bearer '+token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: true, forced: 'turbosportslive', auto_start: false, selected_chat_id: 2961901881 }),
    }), env);
    assert.equal(saved.status, 200);
    const loaded = await worker.fetch(new Request('https://relay.test/api/relay-state', {
      headers: { Authorization: 'Bearer '+token },
    }), env);
    assert.equal(loaded.status, 200);
    assert.deepEqual(await loaded.json(), { paused: true, forced: 'turbosportslive', auto_start: false, selected_chat_id: 2961901881 });
    const denied = await worker.fetch(new Request('https://relay.test/api/relay-state', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({paused:false,forced:null,auto_start:true}),
    }), env);
    assert.equal(denied.status, 401);
    const row = await env.DB.prepare("SELECT paused, forced, auto_start, selected_chat_id FROM relay_state WHERE id = 'primary'").first();
    assert.deepEqual(row, { paused: 1, forced: 'turbosportslive', auto_start: 0, selected_chat_id: 2961901881 });
  } finally { await platform.dispose(); }
});

test('state validation, authentication and schema failures do not mutate D1', async () => {
  const platform = await getPlatformProxy<{ DB: D1Database }>({ configPath: 'wrangler.jsonc', persist: false });
  try {
    const env = { ...platform.env, ADMIN_TOKEN: token, RWITC_API: '', RWITC_ORIGIN: '' };
    const request = (method = 'GET', body?: string, authorized = true) => new Request('https://relay.test/api/relay-state', {
      method, headers: authorized ? { Authorization: `Bearer ${token}` } : {},
      ...(body === undefined ? {} : { body }),
    });
    assert.equal((await worker.fetch(request('GET', undefined, false), env)).status, 401);
    assert.equal((await worker.fetch(request(), env)).status, 503);
    await env.DB.prepare(`CREATE TABLE relay_state (id TEXT PRIMARY KEY, paused INTEGER NOT NULL, forced TEXT, auto_start INTEGER NOT NULL, selected_chat_id INTEGER, updated_at INTEGER NOT NULL)`).run();
    assert.deepEqual(await (await worker.fetch(request(), env)).json(), { paused: false, forced: null, auto_start: true, selected_chat_id: null });
    assert.equal((await worker.fetch(request('POST'), env)).status, 405);
    assert.equal((await worker.fetch(request('OPTIONS'), env)).status, 405);
    assert.equal((await worker.fetch(request('PUT', '{"paused":true,"forced":"rwitc","auto_start":false,"selected_chat_id":2291644480}'), env)).status, 200);
    for (const body of [
      '{}', 'null', '[]', '{', '{"paused":1,"forced":null}', '{"paused":false}',
      '{"paused":false,"forced":"other","auto_start":true,"selected_chat_id":null}',
      '{"paused":false,"forced":false,"auto_start":true,"selected_chat_id":null}',
      '{"paused":false,"forced":null,"auto_start":true,"selected_chat_id":null,"extra":0}',
      '{"paused":false,"forced":null,"auto_start":true}',
      '{"paused":false,"forced":null,"auto_start":true,"selected_chat_id":"1"}',
      '{"paused":false,"forced":null,"auto_start":true,"selected_chat_id":1.5}',
      '{"paused":false,"forced":null,"auto_start":true,"selected_chat_id":0}',
      '{"paused":false,"forced":null,"auto_start":true,"selected_chat_id":-1}',
      '{"paused":false,"forced":null,"auto_start":true,"selected_chat_id":9007199254740992}',
      '{"paused":false,"forced":null,"auto_start":true,"selected_chat_id":null,"unknown":true}',
    ]) {
      assert.equal((await worker.fetch(request('PUT', body), env)).status, 400, body);
      assert.deepEqual(await (await worker.fetch(request(), env)).json(), { paused: true, forced: 'rwitc', auto_start: false, selected_chat_id: 2291644480 });
    }
    assert.equal((await worker.fetch(request('PUT', ' '.repeat(4097)), env)).status, 413);
    for (const method of ['GET', 'PUT', 'DELETE']) {
      assert.equal((await worker.fetch(request(method, method === 'PUT' ? '{}' : undefined, false), env)).status, 401);
    }
    assert.equal((await worker.fetch(request('PUT', '{"paused":false,"forced":null,"auto_start":true,"selected_chat_id":null}'), env)).status, 200);
    assert.deepEqual(await (await worker.fetch(request(), env)).json(), { paused: false, forced: null, auto_start: true, selected_chat_id: null });
    await env.DB.prepare('DROP TABLE relay_state').run();
    assert.equal((await worker.fetch(request('PUT', '{"paused":false,"forced":null,"auto_start":true,"selected_chat_id":null}'), env)).status, 503);
  } finally { await platform.dispose(); }
});
