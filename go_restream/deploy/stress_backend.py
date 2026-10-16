#!/usr/bin/env python3
"""Bounded, credential-free relay soak. Requires Go, FFmpeg, cc and pkg-config.

Run from any directory: python3 go_restream/deploy/stress_backend.py --out /tmp/relay-stress
Uses real ProcessMedia (copy mode), dashboard, controller and native RTMP sender.
Only the source/discovery and destination API are synthetic. Local CPU is not
a measurement of Render's CPU quota, Telegram capture, or viewer capacity.
"""
import argparse
import concurrent.futures
import http.server
import json
import os
from pathlib import Path
import random
import re
import secrets
import shlex
import signal
import socket
import subprocess
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def percentile(values, fraction):
    return sorted(values)[min(len(values)-1, int((len(values)-1)*fraction))] if values else None


def request(url, token, data=None):
    headers = {'Authorization': 'Bearer ' + token, 'User-Agent': 'StreamDesk-stress/1.0'}
    if data is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(data).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=10) as response:
        return response.read()


def cpu_seconds(text):
    days, _, value = text.rpartition('-')
    fields = value.split(':')
    result = 0.0
    for field in fields:
        result = result * 60 + float(field)
    return result + (int(days)*86400 if days else 0)


def resources(root_pid):
    rows = {}
    for line in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,time=,rss=,comm='], text=True).splitlines():
        fields = line.split(None, 4)
        if len(fields) == 5:
            pid, parent, cpu, rss, name = fields
            rows[int(pid)] = (int(parent), cpu_seconds(cpu), int(rss)/1024, Path(name).name)
    selected = {root_pid}
    for _ in range(4):
        selected |= {pid for pid, row in rows.items() if row[0] in selected}
    return {pid: rows[pid] for pid in selected if pid in rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--seconds', type=int, default=25, help='seconds per concurrency stage (1, 8, 32)')
    args = parser.parse_args()
    if not 5 <= args.seconds <= 120:
        parser.error('--seconds must be 5..120')
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    media_dir = out/'input'; media_dir.mkdir(exist_ok=True)
    processes, logs = [], []
    source_server = None
    try:
        subprocess.run(['go', 'test', '-c', '-tags', 'stress', '-o', str(out/'stress-backend'), './internal/restream'], cwd=ROOT, check=True)
        flags = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs', 'libavformat', 'libavcodec', 'libavutil'], text=True))
        subprocess.run(['cc', '-O2', str(ROOT/'deploy/rtmp_sender.c'), '-o', str(out/'rtmp_sender'), *flags], check=True)
        fixture = out/'fixture.mp4'
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '12', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-b:v', '5M', '-maxrate', '5M', '-bufsize', '10M', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(fixture)], check=True)

        def launch(name, command, env=None):
            log = open(out/(name+'.log'), 'w'); logs.append(log)
            process = subprocess.Popen(command, stdout=log, stderr=log, env=env, start_new_session=True)
            processes.append(process)
            return process

        generator = launch('generator', ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-re', '-stream_loop', '-1', '-i', str(fixture), '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '8', '-hls_flags', 'delete_segments+omit_endlist+program_date_time+temp_file', '-hls_segment_filename', str(media_dir/'input%d.ts'), str(media_dir/'index.m3u8')])
        class QuietHandler(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *a, **kw): super().__init__(*a, directory=str(media_dir), **kw)
            def log_message(self, *a): pass
        source_server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        threading.Thread(target=source_server.serve_forever, daemon=True).start()
        for _ in range(100):
            if (media_dir/'index.m3u8').exists(): break
            if generator.poll() is not None: raise RuntimeError('fixture generator exited')
            time.sleep(.1)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        rtmp_url = f'rtmp://127.0.0.1:{port}/app/stress'
        receiver = launch('receiver', ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'info', '-listen', '1', '-i', rtmp_url, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-'])
        token = secrets.token_hex(32)
        address_file = out/'address'; address_file.unlink(missing_ok=True)
        env = dict(os.environ, GOMAXPROCS='1', GOMEMLIMIT='256MiB', STRESS_SOURCE_URL=f'http://127.0.0.1:{source_server.server_port}/index.m3u8', STRESS_RTMP_URL=rtmp_url, STRESS_SENDER=str(out/'rtmp_sender'), STRESS_TOKEN=token, STRESS_ADDRESS_FILE=str(address_file))
        backend = launch('backend', [str(out/'stress-backend'), '-test.run', '^TestBackendStress$', '-test.v'], env)
        deadline = time.monotonic() + 50
        while time.monotonic() < deadline:
            if backend.poll() is not None: raise RuntimeError('backend exited during startup')
            if address_file.exists():
                base = address_file.read_text()
                state = json.loads(request(base+'/api/status', token))
                if state['phase'] == 'live': break
            time.sleep(.2)
        else: raise RuntimeError('backend never became live; inspect local logs')
        # Let FFmpeg finish opening its live HLS window before measuring.
        time.sleep(5)
        if receiver.poll() is not None: raise RuntimeError('RTMP receiver exited')
        result = {'platform': subprocess.check_output(['uname', '-sm'], text=True).strip(), 'source': '1920x1080 30fps H264 target 5Mbps + AAC', 'mode': 'production copy relay + native sender + RTMP receiver decode', 'limits': {'GOMAXPROCS':1,'GOMEMLIMIT':'256MiB','cpu_quota':None}, 'excluded': ['source generator', 'HTTP source fixture', 'RTMP decode receiver', 'load generator', 'Telegram capture/MediaMTX'], 'stages': []}
        for concurrency in [1, 8, 32]:
            start = time.monotonic(); stop_at = start + args.seconds
            latencies, failures, byte_counts = [], [], []
            lock = threading.Lock()
            samples = []
            before = resources(backend.pid)
            cpu_deltas = {}; peaks = {}; previous = before
            def load(worker_index):
                rng = random.Random(worker_index)
                while time.monotonic() < stop_at:
                    begin = time.monotonic()
                    try:
                        value = rng.random()
                        if value < .60: payload = request(base+'/api/status', token)
                        elif value < .80: payload = request(base+'/output/index.m3u8', token)
                        elif value < .90: payload = request(base+'/preview/turbo/index.m3u8', token)
                        else:
                            playlist = request(base+'/output/index.m3u8', token).decode()
                            name = [line for line in playlist.splitlines() if line and not line.startswith('#')][-1]
                            payload = request(base+'/output/'+name, token)
                        with lock: latencies.append((time.monotonic()-begin)*1000); byte_counts.append(len(payload))
                    except Exception as error:
                        with lock: failures.append(type(error).__name__)
                    time.sleep(.05)
            with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
                futures = [pool.submit(load, i) for i in range(concurrency)]
                while time.monotonic() < stop_at:
                    current = resources(backend.pid)
                    total_rss = sum(row[2] for row in current.values())
                    samples.append(total_rss)
                    for pid, row in current.items():
                        label = 'go' if pid == backend.pid else row[3]
                        peaks[label] = max(peaks.get(label, 0), row[2])
                        if pid in previous:
                            cpu_deltas[label] = cpu_deltas.get(label,0) + max(0,row[1]-previous[pid][1])
                    previous = current
                    if backend.poll() is not None or receiver.poll() is not None:
                        raise RuntimeError('media/backend exited under load')
                    time.sleep(.5)
                for future in futures: future.result()
            elapsed = time.monotonic()-start
            stage = {'concurrency':concurrency,'seconds':round(elapsed,2),'requests':len(latencies)+len(failures),'failures':len(failures),'errors':sorted(set(failures)), 'requests_per_second':round((len(latencies)+len(failures))/elapsed,2),'latency_ms':{'p50':round(percentile(latencies,.5),2),'p95':round(percentile(latencies,.95),2),'p99':round(percentile(latencies,.99),2)},'relay_cpu_core_percent':round(sum(cpu_deltas.values())/elapsed*100,2),'cpu_by_process':{k:round(v/elapsed*100,2) for k,v in cpu_deltas.items()},'relay_rss_mib_peak':round(max(samples),2),'rss_mib_by_process_peak':{k:round(v,2) for k,v in peaks.items()},'phase':json.loads(request(base+'/api/status',token))['phase']}
            result['stages'].append(stage); print(json.dumps(stage), flush=True)
        request(base+'/api/control',token,{'auto':True,'paused':True,'forced':'','fallbacks':[]})
        deadline = time.monotonic()+12
        while time.monotonic()<deadline:
            state=json.loads(request(base+'/api/status',token))
            if state['phase']=='paused': break
            time.sleep(.2)
        result['final_phase']=state['phase']
        backend.send_signal(signal.SIGTERM); backend.wait(timeout=15)
        try: receiver.wait(timeout=10)
        except subprocess.TimeoutExpired: receiver.terminate(); receiver.wait(timeout=5)
        receiver_text=(out/'receiver.log').read_text()
        frames=re.findall(r'frame=\s*(\d+)',receiver_text)
        result['decoded_frames']=int(frames[-1]) if frames else 0
        result['decode_errors']=bool(re.search(r'Error while decoding|corrupt decoded frame|Invalid data found',receiver_text))
        result['backend_exit']=backend.returncode
        result['passed']=all(s['failures']==0 and s['phase']=='live' for s in result['stages']) and result['final_phase']=='paused' and result['decoded_frames']>0 and not result['decode_errors'] and result['backend_exit']==0
        (out/'results.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps({k:result[k] for k in ['decoded_frames','decode_errors','final_phase','backend_exit','passed']}),flush=True)
        if not result['passed']: raise RuntimeError('stress assertions failed')
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: os.killpg(process.pid, signal.SIGKILL); process.wait()
        if source_server: source_server.shutdown(); source_server.server_close()
        for log in logs: log.close()


if __name__ == '__main__': main()
