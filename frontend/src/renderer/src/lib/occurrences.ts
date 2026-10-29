/**
 * Boxes per occurrence: a dataset from outside the model (ecoinvent, BAFU, the library, another model) can
 * stand on the canvas several times — once per combination of tags its inputs carry.
 *
 * The backend draws them (`model_graph.graph`): every input of the model that draws on the same dataset
 * with the same tags shares a box. The box's id is the dataset id while untagged, and the dataset id plus a
 * short hash of the tags once tagged — so tagging a box changes its id. Everything that is keyed by id on
 * the canvas (position, colour, group membership) is carried over to the new id by {@link reconcileBoxes},
 * matched by the inputs (exchange uids) the boxes share, whatever made the tags change: the tag menu, an
 * undo, the assistant, a merge of tag values.
 *
 * A box shows the tags that are in effect for its inputs, as the calculation books them: their own, and for
 * every other tag group the own tag of a process from another model or else the value the process using
 * them passes down (`inherited`). So a box under a Production process reads Production without a tag of its
 * own, and a dataset used in two phases stands there twice. Only the inputs' own tags are editable on the
 * box — an inherited value belongs to a process and follows it.
 *
 * A box can also be put on the canvas before it is connected (a second copy dragged in): it has no inputs
 * yet, gets an id of its own (`<dataset>#new-<n>`) and may carry tags as view state, which the first
 * connection writes onto the new input.
 */
import type { Node } from '@xyflow/react'
import { splitId } from './canvas'

export interface Tag {
  dimension: string
  value: string
  /** In effect for the box's inputs without being held by them (see the module comment). */
  inherited?: boolean
}

/** What a box carries in its node data, beyond the usual process card. */
export interface BoxData {
  /** The dataset behind the box (`db/code`), the same for every box of it. */
  datasetId?: string
  /** The model inputs (exchange uids) that draw on this box. Empty for a copy not yet connected. */
  uids?: string[]
  /** Tags of a copy not yet connected — written onto its first input. */
  pendingTags?: Tag[]
}

/** The dataset id of any canvas id — a box id carries a suffix after `#`. */
export function datasetIdOf(id: string): string {
  const [db, code] = splitId(id)
  return `${db}/${code}`
}

/** Whether a node is a box of an outside dataset (as opposed to a process of the model). */
export function isBox(n: Node | undefined): boolean {
  const d = n?.data as ({ readOnly?: boolean; revealed?: boolean } & BoxData) | undefined
  return !!d?.readOnly && !d.revealed
}

/** The tags a box's inputs hold themselves — its pending tags while unconnected. What the tag menu edits
 *  and a line drawn from the box hands on; an inherited value is left out, it goes with the process. */
export function boxTags(n: Node | undefined): Tag[] {
  return shownTags(n)
    .filter((t) => !t.inherited)
    .map((t) => ({ dimension: t.dimension, value: t.value }))
}

/** Every tag a box shows, the inherited ones marked — what the inspector lists. */
export function shownTags(n: Node | undefined): Tag[] {
  const d = n?.data as ({ tags?: Tag[] } & BoxData) | undefined
  if (!d) return []
  const tags = d.uids?.length ? (d.tags ?? []) : (d.pendingTags ?? d.tags ?? [])
  return tags.map((t) => ({
    dimension: t.dimension,
    value: t.value,
    ...(t.inherited ? { inherited: true } : {})
  }))
}

/** Tags as a comparable key (order-free). */
export function tagKey(tags: Tag[]): string {
  return JSON.stringify(tags.map((t) => [t.dimension, t.value]).sort())
}

/** A fresh id for a copy of ``datasetId`` that is not connected yet. */
export function pendingCopyId(datasetId: string, existing: Iterable<string>): string {
  const taken = new Set(existing)
  let n = 1
  while (taken.has(`${datasetId}#new-${n}`)) n += 1
  return `${datasetId}#new-${n}`
}

/** The body of "add an input" for a line drawn from ``source`` into ``target``: a box hands its tags to the
 *  new input, so the line lands in the same box rather than in an untagged one. */
export function connectBody(
  source: string,
  target: string,
  amount: number,
  nodes: Node[]
): Record<string, unknown> {
  const [adb, acode] = splitId(target)
  const src = nodes.find((n) => n.id === source)
  const [idb, icode] = splitId((src?.data as BoxData | undefined)?.datasetId ?? source)
  const tags = isBox(src) ? boxTags(src) : []
  return {
    activity_database: adb,
    activity_code: acode,
    input_database: idb,
    input_code: icode,
    amount,
    type: 'technosphere',
    ...(tags.length ? { tags: Object.fromEntries(tags.map((t) => [t.dimension, t.value])) } : {})
  }
}

interface NextBox {
  id: string
  dataset_id?: string
  uids?: string[]
  tags?: Tag[]
}

/**
 * For every box of the incoming graph that is not on the canvas yet, the id of the canvas box it replaces:
 * the one that shared the most inputs with it, else (a process that became a reference) the node of the
 * same dataset that is no longer there. Matched by what is on the canvas NOW — a position remembered from
 * an earlier visit of the same id must not stop the box from taking the place, group and colour it has
 * today. Copies the user placed are never matched: they keep their own id (see {@link applyManualBoxes}).
 * Returns ``newId → oldId``.
 */
export function reconcileBoxes(current: Node[], next: NextBox[]): Map<string, string> {
  const nextIds = new Set(next.map((b) => b.id))
  const onCanvas = new Set(current.map((n) => n.id))
  const taken = new Set<string>()
  const out = new Map<string, string>()
  const before = current.filter((n) => !nextIds.has(n.id) && !isCopyId(n.id))
  for (const box of next) {
    if (onCanvas.has(box.id)) continue
    const uids = new Set(box.uids ?? [])
    let best: { id: string; overlap: number } | null = null
    for (const n of before) {
      if (taken.has(n.id)) continue
      const own = ((n.data as BoxData).uids ?? []).filter((u) => uids.has(u)).length
      if (own > 0 && (!best || own > best.overlap)) best = { id: n.id, overlap: own }
    }
    const dataset = box.dataset_id ?? datasetIdOf(box.id)
    const fallback = best
      ? null
      : before.find(
          (n) =>
            !taken.has(n.id) &&
            (n.id === dataset || datasetIdOf(n.id) === dataset) &&
            !(n.data as BoxData).uids?.length
        )
    const from = best?.id ?? fallback?.id
    if (from) {
      out.set(box.id, from)
      taken.add(from)
    }
  }
  return out
}

/** Whether ``id`` names a box of ``dataset`` itself — the dataset id, or it plus the hash of its tags — as
 *  opposed to a copy or a node under an expanded box, which carry a suffix after `#` of their own. */
function isBoxIdOf(id: string, dataset: string): boolean {
  return (
    id === dataset || (id.startsWith(`${dataset}#`) && /^[0-9a-f]{12}$/.test(id.slice(dataset.length + 1)))
  )
}

/**
 * For every box of the incoming graph without a stored spot of its own, the stored id of the same dataset
 * whose spot it takes over. A box changes its id with the tags in effect for it, and when that happened while
 * the model was not on the canvas — the assistant or an MCP client tagged a process, two values were merged —
 * there are no boxes on screen to match it to by its inputs ({@link reconcileBoxes}), only the stored
 * arrangement. Only ids no box of the graph still uses, one per box, in the graph's order. Returns
 * ``newId → oldId``.
 */
export function placeByDataset(next: NextBox[], stored: Record<string, unknown>): Map<string, string> {
  const ids = new Set(next.map((b) => b.id))
  const free = new Map<string, string[]>()
  for (const id of Object.keys(stored)) {
    const dataset = datasetIdOf(id)
    if (ids.has(id) || !isBoxIdOf(id, dataset)) continue
    free.set(dataset, [...(free.get(dataset) ?? []), id])
  }
  const out = new Map<string, string>()
  for (const box of next) {
    if (box.id in stored || isCopyId(box.id)) continue
    const old = free.get(box.dataset_id ?? datasetIdOf(box.id))?.shift()
    if (old) out.set(box.id, old)
  }
  return out
}

/** Sankey share of a box: the exact impact of its inputs (``meta.inputs``, by uid) over the total. */
export function boxShare(
  n: Node,
  inputs: Record<string, number> | undefined,
  total: number
): number | undefined {
  const uids = (n.data as BoxData).uids
  if (!uids?.length || !inputs || !total) return undefined
  const sum = uids.reduce((s, u) => s + (inputs[u] ?? 0), 0)
  return sum / total
}

/** What a contribution answer's `meta` says, as far as the canvas overlay reads it. */
export interface CalcMeta {
  total: number
  unit: string
  method: string[]
  n_nodes: number
  /** Exact impact per direct input from outside the model, by exchange uid. */
  inputs?: Record<string, number>
}

/** The Sankey share of a node: a box from its own inputs, anything else from the tree. */
export function shareFor(n: Node, shares: Record<string, number>, meta: CalcMeta): number | undefined {
  return boxShare(n, meta.inputs, meta.total) ?? shares[n.id]
}

/** The Sankey share of an arrow: an input from outside the model by its own exact impact. */
export function edgeShareFor(
  e: { source: string; data?: unknown },
  shares: Record<string, number>,
  meta: CalcMeta
): number | undefined {
  const uid = (e.data as { uid?: string } | undefined)?.uid
  const own = uid && meta.inputs && meta.total ? meta.inputs[uid] : undefined
  return own !== undefined && meta.total ? own / meta.total : shares[e.source]
}

/** The current node that shares the most inputs with ``box`` (present or not), for placing a box that split
 *  off it. */
export function nearestBox(current: Node[], box: NextBox): string | null {
  const uids = new Set(box.uids ?? [])
  let best: { id: string; overlap: number } | null = null
  for (const n of current) {
    const own = ((n.data as BoxData).uids ?? []).filter((u) => uids.has(u)).length
    if (own > 0 && (!best || own > best.overlap)) best = { id: n.id, overlap: own }
  }
  return best?.id ?? null
}

/**
 * Copies the user put on the canvas and connected keep being boxes of their own: the view remembers which
 * inputs (uids) each one holds — `{ boxId: { dataset, uids } }`, the model view's `occurrences` section —
 * and every graph is adjusted to it before it is drawn. Without this a copy connected before it was tagged
 * would fall into the dataset's untagged box on the next reload, and a tag given to that box afterwards
 * would land on both processes' inputs at once.
 */
export type ManualBoxes = Record<string, { dataset: string; uids: string[] }>

/** Whether ``id`` names a copy the user placed (see {@link pendingCopyId}). */
export function isCopyId(id: string): boolean {
  return /#new-\d+$/.test(id)
}

/** ``graph`` with every remembered copy split out of the box the backend put its inputs in. A copy whose
 *  inputs now carry different tags keeps the largest group; one whose inputs are all gone is left out. */
export function applyManualBoxes<G extends { bg_nodes?: GraphBox[]; bg_edges?: GraphLink[] }>(
  graph: G,
  manual: ManualBoxes
): G {
  const ids = Object.keys(manual)
  if (!ids.length || !graph.bg_nodes?.length) return graph
  let nodes = graph.bg_nodes.map((n) => ({ ...n, uids: [...(n.uids ?? [])] }))
  const edges = (graph.bg_edges ?? []).map((e) => ({ ...e }))
  const claimed = new Set<string>()
  for (const id of ids) {
    const rec = manual[id]
    const byBox = new Map<string, string[]>()
    for (const n of nodes)
      if ((n.dataset_id ?? n.id) === rec.dataset && n.id !== id)
        for (const u of n.uids ?? [])
          if (rec.uids.includes(u) && !claimed.has(u)) byBox.set(n.id, [...(byBox.get(n.id) ?? []), u])
    const best = [...byBox.entries()].sort((a, b) => b[1].length - a[1].length)[0]
    if (!best) continue
    const [from, uids] = best
    const source = nodes.find((n) => n.id === from)!
    uids.forEach((u) => claimed.add(u))
    nodes = nodes
      .map((n) => (n.id === from ? { ...n, uids: (n.uids ?? []).filter((u) => !uids.includes(u)) } : n))
      .filter((n) => n.id !== from || n.uids.length > 0)
    nodes.push({ ...source, id, uids })
    for (const e of edges) if (e.uid && uids.includes(e.uid)) e.source = id
  }
  // A box's tag is its own when one of its inputs holds it; split in two, each half answers for itself — a
  // copy holding only inputs that inherit must not hand that value on as if it were theirs.
  const own = new Map(edges.map((e) => [e.uid, new Set((e.tags ?? []).map((t) => t.dimension))]))
  nodes = nodes.map((n) => ({
    ...n,
    tags: n.tags?.map((t) =>
      (n.uids ?? []).some((u) => own.get(u)?.has(t.dimension))
        ? { dimension: t.dimension, value: t.value }
        : { dimension: t.dimension, value: t.value, inherited: true }
    )
  }))
  return { ...graph, bg_nodes: nodes, bg_edges: edges }
}

/** The copy ``source`` now also holds the input ``uid`` — a line was drawn from it. */
export function noteCopyInput(
  manual: ManualBoxes,
  source: Node | undefined,
  uid: string | undefined
): ManualBoxes {
  if (!source || !uid || !isCopyId(source.id)) return manual
  const dataset = (source.data as BoxData).datasetId ?? datasetIdOf(source.id)
  const uids = manual[source.id]?.uids ?? []
  return uids.includes(uid) ? manual : { ...manual, [source.id]: { dataset, uids: [...uids, uid] } }
}

/** Remembered copies that still hold at least one live input. */
export function pruneManualBoxes(manual: ManualBoxes, live: Set<string>): ManualBoxes {
  return Object.fromEntries(Object.entries(manual).filter(([, rec]) => rec.uids.some((u) => live.has(u))))
}

interface GraphBox {
  id: string
  dataset_id?: string
  uids?: string[]
  tags?: Tag[]
}

interface GraphLink {
  uid: string
  source: string
  /** The input's own tags. */
  tags?: Tag[]
}

/** The nodes an expand revealed under ``id``, all the way up — what goes when the box is replaced. */
export function revealedUnder(
  id: string,
  nodes: Node[],
  edges: { source: string; target: string }[]
): Set<string> {
  const revealed = new Set(nodes.filter((n) => (n.data as { revealed?: boolean }).revealed).map((n) => n.id))
  const gone = new Set<string>()
  const walk = (target: string): void => {
    for (const e of edges)
      if (e.target === target && revealed.has(e.source) && !gone.has(e.source)) {
        gone.add(e.source)
        walk(e.source)
      }
  }
  walk(id)
  return gone
}
