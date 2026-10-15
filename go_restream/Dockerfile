FROM bluenviron/mediamtx:1.19.2 AS mediamtx
FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /streamdesk ./cmd/tgtv
# Offer the exact modified source, build scripts and dependency checksums.
RUN tar --exclude='./.demo-data' --exclude='./data' --exclude='./.env' --exclude='./.git' -czf /source.tar.gz .

FROM debian:bookworm-slim AS native
RUN apt-get update && apt-get install -y --no-install-recommends gcc pkg-config libavformat-dev libavcodec-dev libavutil-dev && rm -rf /var/lib/apt/lists/*
COPY deploy/rtmp_sender.c /tmp/rtmp_sender.c
RUN cc -O2 -Wall -Wextra /tmp/rtmp_sender.c -o /rtmp_sender $(pkg-config --cflags --libs libavformat libavcodec libavutil)

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl tini && rm -rf /var/lib/apt/lists/* && useradd --create-home --uid 10001 streamdesk && mkdir -p /data/session /data/config /app && chown -R 10001:10001 /data
COPY --from=build /streamdesk /usr/local/bin/streamdesk
COPY --from=build /source.tar.gz /app/source.tar.gz
COPY --from=native /rtmp_sender /usr/local/bin/rtmp_sender
COPY --from=mediamtx /mediamtx /usr/local/bin/mediamtx
COPY deploy/mediamtx.yml /app/mediamtx.yml
COPY --chmod=755 deploy/entrypoint.sh /usr/local/bin/entrypoint
USER streamdesk
ENV SESSION_DIR=/data/session SESSION_NAME=tgtv CONFIG_DIR=/data/config HTTP_HOST=0.0.0.0 HTTP_PORT=8090 MAX_CONCURRENT_INGESTS=3 IDLE_GRACE_SECONDS=20 FULL_SCAN_INTERVAL_SECONDS=300 LOG_LEVEL=warn RTMP_SENDER=/usr/local/bin/rtmp_sender SOURCE_ARCHIVE=/app/source.tar.gz
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD curl -fsS http://127.0.0.1:8090/health || exit 1
ENTRYPOINT ["/usr/bin/tini","--","entrypoint"]
