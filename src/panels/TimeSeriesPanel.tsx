import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

import { CAPTURE_ID, useStore } from '../store/useStore.js';
import type { PanelSpec } from '../dashboard/layout.js';
import { axisFormatter, formatValue } from '../data/format.js';
import { parseExpr, unitOf, type Unit } from '../data/expr.js';
import type { SeriesPayload } from '../workers/protocol.js';
import type { Gap } from '../data/types.js';

/** Grafana's classic series palette, so a ported dashboard reads the same. */
const PALETTE = [
  '#73bf69', '#f2cc0c', '#8ab8ff', '#ff9830', '#f2495c', '#b877d9',
  '#ff780a', '#5794f2', '#fade2a', '#7ee0d1', '#e02f44', '#c0d8ff',
];

/**
 * Trim a legend label to what distinguishes it.
 *
 * Full paths are unreadable at panel width -- `rate(common.serverStatus.opcounters.query)` is
 * mostly prefix shared with every other series in the panel. The role prefix and section are
 * dropped for display; the full expression stays in the tooltip and in the panel definition.
 */
function legendLabel(expression: string): string {
  return expression
    .replace(/\b(common|shard|router|configsvr)\./g, '')
    .replace(/\bserverStatus\./g, '')
    .replace(/\bsystemMetrics\./g, 'sys.')
    .replace(/\breplSetGetStatus\./g, 'rs.')
    .replace(/\blocal\.oplog\.rs\.stats\./g, 'oplog.');
}

/**
 * Unit for one series.
 *
 * A panel can legitimately mix units -- Connections carries two gauges and a rate -- so the
 * legend reads each series' own unit while the axis keeps the panel's. An explicit panel unit
 * still wins, since that is a deliberate statement about the whole panel.
 */
function seriesUnit(panel: PanelSpec, metric: string): Unit {
  if (panel.unit !== undefined) return panel.unit;
  try {
    return unitOf(parseExpr(metric));
  } catch {
    return 'count';
  }
}

function panelUnit(panel: PanelSpec): Unit {
  if (panel.unit !== undefined) return panel.unit;
  const first = panel.metrics[0];
  if (first === undefined) return 'count';
  try {
    return unitOf(parseExpr(first));
  } catch {
    return 'count';
  }
}

/**
 * Shade the ranges where the capture has no samples.
 *
 * Missing FTDC means mongod was down, stalled, or the host froze -- one of the strongest
 * signals in a capture, and invisible unless you draw it.
 */
function gapPlugin(gaps: () => readonly Gap[]): uPlot.Plugin {
  return {
    hooks: {
      draw: (u: uPlot) => {
        const ctx = u.ctx;
        ctx.save();
        ctx.fillStyle = 'rgba(235, 87, 87, 0.16)';
        for (const gap of gaps()) {
          const x0 = u.valToPos(gap.fromMs / 1000, 'x', true);
          const x1 = u.valToPos(gap.toMs / 1000, 'x', true);
          if (x1 < u.bbox.left || x0 > u.bbox.left + u.bbox.width) continue;
          ctx.fillRect(x0, u.bbox.top, Math.max(1, x1 - x0), u.bbox.height);
        }
        ctx.restore();
      },
    },
  };
}

export function TimeSeriesPanel({ panel }: { panel: PanelSpec }): ReactElement {
  const holder = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const [series, setSeries] = useState<SeriesPayload[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 600, h: 160 });
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const client = useStore((s) => s.client);
  const status = useStore((s) => s.status);
  const range = useStore((s) => s.range);
  const summary = useStore((s) => s.summary);
  const focused = useStore((s) => s.focused);
  const showBand = useStore((s) => s.showBand);
  const setRange = useStore((s) => s.setRange);
  const setCursor = useStore((s) => s.setCursor);
  const toggleSeries = useStore((s) => s.toggleSeries);
  const showAllSeries = useStore((s) => s.showAllSeries);
  const removePanel = useStore((s) => s.removePanel);
  const renamePanel = useStore((s) => s.renamePanel);

  const gapsRef = useRef<readonly Gap[]>([]);
  gapsRef.current = summary?.gaps ?? [];

  const unit = panelUnit(panel);
  const isSection = panel.kind === 'section';
  const hidden = panel.hidden ?? [];
  const metricsKey = panel.metrics.join('');
  const hiddenKey = hidden.join('');

  useEffect(() => {
    const el = holder.current;
    if (el === null || isSection) return;
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => observer.disconnect();
  }, [isSection]);

  useEffect(() => {
    if (isSection || status !== 'ready' || panel.metrics.length === 0) {
      setSeries([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    const query = {
      maxPoints: Math.max(200, size.w),
      ...(range !== null ? { from: range[0], to: range[1] } : {}),
    };

    client
      .series(CAPTURE_ID, panel.metrics, query)
      .then((result) => {
        if (!cancelled) setSeries(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSeries([]);
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, status, metricsKey, range, size.w, isSection]);

  // Hidden series are dropped before the plot is built rather than styled away, so the y-axis
  // rescales to what is actually shown -- which is the point of hiding a large series.
  const visible = useMemo(
    () => series.filter((s) => !hidden.includes(s.path)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, hiddenKey],
  );

  /** True when the window resolved to no samples at all -- worth saying so explicitly. */
  const empty = series.length > 0 && series.every((s) => s.t.length === 0);

  const data = useMemo<uPlot.AlignedData | null>(() => {
    // uPlot draws nothing useful from empty columns, so do not construct it at all.
    if (visible.length === 0 || visible[0]!.t.length === 0) return null;
    const x = Array.from(visible[0]!.t, (ms) => ms / 1000); // uPlot time axis is seconds
    const cols: number[][] = [x];
    for (const s of visible) {
      cols.push(Array.from(s.mean));
      if (showBand) {
        cols.push(Array.from(s.min));
        cols.push(Array.from(s.max));
      }
    }
    return cols as unknown as uPlot.AlignedData;
  }, [visible, showBand]);

  /** Colour by position in the panel's full metric list, so hiding one does not recolour the rest. */
  const colourOf = (path: string): string =>
    PALETTE[Math.max(0, panel.metrics.indexOf(path)) % PALETTE.length]!;

  useEffect(() => {
    if (holder.current === null || data === null || size.w === 0) return;

    const stride = showBand ? 3 : 1;

    const opts: uPlot.Options = {
      width: size.w,
      height: Math.max(60, size.h),
      legend: { show: false }, // the chip row below the plot is the legend
      cursor: {
        drag: { x: true, y: false, setScale: false },
        sync: { key: 'ftdc' },
        points: { size: 5 },
      },
      scales: { x: { time: true } },
      axes: [
        { stroke: '#8b94a3', grid: { stroke: '#2a2f38', width: 1 }, ticks: { stroke: '#2a2f38' } },
        {
          stroke: '#8b94a3',
          grid: { stroke: '#2a2f38', width: 1 },
          ticks: { stroke: '#2a2f38' },
          values: (_u: uPlot, ticks: number[]) => axisFormatter(unit)(ticks),
          size: 62,
        },
      ],
      plugins: [gapPlugin(() => gapsRef.current)],
      series: [
        { label: 'time' },
        ...visible.flatMap((s) => {
          const colour = colourOf(s.path);
          const line: uPlot.Series = {
            label: s.path,
            stroke: colour,
            width: 1,
            spanGaps: false,
            points: { show: false },
          };
          return showBand
            ? [
                line,
                { label: `${s.path} min`, stroke: 'transparent', spanGaps: false },
                { label: `${s.path} max`, stroke: 'transparent', spanGaps: false },
              ]
            : [line];
        }),
      ],
      // Very light: at higher alpha the envelope reads as a drop shadow behind the line
      // rather than as a range. Off by default; it is what keeps a one-sample spike visible
      // after downsampling, so it stays available.
      bands: showBand
        ? visible.map((s, i) => ({
            series: [stride * i + 3, stride * i + 2] as [number, number],
            fill: `${colourOf(s.path)}14`,
          }))
        : [],
      hooks: {
        setCursor: [
          (u: uPlot) => {
            const idx = u.cursor.idx;
            setHoverIdx(idx ?? null);
            setCursor(idx == null ? null : (u.data[0]![idx] as number) * 1000);
          },
        ],
        setSelect: [
          (u: uPlot) => {
            if (u.select.width <= 0) return;
            const from = u.posToVal(u.select.left, 'x') * 1000;
            const to = u.posToVal(u.select.left + u.select.width, 'x') * 1000;
            u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
            setRange([Math.round(from), Math.round(to)]);
          },
        ],
      },
    };

    plot.current?.destroy();
    plot.current = new uPlot(opts, data, holder.current);

    return () => {
      plot.current?.destroy();
      plot.current = null;
    };
  }, [data, visible, size.w, size.h, unit, showBand, setCursor, setRange]);

  if (isSection) {
    return (
      <div className="section drag-handle">
        <h2>{panel.title}</h2>
      </div>
    );
  }

  const isFocused = focused === panel.id;

  return (
    <div className={isFocused ? 'panel focused' : 'panel'}>
      <div className="panel-head drag-handle">
        <input
          className="panel-title"
          value={panel.title}
          onChange={(e) => renamePanel(panel.id, e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
        />
        {loading && <span className="muted small">…</span>}
        <span className="spacer" />
        {hidden.length > 0 && (
          <button
            className="link small"
            title="Show all series"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => showAllSeries(panel.id)}
          >
            {hidden.length} hidden
          </button>
        )}
        <button
          className="link small"
          title="Remove panel"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => removePanel(panel.id)}
        >
          ✕
        </button>
      </div>

      {error !== null && <div className="small error">{error}</div>}
      {panel.metrics.length > 0 && visible.length === 0 && !empty && (
        <div className="muted small pad">All series hidden — click a legend entry to show it.</div>
      )}
      {empty && (
        <div className="muted small pad">
          No samples in this time range — zoom out or widen the window.
        </div>
      )}
      <div ref={holder} className="plot" />

      {/* Legend below the plot, as in Grafana. Clicking toggles visibility; it does not
          remove the metric -- removal is done from the catalogue. */}
      <div className="legend" onMouseDown={(e) => e.stopPropagation()}>
        {panel.metrics.map((m) => {
          const s = series.find((x) => x.path === m);
          const off = hidden.includes(m);
          const idx = hoverIdx ?? (s ? s.mean.length - 1 : -1);
          const value = s !== undefined && idx >= 0 && idx < s.mean.length ? s.mean[idx] : undefined;
          return (
            <button
              key={m}
              className={off ? 'legend-item off' : 'legend-item'}
              title={off ? `${m} — click to show` : `${m} — click to hide`}
              onClick={() => toggleSeries(panel.id, m)}
            >
              <span className="legend-dash" style={{ background: off ? '#5a6472' : colourOf(m) }} />
              <span className="legend-label">{legendLabel(m)}</span>
              {value !== undefined && !off && (
                <span className="legend-value">
                  {formatValue(value, seriesUnit(panel, m))}
                </span>
              )}
            </button>
          );
        })}
        {panel.metrics.length === 0 && (
          <span className="muted small">
            {isFocused ? 'Pick metrics from the catalog →' : 'Click to focus, then pick metrics'}
          </span>
        )}
      </div>
    </div>
  );
}
