/**
 * What the node menu's entries act on. A right-click inside a multi-selection acts on the selection, one
 * outside it on the clicked node alone — the rule colours and tags follow as well. Each entry takes the
 * nodes it applies to and leaves the others alone: Localize and Remove the locked ones, Delete the model's
 * own processes, Expand those with hidden upstream, Collapse those whose upstream is shown. (Duplicate and
 * Move to library act on the clicked process alone.)
 */
import type { Node } from '@xyflow/react'

export interface MenuTargets {
  /** Nodes whose upstream can be revealed. */
  expand: string[]
  /** Nodes whose upstream is revealed. */
  collapse: string[]
  /** Locked nodes: Localize copies them into the model, Remove takes them off the canvas. */
  locked: string[]
  /** The model's own processes, which Delete deletes. */
  own: string[]
}

export function menuTargets(nodes: Node[], selection: string[], id: string): MenuTargets {
  const ids = new Set(selection.includes(id) && selection.length > 1 ? selection : [id])
  const out: MenuTargets = { expand: [], collapse: [], locked: [], own: [] }
  for (const n of nodes) {
    if (!ids.has(n.id)) continue
    const d = n.data as { upstream?: number; expanded?: boolean; readOnly?: boolean }
    // An upstream count of -1 is "not known until expanded", which is something to expand.
    if (d.expanded) out.collapse.push(n.id)
    else if ((d.upstream ?? 0) !== 0) out.expand.push(n.id)
    ;(d.readOnly ? out.locked : out.own).push(n.id)
  }
  return out
}

/** "1 process", "3 processes" — the count an entry acting on a selection names. */
export const processes = (n: number): string => `${n} process${n === 1 ? '' : 'es'}`
