#!/bin/sh
set -eu
umask 077
mkdir -p /data/session /data/config
mediamtx /app/mediamtx.yml &
media_pid=$!
streamdesk serve &
app_pid=$!
stop() {
  trap - TERM INT
  kill -TERM "$app_pid" 2>/dev/null || true
  wait "$app_pid" 2>/dev/null || true
  kill -TERM "$media_pid" 2>/dev/null || true
  wait "$media_pid" 2>/dev/null || true
}
trap 'stop; exit 0' TERM INT
# A failed dependency must restart the whole service, not leave a half-live host.
while kill -0 "$app_pid" 2>/dev/null && kill -0 "$media_pid" 2>/dev/null; do
  sleep 1 &
  wait $! || true
done
stop
exit 1
