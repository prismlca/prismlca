/**
 * The approval policy of one external session, with a fake backend and a fake window: which calls show
 * a card, what the card is told, and what the backend then receives.
 */
import { describe, expect, it } from 'vitest'
import type { ApiRaw } from '../ai/execute'
import type { McpApprovalMode } from '../../shared/ipc'
import { McpSession } from './sessions'
import { callActions } from './approvalRequest'

interface Sent {
  method: string
  path: string
  body?: unknown
  headers?: Record<string, string>
}

function setup(opts: {
  next?: { step: number | null; summary: string | null; needs_approval: boolean } | 'down'
  answer?: { approved: boolean }
  mode?: McpApprovalMode
}) {
  const sent: Sent[] = []
  const cards: Array<Record<string, unknown>> = []
  const apiRaw: ApiRaw = async (method, path, body, headers) => {
    sent.push({ method, path, body, headers })
    if (path === '/api/v1/setup/status') return { status: 200, body: { state: 'idle' } }
    if (path.startsWith('/api/v1/model/history/next')) {
      if (opts.next === 'down' || !opts.next) return { status: 503, body: 'down' }
      return { status: 200, body: opts.next }
    }
    if (method === 'POST' && path === '/api/v1/model/undo')
      return { status: 200, body: { undone: "Create process 'x'" } }
    if (method === 'POST' && path === '/api/v1/lcia/delete') return { status: 200, body: { deleted: true } }
    return { status: 404, body: { detail: 'not found' } }
  }
  const session = new McpSession(
    'aaaaaaaa-1111-2222-3333-444444444444',
    {
      apiRaw,
      ui: async (_sid, _client, _db, name, args) => {
        if (name === 'approve_tool') {
          cards.push(args)
          return opts.answer ?? { approved: true }
        }
        return { ok: true }
      },
      settings: () => ({ disabledTools: [], preferredBackground: '', eurostatEnabled: false }),
      onChange: () => {},
      onMutated: () => {}
    },
    'Shared',
    { backgroundDbs: [], libraryDbs: [] },
    'proj-A'
  )
  if (opts.mode) session.approval = opts.mode
  const undoPosts = (): Sent[] => sent.filter((s) => s.method === 'POST' && s.path === '/api/v1/model/undo')
  return { session, sent, cards, undoPosts }
}

const FOREIGN = { step: 17, summary: "Import model 'Client Study' from a bundle", needs_approval: true }

describe('McpSession: undo of a step the session did not make', () => {
  it('asks the user in every mode, names the step, and binds the approval to it', async () => {
    for (const mode of ['irreversible', 'never', 'every-write'] as const) {
      const { session, cards, undoPosts } = setup({ next: FOREIGN, mode })
      const oc = await session.call('history', { action: 'undo' })
      expect(oc.ok).toBe(true)
      expect(cards).toHaveLength(1)
      expect(cards[0]).toMatchObject({
        tool: 'history',
        action: 'undo',
        step: { verb: 'undo', summary: FOREIGN.summary }
      })
      // The approval travels with the undo, naming the step the user saw — and the session's model.
      expect(undoPosts()).toHaveLength(1)
      expect(undoPosts()[0].headers?.['X-Prism-Approved-Step']).toBe('undo:17')
      expect(undoPosts()[0].body).toMatchObject({ database: 'Shared', source: 'ai' })
      expect(undoPosts()[0].headers?.['X-Prism-Turn']).toMatch(/^mcp-aaaaaaaa-\d+$/)
    }
  })

  it('does not run when the user declines, and names the change', async () => {
    const { session, undoPosts } = setup({ next: FOREIGN, answer: { approved: false } })
    const oc = await session.call('history', { action: 'undo' })
    expect(oc.ok).toBe(false)
    if (!oc.ok) {
      expect(oc.error).toMatch(/Declined by the user/)
      expect(oc.error).toContain(FOREIGN.summary)
    }
    expect(undoPosts()).toHaveLength(0)
  })

  it('takes back its own step without a card, and an approval never outlives its call', async () => {
    const own = setup({ next: { step: 4, summary: "Create process 'mine'", needs_approval: false } })
    expect((await own.session.call('history', { action: 'undo' })).ok).toBe(true)
    expect(own.cards).toHaveLength(0)
    expect(own.undoPosts()[0].headers?.['X-Prism-Approved-Step']).toBeUndefined()

    const s = setup({ next: FOREIGN })
    await s.session.call('history', { action: 'undo' })
    s.sent.length = 0
    await s.session.call('get_current_model', {})
    expect(s.sent.every((x) => x.headers?.['X-Prism-Approved-Step'] === undefined)).toBe(true)
  })

  it('leaves the decision to the backend when the step cannot be looked up', async () => {
    const { session, cards, undoPosts } = setup({ next: 'down' })
    await session.call('history', { action: 'undo' })
    expect(cards).toHaveLength(0)
    expect(undoPosts()).toHaveLength(1)
    expect(undoPosts()[0].headers?.['X-Prism-Approved-Step']).toBeUndefined()
  })
})

describe('McpSession: the approval card names the action', () => {
  it('names the action and lists it first, with every argument in full', async () => {
    const { session, cards } = setup({})
    const note = 'n'.repeat(700)
    await session.call('edit_lcia_method', { note, action: 'delete', method: ['My family', 'My indicator'] })
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ tool: 'edit_lcia_method', action: 'delete', effect: 'irreversible' })
    expect(Object.keys(cards[0].args as object)[0]).toBe('action')
    expect((cards[0].args as { note: string }).note).toBe(note)
  })

  it('reads the actions as the tool does: trimmed, and batch items too', () => {
    expect(callActions('edit_lcia_method', { action: ' delete ' })).toEqual(['delete'])
    expect(
      callActions('edit_exchange', {
        action: 'set_amount',
        exchanges: [{ action: 'remove' }, { action: 'set_amount' }]
      })
    ).toEqual(['set_amount', 'remove'])
    expect(callActions('delete_model', { database: 'x' })).toEqual([])
  })
})
