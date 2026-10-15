import test from 'node:test';
import assert from 'node:assert/strict';
import { handleStreamdesk, handleStreamdeskState } from '../src/streamdesk';
const env: any = { STREAMDESK_ENABLED: 'true', ADMIN_SECRET: 'a'.repeat(48), ADMIN_TOKEN: 'state-secret', RELAY_TOKEN: 'relay-secret', RELAY_ORIGIN: 'https://relay.example', SESSION_ENCRYPTION_KEY: btoa('x'.repeat(32)), ASSETS: { fetch: async () => new Response('<html>desk</html>', { headers: { 'Content-Type': 'text/html' } }) } };
test('streamdesk refuses anonymous API calls', async () => { const r = await handleStreamdesk(new Request('https://desk.example/api/status'), env); assert.equal(r?.status, 401); });
test('streamdesk secret entry issues private cookie without revealing relay token', async () => { const r = await handleStreamdesk(new Request('https://desk.example/admin/' + env.ADMIN_SECRET), env); assert.equal(r?.status, 200); assert.match(r!.headers.get('Set-Cookie')!, /HttpOnly/); assert.doesNotMatch(await r!.text(), /relay-secret|state-secret/); });
test('streamdesk rejects cross-site controls', async () => { const entry = await handleStreamdesk(new Request('https://desk.example/admin/' + env.ADMIN_SECRET), env); const cookie = entry!.headers.get('Set-Cookie')!.split(';')[0]; const r = await handleStreamdesk(new Request('https://desk.example/api/control', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' }), env); assert.equal(r?.status, 403); });
test('private state authenticates before disclosing storage', async () => { const r = await handleStreamdeskState(new Request('https://desk.example/api/streamdesk-state/controls'), env, 'controls'); assert.equal(r.status, 401); });
test('private state refuses unrecognized keys', async () => { const r = await handleStreamdeskState(new Request('https://desk.example/api/streamdesk-state/session', { headers: { Authorization: 'Bearer ' + env.ADMIN_TOKEN } }), env, 'session'); assert.equal(r.status, 404); });
test('streamdesk proxies status with server-only authorization', async () => { const entry = await handleStreamdesk(new Request('https://desk.example/admin/' + env.ADMIN_SECRET), env); const cookie = entry!.headers.get('Set-Cookie')!.split(';')[0]; const original = globalThis.fetch; globalThis.fetch = async (input, options) => { assert.equal(String(input), 'https://relay.example/api/status'); assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer relay-secret'); return Response.json({ phase: 'idle' }); }; try {
    const r = await handleStreamdesk(new Request('https://desk.example/api/status', { headers: { Cookie: cookie } }), env);
    assert.deepEqual(await r!.json(), { phase: 'idle' });
}
finally {
    globalThis.fetch = original;
} });
test('ownership persistence preserves Telegram int64 values exactly', async () => {
    let ciphertext = '';
    const db: any = { withSession() { return this; }, prepare() { return { bind(...args: any[]) { return { run: async () => { ciphertext = args[1]; return { meta: { changes: 1 } }; }, first: async () => ciphertext ? { ciphertext } : null }; } }; } };
    const e = { ...env, DB: db };
    const raw = '{"channel_id":4347395930,"call":{"ID":7263558765432109876,"AccessHash":-8133558765432109876},"random_id":123}';
    const put = await handleStreamdeskState(new Request('https://desk.example/api/streamdesk-state/owned-call', { method: 'PUT', headers: { Authorization: 'Bearer ' + env.ADMIN_TOKEN }, body: raw }), e, 'owned-call');
    assert.equal(put.status, 204);
    const get = await handleStreamdeskState(new Request('https://desk.example/api/streamdesk-state/owned-call', { headers: { Authorization: 'Bearer ' + env.ADMIN_TOKEN } }), e, 'owned-call');
    assert.equal(await get.text(), raw);
    assert.doesNotMatch(ciphertext, /7263558765432109876/);
});
