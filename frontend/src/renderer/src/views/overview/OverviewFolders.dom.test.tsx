import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithPrism } from '../../test/render'
import type { RouteReply } from '../../test/prism'
import type { DatabaseInfo } from '../../lib/api'

const ROUTE = 'GET /api/v1/databases/folders'
const FOLDERS = { folders: [{ id: 'f1', name: 'Packaging' }], of: { 'PET bottle': 'f1' } }
const DOWN = { status: 503, body: { detail: 'busy' } }

const fg = (name: string): DatabaseInfo => ({ name, node_count: 3, read_only: false, kind: 'foreground' })
const MODELS = [fg('PET bottle'), fg('Glass jar'), fg('Steel can')]

/** The Overview and its folder store, fresh: "never read yet" is module state, and it is what is tested. */
async function freshOverview(): Promise<{
  Overview: typeof import('../Overview').default
  FOLDER_RETRY_MS: number
}> {
  vi.resetModules()
  const [{ default: Overview }, { FOLDER_RETRY_MS }] = await Promise.all([
    import('../Overview'),
    import('../../lib/modelFolders')
  ])
  return { Overview, FOLDER_RETRY_MS }
}

/** Folder bands as the list draws them: "name count". */
const bands = (): string[] =>
  [...document.querySelectorAll('.ov-folder-h')].map(
    (h) =>
      `${h.querySelector('.ov-folder-name')?.textContent} ${h.querySelector('.ov-folder-count')?.textContent}`
  )

describe('Overview model list before its folders are known', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
  afterEach(() => vi.useRealTimers())

  const props = {
    project: 'p',
    methodsCount: 0,
    onOpenModel: () => {},
    onImportedModel: () => {},
    onImportedDatabase: () => {},
    onRenamedModel: () => {},
    onModelInfoClosed: () => {},
    onNewModel: () => {},
    onDuplicateModel: () => {},
    onDeleteModel: () => {},
    onCheckUpdates: () => {}
  }

  it('shows no "Unsorted" band holding every model while the folder request is open', async () => {
    const { Overview } = await freshOverview()
    let answer: (reply: RouteReply) => void = () => {}
    const pending = new Promise<RouteReply>((done) => (answer = done))
    renderWithPrism(<Overview {...props} databases={MODELS} />, { routes: { [ROUTE]: () => pending } })

    expect(screen.getByText('Loading folders…')).toBeInTheDocument()
    expect(bands()).toEqual([])

    await act(async () => answer(FOLDERS))
    expect(await screen.findByText('Packaging')).toBeInTheDocument()
    expect(bands()).toEqual(['Packaging 1', 'Unsorted 2'])
    expect(screen.queryByText('Loading folders…')).toBeNull()
  })

  it('keeps the folders it showed when a later read fails', async () => {
    const { Overview, FOLDER_RETRY_MS } = await freshOverview()
    const replies: RouteReply[] = [FOLDERS, DOWN, DOWN]
    const view = renderWithPrism(<Overview {...props} databases={MODELS} />, {
      routes: { [ROUTE]: () => replies.shift() ?? DOWN }
    })
    expect(await screen.findByText('Packaging')).toBeInTheDocument()

    // A new model changes the list, which re-reads the folders — and this time the backend is busy.
    view.rerender(<Overview {...props} databases={[...MODELS, fg('Paper bag')]} />)
    await act(() => vi.advanceTimersByTimeAsync(FOLDER_RETRY_MS))
    expect(bands()).toEqual(['Packaging 1', 'Unsorted 3'])
    expect(view.prism.calls.filter((c) => `${c.method} ${c.path}` === ROUTE)).toHaveLength(3) // read, failed, retried
  })

  it('says so when the folders cannot be read at all, and reads them on "Try again"', async () => {
    const { Overview, FOLDER_RETRY_MS } = await freshOverview()
    const replies: RouteReply[] = [DOWN, DOWN, FOLDERS]
    renderWithPrism(<Overview {...props} databases={MODELS} />, {
      routes: { [ROUTE]: () => replies.shift() ?? DOWN }
    })
    await act(() => vi.advanceTimersByTimeAsync(FOLDER_RETRY_MS))
    expect(await screen.findByRole('alert')).toHaveTextContent('The folders could not be read')
    expect(bands()).toEqual([])

    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(screen.getByText('Try again'))
    expect(await screen.findByText('Packaging')).toBeInTheDocument()
    expect(bands()).toEqual(['Packaging 1', 'Unsorted 2'])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('files a model named like an Object method where its own entry says, not nowhere', async () => {
    const { Overview } = await freshOverview()
    const named = [fg('constructor'), fg('toString'), fg('__proto__')]
    // Parsed, so "__proto__" is an own key, as it arrives from the backend.
    const folders = { ...FOLDERS, of: JSON.parse('{"__proto__": "f1"}') as Record<string, string> }
    renderWithPrism(<Overview {...props} databases={named} />, { routes: { [ROUTE]: () => folders } })
    expect(await screen.findByText('Packaging')).toBeInTheDocument()
    // "__proto__" in its folder; "constructor" and "toString" in none — not filed under Object's methods.
    expect(bands()).toEqual(['Packaging 1', 'Unsorted 2'])
  })
})
