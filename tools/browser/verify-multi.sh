#!/usr/bin/env bash
# Load a two-node bundle into the real app, in a real browser.
#
# See tools/browser/verify.sh for why Chromium runs in a container. BUNDLE must be a directory
# containing one folder per node, each with its own diagnostic.data.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="$(node -e "console.log(require('$ROOT/node_modules/playwright/package.json').version)")"
BUNDLE="${1:-sample-data/multi}"

docker run --rm \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e URL=http://127.0.0.1:5174/ \
  -e BUNDLE="$BUNDLE" \
  -v "$ROOT":/app -w /app \
  "mcr.microsoft.com/playwright:v$VERSION-noble" \
  bash -c 'npx vite --host 127.0.0.1 --port 5174 >/tmp/vite.log 2>&1 &
           for i in $(seq 1 40); do curl -sf http://127.0.0.1:5174/ >/dev/null && break; sleep 1; done
           node tools/browser/multi.mjs'

docker run --rm -v "$ROOT":/app -w /app "mcr.microsoft.com/playwright:v$VERSION-noble" \
  rm -rf node_modules/.vite
