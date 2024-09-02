#!/bin/bash

# Function to handle Ctrl-C (SIGINT)
cleanup() {
    echo "Stopping Docker containers..."
    docker-compose down
    echo "Docker containers stopped."
    exit 0
}

# Trap Ctrl-C (SIGINT) to run the cleanup function
trap cleanup SIGINT

# Start Docker containers in detached mode
docker-compose up -d

# Tail the logs of the metrics-processor service
docker-compose logs -f metrics-processor
