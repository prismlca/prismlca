import { describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { makePrism } from '../test/prism'
import { useCanvasUiTools, type CanvasUiToolsDeps } from './useCanvasUiTools'
import type { ChatUiHandlers } from './useAiCanvasTools'
import type { ViewKey } from './AppSidebar'

/**
 * The canvas requests of the assistant and of external agents on every page (V481). The chat panel that
 * used to answer them exists on the Model view only; from the Results page each of them waited 30 s for
 * nobody. Now they act on the canvas state where it is, and only the two about the screen open the model
 * view first.
 */
function setup(view: ViewKey, opts: { activeDb?: string; drawn?: Promise<boolean> } = {}) {
  const answers: Array<{ reqId: string; ok: boolean; result: unknown; at: number }> = []
  const fixture = makePrism(
    {},
    {
      ai: {
        uiResult: (reqId: string, ok: boolean, result: unknown) =>
          answers.push({ reqId, ok, result, at: Date.now() })
      }
    }
  )
  ;(window as unknown as { prism: unknown }).prism = fixture.prism
  const ui: ChatUiHandlers = {
    jumpToProcess: vi.fn(),
    autoLayout: vi.fn(),
    screenshotRect: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
    calculateInCanvas: vi.fn(async () => ({ started: true })),
    setupResults: vi.fn(async () => ({ tab: 'overview', note: 'held' })),
    getCanvas: vi.fn(() => ({ nodes: [] })),
    clearCanvas: vi.fn(() => ({ removed: 2 })),
    removeFromCanvas: vi.fn(async () => ({ ok: true, removed: 'ei/x' })),
    refresh: vi.fn()
  }
  const whenDrawn = vi.fn(() => opts.drawn ?? Promise.resolve(true))
  let deps: CanvasUiToolsDeps
  // The Workbench re-renders with the new view (or model): so does this.
  const change = (to: Partial<CanvasUiToolsDeps>): void => {
    deps = { ...deps, ...to }
    act(() => hook.rerender({ d: deps }))
  }
  const setView = vi.fn((v: ViewKey) => change({ view: v }))
  deps = { activeDb: opts.activeDb ?? 'm', view, setView, ui, whenDrawn }
  const hook = renderHook(({ d }: { d: CanvasUiToolsDeps }) => useCanvasUiTools(d), {
    initialProps: { d: deps }
  })
  let n = 0
  const ask = (name: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    const reqId = `r${++n}`
    fixture.emitUiTool({ reqId, name, args, chatId: 'c1', database: 'm', ...extra })
    return reqId
  }
  const answer = async (reqId: string): Promise<Record<string, unknown>> => {
    await waitFor(() => expect(answers.some((a) => a.reqId === reqId)).toBe(true))
    return answers.find((a) => a.reqId === reqId)!.result as Record<string, unknown>
  }
  return { ui, setView, whenDrawn, ask, answer, answers, change }
}

const CALC = { method: ['IPCC 2021', 'climate change', 'GWP100'], code: 'a' }

describe('canvas requests from a page without the canvas', () => {
  it('answers every one of the eight, at once for the six that need no screen', async () => {
    const t = setup('results')
    const t0 = Date.now()
    const ids = {
      layout: t.ask('auto_layout'),
      clear: t.ask('clear_canvas'),
      remove: t.ask('remove_from_canvas', { code: 'x' }),
      calc: t.ask('calculate_in_canvas', CALC),
      read: t.ask('get_canvas'),
      setup: t.ask('setup_results', { tab: 'overview' }),
      jump: t.ask('jump_to_process', { code: 'a' }),
      shot: t.ask('screenshot_canvas')
    }
    for (const id of Object.values(ids)) await t.answer(id)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(t.answers).toHaveLength(8)
    expect(t.answers.every((a) => a.ok)).toBe(true)
    expect(t.ui.autoLayout).toHaveBeenCalledTimes(1)
    expect(t.ui.clearCanvas).toHaveBeenCalledTimes(1)
    expect(t.ui.removeFromCanvas).toHaveBeenCalledWith('x')
    expect(t.ui.calculateInCanvas).toHaveBeenCalledWith(CALC.method, 'a')
    expect(t.ui.getCanvas).toHaveBeenCalledTimes(1)
    expect(t.ui.setupResults).toHaveBeenCalledWith({ tab: 'overview' })
  })

  it('acts on the canvas state without leaving the page, and says where the user sees it', async () => {
    const t = setup('parameters')
    const layout = await t.answer(t.ask('auto_layout'))
    expect(layout).toEqual({ ok: true, visible_in: 'model view (the user is on another page)' })
    expect(await t.answer(t.ask('get_canvas'))).toEqual({
      nodes: [],
      visible_in: 'model view (the user is on another page)'
    })
    expect(await t.answer(t.ask('calculate_in_canvas', CALC))).toMatchObject({
      started: true,
      visible_in: expect.any(String)
    })
    // The Results set-up belongs to the Results page and says itself where the user is.
    expect(await t.answer(t.ask('setup_results', { tab: 'overview' }))).toEqual({
      tab: 'overview',
      note: 'held'
    })
    expect(t.setView).not.toHaveBeenCalled()
  })

  it('adds nothing to a refusal', async () => {
    const t = setup('results')
    vi.mocked(t.ui.removeFromCanvas).mockResolvedValueOnce({ error: 'No reference "q" on the canvas.' })
    expect(await t.answer(t.ask('remove_from_canvas', { code: 'q' }))).toEqual({
      error: 'No reference "q" on the canvas.'
    })
  })

  it('opens the model view for a jump and waits until it is drawn', async () => {
    let draw: (ok: boolean) => void = () => {}
    const t = setup('results', { drawn: new Promise((resolve) => (draw = resolve)) })
    const id = t.ask('jump_to_process', { code: 'a' })
    await waitFor(() => expect(t.setView).toHaveBeenCalledWith('model'))
    await new Promise((r) => setTimeout(r, 30))
    expect(t.ui.jumpToProcess).not.toHaveBeenCalled()
    draw(true)
    expect(await t.answer(id)).toEqual({ ok: true, switched_to: 'model view' })
    expect(t.ui.jumpToProcess).toHaveBeenCalledWith('a')
  })

  it('opens the model view for a screenshot and takes it once drawn', async () => {
    const t = setup('report')
    expect(await t.answer(t.ask('screenshot_canvas'))).toEqual({
      rect: { x: 0, y: 0, width: 800, height: 600 },
      switched_to: 'model view'
    })
    expect(t.setView).toHaveBeenCalledWith('model')
    expect(t.whenDrawn).toHaveBeenCalled()
  })

  it('says the canvas is not visible when it was not drawn in time, and does nothing', async () => {
    const t = setup('report', { drawn: Promise.resolve(false) })
    expect(await t.answer(t.ask('screenshot_canvas'))).toEqual({
      error: 'Canvas not visible.',
      switched_to: 'model view'
    })
    // The model view is open by now (the screenshot opened it): no switch this time.
    expect(await t.answer(t.ask('jump_to_process', { code: 'a' }))).toEqual({ error: 'Canvas not visible.' })
    expect(t.ui.screenshotRect).not.toHaveBeenCalled()
    expect(t.ui.jumpToProcess).not.toHaveBeenCalled()
  })

  it('acts on nothing when the user opened another model or page while it waited', async () => {
    let draw: (ok: boolean) => void = () => {}
    const t = setup('results', { drawn: new Promise((resolve) => (draw = resolve)) })
    const shot = t.ask('screenshot_canvas')
    const jump = t.ask('jump_to_process', { code: 'a' })
    await waitFor(() => expect(t.setView).toHaveBeenCalledWith('model'))
    t.change({ activeDb: 'other' })
    draw(true)
    expect((await t.answer(shot)).error).toMatch(/"m" is not on screen/)
    expect((await t.answer(jump)).error).toMatch(/"m" is not on screen/)
    expect(t.ui.screenshotRect).not.toHaveBeenCalled()
    expect(t.ui.jumpToProcess).not.toHaveBeenCalled()

    const t2 = setup('results', { drawn: new Promise((resolve) => (draw = resolve)) })
    const shot2 = t2.ask('screenshot_canvas')
    await waitFor(() => expect(t2.setView).toHaveBeenCalledWith('model'))
    t2.change({ view: 'parameters' })
    draw(false)
    expect(await t2.answer(shot2)).toEqual({ error: 'Canvas not visible.', switched_to: 'model view' })
  })
})

describe('canvas requests on the model view', () => {
  it('answers as before: no switch, no note', async () => {
    const t = setup('model')
    expect(await t.answer(t.ask('auto_layout'))).toEqual({ ok: true })
    expect(await t.answer(t.ask('jump_to_process', { code: 'a' }))).toEqual({ ok: true })
    expect(await t.answer(t.ask('screenshot_canvas'))).toEqual({
      rect: { x: 0, y: 0, width: 800, height: 600 }
    })
    expect(t.setView).not.toHaveBeenCalled()
  })
})

describe('a canvas request for a model that is not on screen', () => {
  it('refuses a chat run with what still works, and an external agent with the way to the model', async () => {
    const t = setup('model', { activeDb: 'b' })
    const chat = await t.answer(t.ask('get_canvas', {}, { database: 'a' }))
    expect(chat.error).toMatch(/"a" is not on screen/)
    expect(chat.error).toMatch(/modelling tools keep working/)
    const session = await t.answer(
      t.ask('get_canvas', {}, { chatId: undefined, sessionId: 's1', database: 'a' })
    )
    expect(session.error).toBe('The window shows "b", not "a". Call canvas_view action="open_model" first.')
    expect(t.ui.getCanvas).not.toHaveBeenCalled()
    // The model on screen is served.
    expect(await t.answer(t.ask('get_canvas', {}, { database: 'b' }))).toEqual({ nodes: [] })
  })
})

describe('requests that are not about the canvas', () => {
  it('are left to their owners', async () => {
    const t = setup('results')
    t.ask('ask_user', { questions: [] })
    t.ask('open_page', { page: 'model' })
    t.ask('set_chat_title', { title: 'x' })
    await new Promise((r) => setTimeout(r, 50))
    expect(t.answers).toEqual([])
  })
})
