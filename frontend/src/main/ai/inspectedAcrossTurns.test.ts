import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredTranscript } from './agent'
import type { ChatMessage } from './providers/types'
import { chat } from './test/fakeStream'
import { inspectedForTranscript, renameInspected, seedInspected } from './inspectedAcrossTurns'
import { inspectedKey } from './tools/advice/hotspots'

vi.mock('./client', async () => (await import('./test/fakeStream')).clientModuleMock())
chat.toolless = () => ({ text: '- earlier results' })

const { runAgent, forgetTranscript } = await import('./agent')

const call = (id: string, name: string, args: unknown): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
})

const answer = (id: string, body: unknown): ChatMessage => ({
  role: 'tool',
  tool_call_id: id,
  content: JSON.stringify(body)
})
const dataset = (database: string, code: string): Record<string, string> => ({
  database,
  code,
  name: code
})

describe('the record as the transcript stores it', () => {
  it('goes out as database and code and comes back as the same keys', () => {
    const record = new Set([inspectedKey('ei', 'steel-row'), inspectedKey('BAFU', 'pp')])
    const stored = inspectedForTranscript(record, null)
    expect(stored).toEqual([
      { database: 'ei', code: 'steel-row' },
      { database: 'BAFU', code: 'pp' }
    ])
    const seeded = new Set<string>()
    seedInspected(seeded, { messages: [], inspected: JSON.parse(JSON.stringify(stored)) }, null)
    expect(seeded).toEqual(record)
  })

  it('takes the stored record over the transcript, and skips what is not a dataset', () => {
    const seeded = new Set<string>()
    seedInspected(
      seeded,
      {
        // Read in the transcript, but the stored record is what counts.
        messages: [
          call('a', 'get_process_details', { code: 'x' }),
          answer('a', { activity: dataset('ei', 'x') })
        ],
        inspected: [{ database: 'ei', code: 'steel-row' }, { database: 'ei' }, null, 'ei\u0000x']
      },
      'M'
    )
    expect([...seeded]).toEqual([inspectedKey('ei', 'steel-row')])
  })

  it('stores the chat model’s own datasets without its name, so they follow a rename between turns', () => {
    const record = new Set([inspectedKey('Barrow', 'frame'), inspectedKey('ei', 'steel-row')])
    const stored = inspectedForTranscript(record, 'Barrow')
    expect(stored).toEqual([{ code: 'frame' }, { database: 'ei', code: 'steel-row' }])
    const seeded = new Set<string>()
    seedInspected(seeded, { messages: [], inspected: stored }, 'Wheelbarrow')
    expect([...seeded]).toEqual([inspectedKey('Wheelbarrow', 'frame'), inspectedKey('ei', 'steel-row')])
  })

  it('files the datasets of a model renamed in the run under its new name', () => {
    const record = new Set([inspectedKey('Barrow', 'frame'), inspectedKey('ei', 'steel-row')])
    renameInspected(record, 'Barrow', 'Wheelbarrow')
    expect([...record]).toEqual([inspectedKey('ei', 'steel-row'), inspectedKey('Wheelbarrow', 'frame')])
  })

  it('keeps two models apart whose names differ only in case or punctuation', () => {
    const record = new Set([inspectedKey('Bottle Glass', 'fu'), inspectedKey('Bottle-Glass', 'fu')])
    expect(inspectedForTranscript(record, 'Bottle Glass')).toEqual([
      { code: 'fu' },
      { database: 'Bottle-Glass', code: 'fu' }
    ])
    renameInspected(record, 'Bottle-Glass', 'Jar Glass')
    expect([...record]).toEqual([inspectedKey('Bottle Glass', 'fu'), inspectedKey('Jar Glass', 'fu')])
  })

  it('seeds nothing when no transcript is carried', () => {
    const seeded = new Set<string>()
    seedInspected(seeded, null, 'M')
    expect(seeded.size).toBe(0)
  })
})

describe('a transcript kept before the record was stored', () => {
  const seed = (messages: ChatMessage[]): string[] => {
    const seeded = new Set<string>()
    seedInspected(seeded, { messages }, 'M')
    return [...seeded]
  }

  it('counts each read where its answer says the dataset was found — by code alone, or by name', () => {
    expect(
      seed([
        call('a', 'get_process_details', { code: 'steel-row' }),
        answer('a', { found_in: 'ei', activity: dataset('ei', 'steel-row'), exchanges: [] }),
        call('b', 'get_process_details', { name: 'polypropylene', summary: true }),
        answer('b', { activity: dataset('ei', 'pp'), exchange_count: 4, biggest_inputs: [] })
      ])
    ).toEqual([inspectedKey('ei', 'steel-row'), inspectedKey('ei', 'pp')])
  })

  it('counts the codes of a batch that were read, not the ones that failed', () => {
    expect(
      seed([
        call('a', 'get_process_details', { database: 'ei', codes: ['x', 'bad', 'y'] }),
        answer('a', {
          total: 3,
          read: 2,
          failed: 1,
          results: [
            { code: 'x', activity: dataset('ei', 'x') },
            { code: 'bad', error: 'not found' },
            { code: 'y', activity: dataset('ei', 'y') }
          ]
        })
      ])
    ).toEqual([inspectedKey('ei', 'x'), inspectedKey('ei', 'y')])
  })

  it('counts no read that failed, was stopped or whose answer was compacted away', () => {
    expect(
      seed([
        call('a', 'get_process_details', { database: 'ei', code: 'x' }),
        answer('a', { error: 'Activity not found' }),
        call('b', 'get_process_details', { database: 'ei', code: 'y' }),
        answer('b', { error: 'not executed — the run stopped before this call ran' }),
        call('c', 'get_process_details', { database: 'ei', code: 'z' }),
        { role: 'tool', tool_call_id: 'c', content: '[earlier tool result omitted to fit the context]' },
        // Another tool's answer naming an activity is not a read either.
        call('d', 'get_flow_properties', { database: 'ei', code: 'w' }),
        answer('d', { activity: dataset('ei', 'w') })
      ])
    ).toEqual([])
  })
})

/**
 * Two turns of one chat through the real loop and the real tools. A restart lies between them: the
 * in-memory transcript is forgotten, and the next turn reads only what the store kept.
 */
describe('a dataset read in one turn is still opened in the next', () => {
  const stored: StoredTranscript[] = []
  const store = {
    load: async (): Promise<StoredTranscript | null> => stored.at(-1) ?? null,
    save: async (_id: string, t: StoredTranscript): Promise<void> => void stored.push(t)
  }
  /** The model `M` on top of the background `ei`, which holds the two datasets the model reads. */
  const apiRaw = async (
    method: string,
    path: string,
    body?: any
  ): Promise<{ status: number; body: unknown }> => {
    const read = /^\/api\/v1\/model\/activities\/M\/([^/?]+)\?/.exec(path)
    if (method === 'GET' && read)
      // Neither is in M: the app finds it in the one background and says so.
      return {
        status: 200,
        body: { found_in: 'ei', activity: dataset('ei', read[1]), exchanges: [] }
      }
    if (method === 'GET' && path === '/api/v1/databases')
      return {
        status: 200,
        body: [
          { name: 'M', kind: 'foreground' },
          { name: 'ei', kind: 'background' }
        ]
      }
    if (method === 'GET' && path === '/api/v1/model/activities/M')
      return { status: 200, body: [{ code: 'fu', name: 'functional unit' }] }
    if (method === 'GET' && path.startsWith('/api/v1/model/activities/M?'))
      return { status: 200, body: [{ code: 'fu', name: 'functional unit' }] }
    if (method === 'POST' && path === '/api/v1/model/exchanges')
      return {
        status: 200,
        body: {
          exchange: {
            uid: `u-${body.input_code}`,
            type: 'technosphere',
            input: { database: body.input_database, code: body.input_code, name: body.input_code }
          }
        }
      }
    return { status: 200, body: {} }
  }
  const deps = {
    apiRaw,
    callUiTool: async (name: string) => (name === 'approve_tool' ? { approved: true } : {}),
    emit: () => undefined,
    getSkills: async () => [],
    transcriptStore: store
  } as unknown as Parameters<typeof runAgent>[1]
  const turn = (userText: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) =>
    runAgent(
      {
        chatId: 'c1',
        model: 'z-ai/glm-5.3',
        activeDb: 'M',
        backgroundDbs: ['ei'],
        history,
        userText,
        signal: new AbortController().signal
      },
      deps
    )
  const link = (code: string): string =>
    JSON.stringify({
      activity_code: 'fu',
      action: 'add',
      exchanges: [{ input_database: 'ei', input_code: code, amount: 1 }]
    })
  /** What edit_exchange answered in the last turn. */
  const linkAnswer = (): any => {
    const msgs = chat.seen.at(-1)!.messages
    const id = msgs.flatMap((m) => m.tool_calls ?? []).find((tc) => tc.function.name === 'edit_exchange')!.id
    return JSON.parse(String(msgs.find((m) => m.role === 'tool' && m.tool_call_id === id)!.content))
  }

  beforeEach(() => {
    stored.length = 0
    chat.rounds = []
    chat.seen.length = 0
    forgetTranscript()
  })

  it('read by code without a database, or by name: no reminder after the restart', async () => {
    chat.rounds = [
      {
        calls: [
          { id: 'r1', name: 'get_process_details', arguments: JSON.stringify({ code: 'steel-row' }) },
          { id: 'r2', name: 'get_process_details', arguments: JSON.stringify({ name: 'functional unit' }) }
        ]
      },
      { text: 'Read both.' }
    ]
    await turn('read them', [])
    expect(stored.at(-1)!.inspected).toEqual(
      expect.arrayContaining([
        { database: 'ei', code: 'steel-row' },
        { database: 'ei', code: 'fu' }
      ])
    )

    forgetTranscript() // the restart: only the store remembers
    chat.rounds = [
      { calls: [{ id: 'l1', name: 'edit_exchange', arguments: link('steel-row') }] },
      { text: 'Linked.' }
    ]
    await turn('link the steel', [
      { role: 'user', content: 'read them' },
      { role: 'assistant', content: 'Read both.' }
    ])
    const answer = linkAnswer()
    expect(answer.uid).toBe('u-steel-row') // linked
    expect(answer.not_yet_opened).toBeUndefined()
  })

  it('still counts after the reading round has left the transcript', async () => {
    chat.rounds = [
      {
        calls: [{ id: 'r1', name: 'get_process_details', arguments: JSON.stringify({ code: 'steel-row' }) }]
      },
      { text: 'Read it.' }
    ]
    await turn('read it', [])
    // What compaction or the size bound leaves of it: the prose, none of the calls.
    const kept = stored.at(-1)!
    stored.push({ ...kept, messages: kept.messages.filter((m) => m.role !== 'tool' && !m.tool_calls) })

    forgetTranscript()
    chat.rounds = [
      { calls: [{ id: 'l1', name: 'edit_exchange', arguments: link('steel-row') }] },
      { text: 'Linked.' }
    ]
    await turn('link it', [
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: 'Read it.' }
    ])
    const answer = linkAnswer()
    expect(answer.uid).toBe('u-steel-row')
    expect(answer.not_yet_opened).toBeUndefined()
  })

  it('counts a read from the answers of a transcript kept before the record was stored', async () => {
    chat.rounds = [
      {
        calls: [
          { id: 'r1', name: 'get_process_details', arguments: JSON.stringify({ code: 'steel-row' }) },
          {
            id: 'r2',
            name: 'get_process_details',
            arguments: JSON.stringify({ name: 'functional unit', summary: true })
          }
        ]
      },
      { text: 'Read both.' }
    ]
    await turn('read them', [])
    const { inspected: _dropped, ...old } = stored.at(-1)!
    stored.push(old)

    forgetTranscript()
    chat.rounds = [
      { calls: [{ id: 'l1', name: 'edit_exchange', arguments: link('steel-row') }] },
      { text: 'Linked.' }
    ]
    await turn('link the steel', [
      { role: 'user', content: 'read them' },
      { role: 'assistant', content: 'Read both.' }
    ])
    const answer = linkAnswer()
    expect(answer.uid).toBe('u-steel-row')
    expect(answer.not_yet_opened).toBeUndefined()
    // …and from now on the record is stored, filed where the reads found the datasets.
    expect(stored.at(-1)!.inspected).toEqual([
      { database: 'ei', code: 'steel-row' },
      { database: 'ei', code: 'fu' }
    ])
  })

  it('still reminds about a dataset nobody read', async () => {
    chat.rounds = [
      {
        calls: [{ id: 'r1', name: 'get_process_details', arguments: JSON.stringify({ code: 'steel-row' }) }]
      },
      { text: 'Read it.' }
    ]
    await turn('read it', [])

    forgetTranscript()
    chat.rounds = [
      { calls: [{ id: 'l1', name: 'edit_exchange', arguments: link('pp-granulate') }] },
      { text: 'Linked.' }
    ]
    await turn('link the plastic', [
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: 'Read it.' }
    ])
    expect(linkAnswer().not_yet_opened.map((l: any) => l.code)).toEqual(['pp-granulate'])
  })
})
