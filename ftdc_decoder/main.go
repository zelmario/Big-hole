package main

import (
	"bytes"
	"compress/zlib"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/jeremywohl/flatten"
	"github.com/mongodb/mongo-tools/common/db"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"io"
	"log"
	"os"
	"path/filepath"
	"time"
)

func main() {
	// Command-line flags for input and output files
	inputFile := flag.String("input", "", "Path to the input file")
	outputFile := flag.String("output", "", "Path to the output file")
	flag.Parse()

	if *inputFile == "" || *outputFile == "" {
		log.Fatal("Input and output files must be specified")
	}

	// Ensure input file path is absolute
	absInputPath, err := filepath.Abs(*inputFile)
	if err != nil {
		log.Fatalf("Failed to get absolute path of input file: %v", err)
	}

	// Ensure output file path is absolute
	absOutputPath, err := filepath.Abs(*outputFile)
	if err != nil {
		log.Fatalf("Failed to get absolute path of output file: %v", err)
	}

	// Decode the metrics
	fmt.Println("Decoding MongoDB FTDC data:") // Print finish message

	f, err := os.OpenFile(absOutputPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		log.Fatalf("Failed to open file: %v", err)
	}
	defer f.Close()

	// write JSON Data key
	if _, err := f.WriteString("{\"Data\":["); err != nil {
		log.Fatalf("Failed to write to file: %v", err)
	}

	file, err := os.Open(absInputPath)
	if err != nil {
		fmt.Errorf("couldn't open BSON file: %v", err)

	}

	x := db.NewBSONSource(file)

	fmt.Println(absInputPath)
	fmt.Println(absOutputPath)
	i := 0
	for {
		raw := bson.Raw(x.LoadNext())
		if raw == nil { // assume nil means EOF
			break
		}

		binField := raw.Lookup("data")

		if binField.Type == bson.TypeBinary {

			_, b := binField.Binary()


			payload := b
			if len(b) >= 6 && b[4] == 0x78 && (b[5] == 0x9C || b[5] == 0xDA) {
				payload = b[4:]
			}

			zr, err := zlib.NewReader(bytes.NewReader(payload))
			if err != nil {
				print(err)
			}
			defer zr.Close()
			data, err := io.ReadAll(zr)
			raw := bson.Raw(data)
			var m bson.M
			if err := bson.UnmarshalExtJSON([]byte(raw.String()), true, &m); err != nil {
				panic(err)
			}
			dataToWrite := ""
			if i != 0 {
				dataToWrite = "	,\n"
			}

			jsonQuery := normalizeBSON(m)
			if err != nil {
				panic(err)
			}
			jsonQueryBytes, err := json.Marshal(jsonQuery)
			if err != nil {
				panic(err)
			}

			flat, err := flatten.FlattenString(string(jsonQueryBytes), "", flatten.DotStyle)
			if err != nil {
				panic(err)
			}
			dataToWrite = dataToWrite + flat

			if _, err := f.WriteString(dataToWrite); err != nil {
				log.Fatalf("Failed to write to file: %v", err)
			}
			i++
		}

	}

	// close JSON
	if _, err := f.WriteString("\n]}"); err != nil {
		log.Fatalf("Failed to write to file: %v", err)
	}
}

func normalizeBSON(v interface{}) interface{} {
	switch val := v.(type) {
	case bson.M:
		m := map[string]interface{}{}
		for k, v2 := range val {
			m[k] = normalizeBSON(v2)
		}
		return m
	case primitive.A:
		arr := make([]interface{}, len(val))
		for i, v2 := range val {
			arr[i] = normalizeBSON(v2)
		}
		return arr
	case primitive.DateTime:
		return time.UnixMilli(int64(val)).UnixMilli() // or `.Format(time.RFC3339)`
	case primitive.ObjectID:
		return val.Hex()
	default:
		return val
	}
}
