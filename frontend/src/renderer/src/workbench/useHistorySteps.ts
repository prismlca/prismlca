/**
 * Undo and Redo — the toolbar's buttons and Ctrl+Z — over the two histories a model has: the backend's
 * command stack (model edits, per model, assistant turns as blocks) and the canvas's own (the arrangement:
 * positions, colours, group boxes; workbench/useViewHistory.ts). Whichever holds the newer step goes first
 * (lib/viewHistory.ts), by the times both keep, so Undo takes back what was done last, as in any editor.
 */
import { useEffect, useRef, useState } from 'react'

import { api, type DatabaseInfo, type UndoState } from '../lib/api'
import { firstRedo, firstUndo, redoable } from '../lib/viewHistory'
import type { ConfirmSpec } from '../views/ConfirmDialog'
import type { ViewHistory } from './useViewHistory'

export interface HistoryStepDeps {
  run: (fn: () => Promise<unknown>) => Promise<void>
  activeDb: string | null
  undoState: UndoState
  history: ViewHistory
  freshDatabases: () => Promise<DatabaseInfo[]>
  setDatabases: (dbs: DatabaseInfo[]) => void
  setActiveDb: (db: string | null) => void
  reloadGraph: (db: string) => Promise<boolean>
  reloadAudit: () => Promise<void>
  setError: (msg: string | null) => void
  setConfirm: (spec: ConfirmSpec | null) => void
}

export function useHistorySteps(deps: HistoryStepDeps) {
  const { run, activeDb, undoState, history, freshDatabases, setDatabases, setActiveDb } = deps
  const { reloadGraph, reloadAudit, setError, setConfirm } = deps

  // One model step at a time, until the history it leaves is read back: a second click meanwhile would
  // decide between the two histories on the answer from before the first, and could take back a model
  // step past a newer canvas step.
  const [stepping, setStepping] = useState(false)
  const steppingRef = useRef(false)
  const historyStep = (path: '/api/v1/model/undo' | '/api/v1/model/redo', turn?: string) => {
    if (steppingRef.current) return
    steppingRef.current = true
    setStepping(true)
    return modelStep(path, turn).finally(() => {
      steppingRef.current = false
      setStepping(false)
    })
  }
  const modelStep = (path: '/api/v1/model/undo' | '/api/v1/model/redo', turn?: string) =>
    run(async () => {
      // Scoped to the open model: a newest step that belongs to another one is refused, not taken back.
      const out = await api<{
        stopped?: string | null
        undone?: number
        redone?: number
        remaining_in_turn?: number
      }>('POST', path, { ...(turn ? { turn } : {}), ...(activeDb ? { database: activeDb } : {}) })
      // Undoing a bundle import removes a whole model, redoing it brings one back — so the list is
      // re-read here, not only the graph. Before this, undoing an import left the vanished model in
      // the picker and on the canvas, with an Undo button still offering the same step. If the model on the
      // canvas is the one that went, move to another first.
      const dbs = await freshDatabases()
      setDatabases(dbs)
      if (activeDb && !dbs.some((d) => d.name === activeDb)) {
        setActiveDb(dbs.find((d) => d.kind === 'foreground' && !d.read_only)?.name ?? null)
      } else if (activeDb) {
        await reloadGraph(activeDb)
      }
      await reloadAudit()
      // A turn batch that stopped half-way answers 200 — with how far it got and where it stopped. Said
      // here, after the views show the state it left; the audit log alone was the only place to find
      // it.
      if (out?.stopped) {
        const verb = path.endsWith('undo') ? 'Undo' : 'Redo'
        const done = out.undone ?? out.redone ?? 0
        const left = out.remaining_in_turn ?? 0
        setError(
          `${verb} of the assistant turn stopped after ${done} change${done === 1 ? '' : 's'}: ${out.stopped}.` +
            (left
              ? ` ${left} change${left === 1 ? '' : 's'} of the turn remain${left === 1 ? 's' : ''}.`
              : '')
        )
      }
    })
  // When the next step to take back belongs to an assistant turn with several changes, ask which
  // grain the user means — the whole turn in one go, or only the last change. The backend only
  // offers a turn while it lies contiguously on top of the stack, so "the whole turn" is always a
  // plain series of undos, never a pull from the middle.
  //
  // A turn with a step of the canvas's own history inside it (the assistant's auto-layout between two
  // edits) is not offered whole: the block would be taken back past that step. It goes step by step, the
  // canvas's in its place.
  const turnStep = (
    path: '/api/v1/model/undo' | '/api/v1/model/redo',
    block: { turn: string; size: number; from_at?: number; to_at?: number } | null | undefined,
    verb: 'Undo' | 'Redo'
  ) => {
    const kind = verb === 'Undo' ? 'undo' : 'redo'
    const crossed =
      !!activeDb &&
      block?.from_at != null &&
      history.within(activeDb, kind, block.from_at, block.to_at ?? block.from_at)
    if (!block || block.size < 2 || crossed) return historyStep(path)
    setConfirm({
      title: `${verb} an assistant turn`,
      message:
        `The ${verb === 'Undo' ? 'last' : 'next'} change belongs to an assistant turn with ` +
        `${block.size} changes. ${verb} the whole turn in one go, or only ` +
        `${verb === 'Undo' ? 'the last' : 'the next'} change?`,
      confirmLabel: `${verb} all ${block.size}`,
      onConfirm: () => historyStep(path, block.turn),
      secondary: {
        label: `Only ${verb === 'Undo' ? 'the last' : 'the next'} change`,
        onClick: () => historyStep(path)
      }
    })
  }

  // Which history goes first, and what the toolbar says: the canvas's step stands in for the model's
  // whenever it is the newer one (lib/viewHistory.ts) — compared with the model's own newest step even when
  // that one is held by another model's, so a canvas step never jumps ahead of a model change made after it.
  // A canvas step taken back counts for Redo only while no model step is newer than it: one made since
  // ends it (as a new change ends Redo), and undoing that one brings it back.
  const viewUndo = history.top(activeDb, 'undo')
  const redoTop = history.top(activeDb, 'redo')
  const viewRedo = redoable(redoTop, undoState.next_undo_at) ? redoTop : undefined
  // The canvas decides only with the open model's own answer in hand (see UndoState.model) and no model step
  // under way; until then both buttons wait.
  const ready = history.ready(activeDb) && undoState.model === activeDb && !stepping
  const canvasUndoes = firstUndo(viewUndo, undoState.next_undo_at)
  const canvasRedoes = firstRedo(viewRedo, undoState.next_redo_at)
  const shown: UndoState = {
    ...undoState,
    ...(stepping ? { can_undo: false, can_redo: false } : {}),
    ...(canvasUndoes && viewUndo
      ? { can_undo: ready, next_undo: viewUndo.label, next_undo_turn: null, undo_elsewhere: null }
      : {}),
    ...(canvasRedoes && viewRedo
      ? { can_redo: ready, next_redo: viewRedo.label, next_redo_turn: null, redo_elsewhere: null }
      : {})
  }
  // The canvas's step goes first or nothing does: while its model is still loading, Undo waits — never the
  // model's older step in its place. A model step held by another model's holds the canvas's older ones too.
  const undo = () => {
    if (steppingRef.current) return
    if (canvasUndoes) return void (ready && activeDb && history.undo(activeDb))
    return turnStep('/api/v1/model/undo', undoState.next_undo_turn, 'Undo')
  }
  const redo = () => {
    if (steppingRef.current) return
    if (canvasRedoes) return void (ready && activeDb && history.redo(activeDb))
    return turnStep('/api/v1/model/redo', undoState.next_redo_turn, 'Redo')
  }

  // Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) — the toolbar's Undo and Redo, the keys every editor has. Not inside a
  // text field (the field's own undo wins there) and not with a dialog open, the same rules as the canvas's Delete.
  // An assistant turn with several changes asks first, exactly as the button does. Refs, so the listener
  // is registered once and always calls the current handlers.
  const undoKeyRef = useRef({ undo: () => {}, redo: () => {}, canUndo: false, canRedo: false })
  undoKeyRef.current = {
    undo: () => void undo(),
    redo: () => void redo(),
    canUndo: shown.can_undo,
    canRedo: shown.can_redo
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const k = e.key.toLowerCase()
      const isUndo = k === 'z' && !e.shiftKey
      const isRedo = (k === 'z' && e.shiftKey) || (k === 'y' && !e.shiftKey)
      if (!isUndo && !isRedo) return
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      )
        return
      if (document.querySelector('.modal-backdrop, .overlay')) return
      const h = undoKeyRef.current
      if (isUndo && !h.canUndo) return
      if (isRedo && !h.canRedo) return
      e.preventDefault()
      if (isUndo) h.undo()
      else h.redo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return { undo, redo, shownUndoState: shown }
}
