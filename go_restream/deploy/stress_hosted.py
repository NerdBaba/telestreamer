#!/usr/bin/env python3
"""Read-only hosted API bursts. No media startup or Telegram control requests.

Example: python3 go_restream/deploy/stress_hosted.py --secrets-file worker/.dev.vars.release.json --out /tmp/hosted-stress.json
Credentials are read locally, sent only to the existing Render API, never logged.
Maximum 20 requests/second total, 10 seconds at each of 1/5/10/20 concurrency.
"""
import argparse
import concurrent.futures
import json
from pathlib import Path
import threading
import time
import urllib.error
import urllib.request

RENDER = 'https://telestreamer-unhc.onrender.com'
WORKER = 'https://rwitc-racing.curos282.workers.dev'


def pct(values, fraction):
    return round(sorted(values)[min(len(values)-1, int((len(values)-1)*fraction))],2) if values else None


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--secrets-file',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args()
    token=json.loads(args.secrets_file.read_text())['RELAY_TOKEN']
    targets=[('render-health',RENDER+'/health'),('render-status',RENDER+'/api/status'),('worker-status',WORKER+'/api/stream-status')]
    def get(url):
        headers={'User-Agent':'Mozilla/5.0 (compatible; StreamDesk-stress/1.0)'}
        if url.startswith(RENDER+'/'): headers['Authorization']='Bearer '+token
        with urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=15) as response:
            return response.status,json.load(response)
    _, before=get(RENDER+'/api/status')
    result={'targets':[t[0] for t in targets],'request_rate_cap':20,'read_only':True,'initial_phase':before['phase'],'stages':[]}
    for concurrency in [1,5,10,20]:
        start=time.monotonic(); end=start+10; next_request=start
        lock=threading.Lock(); rows=[]; errors=[]; abort=threading.Event(); counter=0
        def load():
            nonlocal next_request,counter
            while time.monotonic()<end and not abort.is_set():
                with lock:
                    slot=max(next_request,time.monotonic()); next_request=slot+.05
                    target=targets[counter%len(targets)]; counter+=1
                if slot>=end: return
                time.sleep(max(0,slot-time.monotonic()))
                begin=time.monotonic()
                try:
                    code,payload=get(target[1])
                    valid=payload.get('status')=='ok' if target[0]=='render-health' else 'phase' in payload if target[0]=='render-status' else 'live' in payload and 'paused' in payload
                    if not valid: raise ValueError('invalid response shape')
                    with lock: rows.append((target[0],code,(time.monotonic()-begin)*1000))
                except Exception as error:
                    with lock:
                        errors.append({'target':target[0],'error':type(error).__name__,'status':getattr(error,'code',None),'reason':str(getattr(error,'reason',error))[:200]})
                        if len(errors)>=5: abort.set()
        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
            list(pool.map(lambda _:load(),range(concurrency)))
        elapsed=time.monotonic()-start
        stage={'concurrency':concurrency,'seconds':round(elapsed,2),'requests':len(rows)+len(errors),'failures':len(errors),'requests_per_second':round((len(rows)+len(errors))/elapsed,2),'errors':errors,'endpoints':{}}
        for name,_ in targets:
            durations=[r[2] for r in rows if r[0]==name]
            stage['endpoints'][name]={'ok':len(durations),'p50_ms':pct(durations,.5),'p95_ms':pct(durations,.95),'p99_ms':pct(durations,.99),'max_ms':round(max(durations),2) if durations else None}
        result['stages'].append(stage);print(json.dumps(stage),flush=True)
        if abort.is_set(): break
    _,after=get(RENDER+'/api/status')
    result['final_phase']=after['phase']; result['controls_unchanged']=before['controls']==after['controls']
    result['passed']=len(result['stages'])==4 and all(s['failures']==0 for s in result['stages']) and result['controls_unchanged']
    args.out.parent.mkdir(parents=True,exist_ok=True);args.out.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'passed':result['passed'],'controls_unchanged':result['controls_unchanged'],'final_phase':result['final_phase']}),flush=True)
    if not result['passed']: raise SystemExit(1)


if __name__=='__main__': main()
