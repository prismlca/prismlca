/**
 * The canvas state machine of the Workbench: the React-Flow node/edge state, the ref mirrors that
 * let stable callbacks read live canvas state, the per-model view (positions, colours, groups), the
 * graph builders (full reload, expand, collapse), and every delete path. Extracted from
 * Workbench.tsx (wave 4.1, stage 7) — this is the one part that genuinely needs the mirrors:
 * callbacks handed into node data are created once per node and must not be rebuilt per render, so
 * they read through refs (`expandNodeRef`, `collapseRef`, `onTagRef`, `paintSelRef`, …).
 *
 * The hook OWNS canvas truth (nodes, edges, selection, colours, groups, positions). Everything else
 * — project lifecycle, tag menus, the AI handlers, the calculate overlay — consumes it through the
 * returned API and the exposed refs.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useEdgesState, useNodesState, type Edge, type Node } from '@xyflow/react'

import { api, ApiError, type Graph } from '../lib/api'
import { fetchQuery, invalidate, latestOnly } from '../lib/server/useQuery'
import { graphRoute } from '../lib/server/routes'
import { useIdListState } from '../lib/useIdListState'
import { flushViews, SAVE_NOW_EVENT, viewFetch, viewSet, viewSync } from '../lib/modelView'
import { ARROW_COLOR, arrowMarker, splitId } from '../lib/canvas'
import {
  addGroup,
  addToGroup,
  drawnGroups,
  nextGroupColor,
  nodeBoxes,
  pruneGroups,
  readGroups,
  recolorGroup,
  removeGroup,
  renameGroup,
  restack,
  type NodeGroup
} from '../lib/groups'
import { layoutWithDagre } from '../lib/layout'
import { getSettings, fmtSig } from '../lib/settings'
import { shortUnit } from '../lib/units'
import type { ConfirmSpec } from '../views/ConfirmDialog'
import type { BoxData } from '../lib/occurrences'
import { rememberGone, takeGone } from './goneBoxes'
import { useBoxes } from './useBoxes'
import { useNodeColors } from './useNodeColors'
import { useViewHistory } from './useViewHistory'
import { useReferences } from './useReferences'
import { blockedConsumers, inUseMessage } from './inUse'

/** What an arrow's source supplies for its label: the unit, and the product the arrow carries. */
type EdgeSource = { unit?: string | null; product?: string | null } | undefined

// Canvas arrow label: the (rounded) exchange amount plus the input's reference-product unit.
const edgeLabelText = (amount: number, digits: number, unit?: string | null): string => {
  const n = fmtSig(amount, digits)
  const u = shortUnit(unit)
  return u ? `${n} ${u}` : n
}

export interface CanvasModelDeps {
  run: (fn: () => Promise<void>) => Promise<void>
  activeDb: string | null
  setConfirm: (spec: ConfirmSpec | null) => void
  setError: (msg: string | null) => void
  reloadAudit: () => Promise<void>
  /** Significant digits for the arrow labels (Settings → rounding). */
  edgeDigits: number
}

// The return type is the API surface; spelling it out here would be a second copy of every
// signature below, kept in step by hand.
export function useCanvasModel(deps: CanvasModelDeps) {
  const { run, activeDb, setConfirm, setError, reloadAudit, edgeDigits } = deps
  const [nodes, setNodes, onNodesChange] = useNodesState([] as Node[])
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[])
  const [selected, setSelected] = useIdListState()
  // Which model the colour writers should write to. A ref, not the state: `setNodeColor` is passed
  // down through refs and must not be rebuilt whenever the active model changes.
  const activeDbRef = useRef<string | null>(null)
  // The previously open model — so its canvas can be saved before the incoming one loads.
  const prevDbRef = useRef<string | null>(null)
  // Group boxes. View state exactly like the node colours (workbench/useNodeColors.ts) — a group says nothing about the LCA — so
  // they live in the model's view under their own `groups` section (see lib/groups.ts).
  const [groups, setGroups] = useState<NodeGroup[]>([])
  // The selected box, kept apart from `selected` on purpose: every existing consumer of the node
  // selection (delete, paint, tag, calculate, the right-hand panel) would have to learn about group
  // ids otherwise, and one that forgot would treat a box as a process.
  const [selGroup, setSelGroup] = useState<string | null>(null)
  // The box whose name is being typed. Up here rather than inside the strip so the box's own context
  // menu can start the edit as well — the strip's text is discoverable once you know it is clickable.
  const [editGroup, setEditGroup] = useState<string | null>(null)
  // The colour picker for a box, positioned in SCREEN pixels. It cannot live on the box: the box is
  // drawn inside React Flow's viewport, so a popover parented to it would be zoomed with the canvas
  // and, at a negative z-index, could never come out in front of the process cards.
  const [groupPicker, setGroupPicker] = useState<{ right: number; top: number; id: string } | null>(null)
  const groupsRef = useRef<NodeGroup[]>([])
  // Held in a ref because the delete paths are memoised on other things and must not be rebuilt
  // every time a group changes.
  const dropGroupsRef = useRef<(ids: string[]) => void>(() => {})
  const posRef = useRef<Record<string, { x: number; y: number }>>({})
  const goneRef = useRef<Record<string, { x: number; y: number }>>({}) // see goneBoxes.ts
  // Live mirror of the canvas so buildGraph() can preserve frontend-only nodes
  // (locked ecoinvent references + expanded background tiers) across reloads.
  const nodesRef = useRef<Node[]>([])
  const edgesRef = useRef<Edge[]>([])
  const selectedRef = useRef<string[]>([])
  const lastSelRef = useRef<string[]>([]) // latest box selection (for the paint brush)
  const expandNodeRef = useRef<(id: string) => void>(() => {})
  const collapseRef = useRef<(id: string) => void>(() => {})
  const tagColorRef = useRef<Map<string, string>>(new Map()) // group name → colour, for node chips
  const hlTagRef = useRef<{ dimension: string; value: string } | null>(null)
  const onTagRef = useRef<(id: string, x: number, y: number) => void>(() => {})
  const rfRef = useRef<{
    screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number }
    fitView: (opts?: { padding?: number; duration?: number; nodes?: { id: string }[] }) => void
    getNodes: () => Node[]
    getNode?: (id: string) => Node | undefined
    setCenter?: (x: number, y: number, opts?: { zoom?: number; duration?: number }) => void
  } | null>(null)
  const fitSoon = (): void => {
    requestAnimationFrame(() =>
      setTimeout(() => rfRef.current?.fitView({ padding: 0.2, duration: 400 }), 120)
    )
  }
  useEffect(() => {
    nodesRef.current = nodes
    edgesRef.current = edges
  }, [nodes, edges])
  useEffect(() => {
    selectedRef.current = selected
  }, [selected])

  // The canvas's undo history notes a step before each change the user makes (useViewHistory below);
  // the writers above it reach it through this ref.
  const rememberRef = useRef<(label: string) => void>(() => {})
  // The model whose canvas has finished loading — the undo history waits while one loads (useViewHistory).
  const loadedRef = useRef<string | null>(null)
  // The colour refs live here, beside the canvas's other refs, and useNodeColors keeps them current: the
  // delete paths and the node data read them from callbacks memoised on other things.
  const colorsRef = useRef<Record<string, string>>({})
  const setColorRef = useRef<(id: string, color: string) => void>(() => {})
  const paintSelRef = useRef<(id: string, color: string) => void>(() => {})
  const { nodeColors, setNodeColors, setNodeColor, replaceColors, resetColors, paintNodes } = useNodeColors({
    ...{ activeDbRef, selectedRef, setNodes, rememberRef },
    ...{ colorsRef, setColorRef, paintSelRef }
  })

  // One writer for the section, like the colour writers: state, mirror and the model's view in one place,
  // so the canvas can never draw a list that is not the one being persisted. With a label, the change is
  // the user's and a step of the undo history; without, it follows from something else that is.
  const putGroups = useCallback((next: NodeGroup[], label?: string) => {
    if (label) rememberRef.current(label)
    groupsRef.current = next
    setGroups(next)
    if (activeDbRef.current) viewSet(activeDbRef.current, 'groups', next)
  }, [])
  const history = useViewHistory({
    activeDbRef,
    nodesRef,
    setNodes,
    posRef,
    colorsRef,
    replaceColors,
    groupsRef,
    putGroups,
    loadedRef
  })
  rememberRef.current = history.remember
  const { begin: beginDrag, end: endDrag, remember: rememberStep } = history

  /**
   * Box the given processes (default: the current selection) and select the new box.
   *
   * Nobody is asked for a colour on the way in — neither route ever was worth a question, since the
   * colour carries no meaning and the next unused one is always a fine answer. It is changed
   * afterwards from the dot on the box's own strip.
   */
  const groupSelection = useCallback(
    (ids?: string[]) => {
      const next = addGroup(groupsRef.current, ids ?? selectedRef.current, nextGroupColor(groupsRef.current))
      if (next === groupsRef.current) return // fewer than two members is not a group
      putGroups(next, 'Group processes')
      // The box is now the thing you are looking at; leaving the members selected would have the
      // Group button offering to group the same processes a second time.
      setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)))
      setSelected([])
      setSelGroup(next[next.length - 1].id)
    },
    [putGroups, setNodes, setSelected]
  )

  const ungroup = useCallback(
    (id: string) => {
      // Only the box goes. Nothing here touches a process, which is the whole contract of ungroup.
      putGroups(removeGroup(groupsRef.current, id), 'Ungroup')
      setSelGroup((cur) => (cur === id ? null : cur))
    },
    [putGroups]
  )

  /** Put the selection's non-members into an existing box (see `addTarget` for when this is offered). */
  const addSelectionToGroup = useCallback(
    (id: string) => {
      const next = addToGroup(groupsRef.current, id, selectedRef.current)
      if (next === groupsRef.current) return
      putGroups(next, 'Add to group')
      // Same reason as grouping: the box is now the subject, and leaving the processes selected would
      // have the toolbar offering to add them a second time.
      setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)))
      setSelected([])
      setSelGroup(id)
    },
    [putGroups, setNodes, setSelected]
  )

  const renameGroupTo = useCallback(
    (id: string, label: string) => putGroups(renameGroup(groupsRef.current, id, label), 'Rename group'),
    [putGroups]
  )

  /** Bring one box forward / send it backward, against the order currently on screen. */
  const restackGroup = useCallback(
    (id: string, step: 1 | -1) => {
      const order = drawnGroups(groupsRef.current, nodeBoxes(nodesRef.current)).map((e) => e.group.id)
      const next = restack(groupsRef.current, order, id, step)
      if (next !== groupsRef.current) putGroups(next, 'Restack group')
    },
    [putGroups]
  )

  const selectGroup = useCallback(
    (id: string | null) => {
      setSelGroup(id)
      setEditGroup(null)
      setGroupPicker(null)
      if (!id) return
      // A box and a process are different subjects: the right-hand panel, Delete, the tag menu and the
      // paint brush all read the node selection, so picking a box has to leave it empty.
      setNodes((ns) => (ns.some((n) => n.selected) ? ns.map((n) => ({ ...n, selected: false })) : ns))
      setSelected([])
    },
    [setNodes, setSelected]
  )

  // Select exactly one process, in React Flow and in `selected` together. Only for a box already on the
  // canvas: React Flow reports its own selection back on every render, and an id it has no node for is
  // overwritten by that report at once.
  const selectOnly = useCallback(
    (id: string) => {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })))
      setSelected([id])
    },
    [setNodes, setSelected]
  )

  const paintGroup = useCallback(
    (id: string, color: string) => putGroups(recolorGroup(groupsRef.current, id, color), 'Recolour group'),
    [putGroups]
  )

  /**
   * Drag the box: the members move and the rectangle is re-derived from them, so there is no second
   * copy of the geometry to keep in step. Nested and overlapping groups follow for free — a box whose
   * members moved recomputes whether or not it was the one dragged.
   */
  const moveGroup = useCallback(
    (id: string, dx: number, dy: number) => {
      const g = groupsRef.current.find((x) => x.id === id)
      if (!g) return
      beginDrag(true) // the first move of the drag keeps the arrangement from before it
      const member = new Set(g.members)
      setNodes((ns) =>
        ns.map((n) =>
          member.has(n.id) ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n
        )
      )
    },
    [setNodes, beginDrag]
  )

  /** `posRef` is written once at the end of the drag, not per frame: the updater above must stay pure
   *  (StrictMode calls it twice in development, which would double every delta). */
  const moveGroupEnd = useCallback(
    (id: string) => {
      const g = groupsRef.current.find((x) => x.id === id)
      if (!g) return
      const member = new Set(g.members)
      for (const n of nodesRef.current) if (member.has(n.id)) posRef.current[n.id] = n.position
      endDrag('Move group')
    },
    [endDrag]
  )

  dropGroupsRef.current = (ids: string[]) => {
    const next = pruneGroups(groupsRef.current, ids)
    if (next === groupsRef.current) return
    putGroups(next)
    setSelGroup((cur) => (cur && next.some((g) => g.id === cur) ? cur : null))
    setEditGroup((cur) => (cur && next.some((g) => g.id === cur) ? cur : null))
    setGroupPicker((cur) => (cur && next.some((g) => g.id === cur.id) ? cur : null))
  }

  // Re-label the canvas arrows when the edge rounding setting changes.
  useEffect(() => {
    setEdges((es) =>
      es.map((e) => {
        const d = e.data as { amount?: number; unit?: string | null } | undefined
        const amt = d?.amount
        if (amt == null) return e
        return { ...e, label: edgeLabelText(amt, edgeDigits, d?.unit) }
      })
    )
  }, [edgeDigits, setEdges])

  /** The tag-group → colour map the node chips read (kept in step by the tag owner). */
  const setTagColors = useCallback((map: Map<string, string>) => {
    tagColorRef.current = map
  }, [])
  /** Temporarily highlight all nodes carrying the chosen tag (drives the .hl node class). */
  const applyHighlight = useCallback(
    (hlTag: { dimension: string; value: string } | null) => {
      hlTagRef.current = hlTag
      setNodes((ns) =>
        ns.map((n) => {
          const tags = (n.data as { tags?: { dimension: string; value: string }[] }).tags ?? []
          const on = !!hlTag && tags.some((t) => t.dimension === hlTag.dimension && t.value === hlTag.value)
          return on === !!(n.data as { highlight?: boolean }).highlight
            ? n
            : { ...n, data: { ...n.data, highlight: on } }
        })
      )
    },
    [setNodes]
  )

  // Arrow label: the exchange amount followed by the input's reference-product unit (e.g. "0.5 kg"), and
  // under it the product itself — drawn by `PrismEdge`, which also applies the two Settings switches.
  const edgeStyle = (uid: string | null, amount: number, type: string, src: EdgeSource): Edge => ({
    id: uid || `${amount}`,
    type: 'prism',
    source: '',
    target: '',
    label: edgeLabelText(amount, getSettings().round.edges, src?.unit),
    data: { uid, amount, type, unit: src?.unit ?? null, product: src?.product ?? null },
    zIndex: 20, // keep edges (and their amount labels) above the nodes
    labelShowBg: true,
    style: { stroke: ARROW_COLOR, strokeWidth: 1.6 },
    markerEnd: arrowMarker(1.6)
  })

  const nodeData = (n: {
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
  }): Record<string, unknown> => ({
    label: n.name,
    // A box of an outside dataset (lib/occurrences.ts): which dataset, which model inputs draw on it, and
    // the tags a copy not yet connected will hand to its first input. Boxes carry tags; other references do not.
    datasetId: n.dataset_id,
    uids: n.uids,
    pendingTags: n.pending_tags,
    taggable: !!n.uids?.length || !!n.pending_tags,
    product: n.product ?? null, // the flow an arrow out of this box carries (exchange dialogs)
    geo: n.location,
    unit: n.unit,
    external: n.external,
    readOnly: n.read_only ?? n.external,
    upstream: n.upstream ?? 0,
    expanded: false,
    color: colorsRef.current[n.id],
    tags: (n.tags ?? n.pending_tags ?? []).map((t) => ({
      ...t,
      color: tagColorRef.current.get(t.dimension) ?? 'var(--green)'
    })),
    highlight:
      !!hlTagRef.current &&
      (n.tags ?? []).some(
        (t) => t.dimension === hlTagRef.current!.dimension && t.value === hlTagRef.current!.value
      ),
    onColor: (c: string) => paintSelRef.current(n.id, c),
    onExpand: () => expandNodeRef.current(n.id),
    onCollapse: () => collapseRef.current(n.id),
    onTag: (x: number, y: number) => onTagRef.current(n.id, x, y)
  })

  // Boxes per occurrence: the copies the user connected, and what goes with a box that changes its id.
  const { prepareGraph, noteConnected, loadBoxes, saveBoxes } = useBoxes({
    nodesRef,
    edgesRef,
    posRef,
    colorsRef,
    setColorRef,
    groupsRef,
    putGroups,
    activeDbRef
  })

  const buildGraph = useCallback(
    (raw: Graph) => {
      // Until the canvas is arranged (a drag, Auto-layout, a saved view, a dropped reference) every reload
      // lays the whole graph out again. A spot carried over while preparing this graph — a box coming
      // back, a box split off another — is no arrangement: counted as one, it ended the layout in the
      // middle of an assistant's build and dropped every other node onto the fallback grid.
      const arranged = Object.keys(posRef.current).length > 0
      const current = new Map(nodesRef.current.map((n) => [n.id, n.position]))
      const { graph: g, dropped: connected } = prepareGraph(raw)
      const backendIds = new Set(g.nodes.map((n) => n.id))
      // A box leaving with this graph keeps its spot, a box coming back (Undo) gets it again.
      const present = new Set([...backendIds, ...(g.bg_nodes ?? []).map((n) => n.id)])
      rememberGone(nodesRef.current, present, goneRef.current)
      // A node with no stored spot stays where it stands; only a new one takes a fallback place.
      const spot = (id: string): { x: number; y: number } | undefined => {
        const back = posRef.current[id] ? undefined : takeGone(id, goneRef.current)
        if (back) posRef.current[id] = back
        return posRef.current[id] ?? current.get(id)
      }
      // Arrow labels carry the input's unit and product → every known node id to what it supplies.
      const srcById = new Map<string, EdgeSource>()
      g.nodes.forEach((n) => srcById.set(n.id, n))
      ;(g.bg_nodes ?? []).forEach((n) => srcById.set(n.id, n))
      const sel = new Set(selectedRef.current)
      const nodeObjs: Node[] = g.nodes.map((n, i) => ({
        id: n.id,
        type: 'prism',
        position: spot(n.id) ?? { x: (i % 5) * 235, y: Math.floor(i / 5) * 150 },
        selected: sel.has(n.id), // keep the current selection across reloads (e.g. after adding a flow)
        data: nodeData(n)
      }))
      const edgeObjs: Edge[] = g.edges.map((e) => ({
        ...edgeStyle(e.uid, e.amount, e.type, srcById.get(e.source)),
        id: e.uid || `${e.source}__${e.target}`,
        source: e.source,
        target: e.target
      }))
      // The direct (tier-1) background inputs the backend reports — always shown so the first
      // ecoinvent tier is visible on open (whoever added the input, user or AI), as locked refs.
      const bgNodeInfos = g.bg_nodes ?? []
      const bgNodeIds = new Set(bgNodeInfos.map((n) => n.id))
      const bgNodeObjs: Node[] = bgNodeInfos.map((n, i) => ({
        id: n.id,
        type: 'prism',
        position: spot(n.id) ?? { x: -280, y: i * 140 }, // left column until laid out
        selected: sel.has(n.id),
        // `fromBackend` records WHY this box is here: an exchange points at it. It is what lets the
        // filter below tell a box that lost its exchange from one the user put there on purpose.
        data: { ...nodeData(n), fromBackend: true }
      }))
      // Locked references / expanded deeper tiers that live purely on the canvas: preserve those
      // read-only nodes that are neither backend foreground nodes nor already a tier-1 bg node.
      // …but NOT one that is only still here because it *used* to be a tier-1 input: when the
      // exchange goes, the box goes. Without this a replaced input leaves an unconnected ghost that
      // `saveCanvas` then writes into the stored view, so it came back on every open (seen when
      // a GLO car market was swapped for the RER one).
      const keptNodes = nodesRef.current.filter(
        (n) =>
          (n.data as { readOnly?: boolean }).readOnly &&
          !backendIds.has(n.id) &&
          !bgNodeIds.has(n.id) &&
          !(n.data as { fromBackend?: boolean }).fromBackend &&
          !connected.has(n.id)
      )
      // Every background reference now on canvas (tier-1 from backend + deeper user-expanded ones).
      const onCanvasRefs = new Set<string>([...bgNodeIds, ...keptNodes.map((n) => n.id)])
      // Background→foreground edges are authoritative from the backend; draw those whose source
      // reference is on the canvas (tier-1 always is now).
      const bgEdges: Edge[] = (g.bg_edges ?? [])
        .filter((e) => onCanvasRefs.has(e.source))
        .map((e) => ({
          ...edgeStyle(e.uid, e.amount, e.type, srcById.get(e.source)),
          id: e.uid || `${e.source}__${e.target}`,
          source: e.source,
          target: e.target
        }))
      // Background↔background edges (revealed by expanding a reference) have no backend
      // representation, so preserve them from the mirror while both endpoints remain on canvas.
      const tierEdges = edgesRef.current.filter(
        (e) =>
          !backendIds.has(e.source) &&
          !backendIds.has(e.target) &&
          onCanvasRefs.has(e.source) &&
          onCanvasRefs.has(e.target)
      )
      // Auto-layout with dagre (foreground + tier-1 background) unless the user arranged it by hand.
      const backendNodes = [...nodeObjs, ...bgNodeObjs]
      const hasSaved = arranged && [...g.nodes, ...bgNodeInfos].some((n) => posRef.current[n.id])
      if (!arranged) posRef.current = {}
      const laid = hasSaved
        ? backendNodes
        : layoutWithDagre(
            backendNodes,
            [...edgeObjs, ...bgEdges],
            // Already this model's groups: the view is read before the graph is (see the effect that
            // opens a model), so the first arrangement of a grouped model separates its boxes too.
            groupsRef.current.map((g) => g.members)
          )
      // Carry each box's measured size over. A rebuilt node arrives without one, React Flow treats it
      // as not yet measured and hides every edge until a ResizeObserver pass has measured it again —
      // after a formula edit all arrows vanished for ~150 ms and came back. A box whose content did change
      // size is re-measured all the same.
      const measured = new Map(nodesRef.current.map((n) => [n.id, n.measured]))
      setNodes([
        ...laid.map((n) => (measured.get(n.id) ? { ...n, measured: measured.get(n.id) } : n)),
        ...keptNodes
      ])
      setEdges([...edgeObjs, ...bgEdges, ...tierEdges])
    },

    [setNodes, setEdges, prepareGraph]
  )

  const autoLayout = useCallback(
    (label = 'Auto-layout') => {
      rememberStep(label)
      setNodes((ns) => {
        // Group members go to dagre as clusters, which is what keeps two arranged boxes from crossing
        // each other (see lib/layout.ts). With no groups it changes nothing at all.
        const laid = layoutWithDagre(
          ns,
          edges,
          groupsRef.current.map((g) => g.members)
        )
        laid.forEach((n) => {
          posRef.current[n.id] = n.position
        })
        return laid
      })
      fitSoon()
    },
    [edges, setNodes, rememberStep]
  )

  type ExpandInput = {
    database: string
    code: string
    name: string
    product?: string | null
    location: string | null
    unit: string
    external: boolean
    read_only?: boolean
    upstream?: number
  }
  type ExpandResult = {
    inputs: ExpandInput[]
    edges: { uid: string | null; amount: number; source: string; target: string }[]
  }

  // Expand ONE process: reveal its direct (tier-1) upstream inputs. Placement is INCREMENTAL —
  // the new inputs are stacked one tier to the LEFT of the expanded node; every other node keeps
  // its position (no horizontal reshuffle of unrelated processes). Use "Auto-layout" for a full
  // re-arrange.
  const expandNode = useCallback(
    (id: string) => {
      void run(async () => {
        const [db, code] = splitId(id)
        const ex = await api<ExpandResult>('POST', '/api/v1/model/expand', { database: db, code })
        // Read AFTER the await, from the mirrors: two expansions in flight each started from the canvas
        // as it was before either answer, and the later one painted over the earlier one's nodes.
        // The setters below merge for the same reason.
        const nodes = nodesRef.current
        const edges = edgesRef.current
        const have = new Set(nodes.map((n) => n.id))
        const parent = nodes.find((n) => n.id === id)
        const px = parent?.position.x ?? 0
        const py = parent?.position.y ?? 0
        const TIER = 360 // one upstream tier to the left (node width 210 + ~150 gap)
        const ROW = 120 // vertical spacing between the revealed siblings

        // Every box expands on its own: an input already on the canvas gets a node of its own under this
        // parent (`<dataset>#<parent>`), so two boxes of one dataset never share their upstream.
        const idOf = new Map(
          ex.inputs.map((inp) => {
            const plain = `${inp.database}/${inp.code}`
            return [plain, have.has(plain) ? `${plain}#${id}` : plain]
          })
        )
        const fresh = ex.inputs.filter((inp) => !have.has(idOf.get(`${inp.database}/${inp.code}`)!))
        const startY = py - ((fresh.length - 1) / 2) * ROW // stack centred on the parent
        const newNodes: Node[] = fresh.map((inp, i) => {
          const nid = idOf.get(`${inp.database}/${inp.code}`)!
          const pos = { x: px - TIER, y: startY + i * ROW }
          posRef.current[nid] = pos
          // `revealed` marks nodes brought in by expand → collapse may remove them again. A node the
          // user placed themselves (search/drag reference) is NOT revealed and is never swept.
          return {
            id: nid,
            type: 'prism',
            position: pos,
            data: { ...nodeData({ ...inp, id: nid }), revealed: true }
          }
        })
        const haveEdges = new Set(edges.map((e) => e.id))
        // Source unit and product for the new arrows: from the freshly revealed inputs, plus placed nodes.
        const srcById = new Map<string, EdgeSource>()
        ex.inputs.forEach((inp) => srcById.set(`${inp.database}/${inp.code}`, inp))
        nodes.forEach((n) => srcById.set(n.id, n.data as EdgeSource))
        const newEdges: Edge[] = ex.edges
          .map((e) => ({
            ...edgeStyle(e.uid, e.amount, 'technosphere', srcById.get(e.source)),
            // Named after both ends: the same exchange shows under every box that was expanded.
            id: `${idOf.get(e.source) ?? e.source}__${id}${e.uid ? `__${e.uid}` : ''}`,
            source: idOf.get(e.source) ?? e.source,
            target: id
          }))
          .filter((e) => !haveEdges.has(e.id))
        // mark the node expanded → its badge flips to ⊖ (collapse); everyone else stays put
        setNodes((cur) => {
          const present = new Set(cur.map((n) => n.id))
          const base = cur.map((n) => (n.id === id ? { ...n, data: { ...n.data, expanded: true } } : n))
          return [...base, ...newNodes.filter((n) => !present.has(n.id))]
        })
        setEdges((cur) => {
          const present = new Set(cur.map((e) => e.id))
          return [...cur, ...newEdges.filter((e) => !present.has(e.id))]
        })
      })
    },
    [run, setNodes, setEdges]
  )
  expandNodeRef.current = expandNode

  const reloadGraph = useCallback(
    async (db: string): Promise<boolean> => {
      // Latest wins ACROSS models: switching the active model twice in quick succession used to let
      // the slower, older graph response paint over the newer model (open finding #7,
      // "Modellwechsel-Supersession") — reloadGraph had no guard while every other loader here had
      // one. The slot spans all graph keys on purpose: there is one canvas, so only the newest
      // request may build it. Always fetched fresh (a graph reload follows a mutation by design);
      // the shared cache still serves any future subscriber.
      const g = await latestOnly('workbench.graph', () => {
        invalidate(graphRoute(db))
        return fetchQuery(graphRoute(db))
      })
      // Says whether THIS request built the canvas: a superseded one did not, and its caller must not act
      // on boxes it expected to be there (selecting a process just created, for one).
      if (!g) return false
      buildGraph(g)
      // The canvas shows this model now — the first load, or one that recovers a failed one.
      if (db === activeDbRef.current) loadedRef.current = db
      return true
    },
    [buildGraph]
  )

  // Grow a removal set upstream: add a background source only when ALL its downstream targets are
  // already being removed (so it's exclusively upstream of what we're removing). Foreground nodes
  // are never swept in.
  const removeClosure = useCallback(
    (seed: Set<string>): Set<string> => {
      // Only expand-revealed background nodes may be swept upstream; user-placed references stay.
      const revealed = new Set(
        nodesRef.current.filter((n) => (n.data as { revealed?: boolean }).revealed).map((n) => n.id)
      )
      const remove = new Set(seed)
      let changed = true
      while (changed) {
        changed = false
        for (const e of edges) {
          if (
            remove.has(e.target) &&
            !remove.has(e.source) &&
            splitId(e.source)[0] !== activeDb &&
            revealed.has(e.source)
          ) {
            const allTargetsRemoved = edges
              .filter((x) => x.source === e.source)
              .every((x) => remove.has(x.target))
            if (allTargetsRemoved) {
              remove.add(e.source)
              changed = true
            }
          }
        }
      }
      return remove
    },
    [edges, activeDb]
  )

  // Collapse a node's revealed upstream: hide the inputs it expanded (+ their exclusive ancestors)
  // and restore its ⊕ badge. Pure view op — never touches background data.
  const collapse = useCallback(
    (id: string) => {
      // Only hide inputs this node revealed via expand — never a reference the user placed.
      const revealed = new Set(
        nodesRef.current.filter((n) => (n.data as { revealed?: boolean }).revealed).map((n) => n.id)
      )
      const directInputs = edges.filter((e) => e.target === id && revealed.has(e.source)).map((e) => e.source)
      const remove = directInputs.length ? removeClosure(new Set(directInputs)) : new Set<string>()
      remove.forEach((r) => delete posRef.current[r])
      setNodes((ns) =>
        ns
          .filter((n) => !remove.has(n.id))
          .map((n) => (n.id === id ? { ...n, data: { ...n.data, expanded: false } } : n))
      )
      setEdges((es) => es.filter((e) => !remove.has(e.source) && !remove.has(e.target)))
      setSelected([])
    },
    [edges, removeClosure, setNodes, setEdges, setSelected]
  )
  collapseRef.current = collapse

  // Remove a background reference node from the canvas (itself + its exclusive upstream). If that
  // reference feeds one of your foreground processes, the link is real model data, so removing the
  // supplier also deletes those input exchanges (undoable) — otherwise it's a pure view op.
  // Resolves to whether the reference was removed: the confirm can be declined and the backend call can
  // fail, and the assistant's remove_from_canvas reported success before either was known.
  const deleteRef = useCallback(
    (id: string): Promise<boolean> => {
      const remove = removeClosure(new Set([id]))
      // Exchanges from a removed reference into a foreground process (bg_edges carry the uid).
      const feedEdges = edges.filter(
        (e) =>
          remove.has(e.source) &&
          splitId(e.target)[0] === activeDb &&
          !remove.has(e.target) &&
          (e.data as { uid?: string })?.uid
      )
      const applyLocal = (): void => {
        remove.forEach((r) => {
          delete posRef.current[r]
          if (colorsRef.current[r]) setColorRef.current(r, '') // don't leak colours to future nodes
        })
        dropGroupsRef.current([...remove])
        const keptN = nodesRef.current.filter((n) => !remove.has(n.id))
        const keptE = edgesRef.current.filter((e) => !remove.has(e.source) && !remove.has(e.target))
        nodesRef.current = keptN // keep the mirror in sync so a following reload can't resurrect it
        edgesRef.current = keptE
        setNodes(keptN)
        setEdges(keptE)
        setSelected([])
      }
      if (!feedEdges.length) {
        applyLocal()
        return Promise.resolve(true)
      }
      return new Promise<boolean>((resolve) => {
        setConfirm({
          title: 'Remove supplier',
          message: `Remove this supplier and delete the ${feedEdges.length} input(s) it feeds into your process? This is undoable.`,
          confirmLabel: 'Remove',
          danger: true,
          onCancel: () => resolve(false),
          onConfirm: () =>
            void run(async () => {
              let removed = false
              try {
                for (const e of feedEdges) {
                  const [adb, acode] = splitId(e.target)
                  await api('POST', '/api/v1/model/exchanges/remove', {
                    activity_database: adb,
                    activity_code: acode,
                    uid: (e.data as { uid: string }).uid
                  })
                }
                applyLocal()
                removed = true
                if (activeDb) {
                  await reloadGraph(activeDb)
                  await reloadAudit()
                }
              } finally {
                resolve(removed)
              }
            })
        })
      })
    },
    [
      edges,
      activeDb,
      removeClosure,
      run,
      reloadGraph,
      reloadAudit,
      setNodes,
      setEdges,
      setSelected,
      setConfirm
    ]
  )

  // Delete EVERYTHING selected with ONE confirm that names the count. Foreground processes go
  // through the backend (undoable); two passes let consumer links INSIDE the selection resolve
  // themselves without force. Locked references are removed from the canvas afterwards.
  const deleteSelected = useCallback(() => {
    const ids = [...selected]
    if (ids.length < 2) return
    const isFg = (id: string): boolean => {
      const n = nodesRef.current.find((x) => x.id === id)
      return splitId(id)[0] === activeDb && !(n?.data as { readOnly?: boolean } | undefined)?.readOnly
    }
    const fg = ids.filter(isFg)
    const refs = ids.filter((id) => !isFg(id))
    setConfirm({
      title: 'Delete processes',
      message: `Delete the ${ids.length} selected processes?${fg.length ? ` Model processes can be brought back with Undo — one click per process (${fg.length}×).` : ''}`,
      confirmLabel: `Delete ${ids.length}`,
      danger: true,
      onConfirm: () =>
        void run(async () => {
          let queue = fg
          // Passes until one changes nothing: a chain A→B→C selected in supplier order frees exactly one
          // process per pass, and two fixed passes left A standing with a message that blamed a consumer
          // outside the selection.
          for (let progress = true; progress && queue.length; ) {
            const blocked: string[] = []
            for (const id of queue) {
              const [db, code] = splitId(id)
              try {
                await api('POST', '/api/v1/model/activities/delete', { database: db, code })
                delete posRef.current[id]
                if (colorsRef.current[id]) setColorRef.current(id, '')
              } catch (e) {
                if (e instanceof ApiError && e.code === 'delete_blocked') blocked.push(id)
                else throw e
              }
            }
            progress = blocked.length < queue.length
            queue = blocked
          }
          // Selected references: drop their exchanges into SURVIVING model processes, then
          // remove them (and exclusively-upstream revealed nodes) from the canvas.
          const removedRefs: string[] = []
          if (refs.length) {
            const remove = removeClosure(new Set(refs))
            removedRefs.push(...remove)
            const feed = edgesRef.current.filter(
              (e) =>
                remove.has(e.source) &&
                splitId(e.target)[0] === activeDb &&
                !remove.has(e.target) &&
                !fg.includes(e.target) &&
                (e.data as { uid?: string })?.uid
            )
            for (const e of feed) {
              const [adb, acode] = splitId(e.target)
              await api('POST', '/api/v1/model/exchanges/remove', {
                activity_database: adb,
                activity_code: acode,
                uid: (e.data as { uid: string }).uid
              })
            }
            remove.forEach((r) => {
              delete posRef.current[r]
              if (colorsRef.current[r]) setColorRef.current(r, '')
            })
            nodesRef.current = nodesRef.current.filter((n) => !remove.has(n.id))
            edgesRef.current = edgesRef.current.filter((e) => !remove.has(e.source) && !remove.has(e.target))
            setNodes(nodesRef.current)
            setEdges(edgesRef.current)
          }
          // Deleted, not merely off-canvas: a collapsed node comes back, a deleted one does not, so
          // this is the moment membership is forgotten (see pruneGroups).
          dropGroupsRef.current([...fg.filter((id) => !queue.includes(id)), ...removedRefs])
          setSelected([])
          if (queue.length)
            setError(
              `${queue.length} process(es) were kept — they are still used by processes outside the selection.`
            )
          if (activeDb) {
            await reloadGraph(activeDb)
            await reloadAudit()
          }
        })
    })
  }, [
    selected,
    activeDb,
    removeClosure,
    run,
    reloadGraph,
    reloadAudit,
    setNodes,
    setEdges,
    setConfirm,
    setError,
    setSelected
  ])

  // Delete the selected node. Foreground process → removed from the model (backend, undoable)
  // after a confirm. A locked background process can't be deleted (that would edit ecoinvent) —
  // Delete just collapses the upstream it revealed instead.
  const deleteNode = useCallback(
    (id: string) => {
      if (!id) return
      const [db, code] = splitId(id)
      const node = nodes.find((n) => n.id === id)
      const label = (node?.data as { label?: string })?.label ?? code
      const readOnly = (node?.data as { readOnly?: boolean })?.readOnly
      const isForeground = db === activeDb && !readOnly

      if (!isForeground) {
        void deleteRef(id) // locked/background reference: not deletable → just remove it from the canvas
        return
      }
      const doDelete = async (force: boolean): Promise<void> => {
        await api('POST', '/api/v1/model/activities/delete', { database: db, code, force })
        delete posRef.current[id]
        if (colorsRef.current[id]) setColorRef.current(id, '') // free the persisted colour too
        dropGroupsRef.current([id])
        setSelected([])
        if (activeDb) {
          await reloadGraph(activeDb)
          await reloadAudit()
        }
      }
      setConfirm({
        title: 'Delete process',
        message: `Delete process “${label}”? It is removed from the model — you can bring it back with Undo.`,
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: () =>
          void run(async () => {
            try {
              await doDelete(false)
            } catch (e) {
              // Consumed by other processes, in this model or another: the backend blocks the cascade —
              // ask again, naming the consumers it lists, and only then force (undo restores the links).
              if (e instanceof ApiError && e.code === 'delete_blocked') {
                setConfirm({
                  title: 'Process is in use',
                  message: inUseMessage(label, db, blockedConsumers(e.details)),
                  confirmLabel: 'Delete anyway',
                  danger: true,
                  onConfirm: () => void run(() => doDelete(true))
                })
                return
              }
              throw e
            }
          })
      })
    },
    [nodes, activeDb, deleteRef, run, reloadGraph, reloadAudit, setConfirm, setSelected]
  )

  // Placing references, Localize and the move to the library live in useReferences — they work on single
  // boxes and hand the result to a reload, so the box bookkeeping above stays the one place it happens.
  const { addReference, localize, toLibrary } = useReferences({
    run,
    activeDb,
    nodesRef,
    edgesRef,
    posRef,
    setNodes,
    setEdges,
    nodeData,
    reloadGraph,
    reloadAudit
  })

  /**
   * The canvas of one model as it is arranged right now: the reference boxes (they live on the canvas, not in
   * the model) and every node's position.
   *
   * Hoisted out of the effect below because it was only ever called there — on *switching to another model*.
   * Arrange the graph, place a couple of ecoinvent references, then close the app, and none of it was written:
   * the switch never happened, so the save never ran. Colours go to localStorage on every change, positions
   * only on that one path, which is why a canvas could come back half-remembered.
   */
  const saveCanvas = useCallback(
    (db: string | null) => {
      if (!db) return
      // A canvas that shows none of its model's processes has nothing of that model to save — it is
      // still loading, its load failed, or a superseded request left it empty. Saving it would replace
      // the stored arrangement with nothing (a workspace switch makes it
      // reachable). No flag to set or forget: as soon as the model's processes are on the canvas again,
      // it saves as before.
      if (!nodesRef.current.some((n) => n.id.startsWith(`${db}/`))) return
      try {
        // Only boxes that live purely on the canvas. A tier-1 background box is rebuilt from
        // `bg_nodes` on every load and its position is kept in `pos`, so storing it here adds nothing
        // — except a resurrection path for one whose exchange has since been removed.
        // Nor a box that "Expand upstream" revealed: its edges to the parent exist only on the canvas
        // (no backend representation), so a stored copy came back after a reload as an unconnected
        // ghost that collapse could no longer sweep — one model had sixteen of them.
        // Expanding is a look under the bonnet, not part of the arrangement.
        const refs = nodesRef.current
          .filter(
            (n) =>
              (n.data as { readOnly?: boolean }).readOnly &&
              !(n.data as { fromBackend?: boolean }).fromBackend &&
              !(n.data as { revealed?: boolean }).revealed
          )
          .map((n) => {
            const d = n.data as {
              label?: string
              geo?: string | null
              unit?: string | null
              upstream?: number
            } & BoxData
            return {
              id: n.id,
              name: d.label ?? n.id,
              location: d.geo ?? null,
              unit: d.unit ?? null,
              upstream: d.upstream ?? -1,
              x: n.position.x,
              y: n.position.y,
              ...(d.datasetId ? { dataset_id: d.datasetId, tags: d.pendingTags ?? [] } : {})
            }
          })
        const pos: Record<string, { x: number; y: number }> = {}
        for (const n of nodesRef.current) pos[n.id] = { x: n.position.x, y: n.position.y }
        viewSet(db, 'layout', { refs, pos })
        saveBoxes(db)
      } catch {
        /* a view that cannot be written must not stop the canvas */
      }
    },
    [saveBoxes]
  )

  // …and the two moments the switch does not cover: closing the window, and this view going away.
  useEffect(() => {
    const onLeave = (): void => {
      saveCanvas(activeDb)
      flushViews() // the debounce must not eat the last move when the window goes away
    }
    // An update asks for the same save while the backend still runs (lib/modelView saveViewsNow).
    const onSaveNow = (): void => saveCanvas(activeDb)
    window.addEventListener('beforeunload', onLeave)
    window.addEventListener(SAVE_NOW_EVENT, onSaveNow)
    return () => {
      window.removeEventListener('beforeunload', onLeave)
      window.removeEventListener(SAVE_NOW_EVENT, onSaveNow)
      onLeave()
    }
  }, [activeDb, saveCanvas])

  useEffect(() => {
    if (!activeDb) return
    // Save the OUTGOING model's canvas before loading the incoming one.
    const prev = prevDbRef.current
    if (prev && prev !== activeDb) saveCanvas(prev)
    prevDbRef.current = activeDb
    activeDbRef.current = activeDb
    // Load the incoming model's saved canvas.
    type Layout = {
      refs?: Array<{
        id: string
        name: string
        location: string | null
        unit: string | null
        upstream?: number
        x: number
        y: number
        dataset_id?: string
        tags?: { dimension: string; value: string }[]
      }>
      pos?: Record<string, { x: number; y: number }>
    }
    // The cache answers instantly so the canvas does not wait for a round trip; the server's answer
    // arrives inside the async block below and wins when the two differ.
    let saved: Layout = (viewSync(activeDb).layout as Layout | undefined) ?? {}
    // Groups come from the cache first for the same reason the arrangement does — the canvas must not
    // wait for a round trip — and are replaced by the server's answer below.
    loadBoxes(viewSync(activeDb))
    const cachedGroups = readGroups(viewSync(activeDb).groups)
    groupsRef.current = cachedGroups
    setGroups(cachedGroups)
    setSelGroup(null)
    setSelected([])
    nodesRef.current = []
    edgesRef.current = []
    loadedRef.current = null
    posRef.current = saved.pos ?? {} // seed saved positions so buildGraph keeps the arrangement
    setNodes([])
    setEdges([])
    void run(async () => {
      // The truth is in the project. On first open per model this also hands the backend whatever
      // this browser had from before the move — that is the whole migration.
      const stored = await viewFetch(activeDb)
      // Not this model any more: the later switch owns the canvas. Without this, A's late answer set B's
      // colours and groups and then fetched A's graph — which the save wrote under B.
      if (activeDbRef.current !== activeDb) return
      saved = (stored.layout as Layout | undefined) ?? saved
      posRef.current = saved.pos ?? {}
      setNodeColors((stored.colors as Record<string, string> | undefined) ?? {})
      loadBoxes(stored)
      const storedGroups = readGroups(stored.groups)
      groupsRef.current = storedGroups
      setGroups(storedGroups)
      await reloadGraph(activeDb)
      if (activeDbRef.current !== activeDb) return
      // Restore placed reference boxes not already rebuilt from the backend (unconnected refs).
      // A reference the user placed carries `upstream: -1` (count unknown until expanded); one that
      // an expand revealed carries the count the backend reported. Older views
      // stored the latter too, so those are dropped here once and the next save no longer has them.
      const savedRefs = (saved.refs ?? []).filter((r) => (r.upstream ?? -1) < 0)
      if (savedRefs.length) {
        setNodes((cur) => {
          const present = new Set(cur.map((n) => n.id))
          const add = savedRefs
            .filter((r) => !present.has(r.id))
            .map((r) => ({
              id: r.id,
              type: 'prism',
              position: { x: r.x, y: r.y },
              data: nodeData({
                name: r.name,
                location: r.location,
                unit: r.unit,
                external: true,
                read_only: true,
                upstream: r.upstream ?? -1,
                id: r.id,
                ...(r.dataset_id ? { dataset_id: r.dataset_id, uids: [], pending_tags: r.tags ?? [] } : {})
              })
            }))
          if (!add.length) return cur
          const merged = [...cur, ...add]
          nodesRef.current = merged
          return merged
        })
      }
      await reloadAudit()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDb, run, reloadGraph, reloadAudit])

  return {
    // React-Flow state
    nodes,
    setNodes,
    onNodesChange,
    edges,
    setEdges,
    onEdgesChange,
    selected,
    setSelected,
    selectOnly,
    // refs shared with stable callbacks elsewhere (chat handlers, tag menu, context menus)
    nodesRef,
    edgesRef,
    posRef,
    selectedRef,
    lastSelRef,
    rfRef,
    activeDbRef,
    prevDbRef,
    onTagRef,
    dropGroupsRef,
    // colours
    nodeColors,
    setNodeColor,
    resetColors,
    paintNodes,
    // groups
    groups,
    groupsRef,
    selGroup,
    setSelGroup,
    editGroup,
    setEditGroup,
    groupPicker,
    setGroupPicker,
    putGroups,
    groupSelection,
    ungroup,
    addSelectionToGroup,
    renameGroupTo,
    restackGroup,
    selectGroup,
    paintGroup,
    moveGroup,
    moveGroupEnd,
    // graph machinery
    buildGraph,
    reloadGraph,
    autoLayout,
    // the canvas's own undo history (workbench/useViewHistory.ts)
    history,
    expandNode,
    collapse,
    removeClosure,
    deleteRef,
    deleteSelected,
    deleteNode,
    addReference,
    localize,
    toLibrary,
    noteConnected,
    saveCanvas,
    // tag/highlight plumbing owned by the tag world
    setTagColors,
    applyHighlight
  }
}
