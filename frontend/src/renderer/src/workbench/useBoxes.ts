/**
 * The bookkeeping of boxes per occurrence on the canvas (lib/occurrences.ts): which inputs each copy the
 * user placed holds, and what keyed by a node's id — position, colour, group membership — goes with it when
 * the id changes (its tags changed, it was localized or moved to the library, or one of those was undone)
 * and when it leaves the canvas and comes back (a delete undone, see goneBoxes.ts). useCanvasModel calls in
 * before every graph it draws, when a line has been drawn and before a delete; the rules themselves are pure
 * functions in lib/occurrences.ts and goneBoxes.ts.
 */
import { useCallback, useRef, type MutableRefObject } from 'react'
import type { Edge, Node } from '@xyflow/react'

import type { Graph } from '../lib/api'
import { renameMember, type NodeGroup } from '../lib/groups'
import { viewSet, workspaceGeneration } from '../lib/modelView'
import { rejoinGroup, rememberGone, stashGone, takeGone, type GoneBoxes } from './goneBoxes'
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
  // What left each model's canvas (goneBoxes.ts), per workspace and model: model names repeat across
  // workspaces, and a box's id names its dataset, which other models use as well.
  const goneRef = useRef<Record<string, GoneBoxes>>({})
  const goneOf = useCallback(
    (db: string | null): GoneBoxes => (goneRef.current[`${workspaceGeneration()}\u0000${db ?? ''}`] ??= {}),
    []
  )

  /** What the node ``from`` had goes to ``to``: its stored spot (an unarranged canvas stays unarranged), its
   *  colour and its place in a group box. */
  const carry = useCallback(
    (from: string, to: string) => {
      if (posRef.current[from]) posRef.current[to] = posRef.current[from]
      if (colorsRef.current[from]) setColorRef.current(to, colorsRef.current[from])
      const regrouped = renameMember(groupsRef.current, from, to)
      if (regrouped !== groupsRef.current) putGroups(regrouped)
    },
    [posRef, colorsRef, setColorRef, groupsRef, putGroups]
  )

  /** A node that becomes another one (Localize, the move to the library): {@link carry}, and the old id
   *  keeps nothing — should its dataset be dragged in again, that box starts plain. */
  const handOver = useCallback(
    (from: string, to: string) => {
      carry(from, to)
      delete posRef.current[from]
      if (colorsRef.current[from]) setColorRef.current(from, '')
    },
    [carry, posRef, colorsRef, setColorRef]
  )

  /** Before a delete path clears them: what each node it removes takes along, for an Undo to bring back. */
  const stash = useCallback(
    (ids: Iterable<string>) =>
      stashGone(ids, nodesRef.current, colorsRef.current, groupsRef.current, goneOf(activeDbRef.current)),
    [nodesRef, colorsRef, groupsRef, activeDbRef, goneOf]
  )

  /** The graph as the canvas draws it: copies split out, and the ids of revealed nodes that went with a
   *  box that changed its id (the new box starts folded). Carries position, colour and group across — to
   *  a node under a new id, and to one coming back under its old id. */
  const prepareGraph = useCallback(
    (g: Graph): { graph: Graph; dropped: Set<string> } => {
      const graph = applyManualBoxes(g, manualRef.current)
      const boxes = graph.bg_nodes ?? []
      const dropped = new Set<string>()
      // The processes too, by the inputs that draw on them: a box that was localized comes back as one.
      const processes = graph.nodes.map((n) => ({
        id: n.id,
        process: true,
        uids: graph.edges.filter((e) => e.source === n.id && e.uid).map((e) => e.uid)
      }))
      const moved = reconcileBoxes(nodesRef.current, [...boxes, ...processes], edgesRef.current)
      // A model being opened has no boxes on screen to match against: the stored arrangement stands in.
      if (!nodesRef.current.length)
        for (const [to, from] of placeByDataset(boxes, posRef.current)) moved.set(to, from)
      for (const [to, from] of moved) {
        carry(from, to)
        revealedUnder(from, nodesRef.current, edgesRef.current).forEach((id) => dropped.add(id))
      }
      // A node leaving with this graph keeps its spot; one coming back under its old id (Undo) gets it again,
      // and the colour and group box a delete took from it.
      const arriving = [...graph.nodes, ...boxes]
      const gone = goneOf(graph.database)
      rememberGone(nodesRef.current, new Set(arriving.map((n) => n.id)), gone)
      for (const { id, uids } of arriving) {
        const back = posRef.current[id] || moved.has(id) ? undefined : takeGone(id, gone, uids)
        if (!back) continue
        posRef.current[id] = back.pos
        if (back.color && !colorsRef.current[id]) setColorRef.current(id, back.color)
        if (back.group) {
          const regrouped = rejoinGroup(groupsRef.current, id, back.group)
          if (regrouped !== groupsRef.current) putGroups(regrouped)
        }
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
    [nodesRef, edgesRef, posRef, colorsRef, setColorRef, groupsRef, putGroups, carry, goneOf]
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

  return { prepareGraph, carry, handOver, stash, noteConnected, loadBoxes, saveBoxes }
}
