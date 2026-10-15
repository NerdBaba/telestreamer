/** Workers hosts the private UI and encrypted durable state; Render owns media. */
export interface StreamdeskEnv {
    STREAMDESK_ENABLED?: string;
    ADMIN_SECRET?: string;
    ADMIN_TOKEN?: string;
    RELAY_TOKEN?: string;
    RELAY_ORIGIN?: string;
    SESSION_ENCRYPTION_KEY?: string;
    ASSETS?: Fetcher;
    DB?: D1Database;
}
const privateHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
async function digest(value: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), v => v.toString(16).padStart(2, '0')).join(''); }
async function equal(a: string, b: string): Promise<boolean> { const [x, y] = await Promise.all([digest(a), digest(b)]); let n = 0; for (let i = 0; i < x.length; i++)
    n |= x.charCodeAt(i) ^ y.charCodeAt(i); return n === 0; }
async function cookieValue(env: StreamdeskEnv) { return digest('streamdesk:' + env.ADMIN_SECRET + ':' + env.SESSION_ENCRYPTION_KEY); }
async function authenticated(request: Request, env: StreamdeskEnv) { const cookie = request.headers.get('Cookie')?.match(/(?:^|;\s*)streamdesk_admin=([a-f0-9]{64})(?:;|$)/)?.[1] || ''; return !!cookie && equal(cookie, await cookieValue(env)); }
function sameOrigin(request: Request) { if (request.headers.get('Sec-Fetch-Site') === 'cross-site')
    return false; const origin = request.headers.get('Origin'); return !origin || origin === new URL(request.url).origin || (origin === 'null' && request.headers.get('Sec-Fetch-Site') === 'same-origin'); }
async function boundedText(request: Request): Promise<string> { const reader = request.body?.getReader(); if (!reader)
    throw new Error(); const chunks: Uint8Array[] = []; let size = 0; try {
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        size += value.byteLength;
        if (size > 16384) {
            await reader.cancel();
            throw new Error();
        }
        ;
        chunks.push(value);
    }
}
finally {
    reader.releaseLock();
} const bytes = new Uint8Array(size); let offset = 0; for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
} ; return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
async function boundedJSON(request: Request): Promise<any> { return JSON.parse(await boundedText(request)); }
async function asset(request: Request, env: StreamdeskEnv, path: string) { if (!env.ASSETS)
    return new Response('Assets unavailable', { status: 503 }); const result = await env.ASSETS.fetch(new Request(new URL(path, request.url))); const headers = new Headers(result.headers); for (const [k, v] of Object.entries(privateHeaders))
    headers.set(k, v); headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; connect-src 'self'; img-src 'self' data:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'"); return new Response(result.body, { status: result.status, headers }); }
export async function handleStreamdesk(request: Request, env: StreamdeskEnv): Promise<Response | null> {
    if (env.STREAMDESK_ENABLED !== 'true')
        return null;
    const path = new URL(request.url).pathname;
    const entry = path.match(/^\/admin\/([a-f0-9]{32,64})\/?$/);
    if (entry) {
        if (!env.ADMIN_SECRET || !await equal(entry[1], env.ADMIN_SECRET))
            return new Response('Not found', { status: 404 });
        const response = await asset(request, env, '/index.html');
        response.headers.set('Set-Cookie', `streamdesk_admin=${await cookieValue(env)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`);
        return response;
    }
    const routes = ['/', '/login', '/app.css', '/app.js', '/hls.min.js', '/HLS-LICENSE.txt', '/api/status', '/api/control', '/source.tar.gz'];
    if (!routes.includes(path) && !path.startsWith('/preview/') && !path.startsWith('/output/'))
        return null;
    if (path === '/app.css' && request.method === 'GET')
        return asset(request, env, path);
    if (path === '/login') {
        if (request.method === 'GET')
            return asset(request, env, '/login.html');
        if (request.method !== 'POST')
            return new Response('Method not allowed', { status: 405 });
        if (!sameOrigin(request))
            return new Response('Cross-site request refused', { status: 403 });
        const size = Number(request.headers.get('Content-Length') || 0);
        if (size > 4096)
            return new Response('Too large', { status: 413 });
        const form = await request.formData();
        if (!env.ADMIN_SECRET || !await equal(String(form.get('token') || ''), env.ADMIN_SECRET))
            return new Response('Invalid admin token', { status: 401 });
        return new Response(null, { status: 303, headers: { ...privateHeaders, Location: '/', 'Set-Cookie': `streamdesk_admin=${await cookieValue(env)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400` } });
    }
    if (!await authenticated(request, env))
        return path === '/' ? Response.redirect(new URL('/login', request.url).href, 303) : new Response('Authentication required', { status: 401, headers: privateHeaders });
    if (path === '/')
        return asset(request, env, '/index.html');
    if (['/app.js', '/hls.min.js', '/HLS-LICENSE.txt'].includes(path))
        return asset(request, env, path);
    const write = path === '/api/control';
    if (request.method !== (write ? 'POST' : 'GET'))
        return new Response('Method not allowed', { status: 405 });
    if (write && (!sameOrigin(request) || !request.headers.get('Content-Type')?.startsWith('application/json')))
        return new Response('Cross-site request refused', { status: 403 });
    if (!env.RELAY_ORIGIN || !env.RELAY_TOKEN)
        return new Response('Relay not configured', { status: 503, headers: privateHeaders });
    let body: string | undefined;
    if (write) {
        try {
            body = JSON.stringify(await boundedJSON(request));
        }
        catch {
            return new Response('Invalid controls', { status: 400 });
        }
    }
    const headers: Record<string, string> = { Authorization: 'Bearer ' + env.RELAY_TOKEN };
    if (write)
        headers['Content-Type'] = 'application/json';
    const range = request.headers.get('Range');
    if (range)
        headers.Range = range;
    try {
        const upstream = await fetch(new URL(path + new URL(request.url).search, env.RELAY_ORIGIN).href, { method: request.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(45000) });
        if (upstream.status >= 300 && upstream.status < 400)
            return new Response('Unexpected relay redirect', { status: 502, headers: privateHeaders });
        const out = new Headers(upstream.headers);
        out.delete('Set-Cookie');
        out.delete('Access-Control-Allow-Origin');
        for (const [k, v] of Object.entries(privateHeaders))
            out.set(k, v);
        return new Response(upstream.body, { status: upstream.status, headers: out });
    }
    catch {
        return new Response('Relay is starting or unavailable', { status: 503, headers: privateHeaders });
    }
}
async function encryptionKey(env: StreamdeskEnv) { const bytes = Uint8Array.from(atob(env.SESSION_ENCRYPTION_KEY || ''), c => c.charCodeAt(0)); if (bytes.length !== 32)
    throw new Error(); return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function seal(value: unknown, name: string, env: StreamdeskEnv) { const key = await encryptionKey(env); const iv = crypto.getRandomValues(new Uint8Array(12)); const result = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('streamdesk:' + name) }, key, new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)))); return btoa(String.fromCharCode(...iv)) + '.' + btoa(String.fromCharCode(...result)); }
async function open(value: string, name: string, env: StreamdeskEnv) { const [a, b] = value.split('.'); const iv = Uint8Array.from(atob(a), c => c.charCodeAt(0)); const data = Uint8Array.from(atob(b), c => c.charCodeAt(0)); return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('streamdesk:' + name) }, await encryptionKey(env), data)); }
export async function handleStreamdeskState(request: Request, env: StreamdeskEnv, name: string): Promise<Response> {
    const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1] || '';
    if (!env.ADMIN_TOKEN || !token || !await equal(token, env.ADMIN_TOKEN))
        return new Response('Unauthorized', { status: 401, headers: privateHeaders });
    if (!['controls', 'owned-call', 'lease'].includes(name))
        return new Response('Not found', { status: 404 });
    if (!env.DB)
        return new Response('Storage unavailable', { status: 503 });
    try {
        const db = env.DB.withSession('first-primary');
        if (name === 'lease') {
            if (request.method !== 'POST')
                return new Response('Method not allowed', { status: 405 });
            const body = await boundedJSON(request);
            if (!/^[a-f0-9]{32}$/.test(body.owner) || !['acquire', 'release'].includes(body.action))
                return new Response('Invalid lease', { status: 400 });
            const now = Date.now();
            let result;
            if (body.action === 'release')
                result = await db.prepare('UPDATE streamdesk_lease SET expires_at=0 WHERE id=1 AND owner=?').bind(body.owner).run();
            else
                result = await db.prepare('INSERT INTO streamdesk_lease(id,owner,expires_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE streamdesk_lease.expires_at < ? OR streamdesk_lease.owner = ?').bind(body.owner, now + 60000, now, body.owner).run();
            return new Response(null, { status: body.action === 'release' || result.meta.changes === 1 ? 204 : 409, headers: privateHeaders });
        }
        if (request.method === 'GET') {
            const row = await db.prepare('SELECT ciphertext FROM streamdesk_state WHERE name=?').bind(name).first<{
                ciphertext: string;
            }>();
            return row ? new Response(await open(row.ciphertext, name, env), { headers: { ...privateHeaders, 'Content-Type': 'application/json' } }) : new Response('Not found', { status: 404, headers: privateHeaders });
        }
        if (request.method !== 'PUT')
            return new Response('Method not allowed', { status: 405 });
        const raw = await boundedText(request);
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return new Response('Invalid state', { status: 400 });
        if (name === 'controls' && (typeof value.auto !== 'boolean' || typeof value.paused !== 'boolean' || typeof value.forced !== 'string' || !Array.isArray(value.fallbacks) || value.fallbacks.length > 128 || value.fallbacks.some((v: unknown) => typeof v !== 'string' || v.length > 64)))
            return new Response('Invalid controls', { status: 400 });
        if (name === 'owned-call' && value.channel_id !== 4347395930)
            return new Response('Invalid channel', { status: 400 });
        await db.prepare('INSERT INTO streamdesk_state(name,ciphertext,updated_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at').bind(name, await seal(raw, name, env), Date.now()).run();
        return new Response(null, { status: 204, headers: privateHeaders });
    }
    catch {
        return new Response('Durable state unavailable', { status: 503, headers: privateHeaders });
    }
}
