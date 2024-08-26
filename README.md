# Big-hole
View all MongoDB FTDC Metrics in Grafana

## Prerequisites
- Python version 3.6 or later
- Go version 1.22 or later
- Docker

## Installation
1. Clone the repository
2. Navigate to the project directory
3. Install dependencies: `pip install -r requeriments.txt`
4. make the file executable: `chmod +x bighole.sh`
5. Run the script: `./bighole.sh /home/any_directory/diagnostic.data/`

## Usage
The script will decode all the diagnostic data files and launch two docker containers, InfluxDB and Grafana

To see the default dashboard you can go to the link that the script shows when it finish the process.

![Screenshoot](https://github.com/zelmario/Big-hole/blob/main/big_hole.png?raw=true?raw=true)


## Custom metrics
There is a file with the list of metrics to get `metrics_to_get.txt` if you want to get more metrics, you can add the name of the metric to that file.
You have the list of all metrics in another file called `metrics.txt`, just add another metric to the file `metrics_to_get.txt` and the script will get it.



If you want to get more metrics
