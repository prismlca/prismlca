/**
 * A tool call a host cut off, through the shipped client, OpenRouter transport and agent loop — only
 * `fetch` is faked. The run goes on, the model hears what arrived, and the request that next leaves the
 * app carries `{}` for that call, where it used to carry the broken string and be refused whole.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/prism-toolargs-test', getAppPath: () => '/tmp/prism-toolargs-test' }
}))

process.env.OPENROUTER_API_KEY = 'test-openrouter-key'

const { runAgent, forgetTranscript } = await import('./agent')
const { setActiveProvider } = await import('./providers/state')

/** Verbatim from a recorded stream: the value of the list never came, then `finish_reason`. */
const CUT = '{"filtered_queries": '

/** One SSE reply made of Chat Completions chunks, served by `host`. */
function sse(host: string, deltas: Array<Record<string, unknown>>, finish: string): Response {
  const chunks = [
    ...deltas.map((delta) => ({ id: 'gen-1', provider: host, choices: [{ delta }] })),
    {
      id: 'gen-1',
      provider: host,
      choices: [{ delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0001 }
    }
  ]
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text))
        c.close()
      }
    })
  } as unknown as Response
}

const call = (index: number, extra: Record<string, unknown>) => ({ tool_calls: [{ index, ...extra }] })

beforeEach(() => {
  setActiveProvider('openrouter')
  forgetTranscript()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a tool call a host cut off, end to end', () => {
  it('does not end the run, and the next request leaves with {} in its place', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const replies = [
      sse(
        'Fireworks',
        [
          call(0, { id: 'c1', type: 'function', function: { name: 'list_models', arguments: '' } }),
          call(0, { function: { arguments: '{}' } }),
          call(1, { id: 'c2', type: 'function', function: { name: 'search_background', arguments: '' } }),
          call(1, { function: { arguments: CUT } })
        ],
        'tool_calls'
      ),
      sse('Fireworks', [{ content: 'Searched again.' }], 'stop')
    ]
    const sent: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/chat/completions')) {
          sent.push(String(init?.body))
          const reply = replies.shift()
          if (!reply) throw new Error('more requests than scripted')
          return reply
        }
        // Listings and lookups the app makes on the side: answered empty, never what this is about.
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ data: [] }),
          text: async () => '{"data":[]}'
        } as unknown as Response
      })
    )

    const res = await runAgent(
      {
        chatId: 'c-toolargs',
        model: 'z-ai/glm-5.3',
        activeDb: 'demo-model',
        history: [],
        userText: 'Find the surfactants.',
        signal: new AbortController().signal
      },
      {
        apiRaw: async () => ({ status: 200, body: [] }),
        callUiTool: async () => ({ approved: true }),
        emit: () => undefined,
        getSkills: async () => []
      } as unknown as Parameters<typeof runAgent>[1]
    )

    expect(res.outcome).not.toBe('error')
    expect(sent).toHaveLength(2)
    const next = JSON.parse(sent[1]) as {
      messages: Array<{
        role: string
        content?: unknown
        tool_call_id?: string
        tool_calls?: Array<{ id: string; function: { arguments: string } }>
      }>
    }
    const round = next.messages.find((m) => m.tool_calls?.length)
    expect(round?.tool_calls?.map((c) => [c.id, c.function.arguments])).toEqual([
      ['c1', '{}'],
      ['c2', '{}']
    ])
    // The raw body never carries the broken string, the refusal tells the model what arrived.
    expect(sent[1]).not.toContain('"arguments":"{\\"filtered_queries\\": "')
    const refusal = next.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'c2')
    expect(JSON.parse(String(refusal?.content)).error).toMatch(
      /not valid JSON .* What arrived: `\{"filtered_queries": `\./
    )
    expect(
      log.mock.calls.map((c) => String(c[0])).some((l) => /Fireworks .* search_background/.test(l))
    ).toBe(true)
  })
})
