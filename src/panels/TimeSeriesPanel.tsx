import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

import { CAPTURE_ID, useStore } from '../store/useStore.js';
import type { SeriesPayload } from '../workers/protocol.js';
import type { Gap } from '../data/types.js';

const PALETTE = ['#4f9cf9', '#f2994a', '#27ae60', '#eb5757', '#bb6bd9', '#2d9cdb', '#f2c94c'];

/**
 * Shade the ranges where the capture has no samples.
 *
 * Missing FTDC means mongod was down, stalled, or the host froze -- one of the strongest
 * signals in a capture, and invisible unless you draw it. Without this the series simply
 * jumps and reads as a normal transition.
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

export function TimeSeriesPanel(): ReactElement {
  const holder = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const [series, setSeries] = useState<SeriesPayload[]>([]);
  const [loading, setLoading] = useState(false);

  const client = useStore((s) => s.client);
  const status = useStore((s) => s.status);
  const selected = useStore((s) => s.selected);
  const range = useStore((s) => s.range);
  const summary = useStore((s) => s.summary);
  const setRange = useStore((s) => s.setRange);
  const setCursor = useStore((s) => s.setCursor);

  const gapsRef = useRef<readonly Gap[]>([]);
  gapsRef.current = summary?.gaps ?? [];

  // Fetch whenever the selection or the window changes. Width in CSS pixels is the natural
  // point budget: there is no reason to transfer more samples than the chart can draw.
  useEffect(() => {
    if (status !== 'ready' || selected.length === 0) {
      setSeries([]);
      return;
    }
    let cancelled = false;
    setLoading(true);

    const width = holder.current?.clientWidth ?? 1200;
    const query = {
      maxPoints: Math.max(200, width),
      ...(range !== null ? { from: range[0], to: range[1] } : {}),
    };

    client
      .series(CAPTURE_ID, selected, query)
      .then((result) => {
        if (!cancelled) setSeries(result);
      })
      .catch(() => {
        if (!cancelled) setSeries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, status, selected, range]);

  const data = useMemo<uPlot.AlignedData | null>(() => {
    if (series.length === 0) return null;
    const first = series[0]!;
    const x = Array.from(first.t, (ms) => ms / 1000); // uPlot time axis is seconds

    const cols: number[][] = [x];
    for (const s of series) {
      cols.push(Array.from(s.mean));
      cols.push(Array.from(s.min));
      cols.push(Array.from(s.max));
    }
    return cols as unknown as uPlot.AlignedData;
  }, [series]);

  useEffect(() => {
    if (holder.current === null || data === null) return;

    const opts: uPlot.Options = {
      width: holder.current.clientWidth,
      height: 420,
      cursor: {
        drag: { x: true, y: false, setScale: false }, // we own zoom; see setSelect below
        sync: { key: 'ftdc' },
      },
      scales: { x: { time: true } },
      plugins: [gapPlugin(() => gapsRef.current)],
      series: [
        { label: 'time' },
        ...series.flatMap((s, i) => {
          const colour = PALETTE[i % PALETTE.length]!;
          return [
            { label: s.path, stroke: colour, width: 1.5, spanGaps: false },
            // Envelope bounds: drawn faintly, and the band between them is what guarantees a
            // one-sample spike survives downsampling.
            { label: `${s.path} min`, stroke: 'transparent', spanGaps: false },
            { label: `${s.path} max`, stroke: 'transparent', spanGaps: false },
          ] as uPlot.Series[];
        }),
      ],
      bands: series.map((_, i) => ({
        series: [3 * i + 3, 3 * i + 2] as [number, number],
        fill: `${PALETTE[i % PALETTE.length]!}33`,
      })),
      hooks: {
        setCursor: [
          (u: uPlot) => {
            const idx = u.cursor.idx;
            setCursor(idx == null ? null : (u.data[0]![idx] as number) * 1000);
          },
        ],
        setSelect: [
          (u: uPlot) => {
            if (u.select.width <= 0) return;
            const from = u.posToVal(u.select.left, 'x') * 1000;
            const to = u.posToVal(u.select.left + u.select.width, 'x') * 1000;
            u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
            // Re-query at the new window rather than rescaling: zooming in must fetch higher
            // resolution from disk, not stretch the points already on screen.
            setRange([Math.round(from), Math.round(to)]);
          },
        ],
      },
    };

    plot.current?.destroy();
    plot.current = new uPlot(opts, data, holder.current);

    const onResize = (): void =>
      plot.current?.setSize({ width: holder.current!.clientWidth, height: 420 });
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      plot.current?.destroy();
      plot.current = null;
    };
  }, [data, series, setCursor, setRange]);

  if (status !== 'ready') return <></>;

  return (
    <div className="panel">
      <div className="panel-head">
        <span>{selected.length} metric{selected.length === 1 ? '' : 's'}</span>
        {loading && <span className="muted">loading…</span>}
        {range !== null && (
          <button onClick={() => setRange(null)} className="link">
            reset zoom
          </button>
        )}
        {series[0]?.raw === false && <span className="muted">min/max envelope</span>}
        {series[0]?.raw === true && <span className="muted">full resolution</span>}
      </div>
      <div ref={holder} className="plot" />
      {selected.length === 0 && <p className="muted pad">Pick a metric from the catalog.</p>}
    </div>
  );
}
