import { beforeEach, describe, expect, it } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Workbench, { describeExternalClients } from './Workbench'
import { renderWithPrism } from './test/render'
import type { Routes } from './test/prism'
import { fetchQuery, resetQueryCache } from './lib/server/useQuery'
import { studyRoute } from './lib/server/routes'
import { resetChatNotices } from './lib/chatNotices'

// The shared query cache (lib/server/useQuery) deliberately outlives a component between mounts —
// deduplicated loading is the feature. These tests assert what one mount loads, so each starts cold.
beforeEach(() => resetQueryCache())

/**
 * Characterisation tests for the Workbench shell — written BEFORE the planned split into
 * useCanvasModel / useProjectModels / presentational components, so that a cut which tears the
 * wiring (mount-time loads, the setup gate's decision, the sidebar/topbar plumbing) turns red here
 * instead of in a running app.
 *
 * Deliberately NOT covered: the ReactFlow canvas itself (view === 'model' mounts the graph, the
 * chat dock and the search panel — an integration surface of its own), drag/drop, tag painting,
 * and undo/redo round trips. These tests pin what every path shares: what mounting loads, and what
 * the gate does when a project has no data or no model.
 */

/** The reads Workbench performs on mount, whatever the project looks like. */
const baseRoutes = (databases: unknown[] = []): Routes => ({
  'GET /api/v1/system/info': { current_project: { name: 'demo' }, app_version: '0.0.0-test' },
  'GET /api/v1/projects': [{ name: 'demo' }],
  'GET /api/v1/databases': databases,
  'GET /api/v1/databases/folders': { folders: [], assignment: {} },
  'GET /api/v1/model/tag-groups': { groups: [] },
  'GET /api/v1/calc/methods': [],
  'GET /api/v1/model/unit-vocabulary': { units: [] },
  'GET /api/v1/model/audit': [],
  'GET /api/v1/model/history': {
    can_undo: false,
    can_redo: false,
    next_undo: null,
    next_redo: null
  },
  'GET /api/v1/search/status': { state: 'idle', database: null }
})

describe('Workbench setup gate', () => {
  it('opens on the import choice when the project has no databases at all', async () => {
    const { prism } = renderWithPrism(<Workbench />, { routes: baseRoutes([]) })

    expect(await screen.findByText('Bring your background data')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import ecoinvent' })).toBeInTheDocument()
    // The gate names the project it is talking about — a gate for the wrong project misdirects the
    // import. ('demo' also appears in the project <select>, hence getAllByText.)
    expect(screen.getAllByText('demo').length).toBeGreaterThan(0)

    // The decision "no data" is made from the databases list, so that read must have happened.
    await waitFor(() =>
      expect(prism.calls.some((c) => c.method === 'GET' && c.path === '/api/v1/databases')).toBe(true)
    )
  })

  it('opens the Overview, not a gate, once a background exists but no model does', async () => {
    renderWithPrism(<Workbench />, {
      routes: baseRoutes([{ name: 'ecoinvent-3.12', node_count: 26000, read_only: true, kind: 'background' }])
    })

    expect(await screen.findByText('No models yet.')).toBeInTheDocument()
    expect(screen.queryByText('Bring your background data')).toBeNull()
    expect(screen.getByText('No model yet')).toBeInTheDocument() // the sidebar's project card
  })

  it('creates the first model from the Overview', async () => {
    const user = userEvent.setup()
    renderWithPrism(<Workbench />, {
      routes: baseRoutes([{ name: 'ecoinvent-3.12', node_count: 26000, read_only: true, kind: 'background' }])
    })

    await screen.findByText('No models yet.')
    await user.click(screen.getAllByTitle('Create another model, or duplicate an existing one')[0])
    expect(await screen.findByText('New model')).toBeInTheDocument()
    expect(screen.getByLabelText(/Model name/i)).toBeInTheDocument()
  })
})

describe('Workbench start-up with a remembered model that is gone', () => {
  it('asks for nothing under that name and shows no error on the first-run card', async () => {
    // A profile outlives its data: the model remembered from the last session was deleted, or the data
    // folder was replaced. Every model-scoped read under the old name used to fail, and the card said so.
    localStorage.setItem('prism.activeModel', JSON.stringify('gone'))
    try {
      const notFound = {
        status: 404,
        body: { error: { code: 'database_not_found', message: "Database 'gone' not found." } }
      }
      const scoped = (ok: unknown) => (_b: unknown, path: string) => (path.includes('gone') ? notFound : ok)
      const { prism } = renderWithPrism(<Workbench />, {
        routes: {
          ...baseRoutes([]),
          'GET /api/v1/model/audit': scoped([]),
          'GET /api/v1/model/history': scoped({
            can_undo: false,
            can_redo: false,
            next_undo: null,
            next_redo: null
          }),
          'GET /api/v1/model/graph/:db': scoped({ nodes: [], edges: [] }),
          'GET /api/v1/views/:db': scoped({ view: {} })
        }
      })
      expect(await screen.findByText('Bring your background data')).toBeInTheDocument()
      await act(async () => new Promise((r) => setTimeout(r, 300)))
      expect(prism.calls.filter((c) => c.path.includes('gone')).map((c) => c.path)).toEqual([])
      expect(screen.queryByText(/not found/)).toBeNull()
    } finally {
      localStorage.removeItem('prism.activeModel')
    }
  })
})

describe('Workbench start-up that fails', () => {
  it('keeps the gate and its controls after the error line is cleared', async () => {
    const user = userEvent.setup()
    renderWithPrism(<Workbench />, {
      routes: {
        ...baseRoutes([]),
        'GET /api/v1/databases': {
          status: 500,
          body: { error: { code: 'internal', message: 'Backend hiccup.' } }
        },
        'GET /api/v1/system/backup/estimate': { bytes: 1_000_000, warning: '', databases: [] }
      },
      overrides: { bridge: { pickDirectory: async () => null } }
    })
    expect(await screen.findByText(/Backend hiccup/)).toBeInTheDocument()
    // A backup clears the error line before it asks for a folder; the user cancels the picker.
    await user.click(screen.getByRole('button', { name: 'Back up this workspace' }))
    await waitFor(() => expect(screen.queryByText(/Backend hiccup/)).toBeNull())
    expect(document.querySelector('.setup .detail')).toBeNull() // cleared, not replaced by another error
    expect(screen.getByRole('button', { name: 'Import ecoinvent' })).toBeInTheDocument()
  })
})

describe('Workbench import wizard', () => {
  it('keeps the second wizard open that "Also import" starts, through the refresh that follows', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Workbench />, {
      routes: {
        ...baseRoutes([]),
        'POST /api/v1/setup/background': { state: 'running', step: 'starting', detail: '', progress: 0 },
        'GET /api/v1/setup/status': {
          state: 'done',
          step: 'finished',
          detail: '',
          progress: 1,
          database: 'ecoinvent-3.12-cutoff'
        },
        'GET /api/v1/setup/background': {
          background: [
            { name: 'ecoinvent-3.12-cutoff', provider: 'ecoinvent', activities: 1, label: '', version: '' }
          ]
        }
      },
      overrides: { bridge: { pickDirectory: async () => '/data/release' } }
    })

    await user.click(await screen.findByRole('button', { name: 'Import ecoinvent' }))
    await user.click(screen.getByRole('button', { name: /choose folder/i }))
    await user.click(screen.getByRole('button', { name: /start import/i }))
    const reads = (): number => prism.calls.filter((c) => c.path === '/api/v1/databases').length
    const before = reads()
    await user.click(await screen.findByRole('button', { name: 'Also import BAFU…' }))
    await waitFor(() => expect(reads()).toBeGreaterThan(before))
    expect(await screen.findByRole('heading', { name: 'Import BAFU:20XY' })).toBeInTheDocument()
  })
})

describe('Workbench full chrome', () => {
  const FG = { name: 'pet-bottle', node_count: 3, read_only: false, kind: 'foreground' }
  const routes = (): Routes => ({
    ...baseRoutes([FG, { name: 'ecoinvent-3.12', node_count: 26000, read_only: true, kind: 'background' }]),
    // The canvas state machine loads the graph for the active model even while Overview is the
    // visible view — pinned here so a split that moves the load into the Model view is a decision.
    'GET /api/v1/model/graph/pet-bottle': { database: 'pet-bottle', nodes: [], edges: [] },
    'GET /api/v1/views/pet-bottle': { view: {} },
    'GET /api/v1/study': {},
    'GET /api/v1/model/reference/pet-bottle': { candidates: [] }
  })

  it('mounts the app shell: sidebar navigation, project card, and the Overview landing view', async () => {
    renderWithPrism(<Workbench />, { routes: routes() })

    // The sidebar names every study page. Some labels ('Model', 'Results') legitimately appear in
    // the mounted view too, so this asserts presence, not uniqueness.
    for (const label of ['Overview', 'Model', 'Parameters', 'Scenarios', 'LCIA', 'Results', 'Report']) {
      expect((await screen.findAllByText(label)).length).toBeGreaterThan(0)
    }
    expect(await screen.findByText('Workspace')).toBeInTheDocument()
    expect(await screen.findByText('pet-bottle · foreground')).toBeInTheDocument()
  })

  it('Ctrl+Z undoes and Ctrl+Shift+Z redoes — but not while typing in a field', async () => {
    const user = userEvent.setup()
    const r = routes()
    r['GET /api/v1/model/history'] = {
      can_undo: true,
      can_redo: true,
      next_undo: 'Set parameter',
      next_redo: 'Set parameter',
      next_undo_turn: null,
      next_redo_turn: null
    }
    r['POST /api/v1/model/undo'] = {}
    r['POST /api/v1/model/redo'] = {}
    const { prism } = renderWithPrism(<Workbench />, { routes: r })
    await screen.findByText('Workspace')
    await waitFor(() => expect(screen.getAllByTitle(/^Undo: Set parameter/).length).toBeGreaterThan(0))
    const posts = (path: string): number =>
      prism.calls.filter((c) => c.method === 'POST' && c.path === path).length

    await user.keyboard('{Control>}z{/Control}')
    await waitFor(() => expect(posts('/api/v1/model/undo')).toBe(1))
    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}')
    await waitFor(() => expect(posts('/api/v1/model/redo')).toBe(1))

    // In a text field the field's own undo wins.
    await user.click(screen.getByPlaceholderText('Find a model…'))
    await user.keyboard('{Control>}z{/Control}')
    expect(posts('/api/v1/model/undo')).toBe(1)
  })

  it('restores a backup as a workspace of its own and asks for a name when that one is taken', async () => {
    const user = userEvent.setup()
    const r = routes()
    const bodies: unknown[] = []
    r['POST /api/v1/projects/restore'] = (body: unknown) => {
      bodies.push(body)
      return (body as { project_name?: string }).project_name
        ? { project_name: 'demo-2' }
        : {
            status: 409,
            body: { error: { code: 'workspace_exists', message: "A workspace named 'demo' already exists." } }
          }
    }
    renderWithPrism(<Workbench />, {
      routes: r,
      overrides: { bridge: { pickFile: async () => '/home/me/backup.tar.gz' } }
    })
    // The workspace block is re-mounted once the loads land; click the one that stays.
    await screen.findByText('pet-bottle · foreground')
    await user.click(screen.getByRole('button', { name: 'Restore a workspace backup' }))
    await user.click(await screen.findByRole('button', { name: 'Restore' }))
    // The name in the archive is taken: no overwrite, a name is asked for instead.
    expect(await screen.findByText('Restore under another name')).toBeInTheDocument()
    await user.type(screen.getByLabelText(/Restore it as/), 'demo-2')
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    expect(await screen.findByText('Workspace restored')).toBeInTheDocument()
    expect(bodies).toEqual([
      { path: '/home/me/backup.tar.gz' },
      { path: '/home/me/backup.tar.gz', project_name: 'demo-2' }
    ])
  })

  it('loads project inventory, methods, audit and the model graph on mount', async () => {
    const { prism } = renderWithPrism(<Workbench />, { routes: routes() })

    await screen.findByText('Workspace')
    const paths = (): string[] => prism.calls.map((c) => `${c.method} ${c.path.split('?')[0]}`)
    await waitFor(() => {
      for (const expected of [
        'GET /api/v1/system/info',
        'GET /api/v1/projects',
        'GET /api/v1/databases',
        'GET /api/v1/model/tag-groups',
        'GET /api/v1/calc/methods',
        'GET /api/v1/model/unit-vocabulary',
        'GET /api/v1/model/audit',
        'GET /api/v1/model/graph/pet-bottle'
      ]) {
        expect(paths()).toContain(expected)
      }
    })
  })
})

describe('the library among the models', () => {
  const LIB = { name: 'My processes', node_count: 4, read_only: false, kind: 'library' }
  const FG = { name: 'pet-bottle', node_count: 3, read_only: false, kind: 'foreground' }

  it('does not list the library among the models, and never opens it by default', async () => {
    renderWithPrism(<Workbench />, {
      routes: {
        ...baseRoutes([LIB, FG, { name: 'eco', node_count: 26000, read_only: true, kind: 'background' }]),
        'GET /api/v1/model/graph/pet-bottle': { database: 'pet-bottle', nodes: [], edges: [] },
        'GET /api/v1/views/pet-bottle': { view: {} },
        'GET /api/v1/study': {},
        'GET /api/v1/model/reference/pet-bottle': { candidates: [] }
      }
    })

    // `!read_only` is not "a model": the library is writable too, and landing in it by default
    // would open a shared dataset store as if it were a study. It is not a card either — you reach
    // ecoinvent through the search rather than by clicking it open, and the library is the same
    // kind of thing.
    expect(await screen.findByText('pet-bottle · foreground')).toBeInTheDocument()
    expect(screen.queryByText(/a change here reaches every model/i)).not.toBeInTheDocument()
  })

  it('opens the library when there is no model at all, rather than the setup gate', async () => {
    // A project can hold a library and no study yet — the gate must still ask for a model, because
    // a library is not something you report on.
    renderWithPrism(<Workbench />, {
      routes: baseRoutes([LIB, { name: 'eco', node_count: 26000, read_only: true, kind: 'background' }])
    })

    expect(await screen.findByText('No model yet')).toBeInTheDocument()
  })
})

describe('a stale active model', () => {
  it('falls back to a real model when the remembered one is the library', async () => {
    // `activeDb` is persisted. A session that left the library open came back to "No model yet"
    // with fifty-one models in the project, because the keep-branch asked `!read_only` and the
    // library is writable. The fallback was right; the branch that never reached it was not.
    localStorage.setItem('prism.activeModel', JSON.stringify('My processes'))
    const LIB = { name: 'My processes', node_count: 4, read_only: false, kind: 'library' }
    const FG = { name: 'pet-bottle', node_count: 3, read_only: false, kind: 'foreground' }
    renderWithPrism(<Workbench />, {
      routes: {
        ...baseRoutes([LIB, FG, { name: 'eco', node_count: 26000, read_only: true, kind: 'background' }]),
        'GET /api/v1/model/graph/pet-bottle': { database: 'pet-bottle', nodes: [], edges: [] },
        'GET /api/v1/views/pet-bottle': { view: {} },
        'GET /api/v1/study': {},
        'GET /api/v1/model/reference/pet-bottle': { candidates: [] }
      }
    })

    expect(await screen.findByText('pet-bottle · foreground')).toBeInTheDocument()
    expect(screen.queryByText('No model yet')).not.toBeInTheDocument()
    localStorage.removeItem('prism.activeModel')
  })
})

/**
 * A question from an assistant whose chat is not on screen.
 *
 * The chat panel is mounted only on the Model view and shows the chat in front of you, so a question
 * asked while you are on the Overview, on Results, or in another model waited for nobody. The
 * Workbench keeps main's list of open questions and banners every one the panel does not show; the
 * button leads to the chat, and once the card is on screen the banner goes.
 */
describe('a question banner for an assistant waiting elsewhere', () => {
  const FG = { name: 'pet-bottle', node_count: 3, read_only: false, kind: 'foreground' }
  const ASK = {
    reqId: 'u1',
    chatId: 'c1',
    database: 'pet-bottle',
    args: { questions: [{ question: 'Which PET?', options: ['virgin', 'recycled'] }] },
    since: 1
  }
  const routes = (): Routes => ({
    ...baseRoutes([FG, { name: 'ecoinvent-3.12', node_count: 26000, read_only: true, kind: 'background' }]),
    'GET /api/v1/model/graph/pet-bottle': { database: 'pet-bottle', nodes: [], edges: [] },
    'GET /api/v1/views/pet-bottle': { view: {} },
    'GET /api/v1/study': {},
    'GET /api/v1/model/reference/pet-bottle': { candidates: [] },
    'GET /api/v1/ai/chats/pet-bottle': { chats: [{ id: 'c1', title: 'Bottle' }] },
    'GET /api/v1/ai/chats/pet-bottle/c1': { id: 'c1', title: 'Bottle', messages: [] }
  })

  it('shows the banner on the Overview, naming the model, with the way to the chat', async () => {
    renderWithPrism(<Workbench />, {
      routes: routes(),
      overrides: { ai: { isRunning: async () => true, pendingAsks: async () => [ASK] } }
    })
    const banner = await screen.findByText(/has a question for you/)
    expect(banner).toHaveTextContent('“pet-bottle”')
    expect(screen.getByRole('button', { name: 'Go to chat' })).toBeInTheDocument()
    // What the button does — switch model and view, open the panel on that chat, restore the card —
    // is pinned in CanvasChat.dom.test.tsx ("opens on the chat a 'Go to chat' request names"). It is
    // not clicked here because the Model view does not mount under jsdom (see the file header).
  })

  it('disappears when the run stops waiting', async () => {
    const { prism } = renderWithPrism(<Workbench />, {
      routes: routes(),
      overrides: { ai: { pendingAsks: async () => [ASK] } }
    })
    await screen.findByText(/has a question for you/)
    prism.emit({ chatId: 'c1', type: 'ask-settled', reqId: 'u1' })
    await waitFor(() => expect(screen.queryByText(/has a question for you/)).toBeNull())
  })

  it('a turn that ends out of sight leaves a notice on the Overview too (V406)', async () => {
    const { prism } = renderWithPrism(<Workbench />, { routes: routes() })
    await screen.findByText(/pet-bottle/)
    // The model is learnt from the run's own events; the chat panel is not mounted on the Overview.
    act(() => prism.emit({ chatId: 'c1', type: 'refresh', database: 'pet-bottle' }))
    act(() => prism.emit({ chatId: 'c1', type: 'done', text: 'The bottle is modelled.' }))
    expect(await screen.findByText(/Assistant finished in “pet-bottle”/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument()
    act(() => resetChatNotices()) // module state: the next test must not inherit the row
  })

  it('an edit made while the canvas is out of sight reloads the graph all the same', async () => {
    const { prism } = renderWithPrism(<Workbench />, {
      routes: routes(),
      // The mock hands every emitted event to every channel; in the app a chat run's events never reach
      // the external agents' listener, which reloads on its own.
      overrides: { mcp: { onEvent: () => () => undefined } }
    })
    await screen.findByText(/pet-bottle/)
    const graphReads = (): number =>
      prism.calls.filter((c) => c.method === 'GET' && c.path === '/api/v1/model/graph/pet-bottle').length
    await waitFor(() => expect(graphReads()).toBeGreaterThan(0))
    await act(() => new Promise((r) => setTimeout(r, 500))) // the opening loads settle first
    const before = graphReads()
    const studyReads = (): number => prism.calls.filter((c) => c.path.startsWith('/api/v1/study')).length
    await fetchQuery(studyRoute('pet-bottle'))
    const studyBefore = studyReads()
    // On the Overview the chat panel is not mounted; the edit must reach the canvas without it.
    act(() => {
      for (let i = 0; i < 3; i++)
        prism.emit({ chatId: 'c1', type: 'refresh', database: 'pet-bottle', graph: true })
    })
    await waitFor(() => expect(graphReads()).toBe(before + 1))
    // …and the model caches: goal and scope written meanwhile open from the server, not the old copy.
    await waitFor(async () => {
      await fetchQuery(studyRoute('pet-bottle'))
      expect(studyReads()).toBe(studyBefore + 1)
    })
    // Coalesced: the burst cost one reload, and an edit to another model costs none.
    act(() => prism.emit({ chatId: 'c2', type: 'refresh', database: 'other', graph: true }))
    await act(() => new Promise((r) => setTimeout(r, 400)))
    expect(graphReads()).toBe(before + 1)
  })

  it('an edit makes the caches stale even when the audit log cannot be read afterwards', async () => {
    let auditDown = false
    const { prism } = renderWithPrism(<Workbench />, {
      routes: {
        ...routes(),
        'GET /api/v1/model/audit': () => (auditDown ? { status: 500, body: { detail: 'down' } } : [])
      },
      overrides: { mcp: { onEvent: () => () => undefined } }
    })
    await screen.findByText(/pet-bottle/)
    await act(() => new Promise((r) => setTimeout(r, 500)))
    const studyReads = (): number => prism.calls.filter((c) => c.path.startsWith('/api/v1/study')).length
    await fetchQuery(studyRoute('pet-bottle'))
    const studyBefore = studyReads()
    auditDown = true
    act(() => prism.emit({ chatId: 'c1', type: 'refresh', database: 'pet-bottle' }))
    await waitFor(() =>
      expect(prism.calls.filter((c) => c.path.startsWith('/api/v1/model/audit')).length).toBeGreaterThan(0)
    )
    await act(() => new Promise((r) => setTimeout(r, 500)))
    // The edit happened whether or not the log could be read: the next reader asks the server.
    await fetchQuery(studyRoute('pet-bottle'))
    expect(studyReads()).toBe(studyBefore + 1)
  })
})

describe('the external-agents bar', () => {
  it('names each client once and counts instances only above one', () => {
    const s = (clientName: string) => ({ clientName })
    expect(describeExternalClients([s('Claude Code')])).toBe('Claude Code')
    expect(describeExternalClients([s('Claude Code'), s('Claude Code'), s('Claude Code')])).toBe(
      'Claude Code (3 instances)'
    )
    expect(describeExternalClients([s('Codex'), s('Claude Code'), s('Codex')])).toBe(
      'Codex (2 instances), Claude Code'
    )
  })
})
