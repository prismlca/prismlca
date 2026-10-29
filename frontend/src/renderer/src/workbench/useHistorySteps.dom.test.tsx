import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { makePrism } from '../test/prism'
import type { UndoState } from '../lib/api'
import { firstRedo, type ViewStep } from '../lib/viewHistory'
import { useHistorySteps, type HistoryStepDeps } from './useHistorySteps'
import type { ViewHistory } from './useViewHistory'

const MODEL_STEP: UndoState = {
  can_undo: true,
  can_redo: false,
  next_undo: 'Set parameter p',
  next_redo: null,
  next_undo_at: 1000,
  next_redo_at: null,
  model: 'm1'
}

function setup(
  undoState: UndoState,
  canvasTop: ViewStep | undefined,
  opts: { ready?: boolean; within?: boolean; redoTop?: ViewStep } = {}
) {
  const fixture = makePrism({
    'POST /api/v1/model/undo': { undone: 'Set parameter p' },
    'GET /api/v1/databases': []
  })
  ;(window as unknown as { prism: unknown }).prism = fixture.prism
  const history = {
    top: (_db: string | null, kind: 'undo' | 'redo') => (kind === 'undo' ? canvasTop : opts.redoTop),
    undo: vi.fn(() => true),
    redo: vi.fn(() => true),
    ready: () => opts.ready ?? true,
    within: () => opts.within ?? false,
    remember: vi.fn(),
    begin: vi.fn(),
    end: vi.fn()
  } as unknown as ViewHistory
  const deps: HistoryStepDeps = {
    run: async (fn) => {
      await fn()
    },
    activeDb: 'm1',
    undoState,
    history,
    freshDatabases: async () => [],
    setDatabases: vi.fn(),
    setActiveDb: vi.fn(),
    reloadGraph: vi.fn(async () => true),
    reloadAudit: vi.fn(async () => {}),
    setError: vi.fn(),
    setConfirm: vi.fn()
  }
  const hook = renderHook((p: HistoryStepDeps) => useHistorySteps(p), { initialProps: deps })
  return { ...hook, history, fixture, deps }
}

describe('Undo across the model and its canvas', () => {
  it('takes back the canvas step when it is the newer one, and the toolbar names it', () => {
    const { result, history, fixture } = setup(MODEL_STEP, {
      label: 'Auto-layout',
      at: 2000,
      snap: {} as never
    })
    expect(result.current.shownUndoState).toMatchObject({ can_undo: true, next_undo: 'Auto-layout' })
    act(() => void result.current.undo())
    expect(history.undo).toHaveBeenCalledWith('m1')
    expect(fixture.calls.some((c) => c.path === '/api/v1/model/undo')).toBe(false)
  })

  it('takes back the model step when that is the newer one', async () => {
    const { result, history, fixture } = setup(MODEL_STEP, {
      label: 'Auto-layout',
      at: 500,
      snap: {} as never
    })
    expect(result.current.shownUndoState.next_undo).toBe('Set parameter p')
    await act(async () => void (await result.current.undo()))
    expect(history.undo).not.toHaveBeenCalled()
    await waitFor(() => expect(fixture.calls.some((c) => c.path === '/api/v1/model/undo')).toBe(true))
  })

  it('offers a canvas step for Redo only while no model step is newer than it', () => {
    const taken: ViewStep = { label: 'Auto-layout', at: 1500, snap: {} as never }
    const { result, rerender, deps } = setup(MODEL_STEP, undefined, { redoTop: taken })
    expect(result.current.shownUndoState).toMatchObject({ can_redo: true, next_redo: 'Auto-layout' })
    rerender({ ...deps, undoState: { ...MODEL_STEP, next_undo_at: 2000 } }) // a new model step
    expect(result.current.shownUndoState.can_redo).toBe(false)
    rerender({ ...deps, undoState: { ...MODEL_STEP, next_undo_at: 1000 } }) // …taken back again
    expect(result.current.shownUndoState.next_redo).toBe('Auto-layout')
  })

  it('leaves the model’s Redo alone when the canvas gets a new step — the two are independent', async () => {
    const undone: UndoState = {
      ...MODEL_STEP,
      can_redo: true,
      next_redo: 'Set parameter p',
      next_redo_at: 1000
    }
    const { result } = setup(undone, { label: 'Move', at: 3000, snap: {} as never })
    expect(result.current.shownUndoState).toMatchObject({ can_redo: true, next_redo: 'Set parameter p' })
  })

  it('does not let a canvas Redo jump ahead of an older model step another model holds', () => {
    const held: UndoState = {
      ...MODEL_STEP,
      can_redo: false,
      next_redo_at: 2000,
      redo_elsewhere: { model: 'B', summary: 'Create process' }
    }
    // The canvas's redo at 3000 was taken back before the held model step at 2000: it comes after it, and waits.
    const later: ViewStep = { label: 'Move', at: 3000, snap: {} as never }
    const { result, history } = setup(held, undefined, { redoTop: later })
    expect(result.current.shownUndoState.can_redo).toBe(false)
    expect(firstRedo(later, held.next_redo_at)).toBe(false)
    expect(history.redo).not.toHaveBeenCalled()
  })

  it('takes an assistant turn step by step when a canvas step lies inside it', async () => {
    const turn: UndoState = {
      ...MODEL_STEP,
      next_undo_turn: { turn: 't1', size: 3, from_at: 100, to_at: 1000 } as never
    }
    const { result, deps, fixture } = setup(turn, undefined, { within: true })
    await act(async () => void (await result.current.undo()))
    expect(deps.setConfirm).not.toHaveBeenCalled()
    await waitFor(() => expect(fixture.calls.filter((c) => c.path === '/api/v1/model/undo')).toHaveLength(1))
    expect(fixture.calls.find((c) => c.path === '/api/v1/model/undo')!.body).toEqual({ database: 'm1' })
  })

  it('waits while the model is still loading rather than taking back the older model step instead', () => {
    const { result, history, fixture } = setup(
      MODEL_STEP,
      { label: 'Move', at: 2000, snap: {} as never },
      { ready: false }
    )
    expect(result.current.shownUndoState.can_undo).toBe(false)
    act(() => void result.current.undo())
    expect(history.undo).not.toHaveBeenCalled()
    expect(fixture.calls.some((c) => c.path === '/api/v1/model/undo')).toBe(false)
  })

  it('takes one model step at a time: a second Undo while the first is out does nothing', async () => {
    let release = (): void => {}
    const held = new Promise<void>((r) => (release = r))
    const { result, fixture } = setup(MODEL_STEP, undefined)
    fixture.setRoute('POST /api/v1/model/undo', async () => (await held, { undone: 'Set parameter p' }))
    act(() => void result.current.undo())
    await waitFor(() => expect(result.current.shownUndoState.can_undo).toBe(false))
    act(() => void result.current.undo())
    release()
    await waitFor(() => expect(result.current.shownUndoState.can_undo).toBe(true))
    expect(fixture.calls.filter((c) => c.path === '/api/v1/model/undo')).toHaveLength(1)
  })

  it('waits for the open model’s own history before the canvas goes first', () => {
    const pending: UndoState = { can_undo: false, can_redo: false, next_undo: null, next_redo: null }
    const { result, history } = setup(pending, { label: 'Paint', at: 500, snap: {} as never })
    expect(result.current.shownUndoState.can_undo).toBe(false)
    act(() => void result.current.undo())
    expect(history.undo).not.toHaveBeenCalled()
  })
})
