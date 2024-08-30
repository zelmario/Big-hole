# Big-hole
View all MongoDB FTDC Metrics that you want in Grafana.

I've been using the Keyhole tool from @simagix (Ken Chen) for a while and it's great! but with the new versions of MongoDB, sometimes I need to see more metrics to analyze specific issues.
Based on the same idea, I've written this small script to gather additional metrics and be able to obtain all the metrics that I need.

The script sends all the metrics data to a Dockerized InfluxDB instance. I chose InfluxDB because it's very simple and comes with its own dashboard, which is very useful for viewing the metrics and constructing queries to use in Grafana.

## Prerequisites
- Python version 3.6 or later
- Docker and Docker-compose

## Installation
1. Clone the repository
2. Navigate to the project directory
3. Install dependencies: `pip install -r requirements.txt`
4. Make the decoder and the script executables: `chmod +x ftdc_decoder bighole.sh`
6. Run the script with the diagnostic data folder as argument: `./bighole.sh /home/any_directory/diagnostic.data/`

## Usage
The script will decode all the diagnostic data files and launch two docker containers, InfluxDB and Grafana

```bash
zelmar@LAPTOP:~/Big-hole$ ./bighole.sh /home/zelmar/diagnostic.data/
[+] Running 4/4
 ✔ Network big-hole_default         Created                                                                                                                0.0s
 ✔ Volume "big-hole_influxdb-data"  Created                                                                                                                0.0s
 ✔ Container big-hole-influxdb-1    Started                                                                                                                0.7s
 ✔ Container big-hole-grafana-1     Started                                                                                                                1.0s
Reading MongoDB FTDC file starting...
Decoding MongoDB FTDC data...
Converting MongoDB metrics...
Successfully wrote metrics to JSON file
Processing metrics: 79it [00:11,  6.63it/s]
Chunk processed
Processing completed.
Access your dashboard at: http://localhost:3001/d/ddnw277huiv40ae/ftdc-dashboard?orgId=1&from=1714151615931&to=1724692415930
```


To see the default dashboard you can go to the link that the script shows when it finish the process:

![Screenshoot](https://github.com/zelmario/Big-hole/blob/main/big_hole.png?raw=true)


## How to get more metrics
There is a file named `metrics_to_get.txt` that contains the list of metrics to retrieve. If you want to gather more metrics, simply add the name of the desired metric to this file.
You'll find a complete list of all available metrics in another file called `metrics.txt`. Just add the metric you want to retrieve to `metrics_to_get.txt`, and the script will collect it.

You can use InfluxDB to view the metrics and construct the queries needed to display them in Grafana.
```bash
http://localhost:8086/
user: zelmario
pass: password
```

![Screenshoot](https://github.com/zelmario/Big-hole/blob/main/influxdb.png?raw=true)

## License
This project is licensed under the MIT License - see the LICENSE file for details.

## Contributing
Contributions are welcome! Since I'm not a professional developer, your feedback is valuable. If you're a programmer and notice any mistakes or have ideas to enhance the script, please feel free to contribute! :)

