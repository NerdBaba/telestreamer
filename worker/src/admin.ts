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
<title>Your live stream</title>
<style>
:root{color-scheme:dark;--page:#0c1214;--surface:#142022;--surface-strong:#1a292b;--line:#34494b;--text:#f1f6f4;--muted:#b4c4c0;--accent:#89e5c7;--accent-ink:#082018;--live:#76e5ac;--danger:#ffb4ad;--focus:#e3ff83}
*{box-sizing:border-box}[hidden]{display:none!important}html{background:var(--page)}body{margin:0;color:var(--text);font:400 16px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,a,summary{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.6}a,button,summary{touch-action:manipulation}button:focus-visible,a:focus-visible,summary:focus-visible,[tabindex="-1"]:focus{outline:3px solid var(--focus);outline-offset:3px}.skip{position:absolute;inset:1rem auto auto 1rem;transform:translateY(-180%);background:var(--focus);color:var(--accent-ink);padding:.7rem;z-index:2}.skip:focus{transform:none}
.shell{width:min(100% - 2rem,70rem);margin:auto;padding:2rem 0 3rem}.masthead,.panel-head{display:flex;gap:1rem;align-items:start;justify-content:space-between}.masthead{margin-bottom:1.5rem}h1{margin:0;font-size:clamp(2rem,5vw,3rem);line-height:1.15;letter-spacing:-.035em}h2{margin:0;font-size:1.2rem}h3{margin:0;font-size:1rem}.eyebrow{margin:0 0 .35rem;color:var(--accent);font-size:.8rem;font-weight:750;letter-spacing:.06em;text-transform:uppercase}.help,.stamp{color:var(--muted);font-size:.9rem}.help{margin:.5rem 0;max-width:68ch}.stamp{margin:.6rem 0 0;overflow-wrap:anywhere}.workspace{display:grid;gap:1rem}.panel{min-width:0;border:1px solid var(--line);border-radius:1rem;background:var(--surface);padding:clamp(1rem,3vw,1.6rem)}.status-panel{background:var(--surface-strong)}.status-line{display:flex;gap:.65rem;align-items:center;margin:0 0 .75rem;font-weight:700}.signal{flex:none;width:.75rem;height:.75rem;border-radius:50%;background:var(--muted)}.signal.live{background:var(--live)}.signal.error{background:var(--danger)}.status-title{font-size:clamp(1.5rem,4vw,2rem);line-height:1.2;letter-spacing:-.025em}.reason{margin:.6rem 0;max-width:70ch;overflow-wrap:anywhere}.next{margin:1rem 0;padding:.8rem 1rem;border-left:3px solid var(--accent);background:rgb(12 18 20 / .4)}.next strong{display:block}.summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin:1rem 0}.summary dt{color:var(--muted);font-size:.85rem}.summary dd{margin:.15rem 0 0;font-weight:650;overflow-wrap:anywhere}
.button-row,.choice-grid,.stream-actions{display:flex;flex-wrap:wrap;gap:.65rem}button,.button-link{display:inline-flex;min-height:44px;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:.65rem;background:transparent;color:var(--text);padding:.7rem .9rem;font-weight:650;line-height:1.2;text-decoration:none}.primary{border-color:var(--accent);background:var(--accent);color:var(--accent-ink)}.danger{border-color:var(--danger);color:var(--danger)}.choice{flex:1 1 8rem}.choice.active{border-color:var(--accent);color:var(--accent);background:rgb(137 229 199 / .1)}.button-link{color:var(--accent)}.feedback{margin:1rem 0 0;padding:.85rem;border:1px solid var(--line);border-radius:.65rem;overflow-wrap:anywhere}.feedback:empty{display:none}.feedback[data-kind="error"]{border-color:var(--danger);color:var(--danger)}.feedback[data-kind="saved"]{border-color:var(--accent)}
.checks{display:grid;gap:.75rem;margin:1rem 0 0;padding:0;list-style:none}.check{padding:.85rem;border:1px solid var(--line);border-radius:.7rem;min-width:0}.check-head{display:flex;gap:.65rem;align-items:start;justify-content:space-between}.check-state{font-size:.85rem;font-weight:700;text-align:right}.check[data-state="error"] .check-state{color:var(--danger)}.check[data-state="ok"] .check-state{color:var(--live)}.check p{margin:.35rem 0 0;color:var(--muted);font-size:.9rem;overflow-wrap:anywhere}
.sources{display:grid;gap:.8rem;margin-top:1rem}.stream-card{display:grid;gap:1rem;padding:1rem;border:1px solid var(--line);border-radius:.8rem;background:rgb(12 18 20 / .3)}.stream-card.selected{border-color:var(--accent)}.stream-title{overflow-wrap:anywhere;font-size:1.05rem}.stream-meta{display:flex;flex-wrap:wrap;gap:.5rem;margin:.5rem 0}.badge{padding:.2rem .5rem;border-radius:.35rem;font-size:.8rem;background:var(--surface-strong);color:var(--muted)}.badge.yes{color:var(--live)}.empty{padding:1rem;border:1px dashed var(--line);border-radius:.7rem;color:var(--muted)}.empty strong{display:block;color:var(--text);margin-bottom:.25rem}.setting{padding:1rem 0;border-bottom:1px solid var(--line)}.setting:last-child{border:0;padding-bottom:0}.setting p{color:var(--muted);font-size:.9rem}.fixtures{list-style:none;margin:1rem 0 0;padding:0}.fixture{display:flex;gap:1rem;justify-content:space-between;padding:.7rem 0;border-bottom:1px solid var(--line)}.fixture span,.fixture time{overflow-wrap:anywhere}.fixture time{color:var(--accent)}details summary{cursor:pointer;min-height:44px;padding:.5rem 0;font-weight:700}details[open] summary{margin-bottom:.5rem}.technical{display:grid;gap:.7rem}.technical dt{color:var(--muted);font-size:.85rem}.technical dd{margin:.15rem 0 0;overflow-wrap:anywhere}
@media(min-width:48rem){.workspace{grid-template-columns:minmax(0,1.25fr) minmax(17rem,1fr)}.status-panel,.checks-panel,.sources-panel,.details-panel{grid-column:1/-1}.checks{grid-template-columns:repeat(3,minmax(0,1fr))}.stream-card{grid-template-columns:minmax(0,1fr) auto;align-items:center}.stream-actions{justify-content:end}.technical{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:29rem){.shell{width:calc(100% - 1.25rem);padding-top:1rem}.masthead,.panel-head{display:block}.panel-head>button{margin-top:.75rem}.summary{grid-template-columns:1fr}.button-row>*{flex:1 1 8rem}.stream-actions>*{width:100%}.check-head{flex-wrap:wrap}.check-state{text-align:left}}@media(hover:hover){button:not(:disabled):hover,.button-link:hover{border-color:var(--accent)}}@media(forced-colors:active){button:focus-visible,a:focus-visible,summary:focus-visible{outline-color:Highlight}}
</style></head><body>
<a class="skip" href="#main">Skip to stream controls</a>
<div class="shell"><header class="masthead"><div><p class="eyebrow">Private controls</p><h1>Your live stream</h1><p class="help">Choose a video feed and send it to your Telegram channel.</p></div><p class="help">Keep this page link private.</p></header>
<main id="main" class="workspace">
<section class="panel status-panel" aria-labelledby="status-heading">
<p class="status-line"><span class="signal" id="signal" aria-hidden="true"></span><span id="live">Checking your stream</span></p>
<h2 class="status-title" id="status-heading">Finding out what is happening</h2>
<p class="reason" id="reason">We are checking the relay server, video server, and live stream list. This does not start any video.</p>
<p class="next"><strong>What to do next</strong><span id="next-action">Wait a moment for the first check.</span></p>
<dl class="summary"><div><dt>Selected video feed</dt><dd id="selected-summary">Checking</dd></div><div><dt>Automatic starting</dt><dd id="autostart-summary">Checking</dd></div></dl>
<div class="button-row" aria-label="Stream controls"><button id="resume" class="primary" type="button" disabled>Resume stream</button><button id="pause" type="button" disabled>Pause stream</button><button id="stop" class="danger" type="button" disabled>Stop stream</button></div>
<p class="help">Pause and Stop keep the stream off until you resume or choose “Use this stream”. Stop also asks the relay to end a Telegram broadcast call it opened.</p>
<p id="status-stamp" class="stamp">Stream status has not been checked yet.</p>
<p id="activity" class="feedback" role="status" aria-live="polite" aria-atomic="true"></p>
</section>
<section class="panel checks-panel" aria-labelledby="checks-heading"><div class="panel-head"><div><h2 id="checks-heading">What is working?</h2><p class="help">Each part is checked separately. A broken stream list does not mean the video server is off.</p></div><button id="check-again" type="button">Check again</button></div>
<ul class="checks">
<li class="check" id="check-relay"><div class="check-head"><h3>Relay server</h3><span class="check-state">Checking</span></div><p>Render: runs your stream controls.</p></li>
<li class="check" id="check-space"><div class="check-head"><h3>Video server</h3><span class="check-state">Checking</span></div><p>Hugging Face Space: supplies the video feeds.</p></li>
<li class="check" id="check-playlist"><div class="check-head"><h3>Live stream list</h3><span class="check-state">Checking</span></div><p>Lists the feeds available on the video server.</p></li>
<li class="check" id="check-input"><div class="check-head"><h3>Incoming video</h3><span class="check-state">Checking</span></div><p>Checks whether the relay is receiving video.</p></li>
<li class="check" id="check-output"><div class="check-head"><h3>Sending to Telegram</h3><span class="check-state">Checking</span></div><p>Checks the sending process, not viewer playback.</p></li>
</ul><p class="stamp" id="checks-stamp">Server checks have not finished yet.</p><p class="help" id="checks-note" role="status" aria-live="polite" aria-atomic="true">Server checks repeat every 30 seconds. Stream status repeats about every 5 seconds.</p></section>
<section class="panel sources-panel" aria-labelledby="sources-heading"><h2 id="sources-heading" tabindex="-1">Choose a live stream</h2><p class="help">These are feeds the relay found. “Live in Telegram” and “Available in the stream list” are different checks. Being in the list does not prove the video will play.</p><p class="help">Preview opens a new tab. “Use this stream” asks the relay to send that feed now, even if paused or automatic starting is off.</p><p class="empty" id="sources-note">Checking for live streams.</p><div id="sources" class="sources"></div></section>
<section class="panel" aria-labelledby="settings-heading"><details id="more-settings"><summary id="settings-heading">More settings</summary><div class="setting"><h3>Other video sources</h3><p>Automatic chooses from the configured sources. Turbo and Official stream choose one instead. This clears your selected Telegram feed but does not cancel a pause.</p><div class="choice-grid" aria-label="Other video sources"><button id="auto" class="choice" type="button" disabled>Automatic</button><button id="force-turbo" class="choice" type="button" disabled>Turbo</button><button id="force-rwitc" class="choice" type="button" disabled>Official stream</button></div></div><div class="setting"><h3>Automatic starting</h3><p>When on, the relay may start an available feed. Pause and Stop always take priority. When off, “Use this stream” can still start a selected feed.</p><button id="autostart" type="button" disabled>Checking setting</button></div><div class="setting"><h3>Clear an old Telegram call</h3><p>Only use this if an ended or incompatible Telegram broadcast call is blocking a new one. It does not fix missing video or sign-in settings.</p><p class="help" id="release-hint">No old-call problem has been reported.</p><button id="release" type="button" hidden disabled>Clear ended output call</button></div></details></section>
<section class="panel" aria-labelledby="fixtures-heading"><h2 id="fixtures-heading">Upcoming races</h2><div id="fixtures"><p class="empty">Loading the race calendar.</p></div></section>
<section class="panel details-panel"><details id="technical-details"><summary>Technical details</summary><p class="help">Safe explanations only. Private addresses, access keys, and raw server errors are not shown.</p><dl class="technical"><div><dt>Current source</dt><dd id="source">Not known yet</dd></div><div><dt>Why the relay is waiting</dt><dd id="pending-detail">Checking</dd></div><div><dt>Latest relay issue</dt><dd id="error-detail">Checking</dd></div><div><dt>Finding Telegram feeds</dt><dd id="discovery-detail">Checking</dd></div><div><dt>Relay status last received</dt><dd id="status-time">Not yet</dd></div><div><dt>Server checks last received</dt><dd id="checks-time">Not yet</dd></div></dl></details></section>
</main></div>
<script>
const el = id => document.getElementById(id);
const adminPath = location.pathname.replace(/\\/$/, '');
const state = {status:null,online:false,statusAt:0,statusAttempt:0,statusError:'',checks:null,checksAt:0,checksAttempt:0,checksError:'',fixtures:null,fixturesError:false,busy:false,checking:false,lastPauseAction:null};
const sourceCards = new Map();
let statusTimer, checksTimer, statusFlight, checksFlight, fixtureFlight;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]);
}
function safePreviewUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
// Never place upstream error text in the document: it may contain private URLs.
function explainIssue(value) {
  if (!value) return 'No issue reported.';
  const text = String(value).toLowerCase();
  if (/flood|waiterror|rate.limit/.test(text)) return 'Telegram has asked the relay to wait. Leave it a while before trying again.';
  if (/ended|groupcall|non.rtmp|incompatible|old.call/.test(text)) return 'An old or incompatible Telegram call may be blocking sending. Check “Clear an old Telegram call” in More settings.';
  if (/auth|session|sign.in|credential|api.id|api.hash/.test(text)) return 'Telegram sign-in or sending settings need attention. Ask the person who set up the relay to check them.';
  if (/permission|access|admin|forbidden|private|channel.invalid/.test(text)) return 'The relay may not have permission to broadcast. Ask the channel owner to check its Telegram access.';
  if (/playlist|capture|tgtv|input|source/.test(text)) return 'The relay could not get the video feed or stream list. Check the video server and live stream list above.';
  if (/publisher|rtmp|destination|ffmpeg/.test(text)) return 'Sending could not start. Ask the person who set up the relay to check the Telegram sending settings.';
  if (/timeout|timed.out|connection|network|unreachable/.test(text)) return 'A connection failed or was too slow. Wait a moment, then choose Check again.';
  return 'The relay reported a problem. Check the five parts above; if it continues, ask the person who set up the relay.';
}
async function requestJson(path, options = {}, timeout = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {...options,cache:'no-store',signal:controller.signal});
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('access');
      if (response.status === 404) throw new Error('missing');
      if (response.status === 502) throw new Error('refused');
      if (response.status === 503) throw new Error('unavailable');
      throw new Error('request');
    }
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error('slow');
    if (error instanceof SyntaxError) throw new Error('invalid');
    if (error instanceof TypeError) throw new Error('network');
    throw error;
  } finally { clearTimeout(timer); }
}
function requestExplanation(error, command = false) {
  const code = error && error.message;
  if (code === 'access') return 'This private page no longer has access. Ask the owner for the current control-page link.';
  if (code === 'slow') return command ? 'The command took too long to confirm. It may have been accepted. Choose Check again before sending it again.' : 'The check took too long. The server may be waking up or unreachable. Wait a moment, then choose Check again.';
  if (code === 'refused') return 'The relay did not accept this request. Check again; the feed may have ended or may not be ready yet.';
  if (code === 'unavailable') return 'The relay server cannot be reached or is not configured. Check again; if it continues, ask the person who set it up.';
  if (code === 'missing') return 'This check is not available on the running server yet. Ask the person who set it up to update it.';
  if (code === 'invalid') return 'The server returned a reply this page could not read. Check again; if it continues, ask the person who set it up.';
  return command ? 'The command could not be confirmed. Check your connection and choose Check again before trying it again.' : 'Could not connect for this check. Check your internet connection, then choose Check again.';
}
function rows() {
  return state.status && Array.isArray(state.status.broadcasts) ? state.status.broadcasts.filter(row => row && typeof row === 'object') : [];
}
function selectedChannel() {
  return rows().find(row => Number(row.chat_id) === state.status.selected_chat_id) || null;
}
function publisher() { return state.status && state.status.publishing || {}; }
function blocked() { return typeof publisher().state === 'string' && /blocked|failed/i.test(publisher().state); }
function callBlocked() {
  return blocked() && /ended|groupcall|non.rtmp|incompatible|old.call/i.test(String(publisher().state) + ' ' + String(state.status.last_error || ''));
}
function sourceLabel() {
  if (!state.status) return 'Not known yet';
  const selected = selectedChannel();
  if (selected) return String(selected.title || 'Selected Telegram feed');
  if (state.status.selected_chat_id) return 'Selected Telegram feed (not in the latest list)';
  const source = state.status.playout && state.status.playout.source || state.status.decision && state.status.decision.chosen || state.status.forced;
  if (source === 'turbosportslive') return 'Turbo';
  if (source === 'rwitc') return 'Official stream';
  if (typeof source === 'string' && source.startsWith('telegram:')) return 'Telegram feed';
  return source ? 'Configured video feed' : 'No feed selected';
}
function summary() {
  if (!state.statusAttempt) return ['checking','Checking your stream','Finding out what is happening','The first check is still running. Checking does not start the stream.','Wait a moment. If this takes too long, choose Check again.'];
  if (!state.online) return ['error','Status unknown','Cannot check your stream',state.statusError,'Choose Check again. Do not assume your stream has stopped: its current state is unknown.'];
  const status = state.status, input = status.playout || {}, output = publisher(), decision = status.decision || {};
  if (status.paused === true) return ['paused','Not sending',state.lastPauseAction === 'stop' ? 'Your stream is stopped' : 'Your stream is paused','The relay is set to keep video off, even when a live feed is available.','Choose Resume stream to allow starting, or choose a feed below and use it now.'];
  if (output.running === true) return ['live','Sending process running','Sending video to Telegram','The relay reports its sending process is running. Viewer playback has not been checked.','Open your Telegram channel’s live stream to make sure the picture and sound work.'];
  if (blocked()) return ['error','Sending is blocked','Your stream cannot start sending',explainIssue(String(output.state) + ' ' + String(status.last_error || '')),callBlocked() ? 'Open More settings and clear the old Telegram call, then choose Check again.' : 'Check the sending issue below. The relay setup or Telegram access may need help from its owner.'];
  if (input.ready === true && typeof output.running !== 'boolean') return ['waiting','Sending not confirmed','Video is ready, but sending is unknown','This relay version reports incoming video but does not report whether it is sending to Telegram.','Check your Telegram channel directly. Ask the setup owner to update the relay for a separate sending check.'];
  if (/manual/i.test(String(status.pending_reason || '')) || status.auto_start === false && !status.selected_chat_id && input.ready !== true && !input.pid) return ['off','Not sending','Your stream is off','Automatic starting is off. The relay is waiting for you to choose a feed.','Choose a live feed below and select Use this stream.'];
  if (input.ready === true || input.pid || decision.available === true || /connect|start/i.test(String(output.state || ''))) return ['waiting','Waiting to send','Getting your stream ready',input.ready ? 'Video is arriving. Sending to Telegram has not been confirmed yet.' : 'The relay is waiting for the incoming video or the sending process to start.','Wait a moment, then choose Check again. If it stays here, check Incoming video and Sending to Telegram below.'];
  if (decision.available === false && (status.selected_chat_id || decision.chosen)) return ['off','Source not ready','Your video feed is not available','The selected feed is not currently available to the relay. This does not prove the video server is off.','Check the live stream list below. Wait for this feed or choose a different available feed.'];
  if (typeof output.running !== 'boolean' && !('ready' in input)) return ['waiting','Status incomplete','Sending has not been confirmed','This relay version did not include separate incoming-video and sending information.','Check your Telegram channel directly, or ask the setup owner to update the relay.'];
  return ['off','Not sending','Your stream is off','No video is currently confirmed as sending to Telegram. The relay is waiting for an available feed.','Choose a live feed below. If none appear, check the video server and live stream list.'];
}
function setCheck(name, tone, label, detail) {
  const card = el('check-' + name);
  card.dataset.state = tone;
  card.querySelector('.check-state').textContent = label;
  card.querySelector('p').textContent = detail;
}
function serverCheck(name) {
  const check = state.checks && state.checks.checks && state.checks.checks[name];
  if (state.checksError) return ['unknown','Could not check',state.checksError + (state.checksAt ? ' The last result is kept in Technical details.' : '')];
  if (!check) return ['unknown',state.checksAttempt ? 'Not reported' : 'Checking','This part has not returned a check yet. Choose Check again if it does not appear.'];
  if (check.code === 'not_configured') return ['unknown','Setup needed','This check has not been configured. Ask the person who set up the stream; it does not mean the server is off.'];
  if (check.state === 'ok') {
    if (name === 'playlist') {
      const count = Number.isSafeInteger(check.stream_count) ? check.stream_count : null;
      return ['ok',count === 0 ? 'List is empty' : 'List loaded',count === 0 ? 'The list loaded, but no live feeds are listed. This is not a broken list.' : (count === null ? 'The live stream list loaded.' : count + ' live feed' + (count === 1 ? '' : 's') + ' listed.') + ' Video playback is not checked here.'];
    }
    return ['ok','Responding',name === 'space' ? 'The Hugging Face Space answered its health check. This does not prove each video feed will play.' : 'The Render server answered its health check. Stream status is checked separately.'];
  }
  if (check.code === 'unreachable') return ['error','Cannot reach',name === 'space' ? 'The video server did not answer. It may be sleeping, starting, or unreachable. Open the Space in Hugging Face, wait for it to run, then check again.' : name === 'playlist' ? 'Could not reach the live stream list. Check the video server separately; this alone does not mean the Space is off.' : 'The relay health check could not reach Render. Wait for the service to wake, then check again.'];
  if (check.code === 'http_error') return ['error','Check failed',name === 'playlist' ? 'The stream list returned an error. The address or access settings may need attention; the Space may still be running.' : 'The server answered with an error. Ask the setup owner to check the service, then choose Check again.'];
  if (check.code === 'invalid_response' || check.code === 'too_large') return ['error','Reply not usable',name === 'playlist' ? 'The stream list could not be read. Ask the setup owner to check the list format and settings. This is not proof the Space is off.' : 'The server reply could not be read. Ask the setup owner to check this service.'];
  return ['unknown','Not known','There is not enough information to check this part yet. Choose Check again.'];
}
function renderChecks() {
  for (const name of ['relay','space','playlist']) setCheck(name,...serverCheck(name));
  if (!state.online) {
    setCheck('input','unknown','Cannot check','Current incoming video is unknown because the relay status could not be read.');
    setCheck('output','unknown','Cannot check','Current sending is unknown. Check Telegram directly; an unreachable relay does not prove it stopped.');
    return;
  }
  const status = state.status, input = status.playout || {}, output = publisher();
  if (status.paused) {
    setCheck('input','unknown','Paused','Incoming video is not being requested while the relay is paused.');
    setCheck('output','unknown','Off — paused','The relay is set not to send video. Resume or use a feed to start again.');
  } else {
    if (input.ready === true) setCheck('input','ok','Video arriving','The relay reports incoming video is ready. This alone does not mean Telegram is receiving it.');
    else if (input.pid) setCheck('input','unknown','Starting','The video process has started, but incoming video is not ready yet.');
    else if (input.ready === false) setCheck('input','unknown','No video yet','The relay is not receiving ready video. Check the selected feed and live stream list.');
    else setCheck('input','unknown','Not reported','The running relay did not include this check. Missing information is not proof of a fault.');
    if (output.running === true) setCheck('output','ok','Sending process running','The sending process is running. Open Telegram to confirm viewer picture and sound.');
    else if (blocked()) setCheck('output','error','Blocked',explainIssue(String(output.state) + ' ' + String(status.last_error || '')));
    else if (typeof output.running !== 'boolean') setCheck('output','unknown','Not confirmed','This relay version does not report sending separately. Check the live stream in Telegram.');
    else setCheck('output','unknown',input.ready || /connect|start/i.test(String(output.state || '')) ? 'Waiting to send' : 'Not sending','No sending process is confirmed running. Incoming video and Telegram setup are separate checks.');
  }
}
function updateButtons() {
  for (const id of ['resume','pause','stop','auto','force-turbo','force-rwitc','autostart','release']) el(id).disabled = state.busy || !state.online;
  el('autostart').disabled = state.busy || !state.online || !state.status || typeof state.status.auto_start !== 'boolean';
  el('check-again').disabled = state.checking || state.busy;
  for (const card of sourceCards.values()) {
    const button = card.querySelector('button');
    button.disabled = state.busy || !state.online || button.dataset.available !== 'yes';
  }
}
function renderStatus() {
  const [tone,label,title,reason,next] = summary();
  el('signal').className = 'signal ' + tone;
  el('live').textContent = label;
  el('status-heading').textContent = title;
  el('reason').textContent = reason;
  el('next-action').textContent = next;
  el('selected-summary').textContent = sourceLabel();
  el('source').textContent = sourceLabel();
  const status = state.status || {}, auto = status.auto_start;
  el('autostart-summary').textContent = typeof auto !== 'boolean' ? 'Not reported' : (auto ? 'On' : 'Off') + (status.paused ? ' — pause takes priority' : '');
  el('autostart').textContent = typeof auto !== 'boolean' ? 'Setting not reported by relay' : auto ? 'Turn automatic starting off' : 'Turn automatic starting on';
  el('pause').classList.toggle('primary',state.online && status.paused === false);
  el('resume').classList.toggle('primary',state.online && status.paused === true);
  const active = status.forced === 'turbosportslive' ? 'force-turbo' : status.forced === 'rwitc' ? 'force-rwitc' : 'auto';
  for (const id of ['auto','force-turbo','force-rwitc']) {
    el(id).classList.toggle('active',id === active && Boolean(state.status));
    el(id).setAttribute('aria-pressed',String(id === active && Boolean(state.status)));
  }
  el('release').hidden = !callBlocked();
  el('release-hint').textContent = callBlocked() ? 'The relay reported a call that may block a new broadcast.' : blocked() ? 'Sending is blocked, but no old-call problem was identified. Check the sending settings instead.' : 'No old-call problem has been reported.';
  el('pending-detail').textContent = !state.status ? 'Not known yet' : status.paused ? 'Paused by the stream controls.' : /manual/i.test(String(status.pending_reason || '')) ? 'Waiting for you to start a feed.' : status.pending_reason ? explainIssue(status.pending_reason) : 'No waiting reason reported.';
  el('error-detail').textContent = state.status ? explainIssue(status.last_error) : 'Not known yet';
  const discovery = status.discovery;
  el('discovery-detail').textContent = !discovery ? 'Not reported by this relay version.' : discovery.enabled === false ? 'Automatic Telegram feed discovery is off.' : discovery.error ? explainIssue(discovery.error) : 'No discovery issue reported. Only feeds found by the relay appear above.';
  renderChecks();
  renderStamps();
  updateButtons();
}
function elapsedStamp(at, threshold, prefix) {
  if (!at) return prefix + 'Not yet.';
  const seconds = Math.max(0,Math.floor((Date.now() - at) / 1000));
  return prefix + new Date(at).toLocaleTimeString() + (seconds > threshold ? ' — out of date (' + Math.floor(seconds / 60) + 'm ' + seconds % 60 + 's ago). Do not rely on this as current.' : '.');
}
function renderStamps() {
  el('status-stamp').textContent = elapsedStamp(state.statusAt,15,'Last stream status: ') + (!state.online && state.statusAt ? ' The latest check failed.' : '');
  const checkedAt = state.checks && Date.parse(state.checks.checked_at);
  el('checks-stamp').textContent = elapsedStamp(checkedAt ? Math.min(checkedAt,state.checksAt) : state.checksAt,75,'Last server checks: ') + (state.checksError ? ' The latest check failed.' : '');
  el('status-time').textContent = state.statusAt ? new Date(state.statusAt).toLocaleString() + (!state.online ? ' (last successful result; latest check failed)' : '') : 'Not yet';
  el('checks-time').textContent = checkedAt ? new Date(checkedAt).toLocaleString() + (state.checksError ? ' (last successful result; latest check failed)' : '') : state.checksAt ? new Date(state.checksAt).toLocaleString() : 'Not yet';
}
function availability(row) {
  const playlist = !state.checksError && state.checks && state.checks.checks && state.checks.checks.playlist;
  if (playlist && playlist.state === 'ok' && Array.isArray(playlist.stream_ids) && row.stream_id) return playlist.stream_ids.includes(String(row.stream_id));
  if (typeof row.capturable === 'boolean') return row.capturable;
  return safePreviewUrl(row.preview_url) ? true : null;
}
function renderSources() {
  const currentRows = rows().filter(row => row.live || row.telegram_live || row.capturable || availability(row) === true);
  const discovery = state.status && state.status.discovery;
  let note = '';
  if (!state.statusAttempt) note = 'Checking for live feeds. This does not start any video.';
  else if (!state.online) note = state.statusAt ? 'Could not refresh the feeds. The previous list below may be out of date; check again before choosing.' : 'Cannot load feeds because the relay status is unavailable. Choose Check again.';
  else if (discovery && discovery.error) note = 'The relay could not finish finding feeds. ' + explainIssue(discovery.error) + (currentRows.length ? ' The feeds below may be from an earlier check.' : '');
  else if (!currentRows.length) note = discovery && discovery.enabled === false ? 'Finding Telegram feeds is turned off. Ask the setup owner to enable it, or choose another video source in More settings.' : 'No live feeds were found by the relay. Start a stream in a source channel, wait for the relay to find it, then choose Check again. This does not mean the video server is off.';
  el('sources-note').hidden = !note;
  el('sources-note').textContent = note;
  const keep = new Set();
  for (const row of currentRows) {
    const chatId = Number(row.chat_id);
    if (!Number.isSafeInteger(chatId) || chatId <= 0) continue;
    const key = String(chatId);
    keep.add(key);
    let card = sourceCards.get(key);
    if (!card) {
      card = document.createElement('article');
      card.className = 'stream-card';
      card.dataset.chatId = key;
      card.innerHTML = '<div><h3 class="stream-title"></h3><p class="stream-meta"><span class="badge telegram"></span><span class="badge listed"></span><span class="badge selected-badge" hidden>Selected feed</span></p><p class="help source-help"></p></div><div class="stream-actions"><a class="button-link" target="_blank" rel="noopener noreferrer" hidden>Preview stream <span class="help"> (new tab)</span></a><button class="primary" type="button">Use this stream</button></div>';
      card.querySelector('button').dataset.chatId = key;
      card.querySelector('button').addEventListener('click',() => control({action:'select_channel',chat_id:chatId},'Asking the relay to use this feed','Feed selected. The request was accepted; sending video is not confirmed yet. Check the status above and your Telegram channel.'));
      sourceCards.set(key,card);
      el('sources').append(card);
    }
    const title = String(row.title || 'Telegram feed'), listed = availability(row), preview = safePreviewUrl(row.preview_url);
    const telegramLive = typeof row.telegram_live === 'boolean' ? row.telegram_live : null;
    card.querySelector('h3').textContent = title;
    card.classList.toggle('selected',Boolean(state.status && state.status.selected_chat_id === chatId));
    card.querySelector('.selected-badge').hidden = !(state.status && state.status.selected_chat_id === chatId);
    const telegramBadge = card.querySelector('.telegram'), listBadge = card.querySelector('.listed');
    telegramBadge.textContent = telegramLive === true ? 'Live in Telegram' : telegramLive === false ? 'Telegram live not reported' : 'Telegram live status unknown';
    telegramBadge.classList.toggle('yes',telegramLive === true);
    listBadge.textContent = listed === true ? 'Available in the stream list' : listed === false ? 'Not in the stream list yet' : 'Stream list availability unknown';
    listBadge.classList.toggle('yes',listed === true);
    const link = card.querySelector('a'), button = card.querySelector('button');
    const canUse = listed === true && row.live === true;
    link.hidden = !preview || listed === false;
    if (preview) link.href = preview; else link.removeAttribute('href');
    link.setAttribute('aria-label','Preview stream: ' + title + ' (opens a new tab)');
    button.dataset.available = canUse ? 'yes' : 'no';
    button.setAttribute('aria-label','Use this stream: ' + title);
    card.querySelector('.source-help').textContent = listed === false ? 'Telegram may be live, but the video server has not listed this feed. Wait and check again, or ask the Space owner to check capture.' : listed === null ? 'The relay has not confirmed that this feed is in the stream list. Check again before starting.' : !row.live ? 'The list contains this feed, but the relay has not marked it ready to select. Wait and check again.' : 'In the list, but playback is not verified. Preview if available, then use this feed to start sending.';
  }
  for (const [key,card] of sourceCards) if (!keep.has(key)) {
    if (card.contains(document.activeElement)) el('sources-heading').focus();
    card.remove();
    sourceCards.delete(key);
  }
  updateButtons();
}
function renderFixtures() {
  if (state.fixturesError) {
    el('fixtures').innerHTML = '<p class="empty"><strong>Could not load the race calendar</strong>This does not stop streaming. Choose Check again to retry.</p>';
    return;
  }
  if (!state.fixtures) return;
  el('fixtures').innerHTML = state.fixtures.length ? '<ul class="fixtures">' + state.fixtures.map(meeting => '<li class="fixture"><span>' + escapeHtml(meeting.title || 'Racing') + '</span><time>' + escapeHtml(meeting.date || 'Date not supplied') + '</time></li>').join('') + '</ul>' : '<p class="empty"><strong>No upcoming races listed</strong>The calendar loaded, but has no meetings in the next 14 days.</p>';
}
function refreshStatus() {
  if (statusFlight) return statusFlight;
  clearTimeout(statusTimer);
  statusFlight = (async () => {
    try {
      const status = await requestJson(adminPath + '/status');
      if (!status || typeof status.paused !== 'boolean') throw new Error('invalid');
      state.status = status;
      state.online = true;
      state.statusAt = Date.now();
      state.statusError = '';
      if (!status.paused && !state.busy) state.lastPauseAction = null;
    } catch (error) {
      state.online = false;
      state.statusError = requestExplanation(error);
    } finally {
      state.statusAttempt = Date.now();
      renderStatus();
      renderSources();
      statusFlight = null;
      statusTimer = setTimeout(refreshStatus,5000);
    }
  })();
  return statusFlight;
}
function refreshFixtures() {
  if (fixtureFlight) return fixtureFlight;
  fixtureFlight = (async () => {
    try {
      const data = await requestJson('/api/fixtures');
      if (!data || !Array.isArray(data.meetings)) throw new Error('invalid');
      state.fixtures = data.meetings.filter(meeting => meeting && typeof meeting === 'object');
      state.fixturesError = false;
    } catch { state.fixturesError = true; }
    finally { renderFixtures(); fixtureFlight = null; }
  })();
  return fixtureFlight;
}
function refreshChecks() {
  if (checksFlight) return checksFlight;
  clearTimeout(checksTimer);
  checksFlight = (async () => {
    try {
      const checks = await requestJson(adminPath + '/checks');
      if (!checks || !checks.checks || typeof checks.checks !== 'object') throw new Error('invalid');
      state.checks = checks;
      state.checksAt = Date.now();
      state.checksError = '';
    } catch (error) { state.checksError = requestExplanation(error); }
    finally {
      state.checksAttempt = Date.now();
      renderChecks();
      renderStamps();
      renderSources();
      checksFlight = null;
      checksTimer = setTimeout(refreshChecks,30000);
    }
  })();
  return checksFlight;
}
function feedback(message,kind) {
  el('activity').dataset.kind = kind;
  el('activity').textContent = message;
}
async function checkAgain() {
  if (state.checking || state.busy) return;
  state.checking = true;
  el('check-again').textContent = 'Checking…';
  updateButtons();
  try { await Promise.all([refreshStatus(),refreshChecks(),refreshFixtures()]); }
  finally {
    state.checking = false;
    el('check-again').textContent = 'Check again';
    el('checks-note').textContent = 'Check finished. ' + (state.online && !state.checksError ? 'The latest results are shown above.' : 'Some parts could not be checked. Read their messages above.') + ' Server checks repeat every 30 seconds; stream status about every 5 seconds.';
    updateButtons();
  }
}
async function control(body,working,saved) {
  if (state.busy || !state.online) return;
  state.busy = true;
  updateButtons();
  feedback(working + '…','working');
  try {
    await requestJson(adminPath + '/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},20000);
    if (body.action === 'stop' || body.action === 'pause') state.lastPauseAction = body.action;
    if (body.action === 'resume' || body.action === 'select_channel') state.lastPauseAction = null;
    feedback(saved,'saved');
    // A poll begun before the command may contain an older snapshot.
    if (statusFlight) await statusFlight;
    await refreshStatus();
  } catch (error) { feedback(requestExplanation(error,true),'error'); }
  finally { state.busy = false; updateButtons(); }
}
el('pause').onclick = () => control({action:'pause'},'Asking the relay to pause','Pause request accepted. Check the status above to confirm the relay is paused.');
el('resume').onclick = () => control({action:'resume'},'Asking the relay to resume','Resume request accepted. This allows starting; it does not confirm video is broadcasting.');
el('stop').onclick = () => control({action:'stop'},'Asking the relay to stop','Stop request accepted. Check the status above and Telegram to confirm the broadcast has ended.');
el('auto').onclick = () => control({action:'auto'},'Saving automatic source choice','Automatic source choice accepted. A pause still takes priority; sending is not confirmed.');
el('force-turbo').onclick = () => control({action:'force',source:'turbosportslive'},'Saving Turbo source choice','Turbo source choice accepted. A pause still takes priority; sending is not confirmed.');
el('force-rwitc').onclick = () => control({action:'force',source:'rwitc'},'Saving official source choice','Official source choice accepted. A pause still takes priority; sending is not confirmed.');
el('autostart').onclick = () => control({action:'auto_start',enabled:!state.status.auto_start},'Saving automatic starting setting','Automatic starting setting accepted. Pause and Stop still take priority; sending is not confirmed.');
el('release').onclick = () => control({action:'release_call'},'Asking Telegram to clear the old call','Clear-call request accepted. Check again to see whether sending can start; video is not confirmed yet.');
el('check-again').onclick = checkAgain;
refreshStatus();
refreshChecks();
refreshFixtures();
setInterval(renderStamps,5000);
</script></body></html>`;
  return new Response(page, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
               'X-Admin-Entry': entryVersion, 'Referrer-Policy': 'no-referrer',
               'X-Robots-Tag': 'noindex, nofollow' },
  });
}
