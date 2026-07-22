// Command oracle decodes an FTDC file using MongoDB's reference implementation
// (github.com/mongodb/ftdc) and emits a fully-restored, order-preserving dump that
// the TypeScript decoder is tested against.
//
// Why not ftdc.WriteCSV: its record writer (csv.go) emits Double metrics as the raw
// int64 bit pattern rather than restoring them via Float64frombits, truncates DateTime
// to whole seconds through RFC3339, and writes empty strings for any type outside its
// switch. Each of those blind spots sits exactly where our decoder is most likely to be
// wrong. ReadMetrics(flatten: true) runs restoreFlat and gives properly typed values
// under dotted keys, which is what we need.
//
// Output is JSONL, one object per line:
//
//	{"t":"schema","i":0,"keys":[...],"types":[...]}   emitted on first chunk and on drift
//	{"t":"sample","v":[...]}                          values positionally match the schema
//	{"t":"summary","samples":N,"schemas":M,"file":"..."}
//
// Emitting the ordered key list rather than a map is deliberate: flatten *order* defines
// the delta-block column order, so a decoder that produces right values in wrong order
// must fail the test.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"

	"github.com/evergreen-ci/birch"
	"github.com/evergreen-ci/birch/bsontype"
	"github.com/mongodb/ftdc"
)

func typeName(t bsontype.Type) string {
	switch t {
	case bsontype.Double:
		return "double"
	case bsontype.Int32:
		return "int32"
	case bsontype.Int64:
		return "int64"
	case bsontype.Boolean:
		return "bool"
	case bsontype.DateTime:
		return "datetime"
	default:
		return fmt.Sprintf("other(%v)", t)
	}
}

// value extracts a restored metric value as a JSON-encodable Go value.
//
// Note: restoreFlat in the reference implementation has no Timestamp case, so BSON
// Timestamp columns arrive here as Int64 -- both the seconds*1000 column and the
// synthetic ".inc" column. That is expected and is precisely what verifies that our
// decoder emits two columns for a Timestamp.
func value(v *birch.Value) (interface{}, string) {
	switch v.Type() {
	case bsontype.Double:
		d := v.Double()
		// encoding/json refuses NaN and ±Inf, which would abort the dump mid-file.
		// Emit sentinels; tests/oracle.ts maps them back.
		if math.IsNaN(d) {
			return "NaN", "double"
		}
		if math.IsInf(d, 1) {
			return "Inf", "double"
		}
		if math.IsInf(d, -1) {
			return "-Inf", "double"
		}
		return d, "double"
	case bsontype.Int32:
		return v.Int32(), "int32"
	case bsontype.Int64:
		return v.Int64(), "int64"
	case bsontype.Boolean:
		return v.Boolean(), "bool"
	case bsontype.DateTime:
		// epoch milliseconds, full precision -- never RFC3339
		return v.DateTime(), "datetime"
	default:
		return nil, typeName(v.Type())
	}
}

func sameKeys(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func main() {
	in := flag.String("in", "", "path to an FTDC metrics.* file (required)")
	out := flag.String("out", "", "output .jsonl path (default: stdout)")
	flag.Parse()

	if *in == "" {
		fmt.Fprintln(os.Stderr, "error: -in is required")
		flag.Usage()
		os.Exit(1)
	}

	f, err := os.Open(*in)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: opening %s: %v\n", *in, err)
		os.Exit(1)
	}
	defer f.Close()

	var w *bufio.Writer
	if *out == "" {
		w = bufio.NewWriterSize(os.Stdout, 1<<20)
	} else {
		of, err := os.Create(*out)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: creating %s: %v\n", *out, err)
			os.Exit(1)
		}
		defer of.Close()
		w = bufio.NewWriterSize(of, 1<<20)
	}
	defer w.Flush()

	enc := json.NewEncoder(w)
	ctx := context.Background()
	iter := ftdc.ReadMetrics(ctx, f)
	defer iter.Close()

	var (
		prevKeys []string
		samples  int
		schemas  int
	)

	for iter.Next() {
		doc := iter.Document()

		di := doc.Iterator()
		keys := make([]string, 0, 2048)
		types := make([]string, 0, 2048)
		vals := make([]interface{}, 0, 2048)

		for di.Next() {
			e := di.Element()
			v, t := value(e.Value())
			keys = append(keys, e.Key())
			types = append(types, t)
			vals = append(vals, v)
		}

		if !sameKeys(keys, prevKeys) {
			if err := enc.Encode(map[string]interface{}{
				"t": "schema", "i": schemas, "keys": keys, "types": types,
			}); err != nil {
				fmt.Fprintf(os.Stderr, "error: writing schema: %v\n", err)
				os.Exit(1)
			}
			schemas++
			prevKeys = keys
		}

		if err := enc.Encode(map[string]interface{}{"t": "sample", "v": vals}); err != nil {
			fmt.Fprintf(os.Stderr, "error: writing sample: %v\n", err)
			os.Exit(1)
		}
		samples++
	}

	if err := iter.Err(); err != nil {
		// A truncated trailing chunk is normal for metrics.interim. Report it on stderr
		// and still emit the summary: everything decoded up to that point is valid, and
		// the interim fixture exists specifically to exercise this path.
		fmt.Fprintf(os.Stderr, "warning: iterator ended with error (expected for metrics.interim): %v\n", err)
	}

	if err := enc.Encode(map[string]interface{}{
		"t": "summary", "samples": samples, "schemas": schemas, "file": *in,
	}); err != nil {
		fmt.Fprintf(os.Stderr, "error: writing summary: %v\n", err)
		os.Exit(1)
	}

	fmt.Fprintf(os.Stderr, "decoded %s: %d samples, %d schema(s)\n", *in, samples, schemas)
}
