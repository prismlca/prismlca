/**
 * The canvas's undo history at work — the rules are in lib/viewHistory.ts. Notes a step before every change
 * the user makes to the arrangement (`remember`; a drag from `begin` to `end`), takes steps back and brings
 * them back by restoring the whole arrangement, and tells the toolbar what its newest step is. One history
 * per model, for the session; workbench/useHistorySteps.ts decides whether the canvas or the model goes first.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'
import type { Node } from '@xyflow/react'

import type { NodeGroup } from '../lib/groups'
import { workspaceGeneration } from '../lib/modelView'
import {
  pushStep,
  redoStep,
  undoStep,
  type ViewSnapshot,
  type ViewStacks,
  type ViewStep
} from '../lib/viewHistory'

export interface ViewHistoryDeps {
  activeDbRef: MutableRefObject<string | null>
  nodesRef: MutableRefObject<Node[]>
  setNodes: Dispatch<SetStateAction<Node[]>>
  posRef: MutableRefObject<Record<string, { x: number; y: number }>>
  colorsRef: MutableRefObject<Record<string, string>>
  /** Writes the whole colour map and persists it — without noting a step. */
  replaceColors: (next: Record<string, string>) => void
  groupsRef: MutableRefObject<NodeGroup[]>
  /** Writes the group boxes and persists them — without noting a step. */
  putGroups: (next: NodeGroup[]) => void
  /** The model whose canvas has finished loading (null while one loads). */
  loadedRef: MutableRefObject<string | null>
}

const EMPTY: ViewStacks = { undo: [], redo: [] }
/** Arrow-key presses this close together are one step. */
const NUDGE_RUN_MS = 1500

/** Whether any box now stands elsewhere than in ``pos``. */
function moved(pos: ViewSnapshot['pos'], nodes: Node[]): boolean {
  return nodes.some((n) => {
    const was = pos[n.id]
    return !!was && (was.x !== n.position.x || was.y !== n.position.y)
  })
}

export function useViewHistory(deps: ViewHistoryDeps) {
  const {
    activeDbRef,
    nodesRef,
    setNodes,
    posRef,
    colorsRef,
    replaceColors,
    groupsRef,
    putGroups,
    loadedRef
  } = deps
  const stacks = useRef(new Map<string, ViewStacks>())
  // The toolbar reads the newest step while rendering: a change of the stacks has to render it again.
  const [, bump] = useState(0)
  // A drag under way: the arrangement from before it, noted as a step only once it has moved something.
  const pending = useRef<{ db: string; at: number; snap: ViewSnapshot } | null>(null)

  const snapshot = useCallback(
    (): ViewSnapshot => ({
      pos: Object.fromEntries(nodesRef.current.map((n) => [n.id, { x: n.position.x, y: n.position.y }])),
      colors: { ...colorsRef.current },
      groups: groupsRef.current
    }),
    [nodesRef, colorsRef, groupsRef]
  )
  // Keyed by workspace and model: model names repeat across workspaces, and a step made in one must not
  // put its colours and boxes onto a namesake in another (lib/modelView.ts bumps the generation per switch).
  const key = (db: string): string => `${workspaceGeneration()}\u0000${db}`
  const put = useCallback((db: string, next: ViewStacks) => {
    stacks.current.set(key(db), next)
    bump((n) => n + 1)
  }, [])
  const of = useCallback((db: string): ViewStacks => stacks.current.get(key(db)) ?? EMPTY, [])
  const add = useCallback((db: string, step: ViewStep) => put(db, pushStep(of(db), step)), [of, put])

  /** Note a step before a change the user makes now. */
  const remember = useCallback(
    (label: string) => {
      const db = activeDbRef.current
      if (db) add(db, { label, at: Date.now(), snap: snapshot() })
    },
    [activeDbRef, add, snapshot]
  )

  /** A drag begins: keep the arrangement from before it. A new drag starts afresh — one whose end never came
   *  must not lend it a stale "before" — unless ``keep``: a group's frame calls this on every move of one drag. */
  const begin = useCallback(
    (keep = false) => {
      const db = activeDbRef.current
      if (db && !(keep && pending.current)) pending.current = { db, at: Date.now(), snap: snapshot() }
    },
    [activeDbRef, snapshot]
  )

  /** A drag ends: one step for all of it, if it moved anything — a box grabbed and let go where it was
   *  moved nothing. ``node`` is the box the pointer held; without it (a group's frame) it did move. */
  const end = useCallback(
    (label: string, node?: { id: string; position: { x: number; y: number } }) => {
      const p = pending.current
      pending.current = null
      if (!p || p.db !== activeDbRef.current) return
      const was = node ? p.snap.pos[node.id] : undefined
      if (node && was && was.x === node.position.x && was.y === node.position.y) return
      add(p.db, { label, at: p.at, snap: p.snap })
    },
    [activeDbRef, add]
  )

  /** Put an arrangement back: positions of the boxes still on the canvas, the colour map, the group boxes. */
  const restore = useCallback(
    (s: ViewSnapshot) => {
      setNodes((ns) => ns.map((n) => (s.pos[n.id] ? { ...n, position: s.pos[n.id] } : n)))
      for (const n of nodesRef.current) if (s.pos[n.id]) posRef.current[n.id] = s.pos[n.id]
      replaceColors(s.colors)
      putGroups(s.groups)
    },
    [setNodes, nodesRef, posRef, replaceColors, putGroups]
  )

  /** Whether ``db``'s canvas has finished loading: while a model loads the canvas is empty, and a step taken
   *  back then would put back nothing and keep the empty canvas as its Redo. A loaded model may well be
   *  empty — readiness is the load having finished, not boxes being there. */
  const ready = useCallback((db: string | null): boolean => !!db && loadedRef.current === db, [loadedRef])

  /** Take back the newest step of ``db``'s canvas; false when there is none or the canvas is not ready. */
  const undo = useCallback(
    (db: string): boolean => {
      if (!ready(db)) return false
      const r = undoStep(of(db), snapshot())
      if (!r) return false
      put(db, r.stacks)
      restore(r.restore)
      return true
    },
    [of, put, ready, restore, snapshot]
  )

  /** Bring back the step taken back last; false when there is none or the canvas is not ready. */
  const redo = useCallback(
    (db: string): boolean => {
      if (!ready(db)) return false
      const r = redoStep(of(db), snapshot())
      if (!r) return false
      put(db, r.stacks)
      restore(r.restore)
      return true
    },
    [of, put, ready, restore, snapshot]
  )

  /** Whether a step of ``db``'s ``kind`` stack was made between ``from`` and ``to`` (ms) — inside an assistant
   *  turn the model would otherwise take back as one block, past it. */
  const within = (db: string, kind: 'undo' | 'redo', from: number, to: number): boolean =>
    of(db)[kind].some((s) => s.at >= from && s.at <= to)

  // Arrow keys move the selected boxes too (React Flow's keyboard access), without a drag: one step for a run
  // of presses. The arrangement is kept on the first press, ahead of React Flow's own handler (capture
  // phase), and becomes a step only once a box has moved — in hand mode or with nothing selected the keys
  // move nothing, and a step there would only end Redo.
  const nudged = useRef<{ db: string; step: ViewStep; at: number } | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Any arrow, with modifiers too (React Flow moves a focused selection on Ctrl+arrow as well); whether a
      // step comes of it is decided by what moved.
      if (!e.key.startsWith('Arrow')) return
      const t = e.target as HTMLElement | null
      if (!t?.closest?.('.react-flow__node, .react-flow__nodesselection-rect')) return
      // A field inside a box (a name being typed) keeps its arrows: they move the caret, not the box.
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
        return
      const db = activeDbRef.current
      if (!db) return
      const now = Date.now()
      const last = nudged.current
      const stack = of(db).undo
      if (last && last.db === db && last.step === stack[stack.length - 1] && now - last.at < NUDGE_RUN_MS) {
        nudged.current = { ...last, at: now }
        return
      }
      const before = snapshot()
      // After React Flow has handled the key and the canvas has rendered it (a discrete event flushes at once).
      setTimeout(() => {
        if (activeDbRef.current !== db || !moved(before.pos, nodesRef.current)) return
        const step = { label: 'Nudge processes', at: now, snap: before }
        add(db, step)
        nudged.current = { db, step, at: Date.now() }
      }, 0)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [activeDbRef, add, nodesRef, of, snapshot])

  /** The newest step Undo or Redo would act on for ``db``. */
  const top = (db: string | null, kind: 'undo' | 'redo'): ViewStep | undefined => {
    const list = db ? of(db)[kind] : []
    return list[list.length - 1]
  }

  return { remember, begin, end, undo, redo, top, ready, within }
}

export type ViewHistory = ReturnType<typeof useViewHistory>
