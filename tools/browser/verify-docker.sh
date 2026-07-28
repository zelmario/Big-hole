#!/usr/bin/env bash
# Build the image, run it, and check the app inside it actually works -- not just that nginx
# answers. The browser shares the container's network namespace so `localhost` is that nginx,
# which is what makes the secure-context requirement (OPFS, workers) a real test.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="$(node -e "console.log(require('$ROOT/node_modules/playwright/package.json').version)")"
NAME="big-hole-verify-$$"

cd "$ROOT"
docker build -t big-hole .
docker run -d --name "$NAME" big-hole >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

for i in $(seq 1 30); do
  docker exec "$NAME" wget -q -O /dev/null http://localhost/ 2>/dev/null && break
  sleep 1
done

docker run --rm --network "container:$NAME" \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -v "$ROOT":/app -w /app \
  "mcr.microsoft.com/playwright:v$VERSION-noble" \
  node tools/browser/verify-docker.mjs
