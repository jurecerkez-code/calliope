#!/bin/bash
# Calliope launcher: start the server, open the door in Chrome.
set -e
cd "$(dirname "$0")"

python3 server.py > server.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8899/api/health > /dev/null 2>&1; then break; fi
  sleep 0.1
done

open -a "Google Chrome" "http://127.0.0.1:8899"
wait $SRV
