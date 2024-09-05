#!/bin/bash

#author: zelmar@michelini.com.uy

# Function to handle Ctrl-C
cleanup() {
    echo "Shutting down Docker Compose..."
    docker-compose down
    echo "Script terminated."
    exit 0
}

# Trap Ctrl-C (SIGINT)
trap cleanup SIGINT

# Check if metrics directory is provided
if [ -z "$1" ]; then
    echo "Usage: $0 <metrics_directory>"
    exit 1
fi

# Directory containing metric files
METRICS_DIR="$1"

echo "This can take some time... ☕"
echo " "

#Process each metric file in parallel
process_file() {
    local metric_file="$1"
    if [[ -f "$metric_file" ]]; then
        # Extracting timestamp from filename
        timestamp=$(basename "$metric_file" | cut -d'-' -f2-3)
        temp_json="temp_${timestamp}.json"

        # Running Go program with the metric file and temp.json
        ./ftdc_decoder -input "$metric_file" -output "$temp_json"

        # Check if temp.json was created
        if [[ -f "$temp_json" ]]; then
            # Run the Python script on the temp.json file
            python3 /scripts/ftdc_parser.py "$temp_json"

            # Remove the temp.json after processing
            rm "$temp_json"
        else
            echo "temp.json not found for $metric_file"
        fi
    else
        echo "No metric files found in $METRICS_DIR"
    fi
}

# Export the function so it can be used in parallel
export -f process_file

# Run the process_file function in parallel for each metric file
find "$METRICS_DIR" -name 'metrics.*' -print0 | xargs -0 -n 1 -P 1 bash -c 'process_file "$0"'

# run python script to show the dashbopard url
python3 /scripts/get_url.py 

echo "Press Ctrl-C when you've finished to analyze the dashboard."

# Step 6: Wait indefinitely to keep the script running
while true; do
    sleep 1
done
