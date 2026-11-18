/**
 * The contribution tree's `meta`, worded for a model to read.
 *
 * The engine hands back the exact impact of every input the model draws from outside itself as
 * `meta.inputs: {exchange uid: impact}` — what the canvas needs to colour its boxes, and a list of ids a model
 * cannot place: one run added shares up by hand from the tree rows, another ignored the field. Here the uids are
 * named through the model graph (which process takes the input, which dataset it is) and sorted by size.
 * `meta.direct` and `meta.upstream` are the tree's split at the root — whatever the opened tree leaves with the
 * root, not anybody's emissions — while `calculate`'s `direct_split` means the activity's own emissions and
 * `meta.foreground_direct` the foreground's own; the tree's figure is passed on as `tree_remainder`, so the one
 * word does not stand for three things in one answer.
 */
import type { ToolCtx } from './context'

export interface ForegroundInput {
  /** The model's process that takes the input. */
  process: string
  /** The dataset it draws on. */
  input: string
  geo?: string
  impact: number
  share: number
}

interface GraphNode {
  id: string
  name?: string
  location?: string
}

interface Graph {
  nodes?: GraphNode[]
  bg_nodes?: GraphNode[]
  bg_edges?: Array<{ uid?: string | null; source: string; target: string }>
}

/** `meta.inputs` as named rows, largest first; undefined when there is nothing to name or the graph cannot
 * be read (then the reply simply goes without them — the tree rows still stand). */
export async function foregroundInputs(
  ctx: ToolCtx,
  database: string,
  meta: { inputs?: Record<string, number>; total?: number } | undefined
): Promise<ForegroundInput[] | undefined> {
  const raw = meta?.inputs
  if (!raw || !database || !Object.keys(raw).length) return undefined
  let graph: Graph
  try {
    graph = await ctx.api('GET', `/api/v1/model/graph/${encodeURIComponent(database)}`)
  } catch {
    return undefined
  }
  const byId = new Map<string, GraphNode>()
  for (const n of [...(graph?.nodes ?? []), ...(graph?.bg_nodes ?? [])]) byId.set(n.id, n)
  const byUid = new Map<string, { source: string; target: string }>()
  for (const e of graph?.bg_edges ?? []) if (e.uid) byUid.set(e.uid, e)
  const total = Number(meta?.total) || 0
  const rows: ForegroundInput[] = []
  for (const [uid, value] of Object.entries(raw)) {
    const impact = Number(value) || 0
    const edge = byUid.get(uid)
    const source = edge ? byId.get(edge.source) : undefined
    rows.push({
      process: (edge && byId.get(edge.target)?.name) || '(a process of the model)',
      input: source?.name || `(exchange ${uid})`,
      ...(source?.location ? { geo: source.location } : {}),
      impact,
      share: total ? impact / total : 0
    })
  }
  rows.sort((x, y) => Math.abs(y.impact) - Math.abs(x.impact))
  return rows
}

/** The tree's `meta` with the uid map replaced by the largest `limit` named rows (and how many were left
 * out) and the root split under its own name. */
export function readableMeta(meta: any, rows: ForegroundInput[] | undefined, limit: number): any {
  if (!meta || typeof meta !== 'object') return meta
  const { inputs: _inputs, direct, upstream: _upstream, ...rest } = meta
  void _inputs
  void _upstream
  const shown = rows?.slice(0, limit) ?? []
  return {
    ...rest,
    ...(direct !== undefined ? { tree_remainder: direct } : {}),
    ...(shown.length ? { foreground_inputs: shown } : {}),
    ...(rows && rows.length > shown.length
      ? { foreground_inputs_cut: `The ${shown.length} largest of ${rows.length} inputs; top_n shows more.` }
      : {})
  }
}

export const META_HOW_TO_READ =
  ' In "meta": "foreground_inputs" lists every input the model draws from outside itself — the process that ' +
  'takes it, the dataset, its exact impact and share, largest first; quote these for "which input carries how ' +
  'much". "foreground_direct" is the own emissions of the foreground processes the tree opened. ' +
  '"tree_remainder" is what the opened tree leaves with the root process — unopened suppliers included — not ' +
  'an emission of the model.'
