#!/usr/bin/env bash
# Generate FTDC test fixtures and their oracle dumps.
#
# Requires a local mongod + mongosh. Writes to sample-data/ (gitignored -- fixtures are
# real captures and are regenerated, not committed).
#
# The key trick is diagnosticDataCollectionPeriodMillis=100. FTDC normally samples at 1 Hz
# and flushes a chunk every 300 samples, so a single chunk takes 5 minutes. At 100 ms a
# chunk lands every 30 s, which turns fixture generation from an hour into two minutes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/sample-data"
WORK="$(mktemp -d)"
RS_PORT=27099
IDLE_PORT=27098
RUN_SECONDS="${RUN_SECONDS:-150}"

command -v mongod   >/dev/null || { echo "mongod not found";   exit 1; }
command -v mongosh  >/dev/null || { echo "mongosh not found";  exit 1; }
[[ -x "$ROOT/tools/oracle/oracle" ]] || { echo "oracle not built -- run: npm run oracle:build"; exit 1; }

cleanup() {
  mongod --dbpath "$WORK/rs"   --shutdown >/dev/null 2>&1 || true
  mongod --dbpath "$WORK/idle" --shutdown >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/rs" "$WORK/idle"

echo "starting mongod instances (fast FTDC sampling)"

# busy-replset: a single-node replica set under write load.
#
# Covers three fixtures' worth of ground at once:
#   - BSON Timestamps in replSetGetStatus.optimes.* -> the ".inc" doubled columns (trap 2)
#   - dense non-zero deltas from the write load
#   - genuine schema drift: replSetGetStatus is nearly empty before rs.initiate() and
#     expands afterwards, so the reference document changes shape mid-file
mongod --dbpath "$WORK/rs" --port "$RS_PORT" --replSet rs0 --bind_ip 127.0.0.1 \
  --setParameter diagnosticDataCollectionPeriodMillis=100 \
  --fork --logpath "$WORK/rs.log" >/dev/null

# idle: no traffic at all. Produces the long zero runs that exercise run-length state
# carrying across column boundaries (trap 4) -- the failure mode that only shows up when
# metrics are NOT changing.
mongod --dbpath "$WORK/idle" --port "$IDLE_PORT" --bind_ip 127.0.0.1 \
  --setParameter diagnosticDataCollectionPeriodMillis=100 \
  --fork --logpath "$WORK/idle.log" >/dev/null

sleep 3
mongosh --quiet --port "$RS_PORT" --eval \
  "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:$RS_PORT'}]})" >/dev/null

echo "generating load for ${RUN_SECONDS}s"
mongosh --quiet --port "$RS_PORT" --eval "
  const c = db.getSiblingDB('bench').events;
  const end = Date.now() + ${RUN_SECONDS} * 1000;
  let n = 0;
  while (Date.now() < end) {
    const batch = [];
    for (let i = 0; i < 500; i++) batch.push({n: n++, ts: new Date(), pad: 'x'.repeat(200), v: Math.random()});
    c.insertMany(batch);
    c.find({n: {\$gt: n - 1000}}).limit(100).toArray();
  }
" >/dev/null

echo "harvesting"
rm -rf "$OUT"
mkdir -p "$OUT/busy-replset" "$OUT/idle" "$OUT/interim"

# Completed files only for the two main fixtures; metrics.interim is captured separately
# because a partially-written trailing chunk is its own test case.
cp "$WORK/rs/diagnostic.data/"metrics.*-[0-9][0-9][0-9][0-9][0-9]   "$OUT/busy-replset/"
cp "$WORK/idle/diagnostic.data/"metrics.*-[0-9][0-9][0-9][0-9][0-9] "$OUT/idle/"
cp "$WORK/idle/diagnostic.data/metrics.interim"                     "$OUT/interim/"
chmod u+w "$OUT"/*/metrics.*

echo "building oracle dumps"
for f in "$OUT"/*/metrics.*; do
  [[ "$f" == *.oracle.jsonl ]] && continue
  "$ROOT/tools/oracle/oracle" -in "$f" -out "$f.oracle.jsonl"
done

echo
echo "fixtures written to $OUT:"
du -h "$OUT"/*/* | sort -k2

cat <<'EOF'

Coverage note. Five of the six fixture cases from ARCHITECTURE.md are covered:
  busy server, idle server (zero runs), fractional doubles, BSON Timestamps
  (replSetGetStatus.optimes.*.ts / .ts.inc), schema drift, truncated interim.

Not yet covered: a capture spanning a major-version upgrade. The drift present here comes
from rs.initiate() reshaping replSetGetStatus mid-file, which exercises merge-by-path but
not cross-version metric renames. Add that fixture when a second mongod version is available.
EOF
