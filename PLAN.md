# ftdc-lens — revised build plan

Review of the build brief, plus the plan I'd actually execute.

Verdict: **the product thesis is right and the stack is right.** Two things need to change
before any code gets written — the decoder spec has four errors, and the storage design
does not survive the stated data volume. Both are fixable without touching the thesis.

Companion document: [`docs/ftdc-format.md`](docs/ftdc-format.md) — the verified byte-level
spec, checked against `github.com/mongodb/ftdc` with line citations. That supersedes §4 of
the brief.

---

## 1. What the brief gets right

Keep all of this:

- **Zero infrastructure / browser-native.** The three-container Docker stack is genuinely
  the thing to disrupt. Drag a folder, get charts, no rebuild loop.
- **Privacy as a hard constraint, not a feature bullet.** For production diagnostic data
  from paying customers this is the difference between "interesting" and "allowed on the
  laptop." It is also, counter-intuitively, the strongest possible SaaS positioning — see §5.
- **Multi-capture with a shared time cursor.** This is the actual differentiator. Nothing
  in the ecosystem does replica-set-wide correlation well.
- **Log overlay on the metric timeline.** Second differentiator, and the reason engineers
  will switch.
- **uPlot, Web Worker, typed arrays, Zustand.** All correct calls. uPlot in particular —
  every React charting library will die on this data.
- **Milestone sequencing with the decoder first and no early scaffolding.** Right instinct.

## 2. What has to change

### 2.1 The decoder spec is wrong in four places

Full detail with source citations in [`docs/ftdc-format.md`](docs/ftdc-format.md). Summary:

| # | Issue | Failure mode |
|---|-------|--------------|
| 1 | `Double` metrics are delta-encoded as their **raw IEEE-754 bit pattern**, requiring `Float64frombits` on decode. Brief omits this entirely. | All float metrics render as ~4.6e18. Loud failure. |
| 2 | BSON `Timestamp` expands to **two** columns (`key` and `key.inc`). Brief treats it as one. | **Silent, total corruption.** Every column after the first Timestamp shifts by one, so real numbers appear under wrong metric names. `replSetGetStatus` is full of Timestamps. |
| 3 | Deltas are unsigned varints holding **two's-complement-wrapped int64**. No zigzag. | Requires exact 64-bit wrapping arithmetic. `Float64Array`/JS `Number` cannot do it — and issue 1 guarantees values above 2^53. Must decode in `BigInt64Array`. |
| 4 | The zero-run counter **carries across column boundaries** — the delta block is one continuous stream, not independent per-column segments. | Works on busy captures, silently corrupts idle ones. The worst possible bug distribution. |

Issues 2 and 4 both produce output that passes a spot-check. Which leads to:

### 2.2 The test strategy is too weak

The brief says "cross-check a handful of metric values." That will not catch issues 2 or 4.

Replace with an **oracle test**: `mongodb/ftdc` ships a CSV exporter (`csv.go`). Dump a
fixture to CSV with the Go reference, then assert **full equality across every metric and
every sample** in Vitest. A few hours of work that retires the entire risk class. This is
the single highest-leverage change to the plan, and it must be built *before* the decoder,
not after.

Required fixtures — each targets a specific failure above: busy server, **idle server**
(issue 4), fractional doubles (issue 1), replica-set member (issue 2), a capture spanning a
version upgrade (schema drift), and a truncated `metrics.interim`.

### 2.3 The storage design does not fit the data

This is the structural problem. The brief specifies `{ metricPath -> Float64Array }` held
resident, full resolution, "never throw away data the user might zoom into." Run the numbers
against your stated target of a multi-GB replica-set capture:

```
metrics per sample     ~2,500   (a real capture's catalog: 2,149 paths)
samples per day        86,400   (1 Hz)
bytes per value             8   (Float64)

  → 1.7 GB  per node per day, decoded, full resolution
```

Default `diagnosticDataCollectionDirectorySizeMB` is 200 MB per node, which at FTDC's
compression ratio typically holds **weeks**. So:

```
3-node replica set × 7 days   ≈ 600 MB on disk   →   ~36 GB decoded
practical browser tab budget                      ≈ 1.5 GB
```

Off by more than an order of magnitude, and a sharded cluster makes it worse. The brief's
own §8 gestures at this ("consider parsing chunk-by-chunk") but the specified output type
locks in the failure.

**Fix: add a storage tier between the decoder and the store — OPFS.**

The Origin Private File System is real disk, private to the origin, requires no server, and
never touches the network. It preserves the privacy promise *exactly* while removing the
memory ceiling. In a Worker, `createSyncAccessHandle()` gives synchronous reads and writes.

```
 decode (worker pool)
        │  BigInt64Array undelta, per-column type transform
        ▼
 columnar writer ──────────────► OPFS: <captureId>/columns.bin + manifest.json
        │                              full resolution, all metrics, written once
        │
        ├─ constant-column elision: a column that never changes is stored as one
        │  scalar + its presence range. Typically removes 40–60% of columns outright.
        │
        └─ manifest: path → {type, byteOffset, length, isConstant, min, max}
                     + the timestamp column + chunk boundaries + detected gaps
        ▼
 resident memory = the metric catalog index (a few MB)
                 + only the series currently on the dashboard, downsampled to
                   the current zoom level
```

Resident footprint becomes a function of **what's on screen**, not of capture size. Forty
plotted series at full resolution over a week is ~190 MB — and you would downsample on read
anyway, so realistically it's tens of MB. Zooming in re-reads from OPFS in single-digit ms.

Two consequences worth accepting up front:

- Ingest becomes a distinct, visible phase ("decoding 3 captures… 40%") that writes to disk
  and produces a **reusable** artifact. Reopening a capture you analyzed yesterday is
  instant. That's a UX *win*, not a tax.
- The store's public interface must be async (`getSeries(path, range, maxPoints)` returns a
  Promise). Design it that way from M1 or you will rewrite every panel later.

**Format decision — flagging, not deciding:** a custom columnar blob is ~200 lines and fast.
Parquet is more work now but gives you duckdb-wasm (M7 SQL panels) and a shareable export
format for free. I'd start custom, keep the writer behind an interface, and add a Parquet
*export* early since it's independently useful for handing data to colleagues.

### 2.4 LTTB alone is the wrong downsampler for this data

LTTB optimizes for visual resemblance of the curve. For diagnostic data that is actively
dangerous: a two-second drop of `wiredTiger.concurrentTransactions.read.available` to zero
is the *entire finding*, and LTTB will happily drop it as visually insignificant.

Use **min/max envelope per pixel bucket** as the default — draw the band, and the line
through the mean. It cannot hide a spike or a dropout, which is the property that matters.
Keep LTTB available for smooth gauges where the envelope looks noisy.

### 2.5 Gaps missing from scope

Small additions, high value, all cheap:

- **Tarball ingestion.** Customers send `bundle.tar.gz`, not tidy directories. `fflate` plus
  ~80 lines of tar reader. Auto-discover `diagnostic.data/`, `mongod.log*`, and `mongod.conf`
  at any nesting depth. Without this, step one of every real investigation is a manual untar.
- **Worker pool**, sized to `navigator.hardwareConcurrency`, one file per worker. The brief
  specifies a single worker, which serialises exactly the multi-node case you care about.
- **Gap and restart detection.** Missing samples mean mongod was down, stalled, or the host
  froze — one of the strongest signals in FTDC and nothing surfaces it. Detect during ingest
  (you're already walking the timestamp column), render as red bands across every chart.
  Restart detection via `uptime` resets is equally cheap. Both are nearly free at ingest time
  and belong in M2, not M6.
- **Permalink size discipline.** Layout-only in the URL, lz-compressed, with a hard cap and
  automatic fallback to a downloadable `.json`. A 30-panel multi-capture dashboard will blow
  past URL length limits.

## 3. Revised milestones

Changes from the brief marked ✚ (new) and ▲ (modified).

| | Milestone | Done when |
|---|---|---|
| **M0** | Scaffold. Vite + React + TS strict, Zustand, worker ping/pong. DropZone accepting a directory ▲ **and `.tar.gz`**. ▲ Worker **pool**. | Drop a folder or a tarball, see the discovered FTDC + log files listed, see "pong". |
| ✚ **M0.5** ✅ | **Oracle harness — DONE 2026-07-22.** Go tool using `ftdc.ReadMetrics` → JSONL (not `csv.go`, which is lossy — see `docs/ftdc-format.md` §7). Reproducible fixture generator. Vitest full-matrix diff. | ✅ 3 fixtures, 5/6 coverage cases, suite red on "decoder not implemented". |
| **M1** ✅ | ▲ **Decoder — DONE 2026-07-22.** Exact hi/lo undelta (no BigInt), per-column narrowing restore, Timestamp→2 columns, cross-column zero-run state. | ✅ Full-matrix equality on all 3 fixtures: **7,806,365 value comparisons**, exact. 197–289M values/s. |
| ✚ **M1.5** | **Storage layer.** OPFS columnar writer + manifest + constant-column elision. Async `getSeries(path, range, maxPoints)`. Gap/restart detection at ingest. | A 3-node, multi-GB capture ingests and the tab stays under ~500 MB resident. |
| **M2** | ▲ Single-capture viewer. uPlot panel, searchable metric catalog, brush zoom, synced hover. ▲ **min/max envelope** downsampling. ▲ Gap bands rendered. | Any metric explorable smoothly across the full range; a 2-second dropout is visible at full zoom-out. |
| **M3** | Editable dashboard. react-grid-layout, add/remove/resize, layout serialization, localStorage, ▲ size-capped permalink. | Dashboard survives reload and shares via URL. |
| **M4** | Multi-capture. Global synced cursor across captures. Overlay/compare mode. ✚ Cross-host derived metrics — replication lag between members, the thing only multi-capture can compute. | Three replica-set members on one dashboard, one cursor, lag chart derived across them. |
| **M5** | Log correlation. JSON log parser, event classification, annotations on the shared axis, click-to-jump. ✚ Slow queries (`attr.durationMillis`) as a *chartable series* next to tickets and cache. | Dropping `mongod.log` overlays elections/checkpoints/slow queries, and slow-query p95 plots as a metric. |
| **M6** | Insights. Derived rates, pathology detectors (ticket saturation, cache pressure, checkpoint stalls, oplog window, connection churn, queue buildup). "Explain this spike": brush → rank metrics by baseline deviation + correlated log events. ▲ Rules in a data file, not compiled in. | Ticket saturation and cache pressure surface automatically on a real capture. |
| **M7** | Stretch. duckdb-wasm SQL panels over the OPFS/Parquet layer, postmortem export, baseline reference lines, Rust/Go WASM decoder if profiling demands it. | — |

Rough sizing: M0–M1.5 is the real work and the real risk (call it half the total). M2–M4
is mostly mechanical once storage is right. M6 is where the product value concentrates and
is worth over-investing in.

## 4. Non-negotiables to enforce mechanically

The privacy promise is a marketing asset only if it's verifiable. Make it a build gate:

- CI check failing the build on `fetch`, `XMLHttpRequest`, `sendBeacon`, or `WebSocket`
  outside an explicit allowlist.
- CSP in the shipped HTML with no external origins. All fonts and wasm bundled.
- No raw FTDC in `localStorage` (OPFS is fine and is not a network surface).
- A test that loads a capture with the network stubbed to throw.

## 5. On the SaaS question

Worth deciding early, because two choices are cheap now and expensive later.

**The problem with a pure client-side app is that there's nothing to charge for.** No server,
no auth, no gating, and MIT means anyone can host your build. That's fine — but the free
local tool should be deliberately positioned as the top of a funnel, not as the whole product.

Two structural decisions to make at M1:

1. **Extract the decoder as a standalone, DOM-free npm package** (`@ftdc-lens/decoder`) in a
   workspace. Zero browser dependencies, so it runs in Node/Deno/Bun unchanged. That single
   constraint is what later allows server-side ingest for a paid tier — and it makes the
   decoder testable without a browser, which you want anyway. Costs nothing now.
2. **Decide the license consciously.** MIT on the decoder is right (adoption, contributions,
   it's a format implementation). MIT on the *app* means a competitor can host your work as a
   service. AGPL or BSL on the app preserves the option. This is reversible only before you
   accept outside contributions, so decide before the repo goes public.

The paid wedge is the set of things that genuinely require a server, none of which
compromise the local-first promise: shared investigations with the data attached, org-wide
capture history, comparison across tickets, baselines learned across many captures,
scheduled ingestion from customer environments, team annotations, generated postmortems.
"Your data never leaves your machine unless you explicitly share an investigation" is a
better sales line than anything a server-side competitor can say.

## 6. Open decisions

Flagged rather than assumed:

1. **OPFS columnar format** — custom blob (simpler, faster now) vs Parquet (duckdb-wasm and
   export for free, more work). Recommendation: custom, behind an interface, with Parquet
   export added early.
2. **Browser-only vs eventual desktop.** OPFS makes the browser viable for replica-set-scale
   captures. If you routinely handle large sharded clusters, Tauri removes the ceiling
   entirely and reuses the React app unchanged — *provided* the storage layer stays behind an
   interface. Keeping that interface clean costs nothing and preserves the option.
3. **Name.** `ftdc-lens` is serviceable; "lens" is well-worn. Continuity with Big-hole may be
   worth more than novelty given the existing audience.
4. **License split** (§5.2) — before the repo is public.
5. ~~**Which column is the sample clock.**~~ **Resolved 2026-07-22.** `start` is column 0,
   a `DateTime` in epoch milliseconds, with a matching `end` at the tail. Verified against a
   mongod 6.0.26 capture. Look it up by path rather than by index, with
   `serverStatus.localTime` as fallback. See `docs/ftdc-format.md` §5.

## 7. Suggested first task

Not M0. Start with **M0.5**, the oracle harness — capture the six fixtures and get the Go
reference emitting CSV. It's the cheapest possible insurance on the one component that can
sink the project, it's completely independent of every UI decision, and having it in place
changes M1 from "write a decoder and hope" into a red-to-green exercise.
