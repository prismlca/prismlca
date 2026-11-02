/**
 * What the node menu's upstream and Localize entries act on. A right-click inside a multi-selection acts on
 * the selection, one outside it on the clicked node alone — the rule colours and tags follow as well. Each
 * entry takes the nodes it applies to and leaves the others alone: Localize the locked ones, Expand those
 * with hidden upstream, Collapse those whose upstream is shown.
 */
import type { Node } from '@xyflow/react'

export interface MenuTargets {
  /** Nodes whose upstream can be revealed. */
  expand: string[]
  /** Nodes whose upstream is revealed. */
  collapse: string[]
  /** Locked nodes, which Localize copies into the model. */
  localize: string[]
}

export function menuTargets(nodes: Node[], selection: string[], id: string): MenuTargets {
  const ids = new Set(selection.includes(id) && selection.length > 1 ? selection : [id])
  const out: MenuTargets = { expand: [], collapse: [], localize: [] }
  for (const n of nodes) {
    if (!ids.has(n.id)) continue
    const d = n.data as { upstream?: number; expanded?: boolean; readOnly?: boolean }
    // An upstream count of -1 is "not known until expanded", which is something to expand.
    if (d.expanded) out.collapse.push(n.id)
    else if ((d.upstream ?? 0) !== 0) out.expand.push(n.id)
    if (d.readOnly) out.localize.push(n.id)
  }
  return out
}

/** "1 process", "3 processes" — the count an entry acting on a selection names. */
export const processes = (n: number): string => `${n} process${n === 1 ? '' : 'es'}`
