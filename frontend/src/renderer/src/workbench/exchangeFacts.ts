/**
 * What the Add-exchange and Edit-exchange dialogs show above the amount. A drag between two boxes
 * opened a dialog with nothing but "Amount" in it — no word of which flow, or in which unit, the
 * number was meant. The flow an arrow carries is the supplier's reference
 * product, and the amount is counted in that product's unit — the same unit the arrow's label shows,
 * spelt the same way ("kg" for ecoinvent's "kilogram"), but never cut short as the label may be.
 */
import type { Node } from '@xyflow/react'
import type { Fact } from '../components/Modal'
import { UNIT_SHORT } from '../lib/units'

interface BoxData {
  label?: string
  product?: string | null
  geo?: string | null
  unit?: string | null
}

export interface ExchangeFacts {
  facts: Fact[]
  unit: string | null
}

/** `source` supplies, `target` consumes — the direction of the canvas arrow. */
export function exchangeFacts(nodes: Node[], source: string, target: string): ExchangeFacts {
  const box = (id: string): BoxData | undefined => nodes.find((n) => n.id === id)?.data as BoxData | undefined
  const from = box(source)
  const into = box(target)
  const named = (d: BoxData | undefined, id: string): string => {
    const name = d?.label ?? id
    return d?.geo ? `${name} · ${d.geo}` : name
  }
  return {
    facts: [
      { label: 'Flow', value: from?.product || from?.label || source },
      { label: 'From', value: named(from, source) },
      { label: 'Into', value: named(into, target) }
    ],
    unit: from?.unit ? (UNIT_SHORT[from.unit.trim().toLowerCase()] ?? from.unit) : null
  }
}
