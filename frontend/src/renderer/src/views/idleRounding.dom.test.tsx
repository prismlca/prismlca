import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, waitFor } from '@testing-library/react'
import { FlowRow } from './ActivityEditor'
import Parameters from './Parameters'
import FlowProperties from './FlowProperties'
import { renderWithPrism } from '../test/render'
import { makePrism } from '../test/prism'
import { DEFAULT_SETTINGS, setSettings } from '../lib/settings'

/**
 * The fields you type into read like the rest of the display and edit like the data: rounded to the
 * Settings digits while idle, the full stored number from the moment they take focus. The cases that
 * matter are the ones where the two could be confused — a focus that changes nothing must write nothing,
 * a typed value must not be hidden behind a rounded one, and an edit must start from every digit.
 */
// The digits are set before mounting, and settings write through window.prism.
beforeEach(() => {
  ;(window as unknown as { prism: unknown }).prism = makePrism().prism
})
afterEach(() => setSettings(DEFAULT_SETTINGS))

const digits = (round: Partial<typeof DEFAULT_SETTINGS.round>): void =>
  setSettings({ ...DEFAULT_SETTINGS, round: { ...DEFAULT_SETTINGS.round, ...round } })

describe('an exchange amount', () => {
  const flow = {
    uid: 'x1',
    input: { database: 'fg', code: 'c1', name: 'tap water', unit: 'kg', location: null },
    amount: 0.123456789,
    type: 'technosphere',
    direction: 'input' as const,
    formula: null,
    comment: null
  }
  const mount = (amount = flow.amount): { input: HTMLInputElement; onAmount: ReturnType<typeof vi.fn> } => {
    const onAmount = vi.fn()
    const { container } = renderWithPrism(
      <FlowRow
        flow={{ ...flow, amount }}
        readOnly={false}
        reference={false}
        onAmount={onAmount}
        onFormula={vi.fn()}
        onComment={vi.fn()}
        onRemove={vi.fn()}
      />
    )
    return { input: container.querySelector('.flow-amt input') as HTMLInputElement, onAmount }
  }

  it('is rounded to the Inputs / Outputs digits while idle, with the full number as its title', () => {
    digits({ io: 3 })
    const { input } = mount()
    expect(input.value).toBe('0.123')
    expect(input.title).toBe('0.123456789')
  })

  it('shows every digit while focused, and a focus that changes nothing writes nothing', () => {
    digits({ io: 3 })
    const { input, onAmount } = mount()
    fireEvent.focus(input)
    expect(input.value).toBe('0.123456789')
    fireEvent.blur(input)
    expect(onAmount).not.toHaveBeenCalled()
    expect(input.value).toBe('0.123')
  })

  it('keeps a typed value visible until the model holds it', () => {
    digits({ io: 3 })
    const { input, onAmount } = mount()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '0,987654321' } })
    fireEvent.blur(input)
    expect(onAmount).toHaveBeenCalledWith('x1', 0.987654321)
    // The write has not come back yet (the flow prop still holds the old amount): the field says what
    // was typed, not a rounding of either number.
    expect(input.value).toBe('0.987654321')
  })

  it('follows the setting live', () => {
    digits({ io: 3 })
    const { input } = mount()
    act(() => digits({ io: 5 }))
    expect(input.value).toBe('0.12346')
  })
})

describe('a typed parameter value', () => {
  const ROUTES = {
    'GET /api/v1/params': [
      {
        name: 'm_pvc',
        amount: 3.9512345678,
        formula: null,
        group_id: 'g1',
        group: 'Masses',
        description: null,
        unit: 'kg',
        rule: {}
      }
    ],
    'GET /api/v1/params/groups': [{ id: 'g1', name: 'Masses', order: 0 }],
    'GET /api/v1/model/audit': [],
    'POST /api/v1/params': {}
  }

  it('is rounded to the Parameters digits while idle and edited in full', async () => {
    digits({ parameters: 4 })
    const { container, prism } = renderWithPrism(<Parameters activeDb="M" />, { routes: ROUTES })
    const input = await waitFor(() => {
      const el = container.querySelector<HTMLInputElement>('.pc-val input')
      if (!el) throw new Error('no value field')
      return el
    })
    expect(input.value).toBe('3.951')
    fireEvent.focus(input)
    expect(input.value).toBe('3.9512345678')
    fireEvent.blur(input)
    expect(input.value).toBe('3.951')
    expect(prism.calls.filter((c) => c.method === 'POST')).toEqual([])
  })
})

describe('a flow property', () => {
  const PATH = '/api/v1/model/activities/fg/c1/properties'
  const routes = (amount: number, readOnly = false, post: unknown = {}): Record<string, unknown> => ({
    [`GET ${PATH}`]: {
      product: 'PVC',
      unit: 'kg',
      read_only: readOnly,
      properties: { 'carbon content': { amount, unit: 'dimensionless' } }
    },
    'GET /api/v1/model/property-vocabulary': { properties: [] },
    'POST /api/v1/model/properties': post
  })
  const mount = (amount: number, readOnly = false, post?: unknown): ReturnType<typeof renderWithPrism> =>
    renderWithPrism(<FlowProperties database="fg" code="c1" onClose={() => {}} onChanged={() => {}} />, {
      routes: routes(amount, readOnly, post)
    })
  /** A POST that answers only when the test says so — the window in which the races live. */
  const deferred = (): { handler: () => Promise<unknown>; answer: (reply: unknown) => void } => {
    let answer: (reply: unknown) => void = () => {}
    const handler = (): Promise<unknown> =>
      new Promise((resolve) => {
        answer = resolve
      })
    return { handler, answer: (reply) => answer(reply) }
  }
  const amountField = (container: HTMLElement): Promise<HTMLInputElement> =>
    waitFor(() => {
      const el = container.querySelector<HTMLInputElement>('input.props-amt')
      if (!el) throw new Error('no amount field')
      return el
    })

  it('never swallows what is typed while a write from Enter is still on its way', async () => {
    const post = deferred()
    const { container, prism } = mount(0.5, false, post.handler)
    const input = await amountField(container)
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '1' } })
    fireEvent.keyDown(input, { key: 'Enter' }) // writes, and the field keeps the focus
    await waitFor(() => expect(prism.calls.some((c) => c.method === 'POST')).toBe(true))
    fireEvent.change(input, { target: { value: '1.' } })
    await act(async () => post.answer({}))
    // "1." parses to the 1 that was written; the decimal point must survive regardless.
    expect(input.value).toBe('1.')
    fireEvent.change(input, { target: { value: '1.5' } })
    fireEvent.blur(input)
    await waitFor(() => {
      const posts = prism.calls.filter((c) => c.method === 'POST')
      expect(posts.at(-1)?.body).toMatchObject({ properties: { 'carbon content': { amount: 1.5 } } })
    })
  })

  it('an old confirmation of the same list does not settle a write of it still on its way', async () => {
    digits({ properties: 3 })
    // Two queued writes, answered by the test: the first (to 1) lands, the second (back to 0.55555) fails.
    const replies: Array<(reply: unknown) => void> = []
    const handler = (): Promise<unknown> => new Promise((resolve) => replies.push(resolve))
    const { container, findByText, prism } = mount(0.55555, false, handler)
    const input = await amountField(container)
    const posts = (): number => prism.calls.filter((c) => c.method === 'POST').length
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '1' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(posts()).toBe(1))
    fireEvent.change(input, { target: { value: '0.55555' } })
    fireEvent.keyDown(input, { key: 'Enter' }) // queued behind the first
    fireEvent.blur(input) // the loaded list again — confirmed once, but a write of it is pending
    expect(input.value).toBe('0.55555')
    await act(async () => replies[0]({}))
    await waitFor(() => expect(posts()).toBe(2))
    await act(async () => replies[1]({ status: 422, body: { detail: 'refused' } }))
    await findByText(/Not saved/)
    // The model holds 1 now; a rounded 0.556 would claim the restore went through.
    expect(input.value).toBe('0.55555')
  })

  it('an earlier write that lands does not settle a later edit still queued behind it', async () => {
    digits({ properties: 3 })
    // Three queued writes, A → B → A: the first two land, the last one fails.
    const replies: Array<(reply: unknown) => void> = []
    const handler = (): Promise<unknown> => new Promise((resolve) => replies.push(resolve))
    const { container, findByText, prism } = mount(0.5, false, handler)
    const input = await amountField(container)
    const posts = (): number => prism.calls.filter((c) => c.method === 'POST').length
    fireEvent.focus(input)
    for (const typed of ['0.55555', '1', '0.55555']) {
      fireEvent.change(input, { target: { value: typed } })
      fireEvent.keyDown(input, { key: 'Enter' })
    }
    fireEvent.blur(input)
    await waitFor(() => expect(posts()).toBe(1))
    await act(async () => replies[0]({})) // the first A: its text is what the field reads again
    await waitFor(() => expect(posts()).toBe(2))
    await act(async () => replies[1]({}))
    await waitFor(() => expect(posts()).toBe(3))
    await act(async () => replies[2]({ status: 422, body: { detail: 'refused' } }))
    await findByText(/Not saved/)
    // The model holds 1: the field must not claim 0.556 was stored.
    expect(input.value).toBe('0.55555')
  })

  it('stays as typed while the write is pending, and after it fails', async () => {
    digits({ properties: 3 })
    const post = deferred()
    const { container, findByText, prism } = mount(0.5, false, post.handler)
    const input = await amountField(container)
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '0.77777' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(prism.calls.some((c) => c.method === 'POST')).toBe(true))
    fireEvent.blur(input) // the same list again: nothing new to send, and nothing confirmed yet
    expect(input.value).toBe('0.77777')
    await act(async () => post.answer({ status: 422, body: { detail: 'refused' } }))
    await findByText(/Not saved/)
    // The model still holds 0.5: a rounded 0.778 here would be a value it does not have.
    expect(input.value).toBe('0.77777')
  })

  it('is rounded while idle, edited from every digit, and an untouched row is sent exactly', async () => {
    digits({ properties: 3 })
    const { container, prism } = mount(0.4561234)
    const input = await waitFor(() => {
      const el = container.querySelector<HTMLInputElement>('input.props-amt')
      if (!el) throw new Error('no amount field')
      return el
    })
    expect(input.value).toBe('0.456')
    fireEvent.focus(input)
    // The edit starts from the stored number — it used to start from the rounded text, so one digit
    // typed at the end saved 0.4567 over 0.4561234.
    expect(input.value).toBe('0.4561234')
    fireEvent.blur(input)
    expect(prism.calls.filter((c) => c.method === 'POST')).toEqual([])
    expect(input.value).toBe('0.456')
  })

  it('reads rounded again once a typed amount is stored', async () => {
    digits({ properties: 3 })
    const { container, prism } = mount(0.5)
    const input = await waitFor(() => {
      const el = container.querySelector<HTMLInputElement>('input.props-amt')
      if (!el) throw new Error('no amount field')
      return el
    })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '0,77777' } })
    fireEvent.blur(input)
    await waitFor(() => expect(prism.calls.some((c) => c.method === 'POST')).toBe(true))
    await waitFor(() => expect(input.value).toBe('0.778'))
  })

  it('is rounded read-only too, with the full number as its title', async () => {
    digits({ properties: 3 })
    const { container } = mount(0.4561234, true)
    const cell = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('.props-amt.ro')
      if (!el) throw new Error('no read-only amount')
      return el
    })
    expect(cell.textContent).toBe('0.456')
    expect(cell.title).toBe('0.4561234')
  })
})
