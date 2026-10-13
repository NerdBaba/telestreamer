FROM python:3.12-slim-bookworm AS sender-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config libavformat-dev libavcodec-dev libavutil-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY relay_engine/rtmp_sender.c ./rtmp_sender.c
RUN cc -std=c11 -O2 -Wall -Wextra rtmp_sender.c -o rtmp_sender \
    $(pkg-config --cflags --libs libavformat libavcodec libavutil)

FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 relay
WORKDIR /app
COPY --chown=relay:relay relay_engine ./relay_engine
COPY --chown=relay:relay rwitc_live.py ./rwitc_live.py
RUN mkdir -p /app/.relay/runtime && chown relay:relay /app \
    && chown -R relay:relay /app/.relay \
    && chmod 700 /app/.relay /app/.relay/runtime
COPY --from=sender-build --chown=relay:relay --chmod=700 /build/rtmp_sender /app/.relay/runtime/rtmp_sender
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
# No session file is baked into this image: a Telegram session is an
# authorized credential, and it must never ship in a public repository.
# Render supplies TELEGRAM_SESSION_B64, which relay_engine.session_restore
# validates and writes to a private 0600 file at startup.
USER relay
EXPOSE 10000
CMD ["python", "-m", "relay_engine.daemon"]
