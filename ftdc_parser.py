# -*- coding: utf-8 -*-
"""
Created on Mon Jun  3 10:55:10 2024

@author: zelmar@michelini.com.uy
"""

import argparse
import ijson
from influxdb_client import InfluxDBClient, Point, WritePrecision
from datetime import datetime
import re
import time
from tqdm import tqdm
from concurrent.futures import ThreadPoolExecutor, as_completed

# Set up argument parser
parser = argparse.ArgumentParser(description='Process a JSON file.')
parser.add_argument('file_path', type=str, help='The path to the JSON file')

# Parse the arguments
args = parser.parse_args()

# InfluxDB details
token = "ftdc"
org = "percona"
bucket = "ftdc"
url = "http://influxdb:8086"

client = InfluxDBClient(url=url, token=token, org=org)
write_api = client.write_api()

# Get metrics and process them
def generate_timestamps(metric_set):
    return metric_set['DataPointsMap']['serverStatus.localTime']

metrics_file = '/app/metrics_to_get.txt'

keys_to_check = []
with open(metrics_file, 'r') as file:
    keys_to_check = [line.strip() for line in file]

# get disk-related metrics
disk_metrics_pattern = re.compile(r'^systemMetrics\.disks\..*\.(io_in_progress|io_queued_ms|io_time_ms|read_sectors|read_time_ms|reads|reads_merged|write_sectors|write_time_ms|writes|writes_merged)$')

#get replica nodes metrics
member_metrics_pattern = re.compile(r'^replSetGetStatus\.members\.\d+\.(pingMs|lastAppliedWallTime|health)$')

#get mount metrics
mount_metrics_pattern = re.compile(r'^systemMetrics\.mounts\.(\/(?:[^\/]+\/?)*)\.(available|capacity|free)$')

def process_metrics(metric_set):
    timestamps = generate_timestamps(metric_set)
    points_dict = {}
    
    for key, values in metric_set["DataPointsMap"].items():
        if key in keys_to_check or disk_metrics_pattern.match(key) or member_metrics_pattern.match(key) or mount_metrics_pattern.match(key):
            for ts, value in zip(timestamps, values):
                if ts not in points_dict:
                    points_dict[ts] = {}
                points_dict[ts][key] = value
    
    points = []
    for ts, fields in points_dict.items():
        timestamp = datetime.fromtimestamp(ts / 1000)
        point = Point("ftdc").time(timestamp, WritePrecision.MS)
        for key, value in fields.items():
            point = point.field(key, value)
        points.append(point)
    return points

# Parallel processing function
def process_batch(batch):
    all_points = []
    for metric_set in batch:
        points = process_metrics(metric_set)
        all_points.extend(points)
    write_api.write(bucket=bucket, org=org, record=all_points)

# Streaming and processing JSON data
batch_size = 5000
batch = []

with open(args.file_path, 'r') as file:
    objects = ijson.items(file, 'Data.item')
    with ThreadPoolExecutor(max_workers=2) as executor:  # Adjust max_workers based on your CPU cores
        futures = []
        for metric_set in tqdm(objects, desc="Processing metrics"):
            batch.append(metric_set)
            if len(batch) >= batch_size:
                futures.append(executor.submit(process_batch, batch))
                batch = []
        if batch:  # Process any remaining metrics
            futures.append(executor.submit(process_batch, batch))
        
        # Wait for all threads to complete before exiting
        for future in as_completed(futures):
            future.result()

time.sleep(1)
client.close()

print("Chunk processed")


