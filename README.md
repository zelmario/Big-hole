# Big-hole
View all MongoDB FTDC Metrics that you want in Grafana.

I've been using the Keyhole tool from @simagix (Ken Chen) for a while and it's great! but with the new versions of MongoDB, sometimes I need to see more metrics to analyze specific issues.
Based on the same idea, I've written this small script to gather additional metrics and be able to obtain all the metrics that I need.

The script sends all the metrics data to a Dockerized InfluxDB instance. I chose InfluxDB because it's very simple and comes with its own dashboard, which is very useful for viewing the metrics and constructing queries to use in Grafana.

## Prerequisites
- Python version 3.6 or later
- Docker

## Installation
1. Clone the repository
2. Navigate to the project directory
3. Install dependencies: `pip install -r requeriments.txt`
4. Make the decoder executable: `chmod +x ftdc_decoder`
5. Make the script executable: `chmod +x bighole.sh`
6. Run the script: `./bighole.sh /home/any_directory/diagnostic.data/`

## Usage
The script will decode all the diagnostic data files and launch two docker containers, InfluxDB and Grafana

To see the default dashboard you can go to the link that the script shows when it finish the process.

![Screenshoot](https://github.com/zelmario/Big-hole/blob/main/big_hole.png?raw=true)


## Custom metrics
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

