# ftdc-lens

Browser-native, zero-infrastructure viewer for MongoDB FTDC diagnostic data.
Everything runs client-side; user data never leaves the machine.

## What this is

Drag in a `diagnostic.data/` folder or a support tarball → decode FTDC in a worker pool →
explore metrics in an editable, shareable dashboard, correlated with MongoDB logs, across
every node of a replica set at once.

## Required reading before touching the decoder

**[`docs/ftdc-format.md`](docs/ftdc-format.md)** — the byte-level spec, verified against
`github.com/mongodb/ftdc` with line citations. It supersedes any format description you
find elsewhere, including in older drafts of the project brief, several of which are wrong.

**[`PLAN.md`](PLAN.md)** — milestones and the reasoning behind the architecture.

## Non-negotiables

- **No backend. No network request ever carries user data.** Must work fully offline. This
  is a product promise and a build gate, not an aspiration — see "Privacy gate" below.
- Parsing happens in a **worker pool** (`navigator.hardwareConcurrency`), one file per
  worker. Not a single worker; that serialises the multi-node case, which is the point of
  the product.
- Metric series are persisted to **OPFS**, not held resident. Resident memory must be a
  function of what is on screen, not of capture size. See "Storage" below.
- The metric store interface is **async**. `getSeries(path, range, maxPoints) => Promise`.
  Do not write a synchronous store "for now" — every panel would have to be rewritten.
- Merge metric series across chunks **by dotted path, never by column index**.
- Charts use uPlot. Dashboard uses react-grid-layout. State uses Zustand.

## The four decoder traps

These are the errors that sink this project. Full detail and citations in
`docs/ftdc-format.md`; this is the checklist.

1. **`Double` metrics are delta-encoded as their raw IEEE-754 bit pattern.** Retain the
   per-column BSON type from the reference document and apply `Float64frombits` after
   undelta. Symptom if missed: float metrics render as ~4.6e18.

2. **BSON `Timestamp` produces TWO columns** — `key` and a synthetic `key.inc`. Symptom if
   missed: every column after the first Timestamp shifts by one, so real numbers appear
   under the wrong metric names, silently. `replSetGetStatus` is full of Timestamps.

3. **Deltas are unsigned varints holding two's-complement-wrapped int64.** No zigzag. A
   naive `Number` read gives `1.84e19` where the answer is `-1`. Requires exact 64-bit
   reinterpretation — but **not** BigInt; see "Decoder performance" below for the fast
   design.

4. **The zero-run counter carries across column boundaries.** The delta block is one
   continuous stream consumed in column-major order, not independently decodable per-column
   segments. Symptom if missed: works on busy captures, corrupts idle ones.

Traps 2 and 4 both produce output that passes a spot-check. Therefore:

## Testing the decoder

**Full-matrix equality against a reference oracle. Spot-checks are not acceptable.**
Built and working — the suite is red only because the decoder is a stub.

```bash
npm run oracle:build   # builds tools/oracle (Go 1.24, via Docker)
npm run fixtures       # captures fixtures from a local mongod + dumps oracle JSONL
npm test               # full-matrix diff, ~40M value comparisons
```

`tools/oracle/` decodes a fixture with `ftdc.ReadMetrics` and emits JSONL; Vitest decodes
the same bytes in TypeScript and compares **every metric of every sample**, plus column
order at each schema boundary.

**Do not switch the oracle to `ftdc.WriteCSV`.** It emits Doubles as the raw int64 bit
pattern, truncates DateTime to whole seconds, and writes empty strings for unhandled types —
lossy in precisely the places the decoder is most likely to be wrong. Reasoning in
`docs/ftdc-format.md` §7.

Current fixture coverage (`tools/fixtures/generate.sh`):

| Fixture | Targets | Status |
|---|---|---|
| `busy-replset` | dense deltas; `.ts`/`.ts.inc` pairs (trap 2); schema drift | ✅ 1541 samples, 5 schemas |
| `idle` | long zero runs across column boundaries (trap 4) | ✅ 1500 samples |
| `interim` | truncated trailing chunk | ✅ 251 samples |
| fractional doubles (trap 1) | present in all three | ✅ 23 double columns |
| major-version upgrade | cross-version renames | ❌ needs a second mongod version |

Also validate `metricsCount == flattenedColumns.length` per chunk at runtime. It is the
cheapest corruption detector available and it catches trap 2 immediately.

## Decoder performance

Speed is a hard requirement, not a nice-to-have. A node-day is ~216M values (2,500 columns ×
86,400 samples); a replica-set week is billions. The decoder is the whole product's floor.

**Do not use BigInt.** `BigInt64Array` is the obvious way to get exact 64-bit wrapping
arithmetic and it is 10–40× slower than `Number`. Full design in `docs/ftdc-format.md`
CORRECTION 3; the shape:

- Read uvarints into `(hi, lo)` 32-bit `Number` halves — no BigInt, no DataView per byte.
- **Accumulate exactly in hi/lo for every column type**, with an explicit carry, then convert
  once per changed sample. Do *not* accumulate integer columns directly in a `Float64Array`:
  WiredTiger timestamp columns are `seconds << 32` (~7.7e18, above 2^53), and per-sample
  rounding drifts a full ULP from the reference within a few hundred samples.
- **Restoration is narrowing, not relabelling.** `Int32` columns truncate to their low 32
  bits — some carry 64-bit WT timestamps and the reference drops the high word. Match it.
- **Zero-run fast path**: when the run covers the rest of a column, `out.fill(current, j, n)`
  instead of looping. Collapses idle captures to memset speed — and idle captures are the
  common case in support work.

Non-negotiable hot-path rules: one allocation per column, no intermediate JS object trees,
no closures or `try`/`catch` inside the sample loop, read from `Uint8Array` directly rather
than `DataView` per byte, reuse the inflate output buffer across chunks.

**Measured (M1, single core, `npm run bench`):**

| Fixture | Throughput |
|---|---|
| busy-replset | 197M values/s |
| idle | 289M values/s |

A one-day single-node capture (~216M values) decodes in **~1.1 s** worst case, inside the
2 s target. A 3-node replica-set week is ~23 s single-core, or ~3 s across a worker pool.
Re-run the bench after any hot-path change; a WASM rewrite is not justified at these numbers.

A Rust/Go WASM decoder stays on the table (M7) but is explicitly *not* the starting point:
you would be optimising before having a verified-correct baseline, and you need the oracle
harness either way. Keep `src/ftdc/`'s interface WASM-swappable.

## Cross-version compatibility

**This must work on every MongoDB version a customer might send.** That is a hard
requirement, and it cannot be met by fixing shapes one bug report at a time -- every failure
mode here is *silent*. A renamed metric produces an empty panel, not an error, so nothing
tells you the tool has stopped answering the question it exists to answer.

Three axes of variation, all resolved from what a capture actually contains rather than from
a version number (`expandMetric` in `src/dashboard/layout.ts`):

| Axis | Example | Mechanism |
|---|---|---|
| **rename** | tickets left `wiredTiger.concurrentTransactions` for `queues.execution` in 8.0 | `src/dashboard/aliases.ts` |
| **role scoping** | a sharded-cluster member reports `shard.serverStatus.…`; older servers use `common.` | `detectRolePrefixes` |
| **cardinality** | one series per disk, mount, or replica-set member | `*` globs in templates |

Never key behaviour off a version string. Roles differ by **topology, not release** — a
single-node 8.0 replica set has no prefix at all, while an 8.0 shard member reports
`common.` and `shard.` simultaneously. Percona builds diverge from upstream too. Detect from
the data.

Roles resolve in two passes, because both behaviours are wanted and they conflict:

- **uniform** — every path under one prefix, tried for each in turn. A node running several
  roles genuinely has a different value per role, so a simple metric shows all of them.
- **mixed** — each path resolved independently. A real sharded capture puts the clock under
  `common.` and replication under `shard.`, so `diff(serverStatus.localTime,
  replSetGetStatus.members.*.lastAppliedWallTime)` resolves under no single prefix. Without
  this fallback, replica lag vanishes on exactly the captures it matters most for.

Uniform wins when it works, so multi-role fan-out survives; mixing only applies to genuinely
cross-section expressions.

**Measured coverage** (`npm run catalogs`):

| Capture | Paths | Roles | Panels |
|---|---|---|---|
| 4.4 / 5.0 / 6.0 | ~2.1–2.5k | none | 41/44 |
| 7.0 | 2,950 | none | 43/44 |
| 8.0 | 5,616 | none | 43/44 |
| 8.0 sharded | 5,846 | `common`, `shard` | 43/44 |

### Observed ticket paths

| Version | Path |
|---|---|
| 4.4 – 7.0 | `serverStatus.wiredTiger.concurrentTransactions.read.available` |
| 8.0 | `serverStatus.queues.execution.read.available` (the old section is gone) |

### The guardrail

```bash
npm run fixtures:versions   # captures 4.4/5.0/6.0/7.0/8.0 via Docker
npm run fixtures:sharded    # sharded cluster -- the only way to reproduce role scoping
npm run catalogs            # per-version diff + alias candidates
npm test                    # tests/versions.test.ts asserts essentials resolve everywhere
```

`tests/versions.test.ts` holds a list of metrics an investigation cannot proceed without --
tickets, cache, queues, connections, opcounters, memory, CPU. Each must resolve on every
captured version. When one breaks, the failure names the version and the metric and points at
`npm run catalogs` for candidates. The suite skips when fixtures are absent so a checkout
without Docker still runs green, but **CI should generate them**.

A plain replica set does not reproduce role scoping — the prefix comes from the topology, not
the release — which is why the sharded fixture is separate and necessary.

## Multi-capture

One capture per node. Files are grouped by the **directory** they sit in (`src/ingest/discover.ts`)
— never merged — because every member's files are called `metrics.<timestamp>` and merging
them produces one incoherent timeline rather than an error. Each capture gets its own worker,
its own OPFS directory and its own id (`c0`, `c1`, …), minted once and never reused.

A panel metric is host-agnostic and **fans out** to every loaded node that can resolve it
(`src/data/panelData.ts`). A node missing the metric contributes no series rather than an
empty one. Three rules, in order:

| Written | Means |
|---|---|
| `serverStatus.mem.resident` | every visible node, one series each |
| `c1:serverStatus.mem.resident` | that node only |
| `diff(c0:…lastWriteDate, c1:…lastWriteDate)` | across nodes — what M4 exists for |

A qualifier is only a qualifier when it names a **loaded** capture. FTDC paths contain dots,
spaces, slashes, parentheses and `#` suffixes, so a purely syntactic rule would eventually
misread a real path; resolution against the loaded set cannot.

Cross-capture expressions **split at the highest single-capture subtree** (`planExpr`). Each
part is evaluated by its own reader at full resolution — so `rate()` stays exact — and only the
pointwise combination on top runs afterwards, on a shared clock. Alignment is
**nearest-sample** with a staleness bound (`alignOnto`): carrying the previous value instead
would bias every lag reading high by up to a full sample interval, and without the bound a node
whose capture ends early holds its last value and fabricates a linear climb. Two nodes sampling
1 s apart cannot resolve sub-second lag, which is why clock skew is charted next to it.

With one capture loaded nothing is qualified at all, so single-capture layouts, permalinks and
saved dashboards are byte-identical to what M3 produced.

## Storage

A 3-node replica set over a week is roughly 600 MB on disk and **~36 GB decoded at full
resolution**. A browser tab has about 1.5 GB. Holding `{path -> Float64Array}` resident
does not work; do not attempt it.

```
decode (worker pool) ──► columnar writer ──► OPFS: <captureId>/columns.bin + manifest.json
                                             full resolution, written once, reusable
resident = catalog index + only the series currently plotted, downsampled to current zoom
```

- **Chunk-major, not path-major.** Ingest streams: decode a chunk, write it, drop it, so
  memory stays bounded by one chunk (~6 MB) regardless of capture size. Reading one metric
  costs one positioned read per chunk, which on a local file is microseconds.
- **Constant-column elision** at write time: a column that never moves within a chunk costs
  8 bytes instead of `sampleCount × 8`.
- **A dotted path is not unique** — BSON allows duplicate keys and real captures contain them
  (`systemMetrics.mounts./run/user.*` twice on a host with two mounts at one mountpoint). The
  decoder emits both columns faithfully; the writer suffixes collisions (`path`, `path#1`).
- Re-opening a previously ingested capture is instant. Ingest is a visible phase that
  produces a durable artifact.
- OPFS is local disk, private to the origin, and never touches the network — the privacy
  promise is fully intact.

**Measured on a real customer capture** (`npm run inspect`) — 42.3 h, 152,308 samples,
5,763 metrics, mongod 8.0.19-7 sharded, 102 MB on disk:

| | |
|---|---|
| ingest | 13.7 s for 877M values (64M values/s, cold) |
| elision | 7,022 MB dense → **1,522 MB stored** (4.6×) |
| resident on open | **1.95 MB** — manifest + sample clock only |
| series read | **10.1 ms** each at 1200 points |

Resident cost scales with capture *duration*, not width: the clock is 8 bytes/sample. A
42-hour capture costs under 2 MB resident regardless of its 5,763 metrics.

**Reads must be issued together, not awaited in turn.** A 42-hour capture is ~500 chunks and
one series touches every one of them; serialising those reads cost 41 ms per series (~5 s to
paint a 121-series dashboard). Planning the reads and running them through one `Promise.all`
took it to 10 ms. The same applies one level up — a panel's metrics resolve concurrently in
the worker.

Remaining cost is inherent to reading full resolution and downsampling after: 152k samples ×
8 bytes per series. Precomputed rollups would fix it if it ever needs fixing; do not trade
away spike fidelity for it without measuring first.

## Downsampling

**Min/max envelope per pixel bucket is the default.** Draw the band, plus a line through the
mean.

Do not default to LTTB. LTTB optimises for visual resemblance of the curve, which for
diagnostic data is actively dangerous: a two-second drop of
`wiredTiger.concurrentTransactions.read.available` to zero *is the finding*, and LTTB will
discard it as visually insignificant. Keep LTTB available for smooth gauges where the
envelope reads as noise.

Never discard full-resolution data — it lives in OPFS and is re-read on zoom.

### uPlot wants `null` for gaps, not `NaN`

The storage layer represents a gap as `NaN` — it has to, since a series is a `Float64Array`.
uPlot does not accept that: a series whose **first** value is `NaN` comes back with
`series.min === NaN`, which makes the shared y scale `NaN` and draws no line and no axis **for
every series in the panel**. Verified in Chromium against the bundled uPlot:

| column | `series.min` / `max` |
|---|---|
| `[10, 20, 30, 40]` | 10 / 40 |
| `[NaN, 20, 30, 40]` | NaN / NaN — panel draws nothing |
| `[10, NaN, 30, 40]` | 10 / 40 |
| `[null, 20, 30, 40]` | 20 / 40 |

So the conversion happens at the boundary, in `src/panels/plotData.ts`, and every column handed
to uPlot goes through it. The bug is easy to miss because it depends on where bucket boundaries
land: the same panel drew fine tiled and blank maximised, because the wider plot asked for more
buckets and the capture's first sample stopped being averaged in with its neighbour.

## Stack

Vite + React + TypeScript (strict) · fflate (zlib inflate + tar) · uPlot ·
react-grid-layout · Zustand · Vitest. Optional later: `@duckdb/duckdb-wasm`.

Prefer a minimal custom BSON reader over the `bson` npm package — this is a hot path and
the subset of BSON needed is small.

## Layout

```
src/ftdc/       decoder: bson reader, chunk decode, flatten  (DOM-free, see below)
src/workers/    ftdcParser.worker.ts + pool management
src/ingest/     directory + tarball discovery, gap/restart detection
src/data/       OPFS columnar store, manifest, downsampling, derived metrics
src/panels/     uPlot panels
src/dashboard/  grid, layout serialization, permalinks, metric catalog
src/logs/       mongod JSON log parser
src/insights/   pathology detectors (rules live in a data file, not compiled in)
tests/          fixture-based decoder correctness
tools/oracle/   Go program: fixture -> expected CSV via mongodb/ftdc
sample-data/    gitignored; real captures for manual testing
```

**`src/ftdc/` must stay DOM-free** and be extractable as a standalone npm package. No
`window`, no `File`, no worker APIs — it takes an `ArrayBuffer` and returns data. This keeps
it testable without a browser and preserves the option of server-side ingest later.

## Privacy gate

Enforced mechanically, not by convention:

- CI fails the build on `fetch`, `XMLHttpRequest`, `sendBeacon`, or `WebSocket` outside an
  explicit allowlist.
- CSP in the shipped HTML permits no external origins. All fonts and wasm are bundled.
- No raw FTDC in `localStorage` (OPFS is fine — it is not a network surface). localStorage
  holds dashboard layouts and settings only.
- A test loads a capture with the network stubbed to throw.
- Permalinks encode **layout only**, lz-compressed, with a size cap and automatic fallback
  to a downloadable `.json`.

## Commands

- `npm run dev` — Vite dev server
- `npm run test` — Vitest
- `npm run build` — production build
- `npm run lint` — ESLint
- `npm run verify:browser` — drag/resize in a real Chromium (jsdom cannot catch that class of bug)
- `npm run verify:multi [bundle]` — load a two-node bundle into the real app and report what
  drew; the bundle is a directory with one folder per node, each holding its own
  `diagnostic.data`

## Working style

Build milestone by milestone per `PLAN.md`. Do not scaffold future milestones early.

Order matters: **M0.5 (the oracle harness) comes before M1 (the decoder)**, and **M1.5 (the
OPFS storage layer) comes before any UI**. The decoder is the highest-risk component and the
storage layer determines every panel's interface; both are cheap to get right first and
expensive to retrofit.

When unsure about the FTDC byte format, consult `docs/ftdc-format.md` first, then
`github.com/mongodb/ftdc`, and verify against real bytes. Do not guess, and do not trust
prose descriptions of the format — including this file — over the reference implementation.
