import type { TelegramEnv } from './mtproto/telegram';

interface RelayState {
  paused: boolean;
  forced: null | 'rwitc' | 'turbosportslive';
  auto_start: boolean;
  selected_chat_id: number | null;
}

function validState(value: unknown): value is RelayState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return Object.keys(state).length === 4 && typeof state.paused === 'boolean'
    && typeof state.auto_start === 'boolean'
    && Object.hasOwn(state, 'forced')
    && (state.forced === null || state.forced === 'rwitc' || state.forced === 'turbosportslive')
    && (state.selected_chat_id === null
      || (typeof state.selected_chat_id === 'number'
        && Number.isSafeInteger(state.selected_chat_id) && state.selected_chat_id > 0));
}

export async function handleRelayState(request: Request, env: TelegramEnv): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  // Authenticate before disclosing binding/schema availability or method details.
  const supplied = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1] ?? '';
  const encoder = new TextEncoder();
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(env.ADMIN_TOKEN ?? '')),
    crypto.subtle.digest('SHA-256', encoder.encode(supplied)),
  ]);
  const expected = new Uint8Array(expectedHash);
  const actual = new Uint8Array(suppliedHash);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ actual[i];
  if (!env.ADMIN_TOKEN || !supplied || difference !== 0) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers });
  }
  if (request.method !== 'GET' && request.method !== 'PUT') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { ...headers, Allow: 'GET, PUT' } });
  }
  if (!env.DB) return Response.json({ error: 'state_unavailable' }, { status: 503, headers });
  let state: RelayState | undefined;
  if (request.method === 'PUT') {
    const chunks: Uint8Array[] = [];
    const reader = request.body?.getReader();
    let length = 0;
    try {
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 4096) {
            await reader.cancel();
            return Response.json({ error: 'body_too_large' }, { status: 413, headers });
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
      if (!validState(parsed)) throw new Error('invalid state');
      state = {
        paused: parsed.paused, forced: parsed.forced, auto_start: parsed.auto_start,
        selected_chat_id: parsed.selected_chat_id,
      };
    } catch {
      return Response.json({ error: 'invalid_state' }, { status: 400, headers });
    } finally { reader?.releaseLock(); }
  }
  try {
    const db = env.DB.withSession('first-primary');
    if (state) {
      await db.prepare(`INSERT INTO relay_state
        (id, paused, forced, auto_start, selected_chat_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET paused = excluded.paused, forced = excluded.forced,
          auto_start = excluded.auto_start, selected_chat_id = excluded.selected_chat_id,
          updated_at = excluded.updated_at`)
        .bind('primary', state.paused ? 1 : 0, state.forced, state.auto_start ? 1 : 0,
          state.selected_chat_id, Date.now()).run();
      return Response.json(state, { headers });
    }
    const row = await db.prepare(
      'SELECT paused, forced, auto_start, selected_chat_id FROM relay_state WHERE id = ?',
    ).bind('primary')
      .first<{ paused: number; forced: unknown; auto_start: number; selected_chat_id: number | null }>();
    if (!row) {
      return Response.json({ paused: false, forced: null, auto_start: true, selected_chat_id: null }, { headers });
    }
    if (row.paused !== 0 && row.paused !== 1) throw new Error('invalid stored state');
    if (row.auto_start !== 0 && row.auto_start !== 1) throw new Error('invalid stored state');
    const loaded = {
      paused: row.paused === 1, forced: row.forced, auto_start: row.auto_start === 1,
      selected_chat_id: row.selected_chat_id,
    };
    if (!validState(loaded)) throw new Error('invalid stored state');
    return Response.json(loaded, { headers });
  } catch {
    return Response.json({ error: 'state_unavailable' }, { status: 503, headers });
  }
}
