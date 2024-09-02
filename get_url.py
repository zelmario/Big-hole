"""
Created on Mon Jun  3 10:55:10 2024

@author: zelmar@michelini.com.uy
"""

from influxdb_client import InfluxDBClient
import urllib.parse

# InfluxDB connection details
url = "http://influxdb:8086"
token = "ftdc"
org = "percona"
bucket = "ftdc"

# Initialize the InfluxDB client
client = InfluxDBClient(url=url, token=token, org=org)

# Query for the first value
query_first = f"""
from(bucket: "{bucket}")
  |> range(start: -1y)  // Adjust this range if necessary
  |> filter(fn: (r) => r._measurement == "ftdc")
  |> filter(fn: (r) => r._field == "serverStatus.localTime")
  |> group()
  |> first()
  |> yield(name: "first_value")
"""

# Query for the last value
query_last = f"""
from(bucket: "{bucket}")
  |> range(start: -1y)  // Adjust this range if necessary
  |> filter(fn: (r) => r._measurement == "ftdc")
  |> filter(fn: (r) => r._field == "serverStatus.localTime")
  |> group()
  |> last()
  |> yield(name: "last_value")
"""

# Execute the queries
query_api = client.query_api()

# Fetch the first value
first_result = query_api.query(org=org, query=query_first)
first_value = None
for table in first_result:
    for record in table.records:
        first_value = record.get_value()

# Fetch the last value
last_result = query_api.query(org=org, query=query_last)
last_value = None
for table in last_result:
    for record in table.records:
        last_value = record.get_value()

# Ensure that we have both values before constructing the URL
if first_value and last_value:
    # Construct the URL
    base_url = "http://localhost:3001/d/ddnw277huiv40ae/ftdc-dashboard"
    params = {
        "orgId": 1,
        "from": first_value,
        "to": last_value
    }
    url = f"{base_url}?{urllib.parse.urlencode(params)}"
    
    # Print the URL
    print("Access your dashboard at:", url)
else:
    print("Failed to retrieve first or last value.")

# Close the client
client.close()
