import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type CanvasChatType from './CanvasChat'
import type { AttachmentMeta } from './lib/ai'
import { renderWithPrism } from './test/render'
import type { PrismOverrides } from './test/prism'

/**
 * Characterisation tests for the chat composer (input, "+" menu, chips, attachments, per-chat
 * toggles and draft) — written BEFORE the planned split of `CanvasChat.tsx` into `chat/chatPrefs.ts`,
 * `chat/useChatPrefs.ts`, `chat/useAttachments.ts`, `chat/ModelPicker.tsx`, `chat/ComposerMenu.tsx`
 * and `chat/ChatComposer.tsx`, so that a cut which tears the wiring turns red here instead of in a
 * running app.
 *
 * The composer's state outlives the panel on purpose: toggles and drafts sit in module-level maps
 * keyed by chat id, with `'(new):<model>'` (`newChatKey`) standing for the chat that does not exist yet. That module state
 * would leak between tests, so every test gets a fresh module registry (`vi.resetModules()` plus a
 * dynamic import of CanvasChat) — and anything the test touches beside the component (`setAS`,
 * `KEY_CHANGED_EVENT`) is imported the same way, so it is the SAME instance the component sees.
 * What goes to the model is read from the payload of `ai.send`, not from the screen: the payload is
 * the contract, the switch is only how the user reaches it.
 *
 * Deliberately NOT covered: recording and transcription (jsdom has no MediaRecorder), parking a
 * transcript while a run is in flight, the textarea growing with its content (jsdom does not lay
 * out), the model picker (own file — its catalogue is module-scoped), the Skills flyout (covered in
 * CanvasChat.dom.test.tsx), and Stop / the run loop (covered there too).
 *
 * Findings, first pinned here as they were, then fixed:
 * - `'(new)'` was never cleared, so every future new chat inherited whatever was last flipped before
 *   a chat existed. Fixed: the first send empties it (test "a new chat starts at the defaults…").
 * - `'(new)'` was also shared across models: a toggle flipped before the first chat of model A was
 *   what the first chat of model B started with. Fixed: the key is per model, `newChatKey(db)`
 *   (test "a flip on model m does not reach a fresh panel on model n").
 * - The "+" menu decided whether to SHOW "Web search" from localStorage (`prism.ai.webSearchEnabled`),
 *   while `send` gates on the app setting (`getAS().webSearchEnabled`): hidden but still sent, or
 *   shown but not sent. Fixed: the menu reads the app setting and hides the row when it is off
 *   (test "web search…").
 * - Text typed while the first send was still creating the chat stayed in the box, but its draft was
 *   stored under `'(new)'`, not under the new chat's id (the draft key was only refreshed on render):
 *   it reappeared in the next new chat and was gone from this one after a remount. Fixed: one key
 *   ref, moved by `adopt`, which carries the draft too (test "keeps the toggles and the box…").
 */

type CanvasChatT = typeof CanvasChatType
let CanvasChat: CanvasChatT
let chats: Array<{ id: string; title?: string }>
let comparedWith: string[]
/** What storing a user message answers — swapped by the tests that make it fail or wait. */
let storeMessage: () => unknown

beforeEach(async () => {
  vi.resetModules()
  CanvasChat = (await import('./CanvasChat')).default
  chats = []
  comparedWith = ['x']
  storeMessage = () => ({})
})

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

const chatRoutes = (db: string): Record<string, unknown> => ({
  [`GET /api/v1/ai/chats/${db}`]: () => ({ chats }),
  [`POST /api/v1/ai/chats/${db}`]: { id: 'c1', title: '', messages: [] },
  [`POST /api/v1/ai/chats/${db}/:id/messages`]: () => storeMessage(),
  [`POST /api/v1/ai/chats/${db}/:id/rename`]: {},
  [`GET /api/v1/ai/chats/${db}/:id`]: (_b: unknown, path: string) => ({
    id: path.split('/').pop(),
    title: '',
    messages: []
  })
})
const routes = (): Record<string, unknown> => ({
  ...chatRoutes('m'),
  ...chatRoutes('n'),
  'GET /api/v1/ai/skills': { skills: [] },
  'GET /api/v1/study': () => ({ compared_with: comparedWith }),
  'GET /api/v1/databases': [],
  'GET /api/v1/databases/folders': { folders: [], of: {} }
})

interface MountOpts {
  props?: Partial<Parameters<CanvasChatT>[0]>
  overrides?: PrismOverrides
}
const DEFAULT_PROPS = {
  activeDb: 'm',
  backgroundDbs: ['ei-3.11', 'agb'],
  secondaryBackgroundDbs: ['agb'],
  libraryDbs: ['lib']
}
const mount = ({ props = {}, overrides = {} }: MountOpts = {}) => {
  const send = vi.fn(async (_req: Record<string, unknown>) => ({ ok: true }))
  const all = { ...DEFAULT_PROPS, ...props }
  const r = renderWithPrism(<CanvasChat ui={ui} {...all} />, {
    routes: routes(),
    overrides: { ...overrides, ai: { send, ...(overrides.ai ?? {}) } }
  })
  const rerender = (p: Partial<Parameters<CanvasChatT>[0]> = {}): void =>
    r.rerender(<CanvasChat ui={ui} {...all} {...p} />)
  return { ...r, send, rerender }
}

/** The composer itself — the transcript above repeats a sent file's chip. */
const bar = (): HTMLElement => document.querySelector('.chat-bar') as HTMLElement
const box = (): Promise<HTMLElement> => screen.findByRole('textbox')
const plus = (): Promise<HTMLElement> => screen.findByLabelText('Attachments and chat options')
const item = (name: string | RegExp): Promise<HTMLElement> => screen.findByRole('menuitemcheckbox', { name })

/** Type into the composer and press Enter, then let the send settle. */
const say = async (user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> => {
  const ta = await box()
  await user.type(ta, `${text}{Enter}`)
}
/** Wait for the run to be marked, then end it the way main does. */
const finish = async (prism: { emit: (ev: unknown) => void }, chatId = 'c1'): Promise<void> => {
  await screen.findByTitle('Stop')
  act(() => prism.emit({ chatId, type: 'done', text: 'ok' }))
  await screen.findByTitle('Send')
}
const openPlus = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  const b = await plus()
  if (b.getAttribute('aria-expanded') !== 'true') await user.click(b)
}
/** The six per-chat switches, as the "+" menu shows them right now. */
const switches = async (): Promise<Record<string, string | null>> => {
  const names = ['Web search', 'Distances', 'Eurostat EoL', 'ei-3.11', 'agb', 'My processes', 'x']
  const out: Record<string, string | null> = {}
  for (const n of names) out[n] = (await item(n)).getAttribute('aria-checked')
  return out
}
const ALL_ON = {
  'Web search': 'true',
  Distances: 'true',
  'Eurostat EoL': 'true',
  'ei-3.11': 'true',
  agb: 'false',
  'My processes': 'false',
  x: 'true'
}
const ALL_FLIPPED = {
  'Web search': 'false',
  Distances: 'false',
  'Eurostat EoL': 'false',
  'ei-3.11': 'false',
  agb: 'true',
  'My processes': 'true',
  x: 'false'
}
const flipAll = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  await openPlus(user)
  for (const n of Object.keys(ALL_ON)) await user.click(await item(n))
}

describe('the composer', () => {
  it('sends the per-chat defaults', async () => {
    const user = userEvent.setup()
    const { send } = mount()
    await say(user, 'hello')
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][0]).toMatchObject({
      chatId: 'c1',
      userText: 'hello',
      webSearch: true,
      webSearchAllowed: true,
      distancesAllowed: true,
      eurostatAllowed: true,
      backgroundDbs: ['ei-3.11'],
      withheldBackgrounds: ['agb'],
      libraryDbs: [],
      comparisonModels: ['x']
    })
    expect(send.mock.calls[0][0]).not.toHaveProperty('attachments')
  })

  it('flips every switch in "+", keeps the menu open, and sends the inverse', async () => {
    const user = userEvent.setup()
    const { send } = mount()
    await openPlus(user)
    expect(await switches()).toEqual(ALL_ON)
    for (const n of Object.keys(ALL_ON)) {
      await user.click(await item(n))
      // The menu stays open between flips: several are set in one visit.
      expect(await plus()).toHaveAttribute('aria-expanded', 'true')
    }
    expect(await switches()).toEqual(ALL_FLIPPED)
    await say(user, 'go')
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][0]).toMatchObject({
      webSearch: false,
      webSearchAllowed: true,
      distancesAllowed: false,
      eurostatAllowed: false,
      backgroundDbs: ['agb'],
      withheldBackgrounds: ['ei-3.11'],
      libraryDbs: ['lib'],
      comparisonModels: []
    })
  })

  it('keeps the toggles and the box on screen through the first send, which creates the chat', async () => {
    // The first send materialises the chat id; the settings effect must not reload for that id, and
    // what is on screen is carried over to it. Text typed while the chat is being created stays in the
    // box and is stored under the new chat: it is back after a remount.
    const user = userEvent.setup()
    let created: (v: unknown) => void = () => {}
    const first = mount()
    first.prism.setRoute('POST /api/v1/ai/chats/m', () => new Promise((res) => (created = res)))
    await flipAll(user)
    await say(user, 'go')
    await user.type(await box(), 'more')
    await act(async () => created({ id: 'c1', title: '', messages: [] }))
    await finish(first.prism)
    expect(await box()).toHaveValue('more')
    await openPlus(user)
    expect(await switches()).toEqual(ALL_FLIPPED)
    first.unmount()

    chats = [{ id: 'c1' }]
    const again = mount()
    await waitFor(() => expect(again.prism.calls.some((c) => c.path === '/api/v1/ai/chats/m/c1')).toBe(true))
    await waitFor(async () => expect(await box()).toHaveValue('more'))
    again.unmount()

    // …and not in the next new chat.
    chats = []
    mount()
    await waitFor(async () => expect(await box()).toHaveValue(''))
  })

  it('a new chat starts at the defaults after the first send of the previous one', async () => {
    // The first send carries '(new)' over to the chat it creates and empties it: the NEXT new chat no longer
    // inherits what was flipped before the first one existed.
    const user = userEvent.setup()
    const first = mount()
    await flipAll(user)
    await say(user, 'go')
    await finish(first.prism)
    first.unmount()

    chats = []
    const fresh = mount()
    await openPlus(user)
    expect(await switches()).toEqual(ALL_ON)
    await say(user, 'again')
    await waitFor(() => expect(fresh.send).toHaveBeenCalledTimes(1))
    expect(fresh.send.mock.calls[0][0]).toMatchObject({
      webSearch: true,
      distancesAllowed: true,
      eurostatAllowed: true,
      backgroundDbs: ['ei-3.11'],
      withheldBackgrounds: ['agb'],
      libraryDbs: [],
      comparisonModels: ['x']
    })
  })

  it('restores the toggles per chat', async () => {
    const user = userEvent.setup()
    const first = mount()
    await flipAll(user)
    await say(user, 'go')
    await finish(first.prism)
    first.unmount()

    // The newest chat is opened on mount — c1, with its own (migrated) switches.
    chats = [{ id: 'c1' }]
    const second = mount()
    await waitFor(() => expect(second.prism.calls.some((c) => c.path === '/api/v1/ai/chats/m/c1')).toBe(true))
    await openPlus(user)
    await waitFor(async () => expect(await switches()).toEqual(ALL_FLIPPED))
    second.unmount()

    // c2 never touched a switch: the defaults.
    chats = [{ id: 'c2' }, { id: 'c1' }]
    const third = mount()
    await waitFor(() => expect(third.prism.calls.some((c) => c.path === '/api/v1/ai/chats/m/c2')).toBe(true))
    await openPlus(user)
    await waitFor(async () => expect(await switches()).toEqual(ALL_ON))
  })

  it('keeps a switch flipped in an existing chat across a remount, and sends it', async () => {
    const user = userEvent.setup()
    chats = [{ id: 'c1' }]
    const first = mount()
    await waitFor(() => expect(first.prism.calls.some((c) => c.path === '/api/v1/ai/chats/m/c1')).toBe(true))
    await openPlus(user)
    await user.click(await item('Web search'))
    expect(await item('Web search')).toHaveAttribute('aria-checked', 'false')
    first.unmount()

    const second = mount()
    await waitFor(() => expect(second.prism.calls.some((c) => c.path === '/api/v1/ai/chats/m/c1')).toBe(true))
    await openPlus(user)
    await waitFor(async () => expect(await item('Web search')).toHaveAttribute('aria-checked', 'false'))
    await say(user, 'go')
    await waitFor(() => expect(second.send).toHaveBeenCalledTimes(1))
    expect(second.send.mock.calls[0][0]).toMatchObject({ chatId: 'c1', webSearch: false })
  })

  it('keeps an unsent draft across a remount, per chat', async () => {
    const user = userEvent.setup()
    const first = mount()
    await user.type(await box(), 'half')
    first.unmount()
    mount().unmount()
    const again = mount()
    expect(await box()).toHaveValue('half')
    again.unmount()

    chats = [{ id: 'c1' }]
    const inC1 = mount()
    await waitFor(() => expect(inC1.prism.calls.some((c) => c.path === '/api/v1/ai/chats/m/c1')).toBe(true))
    await waitFor(async () => expect(await box()).toHaveValue(''))
    await user.type(await box(), 'd1')
    inC1.unmount()

    chats = [{ id: 'c2' }, { id: 'c1' }]
    const inC2 = mount()
    await waitFor(() => expect(inC2.prism.calls.some((c) => c.path === '/api/v1/ai/chats/m/c2')).toBe(true))
    await waitFor(async () => expect(await box()).toHaveValue(''))
    inC2.unmount()

    chats = [{ id: 'c1' }]
    const backInC1 = mount()
    await waitFor(async () => expect(await box()).toHaveValue('d1'))
    backInC1.unmount()
  })

  it('clears the draft on send and does not carry it to the new chat; Shift+Enter is a newline', async () => {
    const user = userEvent.setup()
    const first = mount()
    const ta = await box()
    await user.type(ta, 'a{Shift>}{Enter}{/Shift}b')
    expect(ta).toHaveValue('a\nb')
    expect(first.send).not.toHaveBeenCalled()
    await user.clear(ta)
    await say(user, 'go')
    await finish(first.prism)
    expect(await box()).toHaveValue('')
    first.unmount()

    chats = []
    const fresh = mount()
    expect(await box()).toHaveValue('')
    fresh.unmount()

    chats = [{ id: 'c1' }]
    const inC1 = mount()
    await waitFor(() => expect(inC1.prism.calls.some((c) => c.path === '/api/v1/ai/chats/m/c1')).toBe(true))
    expect(await box()).toHaveValue('')
  })

  it('attaches through the dialog: chips, refusals, dedup by id, removal, and the send', async () => {
    const user = userEvent.setup()
    const good: AttachmentMeta = { id: 'h1', name: 'a.pdf', kind: 'pdf', bytes: 1 }
    const bad: AttachmentMeta = { id: '', name: 'b.exe', kind: 'text', bytes: 0, error: 'refused' }
    let reply: AttachmentMeta[] = [good, bad]
    const pickFiles = vi.fn(async () => ['/a.pdf', '/b.exe'])
    const attach = vi.fn(async (_paths: string[]) => reply)
    const { send, prism } = mount({ overrides: { bridge: { pickFiles }, ai: { attach } } })

    await openPlus(user)
    await user.click(screen.getByRole('menuitem', { name: /Attach files/ }))
    // Choosing "attach" closes the menu.
    expect(await plus()).toHaveAttribute('aria-expanded', 'false')
    expect(await within(bar()).findByText(/a\.pdf/)).toBeInTheDocument()
    expect(attach).toHaveBeenCalledWith(['/a.pdf', '/b.exe'])
    expect(within(bar()).getByText(/b\.exe/)).toBeInTheDocument()
    expect(within(bar()).getByText('refused')).toBeInTheDocument()
    expect(screen.getAllByTitle('Remove attachment')).toHaveLength(2)

    await say(user, 'with files')
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][0].attachments).toEqual([good])
    expect(screen.queryByTitle('Remove attachment')).toBeNull()
    await finish(prism)

    // The same file twice is one attachment.
    reply = [good]
    await openPlus(user)
    await user.click(screen.getByRole('menuitem', { name: /Attach files/ }))
    await within(bar()).findByText(/a\.pdf/)
    await openPlus(user)
    await user.click(screen.getByRole('menuitem', { name: /Attach files/ }))
    await waitFor(() => expect(attach).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.getAllByTitle('Remove attachment')).toHaveLength(1))

    // ✕ removes exactly that one.
    reply = [{ id: 'h2', name: 'c.md', kind: 'text', bytes: 2 }]
    await openPlus(user)
    await user.click(screen.getByRole('menuitem', { name: /Attach files/ }))
    await within(bar()).findByText(/c\.md/)
    expect(screen.getAllByTitle('Remove attachment')).toHaveLength(2)
    await user.click(screen.getAllByTitle('Remove attachment')[0])
    expect(screen.getAllByTitle('Remove attachment')).toHaveLength(1)
    expect(within(bar()).queryByText(/a\.pdf/)).toBeNull()
    expect(within(bar()).getByText(/c\.md/)).toBeInTheDocument()
  })

  it('attaches dropped files, with a refused chip for the overflow', async () => {
    const droppedFilePaths = vi.fn(async () => ({ paths: ['/c.txt'], overflow: 1 }))
    const attach = vi.fn(async () => [{ id: 'h3', name: 'c.txt', kind: 'text', bytes: 3 }])
    const { container } = mount({ overrides: { bridge: { droppedFilePaths }, ai: { attach } } })
    await box()
    const root = container.querySelector('.canvas-chat') as HTMLElement
    fireEvent.dragOver(root, { dataTransfer: { types: ['Files'], files: [], dropEffect: 'none' } })
    expect(screen.getByText('Drop files to attach them')).toBeInTheDocument()

    const file = new File(['x'], 'c.txt', { type: 'text/plain' })
    fireEvent.drop(root, { dataTransfer: { types: ['Files'], files: [file] } })
    expect(screen.queryByText('Drop files to attach them')).toBeNull()
    expect(await screen.findByText(/c\.txt/)).toBeInTheDocument()
    expect(droppedFilePaths).toHaveBeenCalledWith([file])
    expect(attach).toHaveBeenCalledWith(['/c.txt'])
    const more = await screen.findByText(/1 more file$/)
    expect(more.closest('.chat-attach')).toHaveClass('bad')
    expect(screen.getByText(/1 more file was not attached/)).toBeInTheDocument()
  })

  it('enables Send for an attachment alone and sends an empty text with it', async () => {
    const user = userEvent.setup()
    const good: AttachmentMeta = { id: 'h1', name: 'a.pdf', kind: 'pdf', bytes: 1 }
    const { send } = mount({
      overrides: { bridge: { pickFiles: async () => ['/a.pdf'] }, ai: { attach: async () => [good] } }
    })
    expect(await screen.findByTitle('Send')).toBeDisabled()
    await openPlus(user)
    await user.click(screen.getByRole('menuitem', { name: /Attach files/ }))
    await screen.findByText(/a\.pdf/)
    expect(screen.getByTitle('Send')).toBeEnabled()
    await user.click(screen.getByTitle('Send'))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][0]).toMatchObject({ userText: '', attachments: [good] })
  })

  it('shows the comparison chips, and the picker behind "Comparison models…"', async () => {
    const user = userEvent.setup()
    comparedWith = ['x', 'y']
    const { send } = mount()
    const many = await screen.findByRole('button', { name: /2 comparison models/ })
    await user.click(many)
    expect(await plus()).toHaveAttribute('aria-expanded', 'true')

    await user.click(await item('y'))
    const chip = await screen.findByTitle(/^Briefed on x/)
    expect(chip).toHaveTextContent('x')
    expect(screen.queryByRole('button', { name: /comparison models/ })).toBeNull()
    await user.click(within(chip).getByRole('button'))
    expect(screen.queryByTitle(/^Briefed on/)).toBeNull()

    await say(user, 'go')
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][0]).toMatchObject({ comparisonModels: [] })

    await openPlus(user)
    await user.click(screen.getByRole('menuitem', { name: /Comparison models…/ }))
    expect(await plus()).toHaveAttribute('aria-expanded', 'false')
    const close = await screen.findByLabelText('Close')
    await user.click(close)
    expect(screen.queryByLabelText('Close')).toBeNull()
  })

  it('locks the composer without a key, and unlocks it when a key is stored', async () => {
    let hasKey = false
    const { container } = mount({ overrides: { ai: { hasKey: async () => hasKey } } })
    const ta = await screen.findByPlaceholderText(
      'No OpenRouter API key configured — add one under Settings → AI.'
    )
    expect(ta).toBeDisabled()
    expect(await plus()).toBeDisabled()
    expect(screen.getByTitle('Send')).toBeDisabled()
    expect(screen.getByLabelText('Record a voice message')).toBeDisabled()

    hasKey = true
    const { KEY_CHANGED_EVENT } = await import('./lib/ai')
    await act(async () => {
      window.dispatchEvent(new Event(KEY_CHANGED_EVENT))
    })
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled())
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Ask or instruct the assistant…')
    expect(await plus()).toBeEnabled()
    expect(container.querySelector('.chat-mic')).toBeEnabled()
  })

  it('web search: the menu and the send both follow the app setting', async () => {
    const user = userEvent.setup()
    // (a) The old browser key is ignored: shown, switched on, and sent.
    window.localStorage.setItem('prism.ai.webSearchEnabled', 'false')
    const a = mount()
    await openPlus(user)
    expect(await item('Web search')).toHaveAttribute('aria-checked', 'true')
    await say(user, 'go')
    await waitFor(() => expect(a.send).toHaveBeenCalledTimes(1))
    expect(a.send.mock.calls[0][0]).toMatchObject({ webSearch: true, webSearchAllowed: true })
    await finish(a.prism)
    a.unmount()

    // (b) The app setting off: the row is gone (setting off = row gone, like Distances and Eurostat),
    // and the message goes out without web search.
    window.localStorage.clear()
    const { setAS } = await import('./lib/appSettings')
    const b = mount()
    act(() => setAS({ webSearchEnabled: false }))
    await openPlus(user)
    await item('Eurostat EoL')
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Web search' })).toBeNull()
    await say(user, 'again')
    await waitFor(() => expect(b.send).toHaveBeenCalledTimes(1))
    expect(b.send.mock.calls[0][0]).toMatchObject({ webSearch: false, webSearchAllowed: false })
  })

  it('hides the rows that cannot apply', async () => {
    const user = userEvent.setup()
    const availability = vi.fn(async () => ({ available: false }))
    const noDist = mount({ overrides: { distance: { availability } } })
    await openPlus(user)
    await item('Eurostat EoL')
    await waitFor(() => expect(availability).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Distances' })).toBeNull()
    noDist.unmount()

    const { setAS } = await import('./lib/appSettings')
    const { DEFAULT_TRANSPORT } = await import('../../shared/distanceDefaults')
    act(() => setAS({ transport: { ...DEFAULT_TRANSPORT, toolEnabled: false } }))
    const noTool = mount()
    await openPlus(user)
    await item('Eurostat EoL')
    await act(async () => {})
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Distances' })).toBeNull()
    noTool.unmount()

    act(() => setAS({ eurostatEnabled: false, voiceEnabled: false, transport: DEFAULT_TRANSPORT }))
    const trimmed = mount({ props: { libraryDbs: undefined, backgroundDbs: undefined } })
    await openPlus(user)
    await item('Distances')
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Eurostat EoL' })).toBeNull()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'My processes' })).toBeNull()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'ei-3.11' })).toBeNull()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'agb' })).toBeNull()
    expect(screen.queryByLabelText('Record a voice message')).toBeNull()
    trimmed.unmount()
  })

  it('opens the panel on focus, keeps .chat-bar a direct child, and says when no model is open', async () => {
    const user = userEvent.setup()
    const { container, rerender } = mount()
    const root = container.querySelector('.canvas-chat') as HTMLElement
    expect(container.querySelector('.canvas-chat > .chat-bar')).not.toBeNull()
    expect(root).not.toHaveClass('open')
    await user.click(await box())
    expect(root).toHaveClass('open')

    rerender({ activeDb: null })
    expect(await screen.findByPlaceholderText('Open a model to chat')).toBeDisabled()
  })

  it('a flip on model m does not reach a fresh panel on model n', async () => {
    // The not-yet-created chat is kept per model; it used to be one
    // '(new)' entry shared by every model.
    const user = userEvent.setup()
    const { rerender, unmount } = mount()
    await openPlus(user)
    await user.click(await item('Web search'))
    expect(await item('Web search')).toHaveAttribute('aria-checked', 'false')
    rerender({ activeDb: 'n' })
    await openPlus(user)
    await waitFor(async () => expect(await item('Web search')).toHaveAttribute('aria-checked', 'true'))
    rerender({ activeDb: 'm' })
    await openPlus(user)
    await waitFor(async () => expect(await item('Web search')).toHaveAttribute('aria-checked', 'false'))
    unmount()

    // A fresh panel on the other model starts at the default, and sends it.
    const onN = mount({ props: { activeDb: 'n' } })
    await openPlus(user)
    expect(await item('Web search')).toHaveAttribute('aria-checked', 'true')
    await say(user, 'go')
    await waitFor(() => expect(onN.send).toHaveBeenCalledTimes(1))
    expect(onN.send.mock.calls[0][0]).toMatchObject({ webSearch: true })
    onN.unmount()

    // Model m kept its own.
    mount()
    await openPlus(user)
    expect(await item('Web search')).toHaveAttribute('aria-checked', 'false')
  })

  it('closes the "+" menu on Escape', async () => {
    const user = userEvent.setup()
    mount()
    await openPlus(user)
    await item('Web search')
    await user.keyboard('{Escape}')
    expect(await plus()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Web search' })).toBeNull()
  })

  it('closes the "+" menu on a click outside it', async () => {
    const user = userEvent.setup()
    mount()
    await openPlus(user)
    // A click inside keeps it open…
    await user.click(await item('Web search'))
    expect(await plus()).toHaveAttribute('aria-expanded', 'true')
    // …a click elsewhere closes it.
    await user.click(await box())
    expect(await plus()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Web search' })).toBeNull()
  })

  it("a model switch while the first send creates the chat keeps both models' choices apart", async () => {
    // The carry-over used to take whichever model was on screen when
    // createChat resolved, and moved n's draft and switches into m's chat.
    const user = userEvent.setup()
    let created: (v: unknown) => void = () => {}
    const first = mount()
    first.prism.setRoute('POST /api/v1/ai/chats/m', () => new Promise((res) => (created = res)))
    await openPlus(user)
    await user.click(await item('Web search'))
    expect(await item('Web search')).toHaveAttribute('aria-checked', 'false')
    await say(user, 'go')

    first.rerender({ activeDb: 'n' })
    await openPlus(user)
    await waitFor(async () => expect(await item('Web search')).toHaveAttribute('aria-checked', 'true'))
    await user.click(await item('My processes'))
    expect(await item('My processes')).toHaveAttribute('aria-checked', 'true')
    await user.type(await box(), 'on n')

    await act(async () => created({ id: 'c1', title: '', messages: [] }))
    await waitFor(() => expect(first.send).toHaveBeenCalledTimes(1))
    expect(first.send.mock.calls[0][0]).toMatchObject({ chatId: 'c1', activeDb: 'm', webSearch: false })
    // The panel stays on n while m's run is one "elsewhere": until then `send`
    // jumped the panel into c1 and wrote the message into n's transcript.
    expect(await screen.findByText('1 other run')).toBeInTheDocument()
    expect(screen.queryByText('go')).toBeNull()
    await openPlus(user)
    expect(await item('Web search')).toHaveAttribute('aria-checked', 'true')
    expect(await item('My processes')).toHaveAttribute('aria-checked', 'true')
    expect(await box()).toHaveValue('on n')
    // The user message was stored under m's chat, not n's.
    expect(
      first.prism.calls.some((c) => c.method === 'POST' && c.path === '/api/v1/ai/chats/m/c1/messages')
    ).toBe(true)
    act(() => first.prism.emit({ chatId: 'c1', type: 'done', text: 'ok' }))
    await act(async () => {})
    await waitFor(() => expect(screen.queryByText('1 other run')).toBeNull())
    first.unmount()

    // m's chat has m's choices: web search off, My processes off, no draft from n.
    chats = [{ id: 'c1' }]
    const inC1 = mount()
    await waitFor(() => expect(inC1.prism.calls.some((c) => c.path === '/api/v1/ai/chats/m/c1')).toBe(true))
    await openPlus(user)
    await waitFor(async () => expect(await item('Web search')).toHaveAttribute('aria-checked', 'false'))
    expect(await item('My processes')).toHaveAttribute('aria-checked', 'false')
    expect(await box()).toHaveValue('')
    inC1.unmount()

    // n still has its placeholder: My processes on, the draft kept.
    chats = []
    mount({ props: { activeDb: 'n' } })
    await openPlus(user)
    await waitFor(async () => expect(await item('My processes')).toHaveAttribute('aria-checked', 'true'))
    expect(await item('Web search')).toHaveAttribute('aria-checked', 'true')
    expect(await box()).toHaveValue('on n')
  })
})

describe('storing the message before the run', () => {
  it('sends nothing when the message cannot be stored, and gives the words back', async () => {
    chats = [{ id: 'c1' }]
    storeMessage = () => ({ status: 500, body: { detail: 'disk full' } })
    const user = userEvent.setup()
    const r = mount()
    await waitFor(() => expect(r.prism.calls.some((c) => c.path === '/api/v1/ai/chats/m/c1')).toBe(true))
    await say(user, 'hello')
    expect(await screen.findByText(/could not be saved, so it was not sent/)).toBeTruthy()
    expect(await box()).toHaveValue('hello')
    expect(r.send).not.toHaveBeenCalled()
  })

  it('a second message typed while the first is being stored is neither cleared nor sent', async () => {
    chats = [{ id: 'c1' }]
    let release: () => void = () => {}
    storeMessage = () =>
      new Promise((resolve) => {
        release = () => resolve({})
      })
    const user = userEvent.setup()
    const r = mount()
    await waitFor(() => expect(r.prism.calls.some((c) => c.path === '/api/v1/ai/chats/m/c1')).toBe(true))
    await say(user, 'one')
    await say(user, 'two')
    expect(await box()).toHaveValue('two')
    act(() => release())
    await finish(r.prism)
    expect(r.send).toHaveBeenCalledTimes(1)
    expect(r.send.mock.calls[0][0].userText).toBe('one')
    expect(await box()).toHaveValue('two')
  })
})
