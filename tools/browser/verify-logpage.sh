#!/usr/bin/env bash
# Does the log window page through a log larger than its buffer?
#
# See tools/browser/verify.sh for why Chromium runs in a container. BUNDLE must be a directory
# holding one node folder with a diagnostic.data and a mongod log beside it -- the log needs to
# be substantially longer than the buffer for this to test anything, so use a real one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="$(node -e "console.log(require('$ROOT/node_modules/playwright/package.json').version)")"
BUNDLE="${1:-sample-data/logpage}"

docker run --rm \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e URL=http://127.0.0.1:5174/ \
  -e BUNDLE="$BUNDLE" \
  -v "$ROOT":/app -w /app \
  "mcr.microsoft.com/playwright:v$VERSION-noble" \
  bash -c 'npx vite --host 127.0.0.1 --port 5174 >/tmp/vite.log 2>&1 &
           for i in $(seq 1 40); do curl -sf http://127.0.0.1:5174/ >/dev/null && break; sleep 1; done
           node tools/browser/logpage.mjs'

docker run --rm -v "$ROOT":/app -w /app "mcr.microsoft.com/playwright:v$VERSION-noble" \
  rm -rf node_modules/.vite
