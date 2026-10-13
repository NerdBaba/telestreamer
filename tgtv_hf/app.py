"""Gradio host: CPU live streaming with optional GPU video previews."""
import asyncio
import base64
import hmac
import json
import os
import subprocess
from contextlib import asynccontextmanager
from pathlib import Path

import gradio as gr
import httpx
from gradio.routes import App
from fastapi import HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from starlette.background import BackgroundTask
from preview import capture_video_frame, create_preview

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / ".runtime"
REQUIRED = ("TELEGRAM_API_ID", "TELEGRAM_API_HASH", "SESSION_JSON_B64", "PATH_SECRET", "MEDIAMTX_HLS_CDN_SECRET")
STREAM_ID = "2631340b81ae"
BASE_URL = ("https://" + os.environ["SPACE_HOST"]) if os.environ.get("SPACE_HOST") else os.environ.get("PUBLIC_BASE_URL", "http://127.0.0.1:7860")
STATE = {"missing": [], "processes": [], "http": None}


def authorized(token):
    expected = os.environ.get("PATH_SECRET", "")
    return bool(expected and token and hmac.compare_digest(token.encode(), expected.encode()))


def links(token):
    if not authorized(token):
        raise gr.Error("Invalid playback token.")
    prefix = f"{BASE_URL}/p/{token}"
    return f"[Open live player]({prefix}/watch)\n\nVLC / HLS: `{prefix}/streams/{STREAM_ID}/play.m3u8`"


def video_preview(token):
    if not authorized(token):
        raise gr.Error("Invalid playback token.")
    try:
        frame = capture_video_frame(f"http://127.0.0.1:8090/p/{token}/streams/{STREAM_ID}/play.m3u8")
    except (OSError, ValueError, subprocess.SubprocessError):
        raise gr.Error("No video frame available. The broadcast may be offline or still starting.") from None
    return create_preview(frame)


@asynccontextmanager
async def lifespan(app):
    os.umask(0o077)
    STATE["missing"] = [name for name in REQUIRED if not os.environ.get(name)]
    async with httpx.AsyncClient(timeout=httpx.Timeout(90, connect=10), follow_redirects=False) as client:
        STATE["http"] = client
        try:
            if not STATE["missing"]:
                RUNTIME.mkdir(mode=0o700, exist_ok=True)
                session_dir = RUNTIME / "session"
                config_dir = RUNTIME / "config"
                session_dir.mkdir(mode=0o700, exist_ok=True)
                config_dir.mkdir(mode=0o700, exist_ok=True)
                session = base64.b64decode(os.environ["SESSION_JSON_B64"], validate=True)
                json.loads(session)
                (session_dir / "tgtv.json").write_bytes(session)
                media_config = RUNTIME / "mediamtx.yml"
                media_config.write_text("\n".join((
                    "logLevel: warn", "hlsCDNSecret: " + json.dumps(os.environ["MEDIAMTX_HLS_CDN_SECRET"]),
                    "hls: yes", "hlsAddress: 127.0.0.1:8888", "hlsVariant: mpegts",
                    "hlsSegmentCount: 12", "hlsSegmentDuration: 1s", "hlsAlwaysRemux: yes",
                    "rtmp: yes", "rtmpAddress: 127.0.0.1:1935", "rtsp: no", "webrtc: no",
                    "srt: no", "readTimeout: 3600s", "paths:", "  all_others:", ""
                )))
                child_env = dict(os.environ)
                child_env.pop("SESSION_JSON_B64", None)
                child_env.update(SESSION_DIR=str(session_dir), CONFIG_DIR=str(config_dir), SESSION_NAME="tgtv",
                                 HTTP_HOST="127.0.0.1", HTTP_PORT="8090", PUBLIC_BASE_URL=BASE_URL,
                                 RTMP_BASE_URL="rtmp://127.0.0.1:1935/live", MEDIAMTX_HLS_URL="http://127.0.0.1:8888",
                                 MAX_CONCURRENT_INGESTS="1", LOG_LEVEL="info")
                for binary, args in (("mediamtx", [str(media_config)]), ("tgtv", ["serve"])):
                    executable = ROOT / binary
                    executable.chmod(0o755)
                    STATE["processes"].append(await asyncio.create_subprocess_exec(str(executable), *args, env=child_env))
            yield
        finally:
            for process in reversed(STATE["processes"]):
                if process.returncode is None:
                    process.terminate()
            for process in STATE["processes"]:
                try:
                    await asyncio.wait_for(process.wait(), timeout=15)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            STATE["processes"].clear()
            STATE["http"] = None


app = App()


@app.get("/health")
async def health():
    if STATE["missing"]:
        return JSONResponse({"status": "configuration_required", "missing": STATE["missing"]}, status_code=503)
    if any(p.returncode is not None for p in STATE["processes"]):
        return JSONResponse({"status": "relay_process_exited"}, status_code=503)
    try:
        response = await STATE["http"].get("http://127.0.0.1:8090/health")
        return JSONResponse(response.json(), status_code=response.status_code)
    except (httpx.HTTPError, ValueError):
        return JSONResponse({"status": "relay_starting"}, status_code=503)


@app.get("/p/{token}/watch", response_class=HTMLResponse)
async def watch(token):
    if not authorized(token):
        raise HTTPException(404)
    source = json.dumps(f"/p/{token}/streams/{STREAM_ID}/play.m3u8").replace("<", "\\u003c")
    return HTMLResponse("""<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Turbo live playback</title><script src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"></script></head>
<body><video id="video" controls autoplay muted playsinline style="width:100%;max-height:85vh"></video><p id="status">Connecting to live broadcast…</p><script>
const video=document.getElementById('video'),status=document.getElementById('status'),source=""" + source + """;
window.playbackStats={waiting:0,errors:[],samples:[]};
video.addEventListener('waiting',()=>window.playbackStats.waiting++);
video.addEventListener('playing',()=>status.textContent='Live');
setInterval(()=>window.playbackStats.samples.push({wall:performance.now()/1000,media:video.currentTime,ready:video.readyState}),1000);
if(Hls.isSupported()){const hls=new Hls();hls.loadSource(source);hls.attachMedia(video);
hls.on(Hls.Events.MANIFEST_PARSED,()=>video.play().catch(()=>status.textContent='Press play'));
hls.on(Hls.Events.ERROR,(_,event)=>{window.playbackStats.errors.push(event.details);if(event.fatal)status.textContent='Stream unavailable: '+event.details;});}
else if(video.canPlayType('application/vnd.apple.mpegurl')){video.src=source;video.play().catch(()=>status.textContent='Press play');}
else status.textContent='Use VLC with the HLS link; this browser cannot play HLS.';
</script></body></html>""", headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


@app.get("/p/{token}/{path:path}")
async def proxy(token: str, path: str, request: Request):
    if not authorized(token):
        raise HTTPException(404)
    if STATE["missing"] or len(STATE["processes"]) != 2 or any(p.returncode is not None for p in STATE["processes"]):
        raise HTTPException(503, "Relay not running.")
    query = request.url.query
    url = f"http://127.0.0.1:8090/p/{token}/{path}" + (f"?{query}" if query else "")
    headers = {key: request.headers[key] for key in ("range", "if-none-match", "if-modified-since") if key in request.headers}
    try:
        response = await STATE["http"].send(STATE["http"].build_request("GET", url, headers=headers), stream=True)
    except httpx.HTTPError:
        raise HTTPException(502, "Relay unavailable.") from None
    outgoing = {key: value for key, value in response.headers.items()
                if key in ("content-type", "cache-control", "etag", "last-modified", "content-range", "accept-ranges")}
    outgoing["Referrer-Policy"] = "no-referrer"
    return StreamingResponse(response.aiter_bytes(), status_code=response.status_code, headers=outgoing,
                             background=BackgroundTask(response.aclose))


with gr.Blocks(title="Turbo live relay trial") as demo:
    gr.Markdown("# Turbo live relay trial\nLive streaming uses [unmodified tgtv](https://github.com/aleskxyz/tgtv/tree/69ddb30949cdeb604820a5d324e01b1b76a7b79a) on CPU. The optional video preview uses GPU processing when available and falls back to CPU when GPU allocation fails.\n\nEnter your private playback token. The source must be broadcasting. Free Spaces may sleep or restart.")
    token = gr.Textbox(label="Playback token", type="password")
    button = gr.Button("Get live playback links")
    output = gr.Markdown()
    button.click(links, inputs=token, outputs=output, api_name=False)
    preview_button = gr.Button("Refresh video preview (GPU optional)")
    preview_image = gr.Image(label="Current video frame", type="pil")
    preview_status = gr.Markdown()
    preview_button.click(video_preview, inputs=token, outputs=[preview_image, preview_status], api_name="video_preview")

if __name__ == "__main__":
    # ZeroGPU's supported startup handshake is attached to Blocks.launch.
    # Reuse the same app so CPU media endpoints stay outside the GPU queue.
    demo.launch(server_name="0.0.0.0", server_port=7860, _app=app,
                app_kwargs={"lifespan": lifespan}, blocked_paths=[str(RUNTIME)],
                show_error=False, ssr_mode=False)
