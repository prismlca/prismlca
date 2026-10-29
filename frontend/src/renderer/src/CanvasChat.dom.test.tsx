import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReactFlow, ReactFlowProvider } from '@xyflow/react'
import CanvasChat, { AskUserCard, formatArgs, shortSkillName, ToolTraceList } from './CanvasChat'
import CanvasMinimap from './components/CanvasMinimap'
import { useTurnFeed } from './chat/turnView'
import type { ToolTrace } from './lib/ai'
import { renderWithPrism } from './test/render'

/**
 * The chat's two honesty surfaces, and the corner it shares with the canvas minimap.
 *
 * The summary line is the only account a user gets of what a run did, and it has told a false story
 * twice: once reading tool time as wall clock ("10 min" on a 42-minute turn), and once saying "54
 * tool calls" while three of a batch's items had been lost to a dropped socket. Both are now facts
 * this file asserts rather than things someone has to notice.
 */

const trace = (over: Partial<ToolTrace> = {}): ToolTrace => ({
  name: 'calculate',
  status: 'ok',
  ms: 100,
  ...over
})
const LABELS = { calculate: 'Calculate impact score', edit_exchange: 'Add / change exchange' }

describe('the finished-turn summary line', () => {
  it('says the time is time IN TOOLS, not how long the turn took', async () => {
    // A 42-minute turn showed "10 min" and read as a wall clock. The word is the fix.
    const traces = [trace({ ms: 300_000 }), trace({ ms: 300_000 })]
    render(<ToolTraceList traces={traces} labels={LABELS} summary />)
    expect(screen.getByRole('button')).toHaveTextContent('2 tool calls')
    expect(screen.getByRole('button')).toHaveTextContent('10 min in tools')
  })

  it('counts a rejected call and a half-failed batch separately', async () => {
    // A batch call SUCCEEDS while part of its work does not — calling those rejected would be as
    // wrong as the silence was. Three of six processes were lost this way and the line said nothing.
    const traces = [trace({ status: 'rejected' }), trace({ name: 'edit_exchange', itemsFailed: 3 }), trace()]
    render(<ToolTraceList traces={traces} labels={LABELS} summary />)
    const line = screen.getByRole('button')
    expect(line).toHaveTextContent('1 rejected')
    expect(line).toHaveTextContent('3 batch items failed')
  })

  it("keeps a tool's attribution notice on screen under the folded line, once per distinct text", () => {
    // openrouteservice and Mapbox require their attribution to be DISPLAYED; a folded turn must not
    // hide it. Two distances calls with the same attribution print it once.
    const notice = 'Routing © openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors'
    const traces = [trace({ name: 'distances', notice }), trace({ name: 'distances', notice }), trace()]
    render(<ToolTraceList traces={traces} labels={LABELS} summary />)
    expect(screen.getByRole('button')).toHaveTextContent('3 tool calls')
    expect(screen.getAllByText(notice)).toHaveLength(1)
  })

  it('counts one failed item in the singular (V107)', () => {
    const traces = [trace({ name: 'edit_exchange', itemsFailed: 1 }), trace()]
    render(<ToolTraceList traces={traces} labels={LABELS} summary />)
    const line = screen.getByRole('button')
    expect(line).toHaveTextContent('1 batch item failed')
    expect(line).not.toHaveTextContent('items failed')
  })

  it('does not call a failed call rejected (V98)', () => {
    // A `calculate` that died on its arguments was summarised as "1 refused" while the same row,
    // expanded, said "failed" — the collapsed view contradicting the list it opens into. Refused is
    // a decision (a guardrail, a user); failed is a broken call, and they lead somewhere different.
    const traces = [trace({ status: 'error' }), trace({ status: 'rejected' }), trace()]
    const line =
      (render(<ToolTraceList traces={traces} labels={LABELS} summary />), screen.getByRole('button'))
    expect(line).toHaveTextContent('1 failed')
    expect(line).toHaveTextContent('1 rejected')
  })

  it('stays quiet about failures when there were none', () => {
    render(<ToolTraceList traces={[trace(), trace()]} labels={LABELS} summary />)
    const line = screen.getByRole('button')
    expect(line).not.toHaveTextContent('rejected')
    expect(line).not.toHaveTextContent('batch items failed')
  })

  it('shows the cost with enough digits to not read as free, and the provider', () => {
    render(
      <ToolTraceList traces={[trace(), trace()]} labels={LABELS} summary cost={0.0042} provider="Alibaba" />
    )
    expect(screen.getByRole('button')).toHaveTextContent('$0.0042')
    expect(screen.getByRole('button')).toHaveTextContent('Alibaba')

    // Which endpoint served it is the answer to "why was this run four times slower than the last".
    render(<ToolTraceList traces={[trace(), trace()]} labels={LABELS} summary cost={2.03} />)
    expect(screen.getAllByRole('button')[1]).toHaveTextContent('$2.03')
  })

  it('opens to the full list, and never collapses a single call', async () => {
    const user = userEvent.setup()
    const { unmount } = render(<ToolTraceList traces={[trace(), trace()]} labels={LABELS} summary />)
    await user.click(screen.getByRole('button'))
    expect(screen.getAllByText('Calculate impact score')).toHaveLength(2)
    unmount()

    // One call is not a list worth hiding.
    render(<ToolTraceList traces={[trace()]} labels={LABELS} summary />)
    expect(screen.getByText('Calculate impact score')).toBeInTheDocument()
  })
})

describe('AskUserCard', () => {
  const q = (question: string, opts: string[], multiSelect = false) => ({
    question,
    options: opts.map((label) => ({ label })),
    multiSelect
  })

  it('answers a single question on the click itself — no extra confirm', async () => {
    const user = userEvent.setup()
    const onAnswer = vi.fn()
    render(
      <AskUserCard
        ask={{ chatId: 'c1', reqId: '1', questions: [q('Which geography?', ['DE', 'RER'])] }}
        onAnswer={onAnswer}
      />
    )

    await user.click(screen.getByText('RER'))
    expect(onAnswer).toHaveBeenCalledWith([['RER']], [false])
    expect(screen.queryByRole('button', { name: 'Answer' })).toBeNull()
  })

  it('collects several questions into one form with one Answer', async () => {
    // The point of the change: three questions used to stop the run three times, each waiting on a
    // human who may be away for hours.
    const user = userEvent.setup()
    const onAnswer = vi.fn()
    render(
      <AskUserCard
        ask={{
          chatId: 'c1',
          reqId: '1',
          questions: [q('Geography?', ['DE', 'RER']), q('End of life?', ['Recycling', 'Incineration'])]
        }}
        onAnswer={onAnswer}
      />
    )

    const answer = screen.getByRole('button', { name: 'Answer' })
    expect(answer).toBeDisabled() // a half-answered form leaves the agent guessing

    await user.click(screen.getByText('DE'))
    expect(answer).toBeDisabled()
    await user.click(screen.getByText('Incineration'))
    expect(answer).toBeEnabled()

    await user.click(answer)
    expect(onAnswer).toHaveBeenCalledWith([['DE'], ['Incineration']], [false, false])
  })

  it('lets a multi-select question take several, and a single-select replace', async () => {
    const user = userEvent.setup()
    const onAnswer = vi.fn()
    render(
      <AskUserCard
        ask={{ chatId: 'c1', reqId: '1', questions: [q('Which indicators?', ['GWP', 'AP', 'EP'], true)] }}
        onAnswer={onAnswer}
      />
    )
    await user.click(screen.getByText('GWP'))
    await user.click(screen.getByText('EP'))
    await user.click(screen.getByRole('button', { name: 'Answer' }))
    expect(onAnswer).toHaveBeenCalledWith([['GWP', 'EP']], [false])
  })

  it('deselects on a second click in a multi-select', async () => {
    const user = userEvent.setup()
    const onAnswer = vi.fn()
    render(
      <AskUserCard
        ask={{ chatId: 'c1', reqId: '1', questions: [q('Which indicators?', ['GWP', 'AP'], true)] }}
        onAnswer={onAnswer}
      />
    )
    await user.click(screen.getByText('GWP'))
    await user.click(screen.getByText('AP'))
    await user.click(screen.getByText('GWP'))
    await user.click(screen.getByRole('button', { name: 'Answer' }))
    expect(onAnswer).toHaveBeenCalledWith([['AP']], [false])
  })

  it('opens "Something else…" into a field only on a click, and sends the typed answer with Enter', async () => {
    const user = userEvent.setup()
    const onAnswer = vi.fn()
    render(
      <AskUserCard
        ask={{ chatId: 'c1', reqId: '1', questions: [q('Which geography?', ['DE', 'RER'])] }}
        onAnswer={onAnswer}
      />
    )
    expect(screen.queryByRole('textbox')).toBeNull() // closed until asked for

    await user.click(screen.getByRole('button', { name: 'Something else…' }))
    const field = screen.getByRole('textbox', { name: 'Your own answer to: Which geography?' })
    expect(field).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

    await user.type(field, 'Swiss mix{Shift>}{Enter}{/Shift}please')
    expect(onAnswer).not.toHaveBeenCalled() // Shift+Enter breaks the line
    await user.keyboard('{Enter}')
    expect(onAnswer).toHaveBeenCalledWith([['Swiss mix\nplease']], [true])
  })

  it('lets a typed answer stand in for an option in a form, and a picked option withdraw it', async () => {
    const user = userEvent.setup()
    const onAnswer = vi.fn()
    render(
      <AskUserCard
        ask={{
          chatId: 'c1',
          reqId: '1',
          questions: [q('Geography?', ['DE', 'RER']), q('End of life?', ['Recycling', 'Incineration'])]
        }}
        onAnswer={onAnswer}
      />
    )
    const answer = screen.getByRole('button', { name: 'Answer' })
    await user.click(screen.getByText('DE'))
    await user.click(screen.getAllByRole('button', { name: 'Something else…' })[1])
    expect(answer).toBeDisabled() // an empty field answers nothing
    await user.type(screen.getByRole('textbox'), 'As in the EPD')
    expect(answer).toBeEnabled()
    await user.click(answer)
    expect(onAnswer).toHaveBeenLastCalledWith([['DE'], ['As in the EPD']], [false, true])

    // Picking an option closes the field; its text no longer counts.
    await user.click(screen.getByText('Incineration'))
    expect(screen.queryByRole('textbox')).toBeNull()
    await user.click(answer)
    expect(onAnswer).toHaveBeenLastCalledWith([['DE'], ['Incineration']], [false, false])
  })

  it('closes the field on Escape', async () => {
    const user = userEvent.setup()
    render(
      <AskUserCard
        ask={{ chatId: 'c1', reqId: '1', questions: [q('Which geography?', ['DE', 'RER'])] }}
        onAnswer={vi.fn()}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Something else…' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('button', { name: 'Something else…' })).toBeInTheDocument()
  })
})

describe('formatArgs', () => {
  it('pretty-prints JSON and passes malformed arguments through unchanged', () => {
    expect(formatArgs('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(formatArgs('not json')).toBe('not json')
  })

  it('shows nothing for a call that took no arguments', () => {
    expect(formatArgs('{}')).toBeNull()
    expect(formatArgs(undefined)).toBeNull()
    expect(formatArgs('')).toBeNull()
  })
})

/**
 * The corner the chat shares with the minimap.
 *
 * The map does not float next to the chat with a `bottom:` of its own — it is handed in as the slot
 * above the input pill, so the pill's height (which grows with a wrapped draft or an attachment
 * chip) is the offset, and expanding the transcript takes the slot back instead of fighting it for a
 * z-index. Both halves of that are what this describes.
 */
describe('the dock above the input pill', () => {
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
  const mount = (): ReturnType<typeof renderWithPrism> =>
    renderWithPrism(<CanvasChat activeDb="m" ui={ui} aboveBar={<div data-testid="minimap">map</div>} />, {
      routes: { 'GET /api/v1/ai/chats/m': { chats: [] } }
    })

  it('puts the slot in the same column as the input pill, directly above it', async () => {
    const { container } = mount()
    const map = await screen.findByTestId('minimap')
    const bar = container.querySelector('.chat-bar')!
    const dock = container.querySelector('.canvas-chat')!

    // Same flex column, in this order — that is the whole placement rule. Anything measured (a
    // fixed offset, an observed height) would be a second, drifting copy of it.
    expect(map.parentElement).toBe(dock)
    expect(bar.parentElement).toBe(dock)
    expect(map.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('gives the slot to the transcript when the chat is expanded, and back when it collapses', async () => {
    const user = userEvent.setup()
    const { container } = mount()
    expect(await screen.findByTestId('minimap')).toBeInTheDocument()

    await user.click(screen.getByPlaceholderText(/Ask or instruct the assistant/))
    expect(container.querySelector('.chat-panel')).not.toBeNull()
    // Covered by not being there: nothing is painted over, nothing is stacked, and the map is not
    // re-rendering behind an opaque panel while the user types.
    expect(screen.queryByTestId('minimap')).toBeNull()

    await user.click(screen.getByTitle('Collapse'))
    expect(container.querySelector('.chat-panel')).toBeNull()
    expect(screen.getByTestId('minimap')).toBeInTheDocument()
  })

  it('forwards a dataset dropped on it to the canvas underneath', async () => {
    // The dock covers a corner of the canvas that is droppable everywhere else, and a drop there was
    // swallowed in silence. It accepts the gesture like the pane does and hands the event on; deciding
    // what the payload is stays the canvas's job (a foreign one is ignored there, not here).
    const onDatasetDrop = vi.fn()
    const { container } = renderWithPrism(
      <CanvasChat
        activeDb="m"
        ui={ui}
        aboveBar={<div data-testid="minimap">map</div>}
        onDatasetDrop={onDatasetDrop}
      />,
      { routes: { 'GET /api/v1/ai/chats/m': { chats: [] } } }
    )
    await screen.findByTestId('minimap')
    const dock = container.querySelector('.canvas-chat')!
    const over = new MouseEvent('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(over, 'dataTransfer', { value: { dropEffect: 'none' } })
    fireEvent(container.querySelector('.chat-bar')!, over)
    // Cancelling dragover is what makes the corner a drop target at all — without it the browser
    // refuses the drop and nothing downstream is ever asked.
    expect(over.defaultPrevented).toBe(true)

    fireEvent.drop(dock)
    expect(onDatasetDrop).toHaveBeenCalledTimes(1)
  })

  it('takes the corner back from a map that has been enlarged', async () => {
    // The one collapse trigger the map cannot see coming: it is a slot, and expanding the transcript
    // takes the slot. A 520 px map surviving that would sit on top of the conversation.
    const { container } = renderWithPrism(
      <ReactFlowProvider>
        <ReactFlow
          nodes={[{ id: 'a', position: { x: 0, y: 0 }, width: 210, height: 60, data: {} }]}
          edges={[]}
        />
        <CanvasChat activeDb="m" ui={ui} aboveBar={<CanvasMinimap />} />
      </ReactFlowProvider>,
      { routes: { 'GET /api/v1/ai/chats/m': { chats: [] } } }
    )
    const input = await screen.findByPlaceholderText(/Ask or instruct the assistant/)
    const dock = container.querySelector('.canvas-minimap-dock') as HTMLElement
    const rect = (el: Element, r: { left: number; top: number; width: number; height: number }): void => {
      const box = { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top }
      el.getBoundingClientRect = () => ({ ...box, toJSON: () => box }) as DOMRect
    }
    rect(container.querySelector('.react-flow')!, { left: 0, top: 0, width: 1280, height: 800 })
    rect(dock, { left: 1056, top: 528, width: 208, height: 132 })

    vi.useFakeTimers()
    fireEvent.pointerOver(dock)
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(container.querySelector('.react-flow__minimap-svg')!.getAttribute('width')).toBe('520')
    vi.useRealTimers()

    await userEvent.setup().click(input)
    expect(container.querySelector('.chat-panel')).not.toBeNull()
    expect(container.querySelector('.canvas-minimap-dock')).toBeNull()
  })

  it('leaves the corner to the chat alone when there is no map to show', async () => {
    // An empty model passes no slot (see showMinimap); the pill must not grow a stray empty box.
    const { container } = renderWithPrism(<CanvasChat activeDb="m" ui={ui} />, {
      routes: { 'GET /api/v1/ai/chats/m': { chats: [] } }
    })
    expect(await screen.findByPlaceholderText(/Ask or instruct the assistant/)).toBeInTheDocument()
    expect(container.querySelector('.canvas-chat')!.children).toHaveLength(1)
  })
})

describe('the Skills flyout in the "+" menu', () => {
  // A second way to the switches in Settings → AI → Skills, without leaving the chat. The list is
  // the server's, a flip is written straight through, and "Add skill" hands over to the one place a
  // skill can actually be written.
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
  const SKILLS = [
    {
      id: 'lci',
      name: 'LCI modelling',
      description: 'How to build inventories',
      content: '#',
      enabled: true
    },
    {
      id: 'bom',
      name: 'Bill of materials from a product description',
      description: '',
      content: '#',
      enabled: true
    },
    { id: 'rep', name: 'Report style', description: '', content: '#', enabled: false, builtin: true }
  ]
  const mount = (
    onOpenSettings = vi.fn()
  ): ReturnType<typeof renderWithPrism> & { onOpenSettings: typeof onOpenSettings } => {
    let skills = SKILLS.map((s) => ({ ...s }))
    const r = renderWithPrism(<CanvasChat activeDb="m" ui={ui} onOpenSettings={onOpenSettings} />, {
      routes: {
        'GET /api/v1/ai/chats/m': { chats: [] },
        'GET /api/v1/ai/skills': () => ({ skills }),
        'POST /api/v1/ai/skills/:id': (body: unknown, path: string) => {
          const id = path.split('/').pop()!
          const patch = body as { enabled: boolean }
          skills = skills.map((s) => (s.id === id ? { ...s, ...patch } : s))
          return skills.find((s) => s.id === id)
        }
      }
    })
    return { ...r, onOpenSettings }
  }

  it('lists every skill with its switch on hover, and writes a flip through to the server', async () => {
    const user = userEvent.setup()
    const { prism } = mount()
    await user.click(await screen.findByLabelText('Attachments and chat options'))
    await user.hover(screen.getByRole('menuitem', { name: /Skills/ }))

    const lci = await screen.findByRole('menuitemcheckbox', { name: 'LCI modelling' })
    expect(lci).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Report style' })).toHaveAttribute(
      'aria-checked',
      'false'
    )

    await user.click(lci)
    expect(prism.calls).toContainEqual({
      method: 'POST',
      path: '/api/v1/ai/skills/lci',
      body: { enabled: false }
    })
    expect(await screen.findByRole('menuitemcheckbox', { name: 'LCI modelling' })).toHaveAttribute(
      'aria-checked',
      'false'
    )
    // The menu stays open: several switches are flipped in one visit, as with Web search.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Report style' })).toBeInTheDocument()
  })

  it('cuts a long name at 28 characters and keeps the full one in the tooltip', async () => {
    const user = userEvent.setup()
    mount()
    await user.click(await screen.findByLabelText('Attachments and chat options'))
    await user.hover(screen.getByRole('menuitem', { name: /Skills/ }))

    const bom = await screen.findByTitle('Bill of materials from a product description')
    expect(bom).toHaveTextContent('Bill of materials from a pro…')
    expect(bom).not.toHaveTextContent('description')
    expect(shortSkillName('Goal & scope')).toBe('Goal & scope')
    expect(shortSkillName('Bill of materials from a product description')).toBe(
      'Bill of materials from a pro…'
    )
  })

  it('ends in "Add skill", which closes the menu and opens Settings on the Skills page', async () => {
    const user = userEvent.setup()
    const { onOpenSettings } = mount()
    await user.click(await screen.findByLabelText('Attachments and chat options'))
    await user.hover(screen.getByRole('menuitem', { name: /Skills/ }))

    const items = await screen.findAllByRole('menuitem')
    expect(items[items.length - 1]).toHaveTextContent('Add skill')
    await user.click(items[items.length - 1])

    expect(onOpenSettings).toHaveBeenCalledWith('ai-skills', 'add-skill')
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

/**
 * Two assistants on two models at once.
 *
 * The main process always allowed it — one abort controller per chat, each run bound to its model at
 * the start — but the panel held ONE `busy` flag and survives a model switch. Start a run in model A,
 * switch to model B: B showed Stop instead of Send, refused to send, and its Stop cancelled A's run.
 * What this pins: busy means "the chat on screen is running", canvas tools act
 * on their own model's canvas or not at all, and Stop stops only what is on screen.
 */
describe('two assistants working on two models', () => {
  const ui = {
    jumpToProcess: vi.fn(),
    autoLayout: vi.fn(),
    screenshotRect: () => null,
    calculateInCanvas: vi.fn(),
    setupResults: vi.fn(),
    getCanvas: vi.fn(() => ({ nodes: [] })),
    clearCanvas: vi.fn(),
    removeFromCanvas: vi.fn(),
    refresh: vi.fn()
  }
  const routes = {
    'GET /api/v1/ai/chats/a': { chats: [] },
    'GET /api/v1/ai/chats/b': { chats: [] },
    'POST /api/v1/ai/chats/a': { id: 'chat-a', title: '', messages: [] },
    'POST /api/v1/ai/chats/b': { id: 'chat-b', title: '', messages: [] },
    'POST /api/v1/ai/chats/a/chat-a/messages': {},
    'POST /api/v1/ai/chats/b/chat-b/messages': {},
    'POST /api/v1/ai/chats/a/chat-a/rename': {},
    'POST /api/v1/ai/chats/b/chat-b/rename': {}
  }
  // A run that never ends on its own — the test decides when a chat is done, via events.
  const pending = (): Promise<unknown> => new Promise(() => {})

  const mount = () => {
    const send = vi.fn((_req: unknown) => pending())
    const cancel = vi.fn(async () => undefined)
    const uiResult = vi.fn()
    const r = renderWithPrism(<CanvasChat activeDb="a" ui={ui} />, {
      routes,
      overrides: { ai: { send, cancel, uiResult } }
    })
    return { ...r, send, cancel, uiResult }
  }
  const type = async (user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> => {
    const box = await screen.findByPlaceholderText(/Ask or instruct the assistant/)
    await user.clear(box)
    await user.type(box, `${text}{Enter}`)
  }

  it('lets model B send while model A is still running, and ends each run on its own event', async () => {
    const user = userEvent.setup()
    const { rerender, send, prism } = mount()
    await type(user, 'build A')
    expect(await screen.findByTitle('Stop')).toBeInTheDocument()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toMatchObject({ chatId: 'chat-a', activeDb: 'a' })

    // Switch to model B: its chat is not running, so it can be sent to.
    rerender(<CanvasChat activeDb="b" ui={ui} />)
    expect(await screen.findByTitle('Send')).toBeInTheDocument()
    expect(screen.queryByTitle('Stop')).toBeNull()
    // …and the header says the other run is still going, naming its model.
    expect(screen.getByText('1 other run')).toHaveAttribute('title', expect.stringContaining('a'))

    await type(user, 'build B')
    expect(await screen.findByTitle('Stop')).toBeInTheDocument()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0]).toMatchObject({ chatId: 'chat-b', activeDb: 'b' })

    // A finishes: B stays busy. B finishes: B can send again.
    act(() => prism.emit({ chatId: 'chat-a', type: 'done', text: 'A done' }))
    expect(screen.getByTitle('Stop')).toBeInTheDocument()
    expect(screen.queryByText('1 other run')).toBeNull()
    act(() => prism.emit({ chatId: 'chat-b', type: 'done', text: 'B done' }))
    expect(await screen.findByTitle('Send')).toBeInTheDocument()
    expect(screen.getByText('B done')).toBeInTheDocument()
  })

  it('stops only the run on screen', async () => {
    const user = userEvent.setup()
    const { rerender, cancel } = mount()
    await type(user, 'build A')
    rerender(<CanvasChat activeDb="b" ui={ui} />)
    await type(user, 'build B')
    await user.click(await screen.findByTitle('Stop'))
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel).toHaveBeenCalledWith('chat-b')
    // A's run is untouched and still reported.
    expect(screen.getByText('1 other run')).toBeInTheDocument()
  })

  // The header's "1 other run" is the way to that run, not only the news that it exists.
  it("opens the other model's running chat from the header", async () => {
    const user = userEvent.setup()
    const goTo = vi.fn()
    const { rerender } = mount()
    await type(user, 'build A')
    rerender(<CanvasChat activeDb="b" ui={ui} onGoToChat={goTo} />)
    await user.click(await screen.findByRole('button', { name: '1 other run' }))
    expect(goTo).toHaveBeenCalledWith('a', 'chat-a')
  })

  it('lists several other runs by model and chat title before opening one', async () => {
    const user = userEvent.setup()
    const goTo = vi.fn()
    const { rerender, prism } = mount()
    await type(user, 'build A')
    rerender(<CanvasChat activeDb="b" ui={ui} />)
    await type(user, 'build B')
    prism.setRoute('GET /api/v1/ai/chats/c', { chats: [] })
    prism.setRoute('GET /api/v1/ai/chats/a', { chats: [{ id: 'chat-a', title: 'Steel bottle' }] })
    prism.setRoute('GET /api/v1/ai/chats/b', { chats: [{ id: 'chat-b', title: 'PET bottle' }] })
    rerender(<CanvasChat activeDb="c" ui={ui} onGoToChat={goTo} />)
    await user.click(await screen.findByRole('button', { name: '2 other runs' }))
    expect(goTo).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: 'a · Steel bottle' })).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'b · PET bottle' }))
    expect(goTo).toHaveBeenCalledWith('b', 'chat-b')
    expect(screen.queryByRole('button', { name: 'a · Steel bottle' })).toBeNull()
  })

  it('opens a running chat of the model on screen in place, without a model switch', async () => {
    const user = userEvent.setup()
    const goTo = vi.fn()
    const { rerender, prism } = mount()
    rerender(<CanvasChat activeDb="a" ui={ui} onGoToChat={goTo} />)
    await type(user, 'build A')
    prism.setRoute('POST /api/v1/ai/chats/a', { id: 'chat-a2', title: '', messages: [] })
    prism.setRoute('GET /api/v1/ai/chats/a/chat-a', { id: 'chat-a', title: '', messages: [] })
    await user.click(screen.getByTitle('New chat'))
    await user.click(await screen.findByRole('button', { name: '1 other run' }))
    await vi.waitFor(() =>
      expect(prism.calls.some((c) => c.method === 'GET' && c.path === '/api/v1/ai/chats/a/chat-a')).toBe(true)
    )
    expect(await screen.findByTitle('Stop')).toBeInTheDocument()
    expect(screen.queryByText('1 other run')).toBeNull()
    expect(goTo).not.toHaveBeenCalled()
  })

  // Back on a running chat, the panel showed only the calls made since, with clocks from zero, until
  // `done` brought the whole list back.
  const tool = (name: string, phase: 'start' | 'done'): Record<string, unknown> => ({
    chatId: 'chat-a',
    type: 'tool',
    name,
    phase
  })
  const chatARoutes = (prism: { setRoute: (key: string, reply: unknown) => void }): void => {
    prism.setRoute('GET /api/v1/ai/chats/a', { chats: [{ id: 'chat-a', title: 'A' }] })
    prism.setRoute('GET /api/v1/ai/chats/a/chat-a', { id: 'chat-a', title: 'A', messages: [] })
  }

  it('shows the whole running turn with true clocks after a switch to another model and back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
      const { rerender, prism } = mount()
      await type(user, 'build A')
      act(() => prism.emit(tool('search', 'start')))
      act(() => prism.emit(tool('search', 'done')))
      rerender(<CanvasChat activeDb="b" ui={ui} />)
      await screen.findByTitle('Send')
      // Out of sight, the run goes on.
      act(() => prism.emit(tool('calculate', 'start')))
      act(() => vi.advanceTimersByTime(95_000))
      chatARoutes(prism)
      rerender(<CanvasChat activeDb="a" ui={ui} />)
      expect(await screen.findByTitle('Stop')).toBeInTheDocument()
      expect(screen.getByText('search')).toBeInTheDocument()
      expect(screen.getAllByText('calculate')).toHaveLength(2) // the run bar and its row
      // Both clocks count from the call's start, not from the panel's return.
      expect(screen.getAllByText(/^1:3\d min$/)).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps recording a run while the panel is unmounted, as on the Results view', async () => {
    function Host({ show }: { show: boolean }): JSX.Element | null {
      useTurnFeed()
      return show ? <CanvasChat activeDb="a" ui={ui} /> : null
    }
    const user = userEvent.setup()
    const { rerender, prism } = renderWithPrism(<Host show />, {
      routes,
      overrides: { ai: { send: () => pending(), isRunning: async () => true } }
    })
    await type(user, 'build A')
    act(() => prism.emit(tool('search', 'start')))
    rerender(<Host show={false} />)
    act(() => prism.emit(tool('search', 'done')))
    act(() => prism.emit(tool('calculate', 'start')))
    act(() => prism.emit({ chatId: 'chat-a', type: 'delta', text: 'Calculating the bottle' }))
    chatARoutes(prism)
    rerender(<Host show />)
    await user.click(await screen.findByPlaceholderText(/Ask or instruct the assistant/))
    expect(await screen.findByTitle('Stop')).toBeInTheDocument()
    expect(screen.getByText('search')).toBeInTheDocument()
    expect(screen.getAllByText('calculate')).toHaveLength(2)
    expect(screen.getByText('Calculating the bottle')).toBeInTheDocument()
  })

  it('adds an answer once when main reports after done that it could not be saved', async () => {
    const user = userEvent.setup()
    const { prism } = mount()
    await type(user, 'build A')
    act(() => prism.emit({ chatId: 'chat-a', type: 'delta', text: 'The bottle is modelled.' }))
    act(() => prism.emit({ chatId: 'chat-a', type: 'done', text: '' }))
    act(() => prism.emit({ chatId: 'chat-a', type: 'error', message: 'The answer could not be saved' }))
    expect(await screen.findByText('The answer could not be saved')).toBeInTheDocument()
    expect(screen.getAllByText('The bottle is modelled.')).toHaveLength(1)
  })

  it('times a run adopted without any event from when it is shown, not from the epoch', async () => {
    // After a window reload: main says the chat is running, and nothing has arrived for it yet.
    renderWithPrism(<CanvasChat activeDb="a" ui={ui} />, {
      routes: {
        ...routes,
        'GET /api/v1/ai/chats/a': { chats: [{ id: 'chat-a', title: 'A' }] },
        'GET /api/v1/ai/chats/a/chat-a': { id: 'chat-a', title: 'A', messages: [] }
      },
      overrides: { ai: { isRunning: async () => true } }
    })
    await userEvent.setup().click(await screen.findByPlaceholderText(/Ask or instruct the assistant/))
    expect(await screen.findByTitle('Stop')).toBeInTheDocument()
    expect(screen.getByText('0 s')).toBeInTheDocument()
  })

  it("refuses a canvas tool for a model that is not on screen, and serves the shown model's", async () => {
    const user = userEvent.setup()
    const { rerender, uiResult, prism } = mount()
    await type(user, 'build A')
    rerender(<CanvasChat activeDb="b" ui={ui} />)
    await screen.findByTitle('Send')

    act(() =>
      prism.emitUiTool({ reqId: 'u1', name: 'get_canvas', args: {}, chatId: 'chat-a', database: 'a' })
    )
    await vi.waitFor(() => expect(uiResult).toHaveBeenCalledWith('u1', true, expect.anything(), undefined))
    expect(ui.getCanvas).not.toHaveBeenCalled()
    const refusal = uiResult.mock.calls[0][2] as { error: string }
    expect(refusal.error).toMatch(/"a" is not on screen/)
    expect(refusal.error).toMatch(/modelling tools keep working/)

    act(() =>
      prism.emitUiTool({ reqId: 'u2', name: 'get_canvas', args: {}, chatId: 'chat-b', database: 'b' })
    )
    await vi.waitFor(() => expect(uiResult).toHaveBeenCalledWith('u2', true, { nodes: [] }, undefined))
    expect(ui.getCanvas).toHaveBeenCalledTimes(1)
  })

  it("titles the run's own chat, not the chat on screen", async () => {
    const user = userEvent.setup()
    const { rerender, prism } = mount()
    await type(user, 'build A')
    rerender(<CanvasChat activeDb="b" ui={ui} />)
    await screen.findByTitle('Send')

    act(() =>
      prism.emitUiTool({
        reqId: 'u3',
        name: 'set_chat_title',
        args: { title: 'PET bottle' },
        chatId: 'chat-a',
        database: 'a'
      })
    )
    await vi.waitFor(() =>
      expect(prism.calls).toContainEqual({
        method: 'POST',
        path: '/api/v1/ai/chats/a/chat-a/rename',
        body: { title: 'PET bottle' }
      })
    )
    expect(prism.calls.some((c) => c.path.includes('/chats/b/'))).toBe(false)
  })
})

/**
 * A question asked while its chat was not on screen.
 *
 * The card used to exist only in the moment the request arrived: switch model, leave the Model view
 * or collapse the chat, and the question waited for nobody until main's timeout let the run go on.
 * Now main keeps the question, the panel reports which card it shows (the Workbench banners the
 * rest), restores the card when the chat is opened, and opens on a chat the banner points to.
 */
describe('a question asked while the chat was not on screen', () => {
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
  const QUESTION = { questions: [{ question: 'Which PET?', options: ['virgin', 'recycled'] }] }
  const pending = (): Promise<unknown> => new Promise(() => {})

  it('reports the card it shows, and null once the panel is collapsed', async () => {
    const user = userEvent.setup()
    const onAskShown = vi.fn()
    const { prism } = renderWithPrism(<CanvasChat activeDb="a" ui={ui} onAskShown={onAskShown} />, {
      routes: {
        'GET /api/v1/ai/chats/a': { chats: [] },
        'POST /api/v1/ai/chats/a': { id: 'chat-a', title: '', messages: [] },
        'POST /api/v1/ai/chats/a/chat-a/messages': {}
      },
      overrides: { ai: { send: vi.fn((_req: unknown) => pending()), uiResult: vi.fn() } }
    })
    const box = await screen.findByPlaceholderText(/Ask or instruct the assistant/)
    await user.type(box, 'build{Enter}')
    await screen.findByTitle('Stop')
    expect(onAskShown).toHaveBeenLastCalledWith(null)

    act(() =>
      prism.emitUiTool({ reqId: 'u1', name: 'ask_user', args: QUESTION, chatId: 'chat-a', database: 'a' })
    )
    expect(await screen.findByText('Which PET?')).toBeInTheDocument()
    expect(onAskShown).toHaveBeenLastCalledWith('u1')

    await user.click(screen.getByTitle('Collapse'))
    expect(onAskShown).toHaveBeenLastCalledWith(null)
  })

  it('shows the confirmation card for approve_tool and answers it with Allow / Decline', async () => {
    const user = userEvent.setup()
    const uiResult = vi.fn()
    const { prism } = renderWithPrism(<CanvasChat activeDb="a" ui={ui} />, {
      routes: {
        'GET /api/v1/ai/chats/a': { chats: [] },
        'POST /api/v1/ai/chats/a': { id: 'chat-a', title: '', messages: [] },
        'POST /api/v1/ai/chats/a/chat-a/messages': {}
      },
      overrides: { ai: { send: vi.fn((_req: unknown) => pending()), uiResult } }
    })
    const box = await screen.findByPlaceholderText(/Ask or instruct the assistant/)
    await user.type(box, 'delete it{Enter}')
    await screen.findByTitle('Stop')
    act(() =>
      prism.emitUiTool({
        reqId: 'ap1',
        name: 'approve_tool',
        args: { tool: 'delete_model', effect: 'irreversible', args: { database: 'a' }, database: 'a' },
        chatId: 'chat-a',
        database: 'a'
      })
    )
    expect(await screen.findByText(/Allow the assistant to run/)).toBeInTheDocument()
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument()
    // An approval is not a question: the input does not turn into the answer box.
    expect(screen.queryByPlaceholderText(/Type your answer/)).toBeNull()
    await user.click(screen.getByText('Decline'))
    expect(uiResult.mock.calls.map((c) => c.slice(0, 3))).toEqual([['ap1', true, { approved: false }]])
    expect(screen.queryByText(/Allow the assistant to run/)).toBeNull()
  })

  it('queues a message typed while the run works, shows the chip, and takes it back on ✕', async () => {
    const user = userEvent.setup()
    const steer = vi.fn(async () => ({ queued: true }))
    const unsteer = vi.fn(async () => ({ queued: [] }))
    const { prism } = renderWithPrism(<CanvasChat activeDb="a" ui={ui} />, {
      routes: {
        'GET /api/v1/ai/chats/a': { chats: [] },
        'POST /api/v1/ai/chats/a': { id: 'chat-a', title: '', messages: [] },
        'POST /api/v1/ai/chats/a/chat-a/messages': {}
      },
      overrides: { ai: { send: vi.fn((_req: unknown) => pending()), steer, unsteer } }
    })
    const box = await screen.findByPlaceholderText(/Ask or instruct the assistant/)
    await user.type(box, 'build{Enter}')
    await screen.findByTitle('Stop')
    const busyBox = await screen.findByPlaceholderText(/after its current step/)
    await user.type(busyBox, 'use kilograms{Enter}')
    expect(steer).toHaveBeenCalledWith('chat-a', 'use kilograms')
    // Main confirms the queue with the event; the chip appears with a way back.
    act(() => prism.emit({ chatId: 'chat-a', type: 'steer', queued: ['use kilograms'] }))
    expect(await screen.findByText('use kilograms')).toBeInTheDocument()
    await user.click(screen.getByTitle('Take this message back'))
    expect(unsteer).toHaveBeenCalledWith('chat-a', 0)
    act(() => prism.emit({ chatId: 'chat-a', type: 'steer', queued: [] }))
    expect(screen.queryByText('use kilograms')).toBeNull()
  })

  it('restores the card from main when the chat is opened after the question arrived', async () => {
    const user = userEvent.setup()
    const onAskShown = vi.fn()
    renderWithPrism(<CanvasChat activeDb="a" ui={ui} onAskShown={onAskShown} />, {
      routes: {
        'GET /api/v1/ai/chats/a': { chats: [{ id: 'chat-a', title: 'Bottle' }] },
        'GET /api/v1/ai/chats/a/chat-a': { id: 'chat-a', title: 'Bottle', messages: [] }
      },
      overrides: {
        ai: {
          isRunning: async () => true,
          pendingAsks: async () => [
            { reqId: 'u9', chatId: 'chat-a', database: 'a', args: QUESTION, since: 1 }
          ]
        }
      }
    })
    // Collapsed: the question is known (the input already asks for the answer) but the card is not on
    // screen, and the panel says so.
    await screen.findByPlaceholderText(/Type your answer/)
    expect(screen.queryByText('Which PET?')).toBeNull()
    expect(onAskShown).toHaveBeenLastCalledWith(null)

    await user.click(screen.getByPlaceholderText(/Type your answer/))
    expect(await screen.findByText('Which PET?')).toBeInTheDocument()
    expect(screen.getByTitle('Stop')).toBeInTheDocument()
    expect(onAskShown).toHaveBeenLastCalledWith('u9')
  })

  it('opens on the chat a "Go to chat" request names, also when it arrives with the model switch', async () => {
    const routes = {
      'GET /api/v1/ai/chats/a': { chats: [] },
      'GET /api/v1/ai/chats/b': {
        chats: [
          { id: 'b1', title: 'First' },
          { id: 'b2', title: 'Second' }
        ]
      },
      'GET /api/v1/ai/chats/b/b1': { id: 'b1', title: 'First', messages: [] },
      'GET /api/v1/ai/chats/b/b2': { id: 'b2', title: 'Second', messages: [] }
    }
    const { rerender } = renderWithPrism(<CanvasChat activeDb="a" ui={ui} />, { routes })
    await screen.findByPlaceholderText(/Ask or instruct the assistant/)
    // Model switch and focus request in one render — the order the banner's button produces.
    rerender(<CanvasChat activeDb="b" ui={ui} focusChat={{ chatId: 'b2', nonce: 1 }} />)
    expect(await screen.findByTitle('Switch chat')).toHaveTextContent('Second')

    // Same model, another chat: opened directly.
    rerender(<CanvasChat activeDb="b" ui={ui} focusChat={{ chatId: 'b1', nonce: 2 }} />)
    await vi.waitFor(() => expect(screen.getByTitle('Switch chat')).toHaveTextContent('First'))
  })
})
