"""Port the devops-land/mongodb_ftdc_viewer Grafana dashboard to ftdc-lens panel specs.

Grafana applies derivative() to most panels; those become rate() here. Panels whose Flux
does something we cannot express generically (per-disk regex fans, CPU percent, replica lag)
are hand-mapped below and expanded against the capture catalogue at load time via `*` globs.
"""
import json, re, sys

src = sys.argv[1]
d = json.load(open(src))

# Only units Grafana was told explicitly. 'short'/'none'/absent are its DEFAULTS, not
# statements about the data, so those are dropped and the unit is inferred from the metric
# path instead -- which is how "Network In / Out" ended up labelled per-sec while carrying
# bytes, and swap memory labelled count while carrying kB.
UNITS = {
    'decgbytes': 'bytes', 'decbytes': 'bytes', 'bytes': 'bytes',
    'deckbytes': 'bytes', 'MBs': 'bytes/s', 'ms': 'ms', 'µs': 'us',
    'percent': 'percent',
}

# Gauges: an instantaneous reading, not a running total. The upstream dashboard applies
# derivative() per panel, so a gauge sharing a panel with counters gets differenced too --
# which is why connections.current read "0.5/s". Rating a gauge is always meaningless.
GAUGE = re.compile(r"""
    \.(current|available|active|out|totalTickets|queueLength|processing)$
  | \.(resident|virtual|mapped)$
  | \bcurrently\ in\ the\ cache$
  | \bmaximum\ bytes\ configured$
  | \btracked\ dirty\ bytes\ in\ the\ cache$
  | \bcurrently\ active$
  | \.(health|state|pingMs|uptime|uptimeMillis|uptimeEstimate)$
  | \.cursor\.open\.
  | \.io_in_progress$
  | _kb$
  | \.(avgObjSize|storageSize|freeStorageSize)$
  | \.Tcp:CurrEstab$
""", re.X)

# Panels whose queries are not a plain field list. Values are expression templates; `*`
# expands against the catalogue so every disk / mount / replica member is picked up.
CPU_TOTAL = 'sum(' + ', '.join(
    f'rate(systemMetrics.cpu.{k}_ms)'
    for k in ('user', 'system', 'iowait', 'nice', 'softirq', 'steal', 'idle')
) + ')'

HAND = {
    # Exactly Big-hole's two series. `totalTickets` is worth having on 8.0, where the pool is
    # tuned dynamically and `available: 8` alone cannot tell you how close to saturation the
    # server is -- but it is one click away in the catalogue, and this panel is the dashboard's.
    'WiredTiger Tickets': ([
        'serverStatus.wiredTiger.concurrentTransactions.read.available',
        'serverStatus.wiredTiger.concurrentTransactions.write.available',
    ], 'count'),
    # CORRECTION. Grafana computed (localTime - lastAppliedWallTime) / 1000 and labelled the
    # result `ms`. Both are millisecond timestamps, so the difference is already milliseconds;
    # dividing again makes it seconds while the axis still says ms, and 1.08 s of replica lag
    # renders as "1.08 ms". Dropping the /1000 is what makes the number mean its label.
    'Replica members lag': (
        [f'diff(serverStatus.localTime, replSetGetStatus.members.*.lastAppliedWallTime)'], 'ms'),
    'Replica members ping': (['replSetGetStatus.members.*.pingMs'], 'ms'),
    # CORRECTION (label, via a scale). Grafana plotted the rate and labelled it µs, but µs
    # accumulated per second is not microseconds -- it is a fraction of wall time, and 1e6 µs/s
    # is 100% of it. As a percentage the panel answers "how much of the time was this server
    # under flow control", which is the question.
    'FlowControl isLagged': (
        ['scale(rate(serverStatus.flowControl.isLaggedTimeMicros), 0.0001)'], 'percent'),
    # CORRECTION. Grafana plots rate(latency): microseconds accumulated per second, which is a
    # utilisation figure, not a latency. Average latency per operation is what the panel title
    # promises and what a support engineer reads it for.
    'Latency': ([f'div(rate(serverStatus.opLatencies.{k}.latency), '
                 f'rate(serverStatus.opLatencies.{k}.ops))' for k in ('reads','writes','commands')], 'us'),
    # CORRECTION (label only). These are operations per second; Grafana's unit said µs.
    'Operations latencies op': ([f'rate(serverStatus.opLatencies.{k}.ops)'
                                 for k in ('reads','writes','commands')], 'per-sec'),
    # CORRECTION. Grafana divided the two cumulative counters, which yields the average over
    # the server's whole uptime and barely moves. Dividing the rates gives the ratio right now,
    # which is what makes a bad query plan visible when it starts.
    'Query Targeting: Scanned Objects / Returned ': (
        ['div(rate(serverStatus.metrics.queryExecutor.scannedObjects), '
         'rate(serverStatus.metrics.document.returned))'], 'count'),
    # FAN-OUT. Grafana hardcoded members 0/1/2 (with a "// Add more members as needed" note in
    # the Flux); the glob expands to whatever the capture has.
    'Replica members health': (['replSetGetStatus.members.*.health'], 'count'),
    'Replica members state': (['replSetGetStatus.members.*.state'], 'count'),
    # Big-hole's three series -- user, system, iowait -- as a share of the machine's total CPU:
    # 100 * user / (user + system + iowait + nice + softirq + steal + idle), which is what its
    # two chained map() steps computed. Bounded 0-100 whatever the core count, and immune to a
    # stalled systemMetrics collector catching up in one sample, because numerator and
    # denominator stretch together.
    'CPU Usage': ([f'pct(rate(systemMetrics.cpu.{k}_ms), ' + CPU_TOTAL + ')'
                   for k in ('user', 'system', 'iowait')], 'percent'),
    # CORRECTION. Same three fields Grafana used, each read as what /proc/diskstats means:
    # io_in_progress is a gauge (requests in flight now) and differencing it is meaningless;
    # io_time_ms is milliseconds the device was busy, so ms/s / 10 is utilisation percent --
    # iostat's %util; io_queued_ms is weighted time in queue, so ms/s / 1000 is average queue
    # depth. Grafana differenced all three and plotted them as bare numbers.
    'Disk I/O': (['scale(rate(systemMetrics.disks.*.io_time_ms), 0.1)',
                  'scale(rate(systemMetrics.disks.*.io_queued_ms), 0.001)',
                  'systemMetrics.disks.*.io_in_progress'], ''),
    'Disk writes and reads': (['rate(systemMetrics.disks.*.reads)',
                               'rate(systemMetrics.disks.*.writes)'], 'per-sec'),
    # CORRECTION, plus Big-hole's writes_merged. write_sectors is 512-byte sectors (scaled to
    # bytes by PATH_SCALES), so this is throughput. write_time_ms alone is milliseconds of
    # service time accumulated per second; over the write count it is average service time,
    # iostat's w_await, which is the number anyone reads this panel for.
    'Disk writes': (['rate(systemMetrics.disks.*.write_sectors)',
                     'div(rate(systemMetrics.disks.*.write_time_ms), rate(systemMetrics.disks.*.writes))',
                     'rate(systemMetrics.disks.*.writes_merged)'], ''),
    'Disk reads': (['rate(systemMetrics.disks.*.read_sectors)',
                    'div(rate(systemMetrics.disks.*.read_time_ms), rate(systemMetrics.disks.*.reads))',
                    'rate(systemMetrics.disks.*.reads_merged)'], ''),
}
panels = []
for p in d.get('panels', []):
    gp = p.get('gridPos', {})
    title = p.get('title', '')
    if p.get('type') == 'row':
        panels.append({'kind': 'section', 'title': title,
                       'x': gp.get('x', 0), 'y': gp.get('y', 0), 'w': gp.get('w', 24), 'h': 1,
                       'metrics': []})
        continue

    unit = UNITS.get(p.get('fieldConfig', {}).get('defaults', {}).get('unit', ''), '')

    if title in HAND:
        metrics, unit = HAND[title]
    else:
        queries = ' '.join((t.get('query') or '') for t in p.get('targets', []))
        derive = 'derivative(' in queries
        fields, seen = [], set()
        for t in p.get('targets', []):
            for f in re.findall(r'r\["?_field"?\]\s*==\s*"([^"]+)"', t.get('query') or ''):
                if f not in seen:
                    seen.add(f); fields.append(f)
        if not fields:
            continue
        metrics = []
        rated = False
        for f in fields:
            gauge = bool(GAUGE.search(f))
            metrics.append(f'rate({f})' if derive and not gauge else f)
            if derive and not gauge:
                rated = True
        # Only promote the unit when something in the panel actually got differenced.
        if rated and unit == 'bytes':
            unit = 'bytes/s'

    panels.append({'kind': 'chart', 'title': title, 'metrics': metrics, 'unit': unit or None,
                   'x': gp.get('x', 0), 'y': gp.get('y', 0),
                   'w': gp.get('w', 8), 'h': gp.get('h', 6)})

out = [
    '/**',
    ' * Default dashboard.',
    ' *',
    ' * Ported panel for panel from zelmario/Big-hole (grafana/dashboards/dashboard.json,',
    ' * vendored at tools/port/big-hole-dashboard.json). Generated by',
    ' * tools/port/port-dashboard.py -- regenerate rather than hand-editing.',
    ' *',
    ' * Titles, order, geometry and series are Big-hole\'s. Grafana applied derivative() to most',
    ' * panels, so those metrics are wrapped in rate() here, except on gauges: Grafana',
    ' * differenced whole streams, so `connections.current` was being plotted as a rate.',
    ' *',
    ' * Panels Grafana fanned out by regex or hardcoded index (per-disk, per-replica-member) use',
    ' * a `*` glob, expanded against the capture catalogue at load time. A handful of queries',
    ' * whose math did not match their title are corrected; each is justified in the porter.',
    ' *',
    ' * Grid is 24 columns to match Grafana 1:1.',
    ' */',
    '',
    "import type { Unit } from '../data/expr.js';",
    '',
    'export interface PanelTemplate {',
    "  readonly kind: 'chart' | 'section';",
    '  readonly title: string;',
    '  readonly metrics: readonly string[];',
    '  readonly unit?: Unit;',
    '  readonly x: number;',
    '  readonly y: number;',
    '  readonly w: number;',
    '  readonly h: number;',
    '}',
    '',
    'export const DEFAULT_TEMPLATES: readonly PanelTemplate[] = [',
]
for p in panels:
    metrics = ', '.join(json.dumps(m) for m in p['metrics'])
    unit = (f", unit: {json.dumps(p['unit'])}"
            if p['kind'] == 'chart' and p.get('unit') else '')
    out.append(f"  {{ kind: {json.dumps(p['kind'])}, title: {json.dumps(p['title'])}, "
               f"metrics: [{metrics}]{unit}, "
               f"x: {p['x']}, y: {p['y']}, w: {p['w']}, h: {p['h']} }},")
out.append('];')
out.append('')
print('\n'.join(out))
