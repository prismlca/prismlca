/**
 * The boxes of outside datasets that the user places or converts: dropping a reference onto the canvas,
 * Localize (a box becomes an editable process of the model) and the move of a process into the library
 * (a process becomes a box). These change what a box IS; useCanvasModel owns where boxes are and how they are
 * kept — every action here hands the node's position, colour and group membership to its new id
 * (useBoxes' handOver) and ends in a graph reload, whose reconciliation (lib/occurrences.ts) carries them
 * on from there, and back again when the change is undone.
 *
 * A dataset may stand on the canvas several times, one box per tag combination its inputs carry. Dropping
 * a dataset that is already there therefore adds a SECOND box: a copy that is not connected yet, may carry
 * tags of its own, and hands them to the first input drawn from it.
 */
import { useCallback, type MutableRefObject } from 'react'
import type { Edge, Node } from '@xyflow/react'

import { api } from '../lib/api'
import { splitId } from '../lib/canvas'
import type { BoxData } from '../lib/occurrences'
import { boxTags, pendingCopyId, revealedUnder } from '../lib/occurrences'
import type { SearchHit } from '../lib/search'

export interface ReferenceDeps {
  run: (fn: () => Promise<void>) => Promise<void>
  activeDb: string | null
  nodesRef: MutableRefObject<Node[]>
  edgesRef: MutableRefObject<Edge[]>
  posRef: MutableRefObject<Record<string, { x: number; y: number }>>
  setNodes: (update: Node[] | ((nodes: Node[]) => Node[])) => void
  setEdges: (update: Edge[] | ((edges: Edge[]) => Edge[])) => void
  /** The card data of a node (useCanvasModel's nodeData), so a placed box carries the same callbacks. */
  nodeData: (n: {
    name: string
    product?: string | null
    location: string | null
    unit: string | null
    external: boolean
    read_only?: boolean
    upstream?: number
    id: string
    tags?: { dimension: string; value: string }[]
    dataset_id?: string
    uids?: string[]
    pending_tags?: { dimension: string; value: string }[]
  }) => Record<string, unknown>
  /** Give the node's spot, colour and group box to the id it becomes (useBoxes). */
  handOver: (from: string, to: string) => void
  reloadGraph: (db: string) => Promise<unknown>
  reloadAudit: () => Promise<void>
}

export function useReferences(deps: ReferenceDeps) {
  const {
    run,
    activeDb,
    nodesRef,
    edgesRef,
    posRef,
    setNodes,
    setEdges,
    nodeData,
    handOver,
    reloadGraph,
    reloadAudit
  } = deps

  // Bring a dataset onto the canvas as a LOCKED reference (no copy, no data change). Editable only after
  // "Localize" (right-click). Upstream count is unknown until expanded (-1).
  const addReference = useCallback(
    (h: SearchHit, pos?: { x: number; y: number }): void => {
      const dataset = `${h.database}/${h.code}`
      const ids = nodesRef.current.map((n) => n.id)
      // Already there: a second box, so it can serve another process under another tag.
      const id = ids.includes(dataset) ? pendingCopyId(dataset, ids) : dataset
      const n = nodesRef.current.length
      const p = pos ?? { x: 110 + (n % 6) * 36, y: 90 + (n % 6) * 36 }
      posRef.current[id] = p
      setNodes((ns) => [
        ...ns,
        {
          id,
          type: 'prism',
          position: p,
          selected: true,
          data: nodeData({
            id,
            name: h.name,
            product: h.product ?? null,
            location: h.geography,
            unit: h.unit ?? null,
            external: true,
            read_only: true,
            upstream: -1,
            dataset_id: dataset,
            uids: [],
            pending_tags: []
          })
        }
      ])
    },
    [nodesRef, posRef, setNodes, nodeData]
  )

  /** Forget the boxes an expand revealed under ``id`` — they belonged to the reference, not to what
   *  replaces it, and the reload brings the new process's real inputs. */
  const dropRevealedUnder = (id: string): void => {
    const gone = revealedUnder(id, nodesRef.current, edgesRef.current)
    if (!gone.size) return
    gone.forEach((g) => delete posRef.current[g])
    nodesRef.current = nodesRef.current.filter((n) => !gone.has(n.id))
    edgesRef.current = edgesRef.current.filter((e) => !gone.has(e.source) && !gone.has(e.target))
    setNodes(nodesRef.current)
    setEdges(edgesRef.current)
  }

  // Localize boxes: copy each one's dataset into the model (editable) and point THAT box's inputs at the copy.
  // Other boxes of the same dataset keep drawing on the original. Their common tags become the copy's own.
  // Several at once (the node menu on a selection) are one step each, under one reload.
  const localize = useCallback(
    (ids: string[]): void => {
      void run(async () => {
        if (!activeDb) return
        try {
          for (const id of ids) {
            const box = nodesRef.current.find((n) => n.id === id)
            if (!box) continue // went with a box localized before it (it was revealed under that one)
            const [db, code] = splitId(id)
            const data = box.data as BoxData
            const res = await api<{ activity: { code: string } }>('POST', '/api/v1/model/activities/copy', {
              source_database: db,
              source_code: code,
              target_database: activeDb,
              // The model's inputs must follow the box, or the canvas shows a supply the calculation does not
              // use — this box's inputs only; a copy that was never connected moves none (uids: []).
              relink_consumers: true,
              ...(data.datasetId ? { uids: data.uids ?? [] } : {})
            })
            const newId = `${activeDb}/${res.activity.code}`
            // An unconnected copy's tags were meant for its inputs; the process it became carries them now.
            if (data.datasetId && !data.uids?.length)
              for (const t of boxTags(box))
                await api('POST', '/api/v1/model/tags/set', {
                  keys: [{ database: activeDb, code: res.activity.code }],
                  group: t.dimension,
                  value: t.value
                })
            handOver(id, newId)
            dropRevealedUnder(id)
            nodesRef.current = nodesRef.current.filter((n) => n.id !== id)
          }
        } finally {
          // Also after a failure part-way: the copies made so far are on the model, and the canvas must say so.
          await reloadGraph(activeDb)
          await reloadAudit()
        }
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run, activeDb, handOver, reloadGraph, reloadAudit]
  )

  /**
   * The inverse of :func:`localize`: the process leaves the model for the library, and the node becomes a
   * box of it — locked here, editable there, and shared with every other study. Its tags move onto the
   * inputs that draw on it (the library carries none), which may give the box a tag id after the reload;
   * renaming the node first lets the reconciliation hand it the old place.
   */
  const toLibrary = useCallback(
    (id: string): void => {
      void run(async () => {
        const [db, code] = splitId(id)
        const res = await api<{ database: string; code: string }>(
          'POST',
          '/api/v1/model/activities/to-library',
          {
            database: db,
            code
          }
        )
        const newId = `${res.database}/${res.code}`
        handOver(id, newId)
        nodesRef.current = nodesRef.current.map((n) =>
          n.id === id ? { ...n, id: newId, data: { ...n.data, readOnly: true, uids: [] } } : n
        )
        edgesRef.current = edgesRef.current.map((e) => ({
          ...e,
          source: e.source === id ? newId : e.source,
          target: e.target === id ? newId : e.target
        }))
        if (activeDb) await reloadGraph(activeDb)
        await reloadAudit()
      })
    },
    [run, activeDb, nodesRef, edgesRef, handOver, reloadGraph, reloadAudit]
  )

  return { addReference, localize, toLibrary }
}
