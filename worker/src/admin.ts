import type { RelayEnv } from './relay';

const ENTRY_VERSION = '1';

interface AdminControl {
  paused: boolean;
  auto_start: boolean;
  forced: string | null;
}

type ControlAction =
  | { action: 'pause' | 'resume' | 'stop' }
  | { action: 'force'; source: 'rwitc' | 'turbosportslive' }
  | { action: 'auto' }
  | { action: 'auto_start'; enabled: boolean };

/** Control writes never carry the worker token to the browser. */
export async function adminRelayControl(request: Request, env: RelayEnv): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store' };
  if (!env.RELAY_ORIGIN || !env.RELAY_TOKEN) {
    return Response.json({ error: 'relay_unconfigured' }, { status: 503, headers });
  }
  let body: ControlAction;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object');
    const candidate = parsed as Record<string, unknown>;
    if (candidate.action === 'pause' || candidate.action === 'resume'
        || candidate.action === 'stop' || candidate.action === 'auto') {
      body = { action: candidate.action };
    } else if (candidate.action === 'force') {
      if (candidate.source !== 'rwitc' && candidate.source !== 'turbosportslive') {
        throw new Error('bad source');
      }
      body = { action: 'force', source: candidate.source };
    } else if (candidate.action === 'auto_start') {
      if (typeof candidate.enabled !== 'boolean') throw new Error('bad enabled');
      body = { action: 'auto_start', enabled: candidate.enabled };
    } else {
      throw new Error('bad action');
    }
  } catch {
    return Response.json({ error: 'invalid_request' }, { status: 400, headers });
  }
  const upstream = await fetch(new URL('/api/control', env.RELAY_ORIGIN), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RELAY_TOKEN}`,
      'Content-Type': 'application/json',
      'Content-Length': String(JSON.stringify(body).length),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!upstream.ok) {
    return Response.json({ error: 'relay_refused', status: upstream.status },
      { status: 502, headers });
  }
  const payload = await upstream.json<AdminControl & Record<string, unknown>>();
  return Response.json(payload, { headers });
}

/**
 * Self-contained admin page. Deliberately shows no channel identity, RTMP
 * host, or relay origin: those live in worker secrets and never reach a
 * browser. Every action goes through the worker, so the admin token stays
 * server-side even though this page is public at an unguessable path.
 */
export function adminPage(entryVersion: string = ENTRY_VERSION): Response {
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Relay control</title>
<style>
:root{--fg:currentColor;--muted:var(--muted);--border:var(--border);--surface:var(--surface);
--c1:var(--c1);--c5:var(--c5);--c6:var(--c6)}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 ui-sans-serif,system-ui,sans-serif;padding:24px 18px 60px;max-width:860px;margin-inline:auto}
h1{font-size:21px;margin:0 0 2px}header p{color:var(--muted);margin:0 0 20px;font-size:13.5px}
section{border:1px solid var(--border);border-radius:11px;background:var(--surface);padding:15px 16px;margin-bottom:14px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:0 0 11px}
.row{display:flex;gap:9px;flex-wrap:wrap}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--fg);cursor:pointer}
button:hover{border-color:var(--c1)}
button:disabled{opacity:.45;cursor:not-allowed}
button.on{background:var(--c1);border-color:var(--c1);color:#fff}
#state{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:12px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--muted);display:inline-block;margin-right:6px}
.dot.live{background:var(--c5)}.dot.err{background:var(--c6)}
#reason{font-size:13.5px;color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--border)}
th{color:var(--muted);font-weight:500;font-size:12px}
.tag{font-size:11.5px;padding:2px 8px;border-radius:99px;border:1px solid var(--border);color:var(--muted)}
.tag.live{color:var(--c5);border-color:var(--c5)}
#log{font:12.5px ui-monospace,monospace;color:var(--muted);white-space:pre-wrap;margin:0}
.muted{color:var(--muted);font-size:12.5px}
</style></head><body>
<header><h1>Relay control</h1><p>Live status, source selection, and restream controls.</p></header>

<section><h2>State</h2>
<div id="state"><span><span class="dot" id="dot"></span><span id="live">checking</span></span>
<span class="tag" id="source">—</span><span id="reason" class="muted"></span></div>
<div class="row">
<button id="pause">Pause</button><button id="resume">Resume</button><button id="stop">Stop</button>
</div></section>

<section><h2>Source</h2>
<div class="row">
<button id="auto">Automatic (Turbo first)</button><button id="force-turbo">Turbo</button>
<button id="force-rwitc">Official stream</button>
</div>
<p class="muted" style="margin:10px 0 0">Automatic plays Turbo while it broadcasts and falls back to the official stream when it is quiet.</p></section>

<section><h2>Automatic start</h2>
<div class="row"><button id="autostart">Auto-start: loading</button></div>
<p class="muted" style="margin:10px 0 0">With auto-start on, a live source opens the restream on its own.</p></section>

<section><h2>Fixtures</h2><div id="fixtures"><p class="muted">Loading race calendar.</p></div></section>

<section><h2>Activity</h2><p id="log">Waiting.</p></section>

<script>
const el = id => document.getElementById(id);
const state = { paused: false, auto_start: true, forced: null, live: false, reason: '', source: null, fixtures: [] };

async function call(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(await response.text().catch(() => 'failed'));
  return response;
}

async function refresh() {
  try {
    const [status, fixtures] = await Promise.all([
      call('/api/admin/status').then(r => r.json()),
      call('/api/fixtures').then(r => r.json()),
    ]);
    state.paused = status.paused; state.auto_start = status.auto_start; state.forced = status.forced;
    state.live = Boolean(status.playout && status.playout.ready);
    state.reason = status.decision && status.decision.reason;
    state.source = status.playout && status.playout.source;
    state.fixtures = fixtures.meetings || [];
    render();
    el('log').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (error) {
    el('dot').className = 'dot err';
    el('live').textContent = 'unreachable';
    el('log').textContent = 'Status failed: ' + error.message;
  }
}

function render() {
  el('dot').className = 'dot' + (state.paused ? '' : state.live ? ' live' : '');
  el('live').textContent = state.paused ? 'paused' : state.live ? 'live' : 'idle';
  el('source').textContent = state.source || 'none';
  el('reason').textContent = state.reason || '';
  el('pause').classList.toggle('on', state.paused);
  el('autostart').textContent = 'Auto-start: ' + (state.auto_start ? 'on' : 'off');
  el('autostart').classList.toggle('on', state.auto_start);
  for (const id of ['auto', 'force-turbo', 'force-rwitc']) el(id).classList.remove('on');
  el(state.forced === 'turbosportslive' ? 'force-turbo'
    : state.forced === 'rwitc' ? 'force-rwitc' : 'auto').classList.add('on');
  el('fixtures').innerHTML = state.fixtures.length
    ? '<table><tr><th>Date</th><th>Meeting</th></tr>'
      + state.fixtures.map(m => '<tr><td>' + m.date + '</td><td>'
        + (m.title || 'Racing').replace(/[<>&]/g, '') + '</td></tr>').join('') + '</table>'
    : '<p class="muted">No upcoming meetings in the calendar.</p>';
}

async function control(body) {
  try {
    await call('/api/admin/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    el('log').textContent = 'Sent ' + body.action + ' at ' + new Date().toLocaleTimeString();
    await refresh();
  } catch (error) {
    el('log').textContent = 'Control failed: ' + error.message;
  }
}

el('pause').onclick = () => control({ action: 'pause' });
el('resume').onclick = () => control({ action: 'resume' });
el('stop').onclick = () => control({ action: 'stop' });
el('auto').onclick = () => control({ action: 'auto' });
el('force-turbo').onclick = () => control({ action: 'force', source: 'turbosportslive' });
el('force-rwitc').onclick = () => control({ action: 'force', source: 'rwitc' });
el('autostart').onclick = () => control({ action: 'auto_start', enabled: !state.auto_start });

refresh();
setInterval(refresh, 5000);
</script></body></html>`;
  return new Response(page, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
               'X-Admin-Entry': entryVersion, 'Referrer-Policy': 'no-referrer',
               'X-Robots-Tag': 'noindex, nofollow' },
  });
}
