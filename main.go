// main.go
package main

import (
    "encoding/json"
    "flag"
    "fmt"
    "io/ioutil"
    "log"
    "os"
    "path/filepath"

    "ftdc/decoder" // Adjust the import path based on your project structure
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

    // Read the input file
    //fmt.Println("Reading MongoDB FTDC file starting...") // Print finish message    
    data, err := ioutil.ReadFile(absInputPath)
    if err != nil {
        log.Fatalf("Failed to read input file: %v", err)
    }

    // Decode the metrics
    fmt.Println("Decoding MongoDB FTDC data...") // Print finish message
    metrics := decoder.NewMetrics()
    err = metrics.ReadAllMetrics(&data)
    if err != nil {
        log.Fatalf("Failed to decode metrics: %v", err)
    }

    // Convert the metrics to JSON
    //fmt.Println("Converting MongoDB metrics...") // Print
    jsonData, err := json.MarshalIndent(metrics, "", "  ")
    if err != nil {
        log.Fatalf("Failed to marshal metrics to JSON: %v", err)
    }

    // Ensure the output directory exists
    outputDir := filepath.Dir(absOutputPath)
    if _, err := os.Stat(outputDir); os.IsNotExist(err) {
        os.MkdirAll(outputDir, os.ModePerm)
    }

    // Write the JSON data to the output file
    err = ioutil.WriteFile(absOutputPath, jsonData, 0644)
    if err != nil {
        log.Fatalf("Failed to write output file: %v", err)
    }

   // fmt.Println("Successfully wrote metrics to JSON file")
}
