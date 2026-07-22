#!/usr/bin/env bash
# Exercise drag and resize in a real browser.
#
# jsdom cannot catch this class of bug: it has a real `process`, so
# `ReferenceError: process is not defined` -- which killed every drag in the browser -- passed
# silently in tests. Chromium runs in a container because Playwright's system libraries are
# not installable here without root.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="$(node -e "console.log(require('$ROOT/node_modules/playwright/package.json').version)")"

docker run --rm \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e URL=http://127.0.0.1:5174/tools/browser/debug-grid.html \
  -v "$ROOT":/app -w /app \
  "mcr.microsoft.com/playwright:v$VERSION-noble" \
  bash -c 'npx vite --host 127.0.0.1 --port 5174 >/tmp/vite.log 2>&1 &
           for i in $(seq 1 40); do curl -sf http://127.0.0.1:5174/ >/dev/null && break; sleep 1; done
           node tools/browser/drive.mjs'

# The container runs as root and leaves a root-owned Vite cache behind.
docker run --rm -v "$ROOT":/app -w /app "mcr.microsoft.com/playwright:v$VERSION-noble" \
  rm -rf node_modules/.vite
