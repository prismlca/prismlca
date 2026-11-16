import { describe, expect, it, vi, type Mock } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import type { Node } from '@xyflow/react'

import { useTurnFeed } from '../chat/turnView'
import type { MethodEntry } from '../lib/methods'
import { renderWithPrism } from '../test/render'
import { LOOK_AGAIN_MS, LOOKS, useRunCalculationOnCanvas } from './useRunCalculationOnCanvas'

const IPCC = ['IPCC 2021', 'climate change', 'GWP100']
const METHODS: MethodEntry[] = [
  { method: ['CML v4.8 2016', 'climate change', 'GWP 100a'], name: 'CML', unit: 'kg CO2-Eq' },
  { method: IPCC, name: 'IPCC', unit: 'kg CO2-Eq' }
]
/** Each model's chats, as the backend lists them. */
const CHATS: Record<string, string[]> = { m: ['chat-m'], other: ['chat-other'] }
const chatRoute = (_body: unknown, path: string): unknown => ({
  chats: (CHATS[decodeURIComponent(path.split('/').pop() ?? '')] ?? []).map((id) => ({ id }))
})

interface Spies {
  selectOnly: Mock<(id: string) => void>
  setChosen: Mock<(v: string) => void>
}

const boxes = (...ids: string[]): { current: Node[] } => ({ current: ids.map((id) => ({ id }) as Node) })

/** The Workbench holds the turn feed and this hook for its whole lifetime; this stands in for it. */
function Holder({
  activeDb,
  spies,
  nodesRef = boxes('m/fu', 'm/part')
}: {
  activeDb: string | null
  spies: Spies
  nodesRef?: { current: Node[] }
}): null {
  useTurnFeed()
  useRunCalculationOnCanvas({
    activeDb,
    methods: METHODS,
    setChosen: spies.setChosen,
    canvas: { selectOnly: spies.selectOnly, nodesRef }
  })
  return null
}

const spies = (): Spies => ({
  selectOnly: vi.fn<(id: string) => void>(),
  setChosen: vi.fn<(v: string) => void>()
})
const calculated = (chatId: string, args: unknown, status: 'ok' | 'error' = 'ok') => ({
  chatId,
  type: 'done',
  text: '73 kg CO2e with IPCC 2021.',
  trace: [{ name: 'calculate', args: JSON.stringify(args), status }]
})
const chatLookups = (calls: Array<{ path: string }>): number =>
  calls.filter((c) => c.path.startsWith('/api/v1/ai/chats/')).length

describe('the toolbar after a run that calculated', () => {
  it("selects the run's process and sets its method when a run of the model on screen ends", async () => {
    const s = spies()
    const { prism } = renderWithPrism(<Holder activeDb="m" spies={s} />, {
      routes: { 'GET /api/v1/ai/chats/:db': chatRoute }
    })
    act(() => prism.emit(calculated('chat-m', { code: 'fu', method: IPCC })))
    await waitFor(() => expect(s.setChosen).toHaveBeenCalledWith('1'))
    expect(s.selectOnly).toHaveBeenCalledWith('m/fu')
  })

  it('changes nothing for a run of another model', async () => {
    const s = spies()
    const { prism } = renderWithPrism(<Holder activeDb="m" spies={s} />, {
      routes: { 'GET /api/v1/ai/chats/:db': chatRoute }
    })
    act(() => prism.emit(calculated('chat-other', { code: 'fu', method: IPCC })))
    await waitFor(() => expect(chatLookups(prism.calls)).toBe(1))
    await act(async () => {})
    expect(s.selectOnly).not.toHaveBeenCalled()
    expect(s.setChosen).not.toHaveBeenCalled()
  })

  it('changes nothing when the user opened another model before the answer came', async () => {
    const s = spies()
    let answer: (v: unknown) => void = () => {}
    const { prism, rerender } = renderWithPrism(<Holder activeDb="m" spies={s} />, {
      routes: { 'GET /api/v1/ai/chats/:db': () => new Promise((resolve) => (answer = resolve)) }
    })
    act(() => prism.emit(calculated('chat-m', { code: 'fu', method: IPCC })))
    await waitFor(() => expect(chatLookups(prism.calls)).toBe(1))
    rerender(<Holder activeDb="other" spies={s} />)
    await act(async () => answer({ chats: [{ id: 'chat-m' }] }))
    expect(s.selectOnly).not.toHaveBeenCalled()
    expect(s.setChosen).not.toHaveBeenCalled()
  })

  it('asks nothing after a run that calculated nothing, or whose calculation failed', async () => {
    const s = spies()
    const { prism } = renderWithPrism(<Holder activeDb="m" spies={s} />, {
      routes: { 'GET /api/v1/ai/chats/:db': chatRoute }
    })
    act(() => prism.emit({ chatId: 'chat-m', type: 'done', text: 'Hello.', trace: [] }))
    act(() => prism.emit(calculated('chat-m', { code: 'fu', method: IPCC }, 'error')))
    await act(async () => {})
    expect(chatLookups(prism.calls)).toBe(0)
    expect(s.selectOnly).not.toHaveBeenCalled()
  })

  it('reads a failed run from the rows its turn assembled', async () => {
    const s = spies()
    const { prism } = renderWithPrism(<Holder activeDb="m" spies={s} />, {
      routes: { 'GET /api/v1/ai/chats/:db': chatRoute }
    })
    const args = JSON.stringify({ code: 'part', method: IPCC })
    act(() => {
      prism.emit({ chatId: 'chat-m', type: 'tool', name: 'calculate', callId: '1.0', phase: 'start', args })
      prism.emit({ chatId: 'chat-m', type: 'tool', name: 'calculate', callId: '1.0', phase: 'done' })
      prism.emit({ chatId: 'chat-m', type: 'error', message: 'Provider down' })
    })
    await waitFor(() => expect(s.selectOnly).toHaveBeenCalledWith('m/part'))
    expect(s.setChosen).toHaveBeenCalledWith('1')
  })
})

/**
 * A process created in the run's last moments is not a box until the canvas has reloaded after the run's
 * last edit. The method is set at once; the box is looked for again a few times and selected once it is
 * there — for the model on screen only, and not over a newer run's choice.
 */
describe('a process the canvas does not show yet', () => {
  const step = async (ms: number): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }
  const setup = (nodesRef: { current: Node[] }) => {
    const s = spies()
    const r = renderWithPrism(<Holder activeDb="m" spies={s} nodesRef={nodesRef} />, {
      routes: { 'GET /api/v1/ai/chats/:db': chatRoute }
    })
    return { s, ...r }
  }

  it('is selected as soon as the canvas shows it', async () => {
    vi.useFakeTimers()
    try {
      const nodesRef = boxes('m/fu')
      const { s, prism } = setup(nodesRef)
      act(() => prism.emit(calculated('chat-m', { code: 'new', method: IPCC })))
      await step(0)
      expect(s.setChosen).toHaveBeenCalledWith('1') // the method does not wait
      await step(LOOK_AGAIN_MS)
      await step(LOOK_AGAIN_MS)
      expect(s.selectOnly).not.toHaveBeenCalled()
      nodesRef.current = [...nodesRef.current, { id: 'm/new' } as Node]
      await step(LOOK_AGAIN_MS)
      expect(s.selectOnly).toHaveBeenCalledTimes(1)
      expect(s.selectOnly).toHaveBeenCalledWith('m/new')
    } finally {
      vi.useRealTimers()
    }
  })

  it('is given up after the last look, silently', async () => {
    vi.useFakeTimers()
    try {
      const nodesRef = boxes('m/fu')
      const { s, prism } = setup(nodesRef)
      act(() => prism.emit(calculated('chat-m', { code: 'new', method: IPCC })))
      await step(0)
      await step(LOOK_AGAIN_MS * LOOKS)
      expect(vi.getTimerCount()).toBe(0)
      // Too late to come out of nowhere.
      nodesRef.current = [...nodesRef.current, { id: 'm/new' } as Node]
      await step(LOOK_AGAIN_MS * 3)
      expect(s.selectOnly).not.toHaveBeenCalled()
      expect(s.setChosen).toHaveBeenCalledWith('1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('is not selected once another model is on screen', async () => {
    vi.useFakeTimers()
    try {
      const nodesRef = boxes('m/fu')
      const { s, prism, rerender } = setup(nodesRef)
      act(() => prism.emit(calculated('chat-m', { code: 'new', method: IPCC })))
      await step(0)
      rerender(<Holder activeDb="other" spies={s} nodesRef={nodesRef} />)
      nodesRef.current = [...nodesRef.current, { id: 'm/new' } as Node]
      await step(LOOK_AGAIN_MS * LOOKS)
      expect(s.selectOnly).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('is not selected over a newer run, nor after the Workbench is gone', async () => {
    vi.useFakeTimers()
    try {
      const nodesRef = boxes('m/fu')
      const { s, prism, unmount } = setup(nodesRef)
      act(() => prism.emit(calculated('chat-m', { code: 'new', method: IPCC })))
      await step(0)
      // A newer run of the same model ends with a process that is on the canvas.
      act(() => prism.emit(calculated('chat-m', { code: 'fu', method: IPCC })))
      await step(0)
      expect(s.selectOnly).toHaveBeenLastCalledWith('m/fu')
      nodesRef.current = [...nodesRef.current, { id: 'm/new' } as Node]
      await step(LOOK_AGAIN_MS * LOOKS)
      expect(s.selectOnly).not.toHaveBeenCalledWith('m/new')

      // A wait still running when the hook unmounts ends with it.
      act(() => prism.emit(calculated('chat-m', { code: 'newer', method: IPCC })))
      await step(0)
      unmount()
      expect(vi.getTimerCount()).toBe(0)
      nodesRef.current = [...nodesRef.current, { id: 'm/newer' } as Node]
      await step(LOOK_AGAIN_MS * LOOKS)
      expect(s.selectOnly).not.toHaveBeenCalledWith('m/newer')
    } finally {
      vi.useRealTimers()
    }
  })
})
