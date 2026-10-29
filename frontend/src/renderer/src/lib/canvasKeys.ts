/**
 * Canvas node ids name their model: `<database>/<code>`, unescaped (the backend's `node_id`). The
 * positions, the node colours, the group boxes and the placed reference boxes of a model's view are all
 * keyed by them, so a model that is renamed — or imported under another name — has to take those keys
 * along, or its canvas falls back to the grid and loses its colours and boxes.
 *
 * The backend does the same to the stored views (`view_store.rename_canvas_keys`) — change both or neither.
 * One difference: the backend knows the model's process codes and moves exactly the keys that name one of
 * them; this cache copy has no codes and takes a key as the model's when the rest is one plain code. The
 * server's answer replaces the copy on the next load, so only a code holding a `/` that was dragged in the
 * moment of a rename can come out differently.
 */
type Rec = Record<string, unknown>

const isRec = (x: unknown): x is Rec => typeof x === 'object' && x !== null && !Array.isArray(x)

/**
 * `view` with every canvas key of model `from` moved to `to`, or `null` when nothing named it. A key only
 * moves when the rest is one plain code: `A/B/x` belongs to a model called `A/B`, not to `A`.
 */
export function renameCanvasKeys(view: Rec, from: string, to: string): Rec | null {
  let changed = false
  const prefix = `${from}/`
  const node = (k: unknown): unknown => {
    if (typeof k !== 'string' || !k.startsWith(prefix) || k.slice(prefix.length).includes('/')) return k
    changed = true
    return `${to}/${k.slice(prefix.length)}`
  }
  const next: Rec = { ...view }
  if (isRec(view.layout)) {
    const layout: Rec = { ...view.layout }
    if (isRec(layout.pos))
      layout.pos = Object.fromEntries(Object.entries(layout.pos).map(([k, v]) => [node(k), v]))
    if (Array.isArray(layout.refs))
      layout.refs = layout.refs.map((r: unknown) =>
        isRec(r)
          ? { ...r, id: node(r.id), ...('dataset_id' in r ? { dataset_id: node(r.dataset_id) } : {}) }
          : r
      )
    next.layout = layout
  }
  if (isRec(view.colors))
    next.colors = Object.fromEntries(Object.entries(view.colors).map(([k, v]) => [node(k), v]))
  if (Array.isArray(view.groups))
    next.groups = view.groups.map((g: unknown) =>
      isRec(g) && Array.isArray(g.members) ? { ...g, members: g.members.map(node) } : g
    )
  return changed ? next : null
}
