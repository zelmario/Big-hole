#!/usr/bin/env bash
# Capture FTDC from a matrix of MongoDB versions.
#
# The dashboard has to work on whatever a customer sends, and metric paths move between
# releases -- concurrency tickets left wiredTiger.concurrentTransactions for queues.execution
# in 8.0, and 8.0 scopes sections by role on a sharded cluster. Guessing at that is how you
# ship a dashboard that silently resolves nothing; this captures the ground truth instead.
#
#   bash tools/fixtures/versions.sh            # default matrix
#   VERSIONS="6.0 8.0" bash tools/fixtures/versions.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/sample-data/versions"
VERSIONS="${VERSIONS:-4.4 5.0 6.0 7.0 8.0}"
RUN_SECONDS="${RUN_SECONDS:-75}"

mkdir -p "$OUT"

start_one() {
  local version="$1" name="ftdc-lens-v${1//./_}"
  docker rm -f "$name" >/dev/null 2>&1

  # Fast FTDC sampling: a chunk every ~30s instead of every 5 minutes.
  if ! docker run -d --name "$name" "mongo:$version" \
      --replSet rs --bind_ip_all \
      --setParameter diagnosticDataCollectionPeriodMillis=100 >/dev/null 2>&1; then
    echo "  $version: could not start (image unavailable on this platform?)"
    return 1
  fi
  echo "  $version: started"
}

shell_in() {
  local name="$1" script="$2"
  # mongosh replaced the legacy shell in 6.0; older images only have `mongo`.
  docker exec "$name" mongosh --quiet --eval "$script" >/dev/null 2>&1 ||
    docker exec "$name" mongo --quiet --eval "$script" >/dev/null 2>&1
}

echo "starting ${VERSIONS}"
started=()
for v in $VERSIONS; do
  if start_one "$v"; then started+=("$v"); fi
done

sleep 12
for v in "${started[@]}"; do
  name="ftdc-lens-v${v//./_}"
  shell_in "$name" 'rs.initiate()' && echo "  $v: replica set initiated"
done

echo "collecting for ${RUN_SECONDS}s"
for v in "${started[@]}"; do
  name="ftdc-lens-v${v//./_}"
  # Light write load in the background so counters actually move.
  docker exec -d "$name" sh -c \
    "(mongosh --quiet --eval 'const c=db.getSiblingDB(\"b\").e; const end=Date.now()+${RUN_SECONDS}*1000; let n=0; while(Date.now()<end){const a=[];for(let i=0;i<200;i++)a.push({n:n++,p:\"x\".repeat(100)});c.insertMany(a);c.find().limit(50).toArray();}' || \
      mongo --quiet --eval 'var c=db.getSiblingDB(\"b\").e; var end=Date.now()+${RUN_SECONDS}*1000; var n=0; while(Date.now()<end){var a=[];for(var i=0;i<200;i++)a.push({n:n++,p:\"x\"});c.insert(a);}')" >/dev/null 2>&1
done

sleep "$RUN_SECONDS"
sleep 20   # let one more chunk flush

echo "harvesting"
for v in "${started[@]}"; do
  name="ftdc-lens-v${v//./_}"
  dest="$OUT/$v"
  rm -rf "$dest"; mkdir -p "$dest"
  if docker cp "$name:/data/db/diagnostic.data/." "$dest/" >/dev/null 2>&1; then
    chmod -R u+w "$dest" 2>/dev/null
    n=$(find "$dest" -name 'metrics.*' | wc -l)
    echo "  $v: $n file(s), $(du -sh "$dest" | cut -f1)"
  else
    echo "  $v: no diagnostic.data"
  fi
  docker rm -f "$name" >/dev/null 2>&1
done

echo
echo "captures in $OUT"
