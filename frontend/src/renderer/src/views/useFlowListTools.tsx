import { useState } from 'react'
import FlowSearchControl, { filterFlows } from './FlowSearch'
import FlowSortControl, { FLOW_TOOLS_MIN, type FlowLike, type FlowSort, sortFlows } from './FlowSort'

/** Filter and sort for the flow lists of the process details window, one state per section key. Both
 *  appear once a list has FLOW_TOOLS_MIN entries — the inspector's rule for its sort — and a shorter list
 *  is shown as it is. */
export function useFlowListTools(): {
  bar: (rows: FlowLike[], key: string) => JSX.Element | null
  rows: <T extends FlowLike>(rows: T[], key: string) => T[]
  empty: (rows: FlowLike[], key: string, fallback: string) => string
} {
  const [sorts, setSorts] = useState<Record<string, FlowSort>>({})
  const [queries, setQueries] = useState<Record<string, string | null>>({})
  const active = (rows: FlowLike[]): boolean => rows.length >= FLOW_TOOLS_MIN
  const shown = <T extends FlowLike>(rows: T[], key: string): T[] =>
    active(rows) ? sortFlows(filterFlows(rows, queries[key] ?? ''), sorts[key] ?? null) : rows
  return {
    bar: (rows, key) =>
      active(rows) ? (
        <span className="flow-tools">
          <FlowSearchControl
            query={queries[key] ?? null}
            onChange={(q) => setQueries((m) => ({ ...m, [key]: q }))}
          />
          <FlowSortControl
            value={sorts[key] ?? null}
            onChange={(v) => setSorts((m) => ({ ...m, [key]: v }))}
          />
        </span>
      ) : null,
    rows: shown,
    // A filter that matches nothing says so, rather than the section's "No emissions." — the emissions
    // are there, the filter hides them.
    empty: (rows, key, fallback) =>
      rows.length && !shown(rows, key).length ? 'No flow matches the filter.' : fallback
  }
}
