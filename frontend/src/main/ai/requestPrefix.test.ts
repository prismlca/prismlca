import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamChatOpts } from './providers/types'
import { chat } from './test/fakeStream'

/**
 * A provider that caches on its own (no breakpoints from us) reuses a round's prompt only where the next
 * request starts with the very same bytes. So within a turn the chat loop may only ever append: a request
 * that changed anything in front — the system prompt, the tools, a message already sent — would be billed in
 * full every round, and only a provider's usage figures would show it. Compaction is the one deliberate
 * exception, and only under context pressure.
 *
 * These runs drive the real loop with scripted replies and put every request through the real OpenRouter
 * transport, recording the body exactly as it would go on the wire. The models are the two whose runs miss
 * the cache once early on, in the round after the first large tool results: the body proves that round is
 * the round before it plus what the tools returned, so the miss comes from the provider's side.
 */
const wire = vi.hoisted(() => ({ bodies: [] as string[] }))

vi.mock('./client', async () => {
  const fake = await import('./test/fakeStream')
  const { openrouterTransport } = await import('./providers/openrouter')
  return {
    // Built when the loop sends, before it appends the round's reply: what the provider would receive.
    // Toolless calls (the history summariser) are separate requests with their own prompt.
    streamChat: (opts: StreamChatOpts) => {
      if (opts.tools?.length) wire.bodies.push(openrouterTransport.buildRequest(opts, 'test-key').body)
      return fake.chat.streamChat(opts)
    }
  }
})

const { runAgent, forgetTranscript } = await import('./agent')

/** A background search answer of realistic size — the kind of result after which the next round grew from
 *  about 26k to about 40k tokens in the measured runs. */
const SEARCH_ROWS = Array.from({ length: 150 }, (_, i) => ({
  id: `bg-${i}`,
  name: `market for polyester fibre, variant ${i}`,
  location: i % 2 ? 'RER' : 'GLO',
  unit: 'kg',
  reference_product: 'fibre, polyester',
  score: 0.5 + i / 1000
}))

function deps(): Parameters<typeof runAgent>[1] {
  return {
    apiRaw: async () => ({ status: 200, body: { ok: true, results: SEARCH_ROWS } }),
    callUiTool: async (name: string) => (name === 'approve_tool' ? { approved: true } : { answers: ['Yes'] }),
    emit: () => {},
    getSkills: async () => [],
    persistPlan: async () => {}
  } as unknown as Parameters<typeof runAgent>[1]
}

/** The opening of a modelling run as the logs show it: a plan, two searches side by side, a look at one
 *  hit while saying so, then the answer. */
function script(): void {
  chat.rounds = [
    {
      calls: [
        {
          id: 'p1',
          name: 'plan',
          arguments: JSON.stringify({
            title: 'T-shirt model',
            steps: [
              { step: 'Find the background datasets', status: 'in_progress' },
              { step: 'Build and calculate', status: 'pending' }
            ]
          })
        }
      ]
    },
    {
      calls: [
        { id: 's1', name: 'search_background', arguments: '{"query":"polyester fibre"}' },
        { id: 's2', name: 'search_background', arguments: '{"query":"cotton fibre"}' }
      ]
    },
    {
      text: 'Two candidates; I check the first.',
      calls: [{ id: 'd1', name: 'get_process_details', arguments: '{"uid":"bg-0"}' }]
    },
    { text: 'Done.' }
  ]
}

beforeEach(() => {
  chat.rounds = []
  chat.seen.length = 0
  wire.bodies.length = 0
  forgetTranscript()
})

describe('the request of a model without cache breakpoints only grows at its end', () => {
  it.each(['mistralai/mistral-large-4-0', 'tencent/hy4'])('%s', async (model) => {
    script()
    const res = await runAgent(
      {
        chatId: 'c1',
        model,
        activeDb: 'demo-model',
        history: [],
        userText: 'Model a cotton T-shirt, cradle to gate.',
        signal: new AbortController().signal
      },
      deps()
    )
    expect(res.outcome).toBe('answered')
    expect(wire.bodies).toHaveLength(4)
    // The scenario holds the jump the measured runs missed after: the search results at least double the
    // conversation (the tool definitions, the larger part of the body, stay as they are).
    const conversation = wire.bodies.map((b) =>
      JSON.stringify((JSON.parse(b) as { messages: unknown }).messages)
    )
    expect(conversation[2].length).toBeGreaterThan(conversation[1].length * 2)

    for (let i = 1; i < wire.bodies.length; i++) {
      const before = JSON.parse(wire.bodies[i - 1]) as { messages: unknown[] } & Record<string, unknown>
      const after = JSON.parse(wire.bodies[i]) as { messages: unknown[] } & Record<string, unknown>
      // On the wire: the earlier body, up to the end of its last message, is where the later one starts.
      const sent = JSON.stringify(before.messages)
      const end = wire.bodies[i - 1].indexOf(sent) + sent.length - 1
      expect(end).toBeGreaterThan(sent.length)
      expect(wire.bodies[i].startsWith(wire.bodies[i - 1].slice(0, end))).toBe(true)
      expect(after.messages.length).toBeGreaterThan(before.messages.length)
      // Everything beside the conversation — tools, routing, limits, the session key — stays as it was.
      const { messages: _b, ...restBefore } = before
      const { messages: _a, ...restAfter } = after
      expect(restAfter).toEqual(restBefore)
    }
  })
})
