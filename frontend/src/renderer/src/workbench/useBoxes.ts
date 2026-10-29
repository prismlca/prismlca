/**
 * The bookkeeping of boxes per occurrence on the canvas (lib/occurrences.ts): which inputs each copy the
 * user placed holds, and what keyed by a box's id — position, colour, group membership — goes with it when
 * the box changes id because its tags changed. useCanvasModel calls in before every graph it draws and
 * when a line has been drawn; the rules themselves are pure functions in lib/occurrences.ts.
 */
import { useCallback, useRef, type MutableRefObject } from 'react'
import type { Edge, Node } from '@xyflow/react'

import type { Graph } from '../lib/api'
import { renameMember, type NodeGroup } from '../lib/groups'
import { viewSet } from '../lib/modelView'
import {
  applyManualBoxes,
  nearestBox,
  noteCopyInput,
  placeByDataset,
  pruneManualBoxes,
  reconcileBoxes,
  revealedUnder,
  type BoxData,
  type ManualBoxes
} from '../lib/occurrences'

export interface BoxDeps {
  nodesRef: MutableRefObject<Node[]>
  edgesRef: MutableRefObject<Edge[]>
  posRef: MutableRefObject<Record<string, { x: number; y: number }>>
  colorsRef: MutableRefObject<Record<string, string>>
  setColorRef: MutableRefObject<(id: string, color: string) => void>
  groupsRef: MutableRefObject<NodeGroup[]>
  putGroups: (groups: NodeGroup[]) => void
  activeDbRef: MutableRefObject<string | null>
}

export function useBoxes(deps: BoxDeps) {
  const { nodesRef, edgesRef, posRef, colorsRef, setColorRef, groupsRef, putGroups, activeDbRef } = deps
  // Copies the user connected, by the inputs they hold — view state like the groups, section `occurrences`.
  const manualRef = useRef<ManualBoxes>({})

  /** The graph as the canvas draws it: copies split out, and the ids of revealed nodes that went with a
   *  box that changed its id (the new box starts folded). Carries position, colour and group across. */
  const prepareGraph = useCallback(
    (g: Graph): { graph: Graph; dropped: Set<string> } => {
      const graph = applyManualBoxes(g, manualRef.current)
      const boxes = graph.bg_nodes ?? []
      const dropped = new Set<string>()
      const moved = reconcileBoxes(nodesRef.current, boxes)
      // A model being opened has no boxes on screen to match against: the stored arrangement stands in.
      if (!nodesRef.current.length)
        for (const [to, from] of placeByDataset(boxes, posRef.current)) moved.set(to, from)
      for (const [to, from] of moved) {
        if (posRef.current[from]) posRef.current[to] = posRef.current[from]
        if (colorsRef.current[from]) setColorRef.current(to, colorsRef.current[from])
        const regrouped = renameMember(groupsRef.current, from, to)
        if (regrouped !== groupsRef.current) putGroups(regrouped)
        revealedUnder(from, nodesRef.current, edgesRef.current).forEach((id) => dropped.add(id))
      }
      // A box split off another one (an input tagged on its own) lands beside the box it came from.
      for (const box of boxes)
        if (!posRef.current[box.id]) {
          const near = nearestBox(nodesRef.current, box)
          if (near && posRef.current[near])
            posRef.current[box.id] = { x: posRef.current[near].x + 30, y: posRef.current[near].y + 70 }
        }
      return { graph, dropped }
    },
    [nodesRef, edgesRef, posRef, colorsRef, setColorRef, groupsRef, putGroups]
  )

  /** A line was drawn from ``source`` and became the input ``uid``: a copy keeps it as its own. */
  const noteConnected = useCallback(
    (source: string, uid: string | undefined) => {
      const next = noteCopyInput(
        manualRef.current,
        nodesRef.current.find((n) => n.id === source),
        uid
      )
      if (next === manualRef.current) return
      manualRef.current = next
      if (activeDbRef.current) viewSet(activeDbRef.current, 'occurrences', next)
    },
    [nodesRef, activeDbRef]
  )

  /** The remembered copies of the model being opened (from the cached or the stored view). */
  const loadBoxes = useCallback((view: { [section: string]: unknown }) => {
    manualRef.current = (view.occurrences as ManualBoxes | undefined) ?? {}
  }, [])

  /** Forget copies none of whose inputs is still on the canvas. */
  const saveBoxes = useCallback(
    (db: string) => {
      const live = new Set(nodesRef.current.flatMap((n) => (n.data as BoxData).uids ?? []))
      const kept = pruneManualBoxes(manualRef.current, live)
      if (Object.keys(kept).length === Object.keys(manualRef.current).length) return
      manualRef.current = kept
      viewSet(db, 'occurrences', kept)
    },
    [nodesRef]
  )

  return { prepareGraph, noteConnected, loadBoxes, saveBoxes }
}
