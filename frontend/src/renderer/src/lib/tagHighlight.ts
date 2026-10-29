/**
 * The tag groups the canvas's highlight menu offers: only what a box on this canvas carries.
 *
 * The menu listed every tag group of the workspace, with every value — groups from other models and
 * values no box here has, each of which highlighted nothing when picked. Order
 * is kept as the workspace defines it, so the menu reads the same in every model.
 */
export interface HighlightGroup {
  name: string
  color: string
  values: string[]
}

export function groupsOnCanvas<G extends HighlightGroup>(groups: G[], nodes: { data: unknown }[]): G[] {
  const carried = new Map<string, Set<string>>()
  for (const n of nodes) {
    for (const t of (n.data as { tags?: { dimension: string; value: string }[] }).tags ?? []) {
      let values = carried.get(t.dimension)
      if (!values) carried.set(t.dimension, (values = new Set()))
      values.add(t.value)
    }
  }
  return groups
    .map((g) => ({ ...g, values: g.values.filter((v) => carried.get(g.name)?.has(v)) }))
    .filter((g) => g.values.length > 0)
}
