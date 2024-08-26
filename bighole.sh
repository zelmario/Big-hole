#!/bin/bash

# Function to handle Ctrl-C
cleanup() {
    echo "Shutting down Docker Compose..."
    docker-compose down
    echo "Script terminated."
    exit 0
}

# Trap Ctrl-C (SIGINT)
trap cleanup SIGINT

# Function to check if Docker is running
check_docker() {
    if ! docker info > /dev/null 2>&1; then
        echo "Docker is not running. Please start Docker and try again."
        exit 1
    fi
}

# Step 1: Check if Docker is running
check_docker

# Step 2: Check if metrics directory is provided
if [ -z "$1" ]; then
    echo "Usage: $0 <metrics_directory>"
    exit 1
fi

# Step 3: Launch Docker Compose
docker-compose up -d

# Directory containing metric files
METRICS_DIR="$1"

# Step 4: Process each metric file in parallel
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
            python3 ftdc_parser.py "$temp_json"

            # Optionally, you can remove the temp.json after processing
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
find "$METRICS_DIR" -name 'metrics.*' -print0 | xargs -0 -n 1 -P 4 bash -c 'process_file "$0"'

# Step 5: Calculate the "from" and "to" timestamps
current_time=$(date +%s%3N)  # Current time in milliseconds
four_months_ago=$(date -d "-4 months" +%s%3N)  # Time 4 months ago in milliseconds

# Print the URL with the calculated timestamps
echo "Processing completed."
echo "Access your dashboard at: http://localhost:3001/d/ddnw277huiv40ae/ftdc-dashboard?orgId=1&from=${four_months_ago}&to=${current_time}"

# Step 6: Wait indefinitely to keep the script running
while true; do
    sleep 1
done
