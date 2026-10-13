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
  | { action: 'auto_start'; enabled: boolean }
  // Select one live broadcast from a member channel by its Telegram chat id.
  | { action: 'select_channel'; chat_id: number }
  // Discard an empty ended output call that blocks a new RTMP broadcast.
  | { action: 'release_call' };

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
    } else if (candidate.action === 'release_call') {
      body = { action: 'release_call' };
    } else if (candidate.action === 'force') {
      if (candidate.source !== 'rwitc' && candidate.source !== 'turbosportslive') {
        throw new Error('bad source');
      }
      body = { action: 'force', source: candidate.source };
    } else if (candidate.action === 'auto_start') {
      if (typeof candidate.enabled !== 'boolean') throw new Error('bad enabled');
      body = { action: 'auto_start', enabled: candidate.enabled };
    } else if (candidate.action === 'select_channel') {
      // Broadcasts expose the raw positive entity.id, so the contract is a
      // positive safe integer. Marked ids (-100…) and non-integers are never
      // forwarded.
      if (typeof candidate.chat_id !== 'number' || !Number.isSafeInteger(candidate.chat_id)
          || candidate.chat_id <= 0) {
        throw new Error('bad chat_id');
      }
      body = { action: 'select_channel', chat_id: candidate.chat_id };
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
<title>Live relay control</title>
<style>
:root{color-scheme:dark;--page:#0c1214;--surface:#142022;--surface-strong:#1a292b;--line:#34494b;--text:#f1f6f4;--muted:#b4c4c0;--accent:#89e5c7;--accent-ink:#082018;--live:#76e5ac;--danger:#ffb4ad;--danger-ink:#31110e;--focus:#e3ff83;--shadow:0 16px 34px rgb(0 0 0 / .22)}
*{box-sizing:border-box}[hidden]{display:none!important}html{background:var(--page);scroll-behavior:smooth}body{margin:0;background:var(--page);color:var(--text);font:400 16px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
button,a{font:inherit}button{cursor:pointer}button:disabled{cursor:wait;opacity:.62}.skip{position:absolute;inset-block-start:.75rem;inset-inline-start:.75rem;transform:translateY(-180%);background:var(--focus);color:#152010;padding:.65rem .85rem;border-radius:.55rem;font-weight:700;z-index:2}.skip:focus{transform:none}
.shell{width:min(100% - 2rem,70rem);margin-inline:auto;padding-block:1.5rem 3rem}.masthead{display:flex;gap:1rem;align-items:flex-end;justify-content:space-between;margin-block-end:1.5rem}.eyebrow{margin:0 0 .25rem;color:var(--accent);font-size:.75rem;font-weight:750;letter-spacing:.09em;text-transform:uppercase}.masthead h1{margin:0;max-width:18ch;font-size:clamp(2rem,5vw,3.4rem);line-height:1.04;letter-spacing:-.045em;text-wrap:balance}.masthead p{max-width:43ch;margin:.6rem 0 0;color:var(--muted);text-wrap:pretty}.secure{flex:none;margin:0;color:var(--muted);font-size:.8rem}
.workspace{display:grid;gap:1rem}.panel{min-width:0;padding:clamp(1.1rem,3vw,1.6rem);border:1px solid var(--line);border-radius:1.1rem;background:var(--surface);box-shadow:var(--shadow)}.panel-head{display:flex;gap:1rem;align-items:start;justify-content:space-between;margin-block-end:1rem}.panel h2{margin:0;font-size:1.1rem;letter-spacing:-.02em}.help{max-width:62ch;margin:.45rem 0 0;color:var(--muted);font-size:.925rem}.status-panel{background:var(--surface-strong)}.status-line{display:flex;gap:.65rem;align-items:center;margin:0 0 .5rem;font-weight:700}.signal{width:.72rem;height:.72rem;flex:none;border-radius:50%;background:var(--muted);box-shadow:0 0 0 4px rgb(180 196 192 / .12)}.signal.live{background:var(--live);box-shadow:0 0 0 4px rgb(118 229 172 / .14)}.signal.paused{background:var(--accent);box-shadow:0 0 0 4px rgb(137 229 199 / .14)}.signal.offline{background:var(--danger);box-shadow:0 0 0 4px rgb(255 180 173 / .14)}.status-title{margin:0;font-size:clamp(1.35rem,3vw,1.8rem);line-height:1.15;letter-spacing:-.03em}.reason{margin:.45rem 0 0;color:var(--muted);overflow-wrap:anywhere}.summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem;margin:1.2rem 0}.summary div{padding:.75rem;border-radius:.75rem;background:rgb(12 18 20 / .42)}.summary dt{color:var(--muted);font-size:.75rem;font-weight:650;letter-spacing:.07em;text-transform:uppercase}.summary dd{margin:.2rem 0 0;overflow-wrap:anywhere;font-weight:650}
.button-row,.choice-grid,.stream-actions{display:flex;flex-wrap:wrap;gap:.65rem}button,.button-link{display:inline-flex;min-height:2.75rem;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:.72rem;background:transparent;color:var(--text);padding:.65rem .9rem;font-weight:650;line-height:1.1;text-decoration:none;transition:border-color 150ms,color 150ms,background-color 150ms,transform 150ms}.primary{border-color:var(--accent);background:var(--accent);color:var(--accent-ink)}.danger{border-color:var(--danger);color:var(--danger)}.choice{flex:1 1 9rem}.choice.active{border-color:var(--accent);background:rgb(137 229 199 / .12);color:var(--accent)}.button-link{color:var(--accent)}button:focus-visible,a:focus-visible{outline:3px solid var(--focus);outline-offset:3px}@media(hover:hover){button:not(:disabled):hover,.button-link:hover{border-color:var(--accent)}.primary:not(:disabled):hover{background:#b0f4db}.danger:not(:disabled):hover{background:rgb(255 180 173 / .12)}button:not(:disabled):active,.button-link:active{transform:scale(.96)}}
.sources{display:grid;gap:.8rem}.stream-card{display:grid;gap:1rem;padding:1rem;border:1px solid var(--line);border-radius:.9rem;background:rgb(12 18 20 / .34)}.stream-card.selected{border-color:var(--accent);box-shadow:inset 3px 0 var(--accent)}.stream-title{margin:0;font-size:1.05rem;line-height:1.25;overflow-wrap:anywhere}.stream-meta{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin:.35rem 0 0;color:var(--muted);font-size:.86rem}.badge{display:inline-flex;align-items:center;gap:.35rem;border-radius:999px;padding:.2rem .5rem;background:rgb(118 229 172 / .13);color:var(--live);font-size:.75rem;font-weight:750}.badge.selected{background:rgb(137 229 199 / .15);color:var(--accent)}.empty{padding:1.2rem;border:1px dashed var(--line);border-radius:.85rem;color:var(--muted);text-align:center}.empty strong{display:block;margin-block-end:.25rem;color:var(--text)}.skeleton{height:6rem;border-radius:.85rem;background:linear-gradient(100deg,rgb(255 255 255 / .03),rgb(255 255 255 / .08),rgb(255 255 255 / .03));background-size:200% 100%;animation:shimmer 1.4s linear infinite}@keyframes shimmer{to{background-position:-200% 0}}
.settings-grid{display:grid;gap:1rem}.setting{padding-block-end:1rem;border-block-end:1px solid var(--line)}.setting:last-child{padding-block-end:0;border:0}.setting h3{margin:0;font-size:.95rem}.setting p{margin:.3rem 0 .75rem;color:var(--muted);font-size:.875rem}.fixtures{display:grid;gap:.5rem;margin:0;padding:0;list-style:none}.fixture{display:flex;gap:.75rem;justify-content:space-between;padding:.7rem 0;border-block-end:1px solid var(--line)}.fixture:last-child{border:0}.fixture time{color:var(--accent);font-variant-numeric:tabular-nums;font-weight:700}.activity{margin:0;color:var(--muted);font:400 .82rem/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
@media(min-width:48rem){.workspace{grid-template-columns:minmax(0,1.45fr) minmax(16rem,.8fr)}.status-panel,.sources-panel{grid-column:1/-1}.stream-card{grid-template-columns:minmax(0,1fr) auto;align-items:center}.stream-actions{justify-content:end}.settings-grid{grid-template-columns:1fr}.shell{padding-block-start:2.5rem}}@media(max-width:29rem){.shell{width:min(100% - 1.25rem,70rem);padding-block-start:1rem}.masthead{display:block}.secure{margin-block-start:.75rem}.button-row button{flex:1 1 7.4rem}.stream-actions>*{width:100%}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
</style></head><body>
<a class="skip" href="#main">Skip to relay controls</a>
<div class="shell"><header class="masthead"><div><p class="eyebrow">Private control room</p><h1>Live stream relay</h1><p>Select a verified member-channel broadcast, preview it, then start the restream to your configured output.</p></div><p class="secure">Private admin session</p></header>
<main id="main" class="workspace">
<section class="panel status-panel" aria-labelledby="status-heading"><div class="panel-head"><div><p class="eyebrow">Relay status</p><h2 id="status-heading">Current playout</h2></div><p class="status-line"><span class="signal" id="signal" aria-hidden="true"></span><span id="live">Checking relay</span></p></div><p class="status-title" id="source">No source selected</p><p class="reason" id="reason">Checking relay and live sources.</p><dl class="summary"><div><dt>Selected stream</dt><dd id="selected-summary">None</dd></div><div><dt>Auto-start</dt><dd id="autostart-summary">Checking</dd></div></dl><div class="button-row" aria-label="Playout controls"><button id="resume" class="primary" type="button">Resume playout</button><button id="pause" type="button">Pause playout</button><button id="stop" class="danger" type="button">Stop relay</button><button id="release" type="button" hidden>Clear ended output call</button></div></section>
<section class="panel sources-panel" aria-labelledby="sources-heading"><div class="panel-head"><div><p class="eyebrow">Choose a stream</p><h2 id="sources-heading">Live member channels</h2><p class="help">Only channels confirmed live by Hugging Face are shown. Your output channel is excluded.</p></div></div><div id="sources" class="sources" aria-live="polite"><div class="skeleton" aria-label="Checking live member channels"></div></div></section>
<section class="panel" aria-labelledby="settings-heading"><div class="panel-head"><div><p class="eyebrow">Playback settings</p><h2 id="settings-heading">Fallback behavior</h2></div></div><div class="settings-grid"><div class="setting"><h3>Automatic source</h3><p>Use the configured priority when you have not selected a member stream.</p><div class="choice-grid" aria-label="Fallback source"><button id="auto" class="choice" type="button">Automatic</button><button id="force-turbo" class="choice" type="button">Turbo</button><button id="force-rwitc" class="choice" type="button">Official stream</button></div></div><div class="setting"><h3>Start behavior</h3><p>When auto-start is off, selecting a live member stream still starts that stream.</p><button id="autostart" type="button">Checking auto-start</button></div></div></section>
<section class="panel" aria-labelledby="fixtures-heading"><div class="panel-head"><div><p class="eyebrow">Race calendar</p><h2 id="fixtures-heading">Upcoming fixtures</h2></div></div><div id="fixtures"><p class="empty">Loading upcoming fixtures.</p></div></section>
<section class="panel" aria-labelledby="activity-heading"><p class="eyebrow">Activity</p><h2 id="activity-heading">Connection log</h2><p class="activity" id="activity" role="status" aria-live="polite">Checking relay.</p></section>
</main></div>
<script>
const el = id => document.getElementById(id);
const state = {paused:false,autoStart:true,forced:null,live:false,online:false,reason:'',source:null,selected:null,broadcasts:[],fixtures:[],publishing:'',busy:false};
const adminPath = location.pathname;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
  })[character]);
}

function safePreviewUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

async function call(path, options) {
  const response = await fetch(path, options);
  if (!response.ok) {
    if (response.status === 503) throw new Error('Relay unavailable. Check its connection, then refresh.');
    if (response.status === 502) throw new Error('Relay refused the request. Refresh live sources and try again.');
    throw new Error('Request failed (' + response.status + '). Try again.');
  }
  return response;
}

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll('button').forEach(button => { button.disabled = busy; });
}

function selectedChannel() {
  return state.broadcasts.find(row => Number(row.chat_id) === state.selected) || null;
}

function renderStatus() {
  const selected = selectedChannel();
  const mode = !state.online ? 'offline' : state.paused ? 'paused' : state.live ? 'live' : 'idle';
  const label = !state.online ? 'Relay unavailable' : state.paused ? 'Paused' : state.live ? 'Restreaming live' : 'Ready for a live stream';
  el('signal').className = 'signal ' + mode;
  el('live').textContent = label;
  el('source').textContent = selected ? selected.title : state.source || 'No source selected';
  el('reason').textContent = state.reason || 'Choose a verified live member-channel stream.';
  el('selected-summary').textContent = selected ? selected.title : 'None';
  el('autostart-summary').textContent = state.autoStart ? 'On' : 'Off';
  el('pause').classList.toggle('primary', state.online && !state.paused);
  el('resume').classList.toggle('primary', state.online && state.paused);
  el('autostart').textContent = state.autoStart ? 'Turn auto-start off' : 'Turn auto-start on';
  // An ended or non-RTMP output call blocks every new broadcast, so the
  // operator only needs this control while publishing is actually blocked.
  el('release').hidden = !state.publishing.startsWith('blocked:');
  for (const id of ['auto','force-turbo','force-rwitc']) el(id).classList.remove('active');
  el(state.forced === 'turbosportslive' ? 'force-turbo' : state.forced === 'rwitc' ? 'force-rwitc' : 'auto').classList.add('active');
}

function renderSources() {
  const rows = state.broadcasts.filter(row => Boolean(row.live));
  if (!state.online) {
    el('sources').innerHTML = '<div class="empty"><strong>Relay unavailable</strong>Reconnect the relay to load live member channels.</div>';
    return;
  }
  if (!rows.length) {
    el('sources').innerHTML = '<div class="empty"><strong>No verified live streams</strong>Member channels appear here as soon as their Hugging Face stream is live.</div>';
    return;
  }
  el('sources').innerHTML = rows.map(row => {
    const chatId = Number(row.chat_id);
    const selected = Number.isSafeInteger(chatId) && chatId === state.selected;
    const preview = safePreviewUrl(row.preview_url);
    const canStart = preview && Number.isSafeInteger(chatId) && chatId > 0;
    const actions = canStart
      ? '<div class="stream-actions"><a class="button-link" href="' + escapeHtml(preview) + '" target="_blank" rel="noopener noreferrer">Preview stream</a><button class="primary" type="button" data-chat-id="' + chatId + '">Start restream</button></div>'
      : '<p class="help">Preview is preparing. Refresh in a moment.</p>';
    return '<article class="stream-card' + (selected ? ' selected' : '') + '"><div><h3 class="stream-title">' + escapeHtml(row.title || 'Channel') + '</h3><p class="stream-meta"><span class="badge">Live now</span>' + (selected ? '<span class="badge selected">Selected</span>' : '') + '</p></div>' + actions + '</article>';
  }).join('');
  for (const button of el('sources').querySelectorAll('button[data-chat-id]')) {
    button.addEventListener('click', () => {
      const chatId = Number(button.dataset.chatId);
      if (Number.isSafeInteger(chatId) && chatId > 0) control({action:'select_channel',chat_id:chatId}, 'Starting selected stream');
    });
  }
  setBusy(state.busy);
}

function renderFixtures() {
  el('fixtures').innerHTML = state.fixtures.length
    ? '<ul class="fixtures">' + state.fixtures.map(meeting => '<li class="fixture"><span>' + escapeHtml(meeting.title || 'Racing') + '</span><time>' + escapeHtml(meeting.date) + '</time></li>').join('') + '</ul>'
    : '<div class="empty"><strong>No upcoming fixtures</strong>The race calendar has no meetings in the next 14 days.</div>';
}

function render() {
  renderStatus();
  renderSources();
  renderFixtures();
}

async function refresh(force = false) {
  if (state.busy && !force) return;
  try {
    const status = await call(adminPath + '/status').then(response => response.json());
    state.paused = Boolean(status.paused);
    state.autoStart = Boolean(status.auto_start);
    state.forced = status.forced || null;
    state.live = Boolean(status.playout && status.playout.ready);
    state.reason = status.decision && status.decision.reason || '';
    state.source = status.playout && status.playout.source || null;
    state.broadcasts = Array.isArray(status.broadcasts) ? status.broadcasts : [];
    state.selected = Number.isSafeInteger(status.selected_chat_id) && status.selected_chat_id > 0 ? status.selected_chat_id : null;
    state.publishing = status.publishing && typeof status.publishing.state === 'string' ? status.publishing.state : '';
    state.online = true;
    el('activity').textContent = 'Relay status updated ' + new Date().toLocaleTimeString() + '.';
  } catch (error) {
    state.online = false;
    state.reason = error.message;
    state.broadcasts = [];
    el('activity').textContent = error.message;
  }
  render();
  try {
    const fixtures = await call('/api/fixtures').then(response => response.json());
    state.fixtures = Array.isArray(fixtures.meetings) ? fixtures.meetings : [];
  } catch { state.fixtures = []; }
  renderFixtures();
}

async function control(body, activity) {
  if (state.busy) return;
  setBusy(true);
  el('activity').textContent = activity + '.';
  try {
    await call(adminPath + '/control', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    await refresh(true);
  } catch (error) {
    state.reason = error.message;
    el('activity').textContent = error.message;
    renderStatus();
  } finally { setBusy(false); }
}

el('pause').onclick = () => control({action:'pause'}, 'Pausing relay');
el('resume').onclick = () => control({action:'resume'}, 'Resuming relay');
el('stop').onclick = () => control({action:'stop'}, 'Stopping relay');
el('auto').onclick = () => control({action:'auto'}, 'Using automatic source');
el('force-turbo').onclick = () => control({action:'force',source:'turbosportslive'}, 'Using Turbo source');
el('force-rwitc').onclick = () => control({action:'force',source:'rwitc'}, 'Using official source');
el('autostart').onclick = () => control({action:'auto_start',enabled:!state.autoStart}, 'Updating auto-start');
el('release').onclick = () => control({action:'release_call'}, 'Clearing the ended output call');
refresh();
setInterval(refresh, 5000);
</script></body></html>`;
  return new Response(page, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
               'X-Admin-Entry': entryVersion, 'Referrer-Policy': 'no-referrer',
               'X-Robots-Tag': 'noindex, nofollow' },
  });
}
