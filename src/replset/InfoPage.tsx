import { Fragment, useEffect, useMemo, useState, type ReactElement } from 'react';

import { useStore } from '../store/useStore.js';
import { mergeFields, nodeFields, type NodeInfo } from './hostInfo.js';

/**
 * What every loaded node is, side by side.
 *
 * A field per row and a node per column, deliberately. The question this page exists to answer
 * is almost never "how much RAM does node2 have" -- it is "why is node2 different", and that is
 * a question about a row, not about a node. Laid out as one card per node you have to hold three
 * numbers in your head to compare them; laid out as a table the difference is the only thing on
 * the line that changes, so a member with half the cache, an older build, or a file-descriptor
 * limit nobody raised is visible without reading anything. Rows whose nodes disagree are marked,
 * because on a nine-member bundle even that is worth pointing at.
 *
 * Everything here is already resident: the metadata document rides in the manifest and the
 * metric values come from the catalogue's whole-capture min/max. Opening this page reads
 * nothing from disk.
 *
 * The raw metadata document is one click away underneath. The curated list is a starting point
 * and will always be missing the field that matters to somebody's case -- `getCmdLineOpts` alone
 * carries every `setParameter` a server was started with -- so the whole document stays
 * reachable rather than being summarised away.
 */
export function InfoPage(): ReactElement | null {
  const open = useStore((s) => s.showInfo);
  const toggle = useStore((s) => s.toggleInfo);
  const captures = useStore((s) => s.captures);
  const [raw, setRaw] = useState<string | null>(null);

  const nodes = useMemo<NodeInfo[]>(
    () =>
      captures.map((c) => ({
        captureId: c.id,
        label: c.label,
        meta: c.summary.meta,
        fields: nodeFields({
          id: c.id,
          label: c.label,
          paths: c.paths,
          catalog: c.catalog,
          ...(c.summary.meta !== undefined ? { meta: c.summary.meta } : {}),
          startMs: c.summary.startMs,
          endMs: c.summary.endMs,
          sampleCount: c.summary.sampleCount,
          cadenceMs: c.summary.cadenceMs,
          gaps: c.summary.gaps.length,
          restarts: c.summary.restarts.length,
          ...(c.summary.mongoVersion !== undefined ? { mongoVersion: c.summary.mongoVersion } : {}),
        }),
      })),
    [captures],
  );

  const rows = useMemo(() => mergeFields(nodes), [nodes]);

  // Same scrim + Esc pattern as the log window, the help overlay and a maximised panel.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') toggle(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, toggle]);

  if (!open) return null;

  const close = (): void => toggle(false);
  const valueOf = (node: NodeInfo, section: string, label: string): string | undefined =>
    node.fields.find((f) => f.section === section && f.label === label)?.value;
  const sourceOf = (section: string, label: string): string =>
    nodes
      .map((n) => n.fields.find((f) => f.section === section && f.label === label)?.source)
      .find((s) => s !== undefined) ?? '';

  const withoutMeta = nodes.filter((n) => n.meta === undefined);
  // Which rows open a section, decided up front rather than by mutating a cursor inside the
  // render loop -- `mergeFields` already groups by section, so this is just its first of each.
  const opensSection = new Set(
    rows.filter((r, i) => i === 0 || rows[i - 1]!.section !== r.section).map((r) => r.section),
  );

  return (
    <div className="logwindow-scrim" onMouseDown={close}>
      <div
        className="logwindow infopage"
        role="dialog"
        aria-label="Node information"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="logwindow-bar">
          <span className="logwindow-title">node info</span>
          <span className="muted small">
            host, processors, memory, WiredTiger cache and the configuration mongod was started
            with — from the FTDC metadata document, so it is the server’s own answer
          </span>
          <div className="spacer" />
          <button className="link" title="Close" onClick={close}>
            ✕
          </button>
        </div>

        <div className="info-body">
          {nodes.length === 0 ? (
            <p className="muted pad">No nodes loaded.</p>
          ) : (
            <>
              {withoutMeta.length > 0 && (
                <p className="small warn pad">
                  ⚠ {withoutMeta.map((n) => n.label).join(', ')}{' '}
                  {withoutMeta.length === 1 ? 'carries' : 'carry'} no FTDC metadata document —
                  either the capture predates this feature and needs decoding again, or its
                  `metrics.*` files genuinely have no type-0 record. The rows below still show
                  what the metrics themselves say.
                </p>
              )}

              <table className="info-table">
                <thead>
                  <tr>
                    <th />
                    {nodes.map((n) => (
                      <th key={n.captureId}>
                        {n.label}
                        <span className="muted small"> {n.captureId}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ section, label }, index) => {
                    const values = nodes.map((n) => valueOf(n, section, label));
                    // "Differs" only counts nodes that answered: a field one node simply does
                    // not report is a gap, not a disagreement, and marking it as one would put
                    // a flag on half the table of a mixed-version replica set.
                    const answered = values.filter((v): v is string => v !== undefined);
                    const differs = new Set(answered).size > 1;
                    const heading =
                      opensSection.has(section) && (index === 0 || rows[index - 1]!.section !== section);
                    return (
                      <Fragment key={`${section}-${label}`}>
                        {heading && (
                          <tr className="info-section">
                            <th colSpan={nodes.length + 1}>{section}</th>
                          </tr>
                        )}
                        <tr className={differs ? 'info-differs' : ''}>
                          <th title={sourceOf(section, label)}>
                            {label}
                            {differs && <span className="info-flag" title="the nodes disagree">≠</span>}
                          </th>
                          {values.map((v, i) => (
                            <td key={nodes[i]!.captureId}>{v ?? <span className="muted">—</span>}</td>
                          ))}
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>

              <div className="info-raw">
                <div className="info-raw-tabs">
                  <span className="muted small">raw metadata document:</span>
                  {nodes.map((n) => (
                    <button
                      key={n.captureId}
                      className={raw === n.captureId ? 'tab on' : 'tab'}
                      disabled={n.meta === undefined}
                      title={
                        n.meta === undefined
                          ? 'this capture carries no metadata document'
                          : `everything ${n.label}'s FTDC recorded about itself`
                      }
                      onClick={() => setRaw(raw === n.captureId ? null : n.captureId)}
                    >
                      {n.label}
                    </button>
                  ))}
                </div>
                {raw !== null && (
                  <pre className="info-json">
                    {JSON.stringify(nodes.find((n) => n.captureId === raw)?.meta ?? {}, null, 2)}
                  </pre>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
