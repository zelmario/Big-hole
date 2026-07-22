#!/usr/bin/env bash
# Capture FTDC from a sharded cluster.
#
# This is the shape that broke: on a sharded cluster MongoDB scopes FTDC sections by role, so
# a shard member reports `shard.serverStatus.…` rather than `serverStatus.…` and a dashboard
# written against bare paths resolves nothing. A plain replica set does NOT reproduce it --
# the prefix comes from the role, not from the version -- so it needs its own fixture.
#
#   VERSION=8.0 bash tools/fixtures/sharded.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="${VERSION:-8.0}"
OUT="$ROOT/sample-data/versions/${VERSION}-sharded"
NET=ftdc-lens-net
RUN_SECONDS="${RUN_SECONDS:-75}"

CFG=ftdc-lens-cfg
SHARD=ftdc-lens-shard
MONGOS=ftdc-lens-mongos

cleanup() { docker rm -f "$CFG" "$SHARD" "$MONGOS" >/dev/null 2>&1; }
cleanup
docker network rm "$NET" >/dev/null 2>&1
docker network create "$NET" >/dev/null 2>&1

echo "starting sharded cluster on mongo:$VERSION"
docker run -d --name "$CFG" --network "$NET" "mongo:$VERSION" \
  --configsvr --replSet cfg --port 27019 --bind_ip_all \
  --setParameter diagnosticDataCollectionPeriodMillis=100 >/dev/null || exit 1
docker run -d --name "$SHARD" --network "$NET" "mongo:$VERSION" \
  --shardsvr --replSet shard0 --port 27018 --bind_ip_all \
  --setParameter diagnosticDataCollectionPeriodMillis=100 >/dev/null || exit 1
sleep 10

docker exec "$CFG" mongosh --quiet --port 27019 --eval \
  "rs.initiate({_id:'cfg',configsvr:true,members:[{_id:0,host:'$CFG:27019'}]})" >/dev/null 2>&1
docker exec "$SHARD" mongosh --quiet --port 27018 --eval \
  "rs.initiate({_id:'shard0',members:[{_id:0,host:'$SHARD:27018'}]})" >/dev/null 2>&1
echo "  replica sets initiated"
sleep 12

docker run -d --name "$MONGOS" --network "$NET" --entrypoint mongos "mongo:$VERSION" \
  --configdb "cfg/$CFG:27019" --bind_ip_all \
  --setParameter diagnosticDataCollectionPeriodMillis=100 >/dev/null || exit 1
sleep 12

docker exec "$MONGOS" mongosh --quiet --eval "sh.addShard('shard0/$SHARD:27018')" >/dev/null 2>&1 &&
  echo "  shard added"

echo "generating load for ${RUN_SECONDS}s"
docker exec -d "$MONGOS" mongosh --quiet --eval "
  sh.enableSharding('bench');
  db.getSiblingDB('bench').e.createIndex({n:1});
  sh.shardCollection('bench.e', {n:1});
  const c = db.getSiblingDB('bench').e;
  const end = Date.now() + ${RUN_SECONDS} * 1000;
  let n = 0;
  while (Date.now() < end) {
    const a = [];
    for (let i = 0; i < 200; i++) a.push({n: n++, p: 'x'.repeat(100)});
    c.insertMany(a);
    c.find({n: {\$gt: n - 500}}).limit(50).toArray();
  }
" >/dev/null 2>&1

sleep "$RUN_SECONDS"
sleep 20

echo "harvesting"
rm -rf "$OUT"; mkdir -p "$OUT"
# The shard member is the interesting one -- that is where role-scoped sections appear.
if docker cp "$SHARD:/data/db/diagnostic.data/." "$OUT/" >/dev/null 2>&1; then
  chmod -R u+w "$OUT" 2>/dev/null
  echo "  shard: $(find "$OUT" -name 'metrics.*' | wc -l) file(s), $(du -sh "$OUT" | cut -f1)"
else
  echo "  shard: no diagnostic.data"
fi

# mongos keeps FTDC too, under a different role; useful for a router-only capture.
MONGOS_OUT="$ROOT/sample-data/versions/${VERSION}-mongos"
rm -rf "$MONGOS_OUT"; mkdir -p "$MONGOS_OUT"
if docker cp "$MONGOS:/data/db/diagnostic.data/." "$MONGOS_OUT/" >/dev/null 2>&1; then
  chmod -R u+w "$MONGOS_OUT" 2>/dev/null
  echo "  mongos: $(find "$MONGOS_OUT" -name 'metrics.*' | wc -l) file(s)"
else
  rmdir "$MONGOS_OUT" 2>/dev/null
  echo "  mongos: no diagnostic.data at /data/db"
fi

cleanup
docker network rm "$NET" >/dev/null 2>&1
echo "done"
