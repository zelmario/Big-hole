#!/usr/bin/env bash
# Build the oracle binary.
#
# github.com/mongodb/ftdc requires Go >= 1.24. Rather than making that a machine
# prerequisite, build in a container by default. Set ORACLE_NATIVE=1 to use a local
# toolchain instead.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="${ORACLE_GOCACHE:-${TMPDIR:-/tmp}/big-hole-gocache}"

if [[ "${ORACLE_NATIVE:-0}" == "1" ]]; then
  echo "building oracle with local Go toolchain"
  (cd "$HERE" && go build -o oracle .)
else
  echo "building oracle in golang:1.24-alpine (set ORACLE_NATIVE=1 to use local Go)"
  mkdir -p "$CACHE"
  docker run --rm \
    -u "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -e GOCACHE=/gocache/build \
    -e GOMODCACHE=/gocache/mod \
    -e GOFLAGS=-mod=mod \
    -v "$HERE":/src \
    -v "$CACHE":/gocache \
    -w /src \
    golang:1.24-alpine \
    sh -c "go mod tidy && go build -o oracle ."
fi

echo "built: $HERE/oracle"
