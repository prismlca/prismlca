import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CanvasChat, { ToolTraceList } from './CanvasChat'
import { renderWithPrism } from './test/render'
import { setAS } from './lib/appSettings'
import type { ChatPlan, ChatRun } from '../../shared/plan'
import { DEFAULT_MAX_COST_USD } from '../../shared/aiDefaults'

/**
 * The plan card beside the chat dock and the Continue button of a stopped run.
 *
 * Its own file because the model catalogue is cached per module registry (see
 * CanvasChat.model.dom.test.tsx): the frozen case needs a catalogue row with `planTool: false`.
 */
const ui = {
  jumpToProcess: vi.fn(),
  autoLayout: vi.fn(),
  screenshotRect: () => null,
  calculateInCanvas: vi.fn(),
  setupResults: vi.fn(),
  getCanvas: vi.fn(),
  clearCanvas: vi.fn(),
  removeFromCanvas: vi.fn(),
  refresh: vi.fn()
}

const CATALOGUE = [
  {
    id: 'anthropic/claude-sonnet-5.5',
    provider: 'openrouter',
    label: 'Planner',
    descriptor: '',
    planTool: true
  },
  { id: 'lab/frozen', provider: 'openrouter', label: 'No plans', descriptor: '', planTool: false }
]

const plan = (over: Partial<ChatPlan> = {}): ChatPlan => ({
  title: 'Build the bike model',
  revision: 1,
  updated: '2026-10-01T10:00:00Z',
  steps: [
    { step: 'Find the frame dataset', status: 'completed', note: 'aluminium, RER' },
    { step: 'Add the wheels', status: 'in_progress' },
    { step: 'Calculate GWP', status: 'pending' }
  ],
  ...over
})
const stopped = (over: Partial<ChatRun> = {}): ChatRun => ({
  runId: 'r1',
  state: 'stopped',
  outcome: 'rounds',
  ...over
})

const mount = (stored: { plan?: ChatPlan | null; run?: ChatRun | null } = {}) => {
  const send = vi.fn(async (_req: Record<string, unknown>) => ({ ok: true }))
  const r = renderWithPrism(<CanvasChat activeDb="m" ui={ui} />, {
    routes: {
      'GET /api/v1/ai/chats/m': {
        chats: [{ id: 'c1', title: 'Bike', created: '', updated: '', message_count: 1 }]
      },
      'GET /api/v1/ai/chats/m/c1': {
        id: 'c1',
        title: 'Bike',
        messages: [{ role: 'assistant', content: '_Stopped after 150 rounds._' }],
        ...stored
      },
      'POST /api/v1/ai/chats/m/:id/messages': {},
      'GET /api/v1/ai/skills': { skills: [] },
      'GET /api/v1/study': { compared_with: [] },
      'GET /api/v1/databases': [],
      'GET /api/v1/databases/folders': { folders: [], of: {} }
    },
    overrides: { ai: { send, models: async () => CATALOGUE } }
  })
  return { ...r, send }
}
/** Wait until the chat GET has landed (the newest chat is opened on mount). */
const loaded = (prism: { calls: Array<{ path: string }> }): Promise<void> =>
  waitFor(() => expect(prism.calls.some((c) => c.path === '/api/v1/ai/chats/m/c1')).toBe(true))

describe('the plan card', () => {
  it('opens on a new plan and shows its steps, with the counter', async () => {
    const { prism } = mount()
    await loaded(prism)
    expect(screen.queryByRole('region', { name: /Plan:/ })).toBeNull()

    act(() => prism.emit({ chatId: 'c1', type: 'plan', plan: plan() }))
    const card = await screen.findByRole('region', { name: 'Plan: Build the bike model' })
    expect(card).toHaveTextContent('1 / 3')
    expect(card).toHaveTextContent('Find the frame dataset')
    expect(card).toHaveTextContent('aluminium, RER')
    expect(card.querySelector('.plan-step.in_progress')).toHaveTextContent('Add the wheels')
  })

  it('stays collapsed across updates once the user collapsed it, and re-opens on a new plan', async () => {
    const user = userEvent.setup()
    const { prism } = mount()
    await loaded(prism)
    act(() => prism.emit({ chatId: 'c1', type: 'plan', plan: plan() }))
    await user.click(await screen.findByRole('button', { name: 'Collapse plan' }))
    expect(screen.queryByRole('region', { name: /Plan:/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Show plan/ })).toHaveTextContent('1 / 3')

    // An update of the same plan: the pill counts on, the card stays shut.
    const next = plan({ revision: 2 })
    next.steps[1] = { step: 'Add the wheels', status: 'completed' }
    next.steps[2] = { step: 'Calculate GWP', status: 'in_progress' }
    act(() => prism.emit({ chatId: 'c1', type: 'plan', plan: next }))
    expect(screen.queryByRole('region', { name: /Plan:/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Show plan/ })).toHaveTextContent('2 / 3')

    // A new plan (another title) opens it again.
    act(() =>
      prism.emit({ chatId: 'c1', type: 'plan', plan: plan({ title: 'Compare two frames', revision: 4 }) })
    )
    expect(await screen.findByRole('region', { name: 'Plan: Compare two frames' })).toBeInTheDocument()
  })

  it('loads a stored plan collapsed — the pill, not the card — and the pill opens it', async () => {
    const user = userEvent.setup()
    mount({ plan: plan({ revision: 3 }) })
    const pill = await screen.findByRole('button', { name: /Show plan/ })
    expect(pill).toHaveTextContent('1 / 3')
    expect(screen.queryByRole('region', { name: /Plan:/ })).toBeNull()
    await user.click(pill)
    expect(screen.getByRole('region', { name: /Plan:/ })).toBeInTheDocument()
  })

  it('shows a finished plan as a tick, and a stopped run as the pill tooltip', async () => {
    const done = plan({
      steps: [
        { step: 'One', status: 'completed' },
        { step: 'Two', status: 'skipped', note: 'n/a' }
      ]
    })
    mount({ plan: done, run: stopped({ outcome: 'interrupted', state: 'interrupted' }) })
    const pill = await screen.findByRole('button', { name: /Show plan/ })
    expect(pill).toHaveTextContent('✓')
    expect(pill).toHaveTextContent('2 / 2')
    expect(pill.getAttribute('title')).toContain('PrismLCA was closed during the run')
  })

  it('collapses on Escape while it has the focus', async () => {
    const { prism } = mount()
    await loaded(prism)
    act(() => prism.emit({ chatId: 'c1', type: 'plan', plan: plan() }))
    const card = await screen.findByRole('region', { name: /Plan:/ })
    fireEvent.focus(card)
    fireEvent.keyDown(card, { key: 'Escape' })
    expect(screen.queryByRole('region', { name: /Plan:/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Show plan/ })).toBeInTheDocument()
  })
})

/**
 * On a small screen there is no room for the card beside the dock, and it opens over the transcript —
 * so it never opens there by itself. jsdom lays nothing out: the column's width and the dock's offset
 * are set here, and the resize observer is fired by hand.
 */
describe('the plan card without room beside the dock', () => {
  let offsetLeft = 100
  const observers: Array<() => void> = []
  beforeEach(() => {
    offsetLeft = 100
    observers.length = 0
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(() => offsetLeft)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          observers.push(cb)
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    )
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('shows a new plan as the pill, and the pill opens it over the transcript', async () => {
    const user = userEvent.setup()
    const { prism } = mount()
    await loaded(prism)
    act(() => prism.emit({ chatId: 'c1', type: 'plan', plan: plan() }))
    const pill = await screen.findByRole('button', { name: /Show plan/ })
    expect(pill).toHaveTextContent('1 / 3')
    expect(screen.queryByRole('region', { name: /Plan:/ })).toBeNull()
    await user.click(pill)
    expect(screen.getByRole('region', { name: /Plan:/ })).toHaveClass('overlay')
  })

  it('folds an open card to the pill when the column becomes too narrow', async () => {
    offsetLeft = 400
    const { prism } = mount()
    await loaded(prism)
    act(() => prism.emit({ chatId: 'c1', type: 'plan', plan: plan() }))
    expect(await screen.findByRole('region', { name: /Plan:/ })).not.toHaveClass('overlay')
    offsetLeft = 100
    act(() => observers.forEach((fire) => fire()))
    expect(screen.queryByRole('region', { name: /Plan:/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Show plan/ })).toBeInTheDocument()
  })
})

describe('Continue', () => {
  it('sends "Continue with the plan." from the card header after a round-limit stop', async () => {
    const user = userEvent.setup()
    const { send } = mount({ plan: plan({ revision: 2 }), run: stopped() })
    await user.click(await screen.findByRole('button', { name: /Show plan/ }))
    expect(screen.getByRole('region', { name: /Plan:/ })).toHaveTextContent('Stopped: round limit')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][0].userText).toBe('Continue with the plan.')
  })

  it('without a plan, sits in the transcript and sends "Continue where you stopped."', async () => {
    const user = userEvent.setup()
    const { send } = mount({ run: stopped({ outcome: 'cancelled' }) })
    await user.click(await screen.findByRole('textbox')) // opens the panel
    await user.click(await screen.findByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][0].userText).toBe('Continue where you stopped.')
  })

  it('after a cost stop asks twice, naming the CURRENT limit, and sends once', async () => {
    const user = userEvent.setup()
    // The run was stopped against $5; the settings now hold the default. The next run is stopped
    // against the CURRENT setting, so that is the figure the confirmation names.
    const { send } = mount({
      plan: plan({ revision: 2 }),
      run: stopped({ outcome: 'cost', costLimitUsd: 5 })
    })
    await user.click(await screen.findByRole('button', { name: /Show plan/ }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(send).not.toHaveBeenCalled()
    const confirm = screen.getByRole('button', { name: `Spend up to another $${DEFAULT_MAX_COST_USD}` })
    await user.dblClick(confirm)
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][0].userText).toBe('Continue with the plan.')
  })

  it('is not offered after an answered run', async () => {
    const user = userEvent.setup()
    mount({ plan: plan({ revision: 2 }), run: stopped({ outcome: 'answered' }) })
    await user.click(await screen.findByRole('button', { name: /Show plan/ }))
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  })
})

describe('a model without the plan tool', () => {
  it('freezes the plan: no auto-open, a hint in the header, Continue still there', async () => {
    const user = userEvent.setup()
    const { prism, send } = mount({ plan: plan({ revision: 2 }), run: stopped() })
    act(() => setAS({ model: 'lab/frozen' }))
    await screen.findByRole('button', { name: /Show plan/ })
    // Give the catalogue a moment to arrive, then a "new" plan must not open the card.
    await waitFor(() => expect(screen.getByText('No plans')).toBeInTheDocument())
    act(() => prism.emit({ chatId: 'c1', type: 'plan', plan: plan({ title: 'Another plan', revision: 1 }) }))
    expect(screen.queryByRole('region', { name: /Plan:/ })).toBeNull()

    await user.click(screen.getByRole('button', { name: /Show plan/ }))
    const card = screen.getByRole('region', { name: /Plan:/ })
    expect(card).toHaveTextContent('Plan from an earlier run; this model does not maintain plans')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  })
})

describe('the plan call in the transcript', () => {
  it('is one line with the counter, not a second copy of the list', () => {
    const preview = 'Plan updated.\nPlan "Build" (rev 2, 3/7 done)\n[x] 1. Find frame'
    renderWithPrism(
      <ToolTraceList
        traces={[{ name: 'plan', status: 'ok', ms: 5, preview, resultChars: preview.length }]}
        labels={{ plan: 'Task plan' }}
      />
    )
    expect(screen.getByText('Plan updated · 3/7')).toBeInTheDocument()
  })
})
