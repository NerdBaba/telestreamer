'use strict';
const $ = id => document.getElementById(id);
let state = null, busy = false, outputKey = '', sourcePreview = null, previewError = '';
const cards = new Map(), players = new Map();
function detach(video) { const hls = players.get(video); if (hls) hls.destroy(); players.delete(video); video.pause(); video.removeAttribute('src'); video.load(); }
function attach(video, url, onError) {
 detach(video);
 if (window.Hls && Hls.isSupported()) {
  const hls = new Hls({enableWorker:true,lowLatencyMode:false,backBufferLength:10,maxBufferLength:12});players.set(video,hls);
  hls.attachMedia(video);hls.loadSource(url);hls.on(Hls.Events.MANIFEST_PARSED,()=>video.play().catch(()=>{}));
  hls.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal){detach(video);if(onError)onError();}});
 } else if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = url; video.play().catch(() => {}); }
 else if(onError) onError();
}
async function control(patch) {
 if (!state || busy) return;
 busy = true;
 try { const response = await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...state.controls,...patch})}); if(!response.ok)throw new Error(await response.text()); render(await response.json()); }
 catch(e){showError(e.message || 'Controls could not be saved.');}
 finally{busy=false;}
}
function showError(message){$('error').textContent=message;$('error').classList.toggle('hidden',!message);}
function render(s) {
 state=s;$('demo').classList.toggle('hidden',!s.demo);
 const active=s.sources.find(source=>source.id===s.active);
 const labels={idle:'Waiting',paused:'Paused',starting:'Starting',live:'Live',retrying:'Retrying'};
 $('phase').textContent=labels[s.phase]||s.phase;$('phase').classList.toggle('live',s.phase==='live');
 $('output-heading').textContent=active?active.title:(s.phase==='paused'?'Automation paused':s.phase==='starting'?'Preparing the broadcast':'Waiting for a live source');
 $('decision').textContent=s.controls.forced?'Manual source selected. Use automatic to restore Turbo priority.':s.controls.paused?'Resume when you’re ready to go live.':'Turbo starts automatically. Enabled backups fill the gaps.';
 $('mode').textContent=s.controls.forced?'Manual':'Automatic';$('checked').textContent=s.checked_at.startsWith('0001')?'—':new Date(s.checked_at).toLocaleTimeString();
 $('pause').textContent=s.controls.paused?'Resume automation':'Pause automation';$('auto').disabled=!s.controls.forced&&s.controls.auto&&!s.controls.paused;
 const nextKey=s.active+(s.events.length?s.events[s.events.length-1].time:'');
 if(!document.hidden&&s.active&&nextKey!==outputKey){outputKey=nextKey;attach($('output-video'),'/output/index.m3u8',()=>{outputKey='';});}
 if(!s.active&&outputKey){detach($('output-video'));outputKey='';}
 $('output-empty').classList.toggle('hidden',!!s.active);
 const ids=new Set(s.sources.map(source=>source.id));
 for(const [id,card] of cards){if(!ids.has(id)){detach(card.querySelector('video'));card.remove();cards.delete(id);}}
 for(const source of s.sources){
  let card=cards.get(source.id);
  if(!card){card=$('source-template').content.firstElementChild.cloneNode(true);cards.set(source.id,card);$('sources').append(card);
   card.querySelector('.use-source').addEventListener('click',()=>control({auto:true,paused:false,forced:source.id}));
   card.querySelector('input').addEventListener('change',event=>{const enabled=event.target.checked;const fallbacks=state.controls.fallbacks||[];control({fallbacks:enabled?[...fallbacks.filter(id=>id!==source.id),source.id]:fallbacks.filter(id=>id!==source.id)});});
   card.querySelector('.preview-button').addEventListener('click',()=>{
    previewError='';showError('');
    if(sourcePreview){const old=cards.get(sourcePreview);if(old){detach(old.querySelector('video'));old.querySelector('.preview-button').classList.remove('hidden');}}
    sourcePreview=source.id;card.querySelector('.preview-button').classList.add('hidden');
    attach(card.querySelector('video'),'/preview/'+encodeURIComponent(source.id)+'/index.m3u8',()=>{card.querySelector('.preview-button').classList.remove('hidden');sourcePreview=null;previewError='Preview unavailable for '+source.title+'. The call may be open without playable media. Try again shortly.';showError(previewError);});
   });
  }
  const primary=source.chat_id===2961901881, chosen=source.id===s.active, test=!!source.test_url;
  card.classList.toggle('active',chosen);card.querySelector('h3').textContent=source.title;
  const index=(s.controls.fallbacks||[]).indexOf(source.id);
  card.querySelector('.source-role').textContent=test?'PUBLIC TEST · MANUAL ONLY':primary?'PRIMARY SOURCE':['rwitc','mysore'].includes(source.id)?'OFFICIAL FALLBACK':index>=0?'FALLBACK '+(index+1):'MEMBER CHANNEL';
  card.querySelector('.source-detail').textContent=source.detail;
  const testLink=card.querySelector('.test-link');testLink.classList.toggle('hidden',!test);if(test){testLink.href=source.test_url;testLink.textContent=source.test_url;}
  const badge=card.querySelector('.source-badge');badge.textContent=chosen?'On air':test?'Test':source.live?'Live':'Offline';badge.classList.toggle('live',source.live);
  const preview=card.querySelector('.preview-button');preview.disabled=!source.live;preview.lastElementChild.textContent=source.live?'Open preview':'No live broadcast';
  card.querySelector('.use-source').disabled=!source.live||chosen;card.querySelector('.use-source').textContent=chosen?'On air':'Use this feed';
  const checkbox=card.querySelector('input');checkbox.checked=index>=0;card.querySelector('.fallback').classList.toggle('hidden',primary||test);
  if(!source.live&&sourcePreview===source.id){detach(card.querySelector('video'));preview.classList.remove('hidden');sourcePreview=null;}
 }
 $('events').replaceChildren();for(const event of [...s.events].reverse().slice(0,8)){const li=document.createElement('li');const time=document.createElement('time');time.dateTime=event.time;time.textContent=new Date(event.time).toLocaleTimeString();const text=document.createElement('span');text.textContent=event.detail;li.append(time,text);$('events').append(li);}
 if(!s.events.length){const li=document.createElement('li');li.textContent='Monitoring sources. Broadcast activity will appear here.';$('events').append(li);}
 showError(s.error||previewError);
}
$('pause').addEventListener('click',()=>control({auto:true,paused:!state.controls.paused}));
$('auto').addEventListener('click',()=>control({auto:true,paused:false,forced:''}));
async function poll(){try{const response=await fetch('/api/status');if(response.status===401){location.assign('/login');return;}if(!response.ok)throw new Error();const s=await response.json();if(!busy)render(s);$('connection').textContent='Connected';$('connection').classList.add('connected');}catch{ $('connection').textContent='Connection lost';$('connection').classList.remove('connected');showError('Connection lost. Retrying automatically.');}finally{setTimeout(poll,2000);}}
document.addEventListener('visibilitychange',()=>{if(document.hidden){for(const video of players.keys())detach(video);outputKey='';if(sourcePreview){const card=cards.get(sourcePreview);if(card)card.querySelector('.preview-button').classList.remove('hidden');sourcePreview=null;}}});
poll();

for(const [label,live] of [['Turbo live',['turbo','free']],['Fallback only',['free']],['All offline',[]]]) {const button=document.createElement('button');button.textContent=label;button.addEventListener('click',async()=>{try{const response=await fetch('/api/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({live})});if(!response.ok)throw new Error('Demo change failed');}catch(e){showError(e.message);}});$('demo').append(button);}
