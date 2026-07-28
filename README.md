# Big Hole

**A browser-native reader for MongoDB FTDC.** Drop a `diagnostic.data` directory or a support
tarball onto the page: it decodes the FTDC in a worker pool, writes a columnar store to OPFS, and
draws every metric of every node on one time axis, correlated with the mongod log. There is no
backend, no container, and no upload — the app is static files, and the data never leaves the
machine, which is enforced by the build rather than promised in a README.

![The dashboard](docs/img/dashboard.png)

---

## Why this exists

The first Big Hole decoded FTDC with Python and Go and shipped it into a three-container
InfluxDB + Grafana stack. Two structural problems ended it:

- **The metric set was fixed at build time.** `metrics_to_get.txt` listed what to extract, and
  anything else meant editing the file and rebuilding the image. A modern mongod reports ~5,700
  metrics per sample, and the one you need is never the one you listed.
- **InfluxDB's line protocol cannot hold FTDC's values.** WiredTiger packs transaction times as
  `seconds << 32`, around 6.6e18, past both int64 line protocol and IEEE-754's exact integer
  range. That is [#3](https://github.com/zelmario/Big-hole/issues/3), and no version of "store it
  in InfluxDB" fixes it.

This rewrite takes the storage tier out of the path entirely. The old version is preserved at the
[`v1-grafana`](https://github.com/zelmario/Big-hole/tree/v1-grafana) tag.

## Quick start

Node 20+. No Docker, no Go, no Python.

```bash
git clone https://github.com/zelmario/Big-hole.git
cd Big-hole
npm install
npm run dev          # http://localhost:5173
```

Drop in a `diagnostic.data` directory, a `.tar.gz` support bundle (FTDC and logs are found inside
it at any depth), or a directory holding one folder per node — every member of a replica set loads
at once and each panel fans out to all of them.

`npm run build` produces a static `dist/` that can be served from anywhere, including a USB stick.
It makes no network requests at runtime.

## Architecture

```
 File/tarball ──► worker pool (one capture per worker)
                      │  inflate, BSON reference doc, undelta
                      ▼
                  columnar writer ──► OPFS  <captureId>/columns.bin
                                            <captureId>/manifest.json
                                            <captureId>/time.bin
                      │                     full resolution, written once
                      ▼
        resident = manifest + sample clock (~2 MB)  +  only what is on screen
                      │
                      ▼
   async getSeries(expr, {from, to, maxPoints}) ─► expression eval at full
                      │                            resolution ─► min/max envelope
                      ▼
                    uPlot
```

### Decoder (`src/ftdc/`)

FTDC is zlib-compressed, delta-encoded, column-major data behind a BSON reference document. Four
properties of the format decide whether a decoder is correct, and three of them fail *silently*:

| | Trap | What a naive decoder produces |
|---|---|---|
| 1 | `Double` metrics are delta-encoded as their raw IEEE-754 **bit pattern** | floats render as ~4.6e18 — loud |
| 2 | BSON `Timestamp` flattens to **two** columns, `key` and `key.inc` | every later column shifts by one, so real numbers appear under the wrong metric names — **silent** |
| 3 | Deltas are unsigned varints holding **two's-complement-wrapped int64**, no zigzag | `-1` reads as 1.84e19 |
| 4 | The zero-run counter **carries across column boundaries** | correct on busy captures, corrupt on idle ones — **silent** |

Because three of those are silent, correctness is established by differential testing rather than
spot checks: `tools/oracle/` decodes a fixture with
[`github.com/mongodb/ftdc`](https://github.com/mongodb/ftdc) and emits JSONL, and the suite
compares **every metric of every sample** — millions of values per fixture — plus column order at
each schema boundary.

The hot path uses no BigInt. Exact 64-bit accumulation is done in `(hi, lo)` 32-bit halves with an
explicit carry, converted once per changed sample: `BigInt64Array` is 10–40× slower, and
accumulating directly into a `Float64Array` drifts a full ULP within a few hundred samples on
WiredTiger timestamp columns, which live above 2^53. Measured single-core: **197M values/s** on a
busy capture, **289M/s** on an idle one, where a zero run covering the rest of a column collapses
to `fill()`.

`src/ftdc/` is DOM-free and independent of the rest of the app: it takes an `ArrayBuffer` and
returns typed arrays.

### Storage (`src/data/`)

A three-node replica set over a week is ~600 MB on disk and **~36 GB decoded at full resolution**.
A browser tab has roughly 1.5 GB, so the decoded form cannot be resident.

Ingest is chunk-major and streams: decode a chunk, write it, drop it — memory stays bounded by one
chunk (~6 MB) regardless of capture size. A chunk block is a constant bitmap, then the elided
constants, then the varying columns; a column that never moves within a chunk costs 8 bytes
instead of `sampleCount × 8`. Reading one metric is one positioned read per chunk, and those reads
are planned and issued through a single `Promise.all` — serialising them cost 41 ms per series on
a 500-chunk capture against 10 ms batched.

Merging across chunks is **by dotted path, never by column index**, because schemas drift
mid-capture. A dotted path is also not unique — BSON permits duplicate keys and real captures
contain them (two mounts at one mountpoint) — so collisions are suffixed `path`, `path#1`.

### Downsampling

**Min/max envelope per pixel bucket, not LTTB.** LTTB optimises for visual resemblance of the
curve, which for diagnostic data is actively dangerous: a two-second drop of
`concurrentTransactions.read.available` to zero *is* the finding, and LTTB discards it as visually
insignificant. Full resolution is never destroyed; zooming re-reads from OPFS.

### Multi-capture (`src/data/panelData.ts`)

Captures are grouped by **directory** and never merged — every member's files are called
`metrics.<timestamp>`, so merging produces one incoherent timeline rather than an error. Panel
metrics are host-agnostic and fan out to every node that resolves them; `c1:path` pins one node;
and a cross-host expression such as `diff(c0:…lastWriteDate, c1:…lastWriteDate)` is **split at the
highest single-capture subtree**, evaluated per node at full resolution, and combined afterwards
on a shared clock. Alignment is nearest-sample with a staleness bound: carrying the previous value
would bias every lag reading high by up to a sample interval, and without the bound a node whose
capture ended early holds its last value and fabricates a linear climb.

### Logs (`src/logs/`)

A support bundle's log is routinely 73 MB and can be 2.5 GB, so nothing is held. The parser
streams, unwraps syslog framing, locates a window by binary search over the file, and keeps two
things: a few hundred **markers**, and **`logs.*` series** that join the metric catalogue and need
no special case anywhere downstream.

Which lines become markers is a volume decision, not a taste one. One real 24-hour log holds
19,220 connection events and 18,485 TLS warnings against **10** oplog-fetcher errors; annotating
everything erases the ten lines that explain the incident. Each rule in `classify.ts` declares
`annotate` (rare and specific) or `count` (aggregated into a rate); rules match on the numeric
**statement id** rather than message text, because MongoDB rewords messages between releases; and
a density guard demotes an `annotate` class that fires too often, since a class that is rare on
one server is not rare on another.

The viewer's buffer is a **sliding window, not a cap**: reaching either edge loads the next page
and drops the same number off the far end, so the whole log is reachable while resident cost stays
bounded. Paging backwards asks the reader for the *end* of a sub-range rather than scanning a
36-hour log from its start, and the boundary is requested inclusively with the overlap removed
**by count, not by key** — logs repeat verbatim within a millisecond, and a `Set` would delete
exactly the bursts an investigation is reading.

![The log viewer, following the dashboard's window](docs/img/log.png)

### Insights (`src/insights/`)

Two things, both automatic.

**Detectors.** The checks every engineer runs first — ticket exhaustion, dirty cache, queue
buildup, flow control, page faulting — held as data in `rules.ts`: a metric, a comparison, a
threshold, a duration. They read the min/max envelope rather than full resolution, and each test
reads the column that makes it pessimistic (`<=` reads the bucket's max, `>=` its min), so
downsampling can hide an episode but never invent one. Rules also declare a `toleranceMs`, because
real pathologies flap: a capture that spent 377 s above WiredTiger's 20% dirty trigger, peaking at
36%, never held it unbroken for 60 s, and an unbroken-run detector reported nothing at all.
Qualifying time is measured against samples *actually* in breach, so tolerating a dip can join an
episode but cannot manufacture duration, and a gap in the capture always ends one.

**"Explain this window."** Brush any chart and every metric in the capture is ranked by how far it
moved against the adjacent stretch of time, with the log annotations inside the window listed
first. `CaptureReader.scan()` answers it in one pass over the window's chunks — **5,759 metrics in
48 ms** — rather than 5,763 trips through the expression layer. Counters are compared as rates,
but only when they actually ticked; a rate is scaled by the metric's whole-capture average rather
than by the two values being compared, or every `0 → something` scores identically; and the score
is deviation × share of the metric's own range, because deviation alone ranks a metric that never
moves above one that swung through its entire range.

### Cross-version resolution

Metric paths move between releases and topologies, and every failure here is silent — a renamed
metric produces an empty panel, not an error. Nothing is keyed to a version string; everything
resolves from what the capture contains (`expandMetric`):

| Axis | Example | Mechanism |
|---|---|---|
| rename | tickets left `wiredTiger.concurrentTransactions` for `queues.execution` in 8.0 | `src/dashboard/aliases.ts` |
| role scoping | a shard member reports `shard.serverStatus.…` and `common.…` at once | `detectRolePrefixes` |
| cardinality | one series per disk, mount, or replica-set member | `*` globs in templates |

Roles resolve in two passes — uniform first, so a multi-role node shows one series per role, then
per-path, so a cross-section expression like `diff(serverStatus.localTime,
replSetGetStatus.members.*.lastAppliedWallTime)` still resolves when the clock sits under
`common.` and replication under `shard.`.

| Capture | Metric paths | Roles | Panels that draw |
|---|---|---|---|
| 4.4 / 5.0 / 6.0 | ~2.1–2.5k | none | 43/44 |
| 7.0 | 2,950 | none | 43/44 |
| 8.0 | 5,616 | none | 43/44 |
| 8.0 sharded | 5,846 | `common`, `shard` | 43/44 |
| 8.0 sharded, 3 members | 5,763 | `common`, `shard` | **44/44** |

`tests/versions.test.ts` asserts that the metrics an investigation cannot proceed without resolve
on every captured version. `npm run coverage -- <dir>` prints which panels a capture cannot draw
and why.

## Privacy, enforced by the build

- CI fails on `fetch`, `XMLHttpRequest`, `sendBeacon` or `WebSocket` outside an explicit allowlist.
- The shipped CSP permits no external origins; fonts and wasm are bundled.
- Captures live in **OPFS** — the origin's private on-disk storage, which is local disk and not a
  network surface. `localStorage` holds dashboard layouts only, and `tests/privacy.test.ts`
  enforces that exactly two modules may touch it.
- A test loads a capture with the network stubbed to throw, and the browser harnesses assert that
  a full session — ingest, charts, logs, checks, explain — issues no request at all.
- Permalinks encode layout only: lz-compressed, size-capped, with a fallback to a downloadable
  `.json`.

## Measured

A 42-hour, 152,308-sample, 5,763-metric production capture (102 MB on disk), single core:

| | |
|---|---|
| decode | 197–289M values/s |
| ingest | 13.7 s for 877M values, cold |
| stored | 7,022 MB dense → **1,522 MB** after constant-column elision (4.6×) |
| resident once open | **1.95 MB** — manifest and sample clock |
| one series at 1200 points | **10.1 ms** |
| rank every metric over a window | **48 ms** |

Resident cost scales with capture *duration*, not width: the clock is 8 bytes per sample, so 42
hours costs under 2 MB regardless of its 5,763 metrics.

## Development

```bash
npm run dev                          # Vite
npm test                             # 291 tests, including full-matrix decoder equality
npm run build                        # typecheck + production build

npm run inspect  -- <dir>            # cadence, gaps, roles, throughput, elision, coverage
npm run coverage -- <dir>            # panels this capture cannot draw, and why
npm run checks   -- <dir>            # run every detector, print what fired
npm run explain  -- <dir> [from to]  # rank what moved in a window

npm run oracle:build                 # Go reference decoder (needs Docker)
npm run fixtures                     # capture fixtures from a local mongod
npm run fixtures:versions            # the 4.4 → 8.0 matrix
npm run fixtures:sharded             # a sharded cluster — the only way to reproduce role scoping

npm run verify:multi     [bundle]    # drive the real app in a real Chromium
npm run verify:explain   [bundle]
npm run verify:logpage   [bundle]
```

`ARCHITECTURE.md` documents every non-obvious decision and the measurement behind it.
`docs/ftdc-format.md` is the byte-level format spec, verified against the reference implementation
with line citations.

## Stack

Vite · React · TypeScript (strict) · fflate (inflate + tar) · uPlot · react-grid-layout · Zustand
· Vitest. No charting framework, no state library beyond Zustand, and no runtime dependency that
touches the network.

## Credits

Built after years of using **[Keyhole](https://github.com/simagix/keyhole)** by Ken Chen
(@simagix), and because sometimes you need the metric it does not show.
**[github.com/mongodb/ftdc](https://github.com/mongodb/ftdc)** is the reference implementation
this decoder is verified against.

## License

MIT — see [LICENSE](LICENSE).
