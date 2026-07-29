#!/usr/bin/env bash
# The many-node case in a real browser: UTC chart axes, and a legend that stays readable.
#
# Both bugs came from a real nine-member bundle and neither is visible to jsdom -- one
# is what uPlot does with a Date on a canvas, the other is what CSS does with nine series in
# one panel. See tools/browser/verify.sh for why Chromium/Firefox run in a container.
#
# BUNDLE must be a directory with one folder per node, each holding its own diagnostic.data.
# TZ is deliberately not UTC: a local-time axis and a UTC axis look identical from UTC.
#
#   npm run verify:nodes -- /path/to/bundle
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="$(node -e "console.log(require('$ROOT/node_modules/playwright/package.json').version)")"
BUNDLE="$(cd "${1:-$ROOT/sample-data/incident}" && pwd)"

docker run --rm \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e URL=http://127.0.0.1:5174/ \
  -e BUNDLE=/bundle \
  -e BROWSER="${BROWSER:-firefox}" \
  -e TZ="${TZ:-America/Mexico_City}" \
  -v "$ROOT":/app -v "$BUNDLE":/bundle:ro -w /app \
  --shm-size=2g \
  "mcr.microsoft.com/playwright:v$VERSION-noble" \
  bash -c 'npx vite --host 127.0.0.1 --port 5174 >/tmp/vite.log 2>&1 &
           for i in $(seq 1 60); do curl -sf http://127.0.0.1:5174/ >/dev/null && break; sleep 1; done
           node tools/browser/verify-nodes.mjs'

docker run --rm -v "$ROOT":/app -w /app "mcr.microsoft.com/playwright:v$VERSION-noble" \
  rm -rf node_modules/.vite
