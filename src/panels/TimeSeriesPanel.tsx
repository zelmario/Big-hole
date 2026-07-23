import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

import { useStore } from '../store/useStore.js';
import type { PanelSpec } from '../dashboard/layout.js';
import { axisFormatter, formatValue } from '../data/format.js';
import type { Unit } from '../data/expr.js';
import { fetchPanelData, unitOfMetric, type PanelSeries } from '../data/panelData.js';
import { describeCrossHost } from '../dashboard/crossHost.js';
import { legendLabel, plotColumn, timeColumn } from './plotData.js';
import type { KnownCapture } from '../data/qualify.js';
import type { Gap } from '../data/types.js';

/** Grafana's classic series palette, so a ported dashboard reads the same. */
const PALETTE = [
  '#73bf69', '#f2cc0c', '#8ab8ff', '#ff9830', '#f2495c', '#b877d9',
  '#ff780a', '#5794f2', '#fade2a', '#7ee0d1', '#e02f44', '#c0d8ff',
];

/**
 * Unit for one series.
 *
 * A panel can legitimately mix units -- Connections carries two gauges and a rate -- so the
 * legend reads each series' own unit while the axis keeps the panel's. An explicit panel unit
 * still wins, since that is a deliberate statement about the whole panel.
 */
function seriesUnit(panel: PanelSpec, metric: string, known: KnownCapture): Unit {
  return panel.unit ?? unitOfMetric(metric, known);
}

function panelUnit(panel: PanelSpec, known: KnownCapture): Unit {
  if (panel.unit !== undefined) return panel.unit;
  const first = panel.metrics[0];
  return first === undefined ? 'count' : unitOfMetric(first, known);
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

/**
 * Show what a drag will zoom to.
 *
 * uPlot already renders a selection element while dragging, but its default fill is
 * rgba(0,0,0,0.07) -- invisible on a dark theme, so the gesture gave no feedback about which
 * window was about to be applied. The element is styled in CSS; this adds a live readout of
 * the span, which is the part you actually want to judge before releasing.
 */
function selectionPlugin(): uPlot.Plugin {
  let label: HTMLDivElement | null = null;

  return {
    hooks: {
      init: (u: uPlot) => {
        label = document.createElement('div');
        label.className = 'u-select-label';
        label.style.display = 'none';
        u.over.appendChild(label);
      },
      // setCursor fires on every pointer move, including while dragging, so the label tracks
      // the selection as it grows.
      setCursor: (u: uPlot) => {
        if (label === null) return;
        const { left, width } = u.select;
        if (width > 2) {
          const from = u.posToVal(left, 'x') * 1000;
          const to = u.posToVal(left + width, 'x') * 1000;
          label.textContent = formatValue(to - from, 'ms');
          label.style.left = `${left + width / 2}px`;
          label.style.display = 'block';
        } else {
          label.style.display = 'none';
        }
      },
      setSelect: (u: uPlot) => {
        if (label !== null && u.select.width <= 0) label.style.display = 'none';
      },
    },
  };
}

export function TimeSeriesPanel({ panel }: { panel: PanelSpec }): ReactElement {
  const holder = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const [series, setSeries] = useState<PanelSeries[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 600, h: 160 });
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);

  const client = useStore((s) => s.client);
  const status = useStore((s) => s.status);
  const range = useStore((s) => s.range);
  const captures = useStore((s) => s.captures);
  const known = useStore((s) => s.known);
  const focused = useStore((s) => s.focused);
  const showBand = useStore((s) => s.showBand);
  const setRange = useStore((s) => s.setRange);
  const setCursor = useStore((s) => s.setCursor);
  const toggleSeries = useStore((s) => s.toggleSeries);
  const showAllSeries = useStore((s) => s.showAllSeries);
  const focusPanel = useStore((s) => s.focusPanel);
  const removePanel = useStore((s) => s.removePanel);
  const toggleMaximized = useStore((s) => s.toggleMaximized);
  const isMaximized = useStore((s) => s.maximized === panel.id);
  const renamePanel = useStore((s) => s.renamePanel);

  const gapsRef = useRef<readonly Gap[]>([]);
  gapsRef.current = useStore((s) => s.gaps)();

  // Only the visible captures are drawn, and the fetch has to re-run when that set changes --
  // ticking a node off is a view change, not a reload.
  const refs = useMemo(
    () =>
      captures
        .filter((c) => c.visible)
        .map((c) => ({
          id: c.id,
          label: c.label,
          paths: c.paths,
          cadenceMs: c.summary.cadenceMs,
        })),
    [captures],
  );
  const capturesKey = refs.map((c) => c.id).join(',');

  const unit = panelUnit(panel, known);
  const isSection = panel.kind === 'section';
  const hidden = panel.hidden ?? [];
  const metricsKey = panel.metrics.join('');
  const hiddenKey = hidden.join('');
  const note = describeCrossHost(panel.title);

  useEffect(() => {
    const el = holder.current;
    if (el === null || isSection) return;
    const observer = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => observer.disconnect();
  }, [isSection]);

  useEffect(() => {
    if (isSection || status !== 'ready' || panel.metrics.length === 0 || refs.length === 0) {
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

    fetchPanelData(client, panel.metrics, refs, query)
      .then((result) => {
        if (cancelled) return;
        setSeries(result.series);
        // A node that failed is worth saying out loud; the others still drew.
        setError(result.errors.length > 0 ? result.errors.join(' · ') : null);
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
  }, [client, status, metricsKey, capturesKey, range, size.w, isSection]);

  // Hidden series are dropped before the plot is built rather than styled away, so the y-axis
  // rescales to what is actually shown -- which is the point of hiding a large series.
  const visible = useMemo(
    () => series.filter((s) => !hidden.includes(s.key)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, hiddenKey],
  );

  /** True when the window resolved to no samples at all -- worth saying so explicitly. */
  const empty = series.length > 0 && series.every((s) => s.t.length === 0);

  const data = useMemo<uPlot.AlignedData | null>(() => {
    // uPlot draws nothing useful from empty columns, so do not construct it at all.
    if (visible.length === 0 || visible[0]!.t.length === 0) return null;
    const cols: Array<Array<number | null>> = [timeColumn(visible[0]!.t)];
    for (const s of visible) {
      // plotColumn, not Array.from: a leading NaN nulls the whole panel's y scale. See
      // src/panels/plotData.ts.
      cols.push(plotColumn(s.mean));
      if (showBand) {
        cols.push(plotColumn(s.min));
        cols.push(plotColumn(s.max));
      }
    }
    return cols as unknown as uPlot.AlignedData;
  }, [visible, showBand]);

  /**
   * Colour by position in the panel's full series list, so hiding one does not recolour the
   * rest. The list is generated deterministically from (metric x capture), so a node keeps its
   * colour across panels and across a reload.
   */
  const colourOf = (key: string): string =>
    PALETTE[Math.max(0, series.findIndex((s) => s.key === key)) % PALETTE.length]!;

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
          // Measured, not fixed. At a hardcoded 62px anything past eight characters lost its
          // leading digits, so "143.1 MiB" rendered as "43.1 MiB" -- a plausible-looking
          // number that is wrong by an order of magnitude, on the axis a reader trusts to say
          // what scale they are looking at.
          // Estimated from the character count rather than measured: uPlot calls this before
          // the axis font is on the context, so ctx.measureText under-reports and the labels
          // still lose their leading digits.
          size: (_u: uPlot, values: string[] | null) => {
            const chars = (values ?? []).reduce((m, v) => Math.max(m, v.length), 0);
            return Math.min(130, Math.max(44, Math.round(chars * 7.8) + 16));
          },
        },
      ],
      plugins: [gapPlugin(() => gapsRef.current), selectionPlugin()],
      series: [
        { label: 'time' },
        ...visible.flatMap((s) => {
          const colour = colourOf(s.key);
          const line: uPlot.Series = {
            label: s.key,
            stroke: colour,
            width: 1,
            spanGaps: false,
            points: { show: false },
          };
          return showBand
            ? [
                line,
                { label: `${s.key} min`, stroke: 'transparent', spanGaps: false },
                { label: `${s.key} max`, stroke: 'transparent', spanGaps: false },
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
            fill: `${colourOf(s.key)}14`,
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
            u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, true);
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
    <div
      className={isFocused ? 'panel focused' : 'panel'}
      // Click, not pointerdown: it fires after mouseup, so it can never race a drag gesture.
      onClick={() => focusPanel(panel.id)}
    >
      <div className="panel-head drag-handle">
        {editingTitle ? (
          <input
            className="panel-title"
            value={panel.title}
            autoFocus
            onChange={(e) => renamePanel(panel.id, e.target.value)}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') setEditingTitle(false);
            }}
            onMouseDown={(e) => e.stopPropagation()}
          />
        ) : (
          // A plain span, so the whole header is a drag surface. As an input it swallowed
          // mousedown and any drag started on the title died before the grid saw it.
          <span
            className="panel-title-text"
            title="Double-click to rename"
            onDoubleClick={() => setEditingTitle(true)}
          >
            {panel.title}
          </span>
        )}
        {note !== null && (
          <span className="muted small cross-host" title={note}>
            ⇄
          </span>
        )}
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
          title={isMaximized ? 'Back to the dashboard (Esc)' : 'Maximize this panel'}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => toggleMaximized(panel.id)}
        >
          {isMaximized ? '⤡' : '⤢'}
        </button>
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
      {/* Only once something actually came back. Before M4 this doubled as the loading state
          by accident; with several captures the first fetch takes long enough that every
          panel on the dashboard claimed its series were hidden while they were still being
          read. */}
      {series.length > 0 && visible.length === 0 && !empty && (
        <div className="muted small pad">All series hidden — click a legend entry to show it.</div>
      )}
      {panel.metrics.length > 0 && series.length === 0 && !loading && error === null && (
        <div className="muted small pad">
          No node in this bundle reports {panel.metrics.length === 1 ? 'this metric' : 'these metrics'}.
        </div>
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
        {/* One entry per drawn series, not per panel metric: with several captures loaded a
            single metric becomes one line per node, and each needs its own toggle. */}
        {series.map((s) => {
          const off = hidden.includes(s.key);
          const idx = hoverIdx ?? s.mean.length - 1;
          const value = idx >= 0 && idx < s.mean.length ? s.mean[idx] : undefined;
          return (
            <button
              key={s.key}
              className={off ? 'legend-item off' : 'legend-item'}
              title={off ? `${s.key} — click to show` : `${s.key} — click to hide`}
              onClick={() => toggleSeries(panel.id, s.key)}
            >
              <span
                className="legend-dash"
                style={{ background: off ? '#5a6472' : colourOf(s.key) }}
              />
              <span className="legend-label">
                {s.captureLabel !== '' && <b className="legend-host">{s.captureLabel}</b>}
                {legendLabel(s.expression)}
              </span>
              {value !== undefined && !off && (
                <span className="legend-value">
                  {formatValue(value, seriesUnit(panel, s.expression, known))}
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
