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
HAND = {
    'Replica members lag': (
        [f'diff(serverStatus.localTime, replSetGetStatus.members.*.lastAppliedWallTime)'], 'ms'),
    'Replica members ping': (['replSetGetStatus.members.*.pingMs'], 'ms'),
    # Upstream plots rate(latency), i.e. microseconds accumulated per second -- a utilisation
    # figure, not a latency, and it renders as "3.8 s" for a healthy server. Average latency
    # per operation is what the panel title promises.
    'Latency': ([f'div(rate(serverStatus.opLatencies.{k}.latency), '
                 f'rate(serverStatus.opLatencies.{k}.ops))' for k in ('reads','writes','commands')], 'us'),
    # These are operations per second, not microseconds; upstream's unit was wrong.
    'Operations latencies op': ([f'rate(serverStatus.opLatencies.{k}.ops)'
                                 for k in ('reads','writes','commands')], 'per-sec'),
    # The title promises a ratio; upstream plotted the two raw counters side by side.
    'Query Targeting: Scanned Objects / Returned ': (
        ['div(rate(serverStatus.metrics.queryExecutor.scannedObjects), '
         'rate(serverStatus.metrics.document.returned))'], 'count'),
    # Upstream hardcoded members 0/1/2; glob so any set size works.
    'Replica members health': (['replSetGetStatus.members.*.health'], 'count'),
    'Replica members state': (['replSetGetStatus.members.*.state'], 'count'),
    'CPU Usage': ([f'scale(rate(systemMetrics.cpu.{k}_ms), 0.1)'
                   for k in ('user', 'system', 'iowait', 'nice', 'softirq', 'steal', 'idle')], 'percent'),
    'Disk I/O': (['rate(systemMetrics.disks.*.io_time_ms)',
                  'systemMetrics.disks.*.io_in_progress'], 'count'),
    'Disk writes and reads': (['rate(systemMetrics.disks.*.reads)',
                               'rate(systemMetrics.disks.*.writes)'], 'per-sec'),
    'Disk writes': (['rate(systemMetrics.disks.*.write_sectors)',
                     'rate(systemMetrics.disks.*.write_time_ms)'], 'count'),
    'Disk reads': (['rate(systemMetrics.disks.*.read_sectors)',
                    'rate(systemMetrics.disks.*.read_time_ms)'], 'count'),
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
    ' * Ported from the Grafana dashboard in devops-land/mongodb_ftdc_viewer (MIT), which is',
    ' * itself a descendant of zelmario/Big-hole. Generated by tools/port/port-dashboard.py --',
    ' * regenerate rather than hand-editing if the upstream dashboard changes.',
    ' *',
    ' * Grafana applied derivative() to most panels, so those metrics are wrapped in rate()',
    ' * here. Panels whose Flux fanned out over a regex (per-disk, per-replica-member) use a `*`',
    ' * glob, expanded against the capture catalogue at load time.',
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
