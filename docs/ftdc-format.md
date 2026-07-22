# FTDC binary format — verified specification

Every claim here was checked against `github.com/mongodb/ftdc` at commit `4041a70`
(cloned 2026-07-22). Line citations are to that repo. Where the ftdc-lens build brief
disagreed with the reference implementation, the reference wins and the discrepancy is
called out in **⚠ CORRECTION** blocks.

Read this before writing a single line of `src/ftdc/`.

---

## 1. File layout

A `diagnostic.data/` directory contains:

- `metrics.<ISO-timestamp>` — completed capture files
- `metrics.interim` — the file mongod is currently appending to. Same format. **Its last
  chunk is routinely truncated mid-write**; a decoder must return every chunk it fully
  decoded and treat a short read at EOF as normal termination, not as file corruption.

Each file is a bare concatenation of BSON documents — no header, no index, no framing
beyond BSON's own leading `int32` length. Read a document, advance by its length, repeat.

Each document has a `type` field (`read.go:45-52`):

| `type` | Meaning |
|--------|---------|
| `0`    | Metadata. Plain BSON: `hostInfo`, `buildInfo`, `getCmdLineOpts`, etc. Keep for display and for host identity. |
| `1`    | Metric chunk. Contains the compressed sample block. |
| other  | Skip silently. The reference `continue`s rather than erroring — do the same. |

A type-1 chunk document has:
- `_id` — BSON datetime, the chunk's start time (`read.go:54`)
- `type` — `1`
- `data` — BSON binary, the payload described below

## 2. Chunk payload framing

`data` is **not** BSON. Its structure (`read.go:61-69`):

```
[0..4)   uint32 LE   uncompressed length (informational; the reference ignores it)
[4..]                raw zlib stream
```

The reference implementation slices `zBytes[4:]` and hands the rest to `zlib.NewReader`.
Note this is **zlib** (RFC 1950, with the 2-byte header and Adler-32 trailer), not raw
deflate — use `fflate.unzlibSync`, not `inflateSync`.

Inflating yields, in this exact order:

```
1. A complete BSON document  — the "reference sample"
2. uint32 LE  metricsCount
3. uint32 LE  deltaCount
4. packed varint deltas, column-major
```

**The counts come *after* the reference document, not before it** (`read.go:85-91`). The
Go comment says "now go back and read the first few bytes", which is misleading — nothing
seeks backwards. The brief got this right; don't let the comment confuse you.

Total samples in the chunk = `deltaCount + 1` (`read.go:130`).

Validate `metricsCount == flattenedMetrics.length` and reject the chunk if it differs
(`read.go:96-98`) — this is the cheapest possible corruption detector and it catches most
decoder bugs immediately.

## 3. Flattening the reference document → metric columns

Walk the reference document depth-first in document order (`bson_metric.go:14-25`). The
resulting order **is** the column order of the delta block. Get this wrong by one and every
metric after the error point is silently attributed to the wrong path.

Per BSON type (`bson_metric.go:43-141`):

| BSON type | Emits | Starting value |
|-----------|-------|----------------|
| `Int32` | 1 metric | `int64(value)` |
| `Int64` | 1 metric | `value` |
| `Boolean` | 1 metric | `1` or `0` |
| `DateTime` | 1 metric | epoch **milliseconds** |
| `Double` | 1 metric | **the IEEE-754 bit pattern reinterpreted as int64** — see ⚠ below |
| `Timestamp` | **2 metrics** | `seconds * 1000`, then `<key>.inc` = increment — see ⚠ below |
| `EmbeddedDocument` | recurse, prefixing the path | — |
| `Array` | recurse, child key = `<key>.<index>` | — |
| `ObjectID`, `String`, `Decimal128` | **0 metrics** — skipped entirely | — |
| anything else | 0 metrics | — |

Paths are dotted joins of the parent path with the key — `strings.Join(append(ParentPath,
KeyName), ".")` (`ftdc.go:80-82`). Array elements use their numeric index as a path segment,
so replica-set members appear as `replSetGetStatus.members.0.state`,
`replSetGetStatus.members.1.state`, and so on.

The per-column `originalType` from the reference document **must be retained** — it is
required to restore values correctly after undelta (`bson_restore.go:100-115`). A decoder
that stores only paths and numbers is unrecoverably lossy.

---

### ⚠ CORRECTION 1 — Doubles are delta-encoded as their raw bit pattern

`util.go:93-94`:

```go
func normalizeFloat(in float64) int64 { return int64(math.Float64bits(in)) }
func restoreFloat(in int64) float64   { return math.Float64frombits(uint64(in)) }
```

Every `Double` metric is converted to its 64-bit IEEE-754 **bit pattern**, that integer is
what gets delta-encoded, and it must be reinterpreted back to a float after undelta.

Confirmed independently on the restore path (`bson_restore.go:107-108`), where the library
reconstructs values using the retained `originalType`:

```go
case bsontype.Double:
	return birch.EC.Double(key, math.Float64frombits(uint64(value))), true
```

Note that `restoreFlat` has **no** `Timestamp` case — it falls through to `Int64`. So in the
CSV oracle output (§7), a BSON Timestamp appears as two plain integer columns, `key` and
`key.inc`. That is convenient: the oracle will show you the doubled column directly.

Consequences:

- You **must** retain the original BSON type per column from the reference doc, and apply
  `Float64frombits` only to the `Double` columns at the very end of decoding.
- Skip this and `wiredTiger` percentages and load averages come out as values around
  `4.6e18` — large enough that a chart looks "broken" rather than subtly wrong, which is
  the one mercy here.
- The deltas for these columns are differences between bit patterns and are frequently
  enormous and negative. This interacts directly with CORRECTION 3.
- In JS: `new DataView(buf).setBigInt64(0, v); getFloat64(0)` or a reusable
  `Float64Array`/`BigInt64Array` pair over one 8-byte buffer.

The build brief does not mention this at all.

### ⚠ CORRECTION 2 — BSON `Timestamp` expands to TWO columns

`bson_metric.go:123-138`:

```go
case bsontype.Timestamp:
	t, i := val.Timestamp()
	return []Metric{
		{KeyName: key,          startingValue: int64(t) * 1000},
		{KeyName: key + ".inc", startingValue: int64(i)},
	}
```

The brief lists `timestamp` as a single numeric leaf. It is two columns: the seconds
component scaled to milliseconds, and a synthetic `<key>.inc` column for the increment.

This one is worse than CORRECTION 1 because it fails *silently and totally*. `replSetGetStatus`
is full of BSON Timestamps (`optimes.lastCommittedOpTime`, `appliedOpTime`, `durableOpTime`,
per-member optimes). Miss the `.inc` column on the first one and **every subsequent metric in
the chunk is shifted by one column** — you get plausible-looking numbers attached to entirely
the wrong metric names. The `metricsCount` check in §2 catches this, which is exactly why you
must implement that check.

### ⚠ CORRECTION 3 — Deltas are unsigned varints holding wrapped signed int64

`read.go:112-123`:

```go
delta, err = binary.ReadUvarint(buf)   // uint64
...
metrics[i].Values[j] = int64(delta)    // reinterpret, two's-complement wrap
```

and `util.go:48-55`:

```go
out[idx+1] = out[idx] + delta          // plain int64 addition, wraps on overflow
```

A delta of `-1` is transmitted as the uvarint `0xFFFFFFFFFFFFFFFF` (10 bytes) and only
becomes `-1` via the signed reinterpretation. There is no zigzag encoding.

This means **the delta reinterpretation must be exact 64-bit wrapping integer math**. A naive
`Number` read of the uvarint gives `1.8446744073709552e19` where the answer is `-1`.

### Doing this fast — do NOT reach for BigInt

`BigInt64Array` is the obvious answer and it is the wrong one. BigInt scalar arithmetic runs
roughly 10–40× slower than `Number`, and a single node-day is ~216M values (2,500 columns ×
86,400 samples). BigInt puts the decoder in the tens-of-seconds range per node-day.

The fast design splits the problem, exploiting the fact that **the delta needs exact 64-bit
handling but the accumulator usually does not**:

**Read every uvarint into a `(hi, lo)` pair of 32-bit halves** — plain `Number` ops, no
BigInt:

```js
let lo = 0, hi = 0, shift = 0, b;
do {
  b = buf[p++];
  if (shift < 28)       lo |= (b & 0x7f) << shift;
  else if (shift === 28) { lo |= (b & 0x0f) << 28; hi = (b & 0x7f) >>> 4; }
  else                  hi |= (b & 0x7f) << (shift - 32);
  shift += 7;
} while (b & 0x80);
lo >>>= 0;
```

Then branch on the column's BSON type, known from the reference document:

**Integer-family columns** (`Int32`, `Int64`, `Boolean`, `DateTime` — the overwhelming
majority) — reinterpret the delta as a signed `Number`, then accumulate in `Float64Array`:

```js
const delta = hi >= 0x80000000
  ? (hi - 0x100000000) * 0x100000000 + lo   // two's-complement negative
  : hi * 0x100000000 + lo;
```

This is *exact*: a delta of `-1` arrives as `hi=0xFFFFFFFF, lo=0xFFFFFFFF` and comes out as
exactly `-1`. The accumulated value stays exact while `|value| < 2^53`, which holds for every
realistic FTDC integer — epoch milliseconds are ~1.7e12, and a byte counter would need to
reach 9 petabytes to break it.

**`Double` columns** — these genuinely need full 64-bit accumulation, because the value being
delta-encoded is a bit pattern (CORRECTION 1) and is routinely above 2^53. Accumulate hi/lo
with an explicit carry:

```js
const sum = accLo + dLo;
accLo = sum >>> 0;
accHi = (accHi + dHi + (sum > 0xFFFFFFFF ? 1 : 0)) >>> 0;
```

then convert once per sample via a reusable 8-byte `DataView`: `setUint32(0, accHi);
setUint32(4, accLo); getFloat64(0)`. Doubles are a small minority of FTDC columns, so the
expensive path runs rarely.

**Zero-run fast path** — when the run counter covers the rest of a column, the value is by
definition unchanged, so fill it in one call instead of looping:

```js
if (nzeroes >= remaining) { out.fill(current, j, nSamples); nzeroes -= remaining; break; }
```

On idle captures this collapses the majority of the decode into `TypedArray.prototype.fill`,
which is memset-speed. Idle captures are also the common case in support work — the customer
sends you the whole retention window and the incident is ten minutes of it.

Net effect: pure `Number` and typed-array arithmetic throughout, one allocation per column,
no intermediate JS objects, no BigInt.

The brief's instruction to "prefer typed arrays for metric series" is right for *storage*.
The point of this section is that the *decode arithmetic* needs deliberate design too — just
not BigInt.

### ⚠ CORRECTION 4 — Zero-run state carries across column boundaries

`read.go:101` declares the run counter **outside** the per-metric loop:

```go
var nzeroes uint64                       // <-- outside
for i, v := range metrics {              // per column
    for j := 0; j < ndeltas; j++ {       // per sample
        if nzeroes != 0 { delta = 0; nzeroes-- } else {
            delta = ReadUvarint()
            if delta == 0 { nzeroes = ReadUvarint() }
        }
        ...
    }
}
```

A zero run started near the end of column *i* continues consuming samples at the start of
column *i+1* without any new bytes being read. The delta block is a single continuous
stream that merely happens to be consumed in column-major order — it is **not** a sequence
of independently decodable per-column segments.

Anyone who "optimizes" by decoding columns independently, or who resets run state per
column, produces a decoder that works perfectly on busy captures and corrupts idle ones —
because long zero runs only appear when metrics aren't changing. Test explicitly with an
idle-server fixture.

The encoding itself: a literal `0` varint means "this delta is zero", and the varint
immediately following it gives the count of **additional** consecutive zeros. The brief
describes this correctly.

---

## 4. Reconstruction

For each column: `series[0] = referenceValue`, `series[i] = series[i-1] + delta[i-1]`,
giving `deltaCount + 1` values (`util.go:48-55`).

Then, per column, apply the type transform recorded during flattening:
- `Double` → `Float64frombits`
- everything else → the integer value as-is

## 5. Timestamps — verified empirically

Note that `github.com/mongodb/ftdc` **never derives per-sample timestamps at all**. It
decodes columns and hands you documents (`iterator_sample.go:18-45`); choosing a time axis
is left to the consumer. So unlike §§1–4, this section rests on observation of real captures
rather than on the reference implementation.

Confirmed against a mongod 6.0.26 capture (see `tools/fixtures/generate.sh`):

```
column  0: start                  [datetime]   = 1784728337300
column  1: serverStatus.start     [datetime]
column  2: serverStatus.pid       [int64]
...
last column: end                  [datetime]
```

**`start` is column 0**, a `DateTime`, in epoch milliseconds. There is a matching `end`
column at the tail. Use `start` as the sample clock.

`DateTime` columns are epoch **milliseconds** (`bson_metric.go:119`, `util.go:95`) — note
that `ftdc.WriteCSV` renders them as whole-second RFC3339 and destroys this precision, which
is one of several reasons the oracle does not use it (§7).

Implement with a documented fallback chain — `start`, then `serverStatus.localTime` — and
fail loudly if neither is present rather than silently synthesising a time axis. The column
is not guaranteed to be at index 0 across all server versions; look it up by path.

Samples are *nominally* 1 s apart but **do not assume it**. Derive
every sample's time from the column. Irregular spacing and inter-chunk gaps are real signal
— a gap means mongod was down, stalled, or the host froze. Preserve gaps; never reindex to a
synthetic uniform grid.

## 6. Schema drift across chunks

Consecutive chunks can carry different reference documents — a version upgrade, a storage
engine change, a replica-set member added or removed, a feature toggled. Column *count* and
column *order* both change.

Rules:
- Merge across chunks **by dotted path**, never by column index.
- A path absent from a chunk produces `NaN` for that chunk's sample range. Do not shift, do
  not forward-fill during decode. (Forward-fill is a *presentation* choice, decided per
  panel, and it is wrong for gauges.)
- Array-index paths are unstable by nature: `replSetGetStatus.members.2.*` may refer to a
  different host after a reconfig. When a chunk's member array changes, re-map by
  `members.N.name` rather than trusting the index.

## 7. Test strategy — implemented, see `tools/oracle/`

Full-matrix equality against MongoDB's own decoder. Not a spot-check: CORRECTIONS 2 and 4
both produce output that looks entirely reasonable on a handful of sampled values and is
wrong everywhere.

### ⚠ Do not use `ftdc.WriteCSV` as the oracle

The obvious choice is the shipped CSV exporter. It is unusable here, because its record
writer is lossy in exactly the places our decoder is most likely to be wrong (`csv.go:25-34`):

```go
case bsontype.Double, bsontype.Int32, bsontype.Int64, bsontype.Boolean, bsontype.Timestamp:
    fields[idx] = strconv.FormatInt(m.Values[i], 10)          // Double as raw bit pattern
case bsontype.DateTime:
    fields[idx] = time.Unix(m.Values[i]/1000, 0).Format(time.RFC3339)   // ms precision lost
}                                                              // other types -> empty string
```

- `Double` is emitted as the **undecoded int64 bit pattern** — so CORRECTION 1, the whole
  point of testing doubles, goes unverified.
- `DateTime` is truncated to whole seconds — and the sample clock is a DateTime column (§5).
- Any type outside the switch silently yields an empty string.

**Use `ftdc.ReadMetrics(ctx, r)` instead.** It sets `flatten: true`, runs `restoreFlat`
(`bson_restore.go:100-115`), and yields per-sample documents with dotted keys and properly
restored values. That is what `tools/oracle/` does; it emits JSONL with an ordered key list
per schema, so column *order* is verified alongside values.

### Fixture coverage

`tools/fixtures/generate.sh` produces these from a local mongod. Fast-sampling
(`diagnosticDataCollectionPeriodMillis=100`) cuts chunk time from 5 min to 30 s.

| Fixture | Covers | Status |
|---|---|---|
| `busy-replset` | dense deltas; BSON Timestamps via `replSetGetStatus.optimes.*.ts` + `.ts.inc` (CORRECTION 2); schema drift (§6) | ✅ 1541 samples, 5 schemas |
| `idle` | long zero runs across column boundaries (CORRECTION 4) | ✅ 1500 samples |
| `interim` | truncated trailing chunk (§1) | ✅ 251 samples |
| fractional doubles (CORRECTION 1) | present in all three | ✅ 23 double columns |
| major-version upgrade | cross-version metric renames | ❌ needs a second mongod version |

The drift in `busy-replset` arises naturally: `replSetGetStatus` holds 4 columns before
`rs.initiate()` and 59 after, so the reference document reshapes mid-file and the schema
grows from 1,685 to 2,571 columns. That exercises merge-by-path, though not cross-version
renames.

### Observed shape of a real capture

From `busy-replset` chunk 0 (mongod 6.0.26, 1,685 columns):

| | count | share |
|---|---|---|
| `int64` | 1,228 | 72.9% |
| `int32` | 407 | 24.2% |
| `double` | 23 | **1.4%** |
| `bool` | 16 | 0.9% |
| `datetime` | 11 | 0.7% |

Sections: `serverStatus` 1,263 · `systemMetrics` 413 · `replSetGetStatus` 4 (pre-initiate)
· `local` 3 · `start`/`end` 2.

**Doubles are 1.4% of columns.** This is a direct empirical justification for the split
arithmetic in CORRECTION 3: the expensive exact-64-bit hi/lo path runs on ~1% of columns
while the fast `Number` path handles ~98%.
