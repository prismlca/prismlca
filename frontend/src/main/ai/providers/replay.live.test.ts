/**
 * LIVE check that a tool round carried back WITH its reasoning (ProviderReplay) is accepted through
 * OpenRouter — the one thing the fixtures cannot show. Only the formats in REPLAYED_FORMATS (openrouter.ts)
 * travel back, so the default model is a Gemini one. **Opt-in and PAID** (a few hundred tokens, well under a
 * cent): skipped unless PRISM_REPLAY_LIVE=1 and OPENROUTER_API_KEY is set.
 *
 *     PRISM_REPLAY_LIVE=1 OPENROUTER_API_KEY=… npx vitest run src/main/ai/providers/replay.live.test.ts
 *
 * PRISM_REPLAY_MODELS overrides the models (comma-separated).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/prism-replay-live', getAppPath: () => '/tmp/prism-replay-live' }
}))

const LIVE = process.env.PRISM_REPLAY_LIVE === '1'
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY?.trim() ?? ''
const OR_MODELS = (process.env.PRISM_REPLAY_MODELS || 'google/gemini-3.8-flash')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const { runChatStream } = await import('./engine')
const { openrouterTransport } = await import('./openrouter')
const { assistantToolTurn } = await import('./types')
import type { ChatMessage, ChatTransport, StreamEvent, ToolSpec } from './types'

const TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'get_density',
      description: 'Density of a material in kg/m3',
      parameters: { type: 'object', properties: { material: { type: 'string' } }, required: ['material'] }
    }
  }
]

/** Two rounds: a call, then its result sent back with the round's replay. Returns what round two said. */
async function twoRounds(
  transport: ChatTransport<unknown>,
  model: string,
  key: string
): Promise<{ replaySteps: number; answer: string }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Use the tool before you answer. Be terse.' },
    { role: 'user', content: 'What is the density of PET? Use the tool once, then answer in one sentence.' }
  ]
  const run = async (): Promise<StreamEvent[]> => {
    const out: StreamEvent[] = []
    for await (const ev of runChatStream(
      transport,
      { model, messages, tools: TOOLS, temperature: null, reasoningEffort: 'low', maxTokens: 4_000 },
      key
    ))
      out.push(ev)
    return out
  }
  const first = await run()
  const round = first.find((e) => e.type === 'tool_calls')
  if (round?.type !== 'tool_calls') throw new Error(`${model}: no tool call in round one`)
  messages.push(assistantToolTurn(null, round.calls, round.replay))
  for (const c of round.calls)
    messages.push({ role: 'tool', tool_call_id: c.id, content: '{"density": 1380}' })
  const second = await run()
  return {
    replaySteps: round.replay?.steps.length ?? 0,
    answer: second.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('')
  }
}

describe.skipIf(!LIVE)('reasoning replay, live', () => {
  it.skipIf(!OPENROUTER_KEY).each(OR_MODELS)(
    'OpenRouter %s takes its reasoning blocks back',
    { timeout: 180_000 },
    async (model) => {
      const r = await twoRounds(openrouterTransport as ChatTransport<unknown>, model, OPENROUTER_KEY)
      expect(r.answer).toMatch(/1380|1\.38/)
      console.log(`[replay-live] ${model}: ${r.replaySteps} reasoning block(s) carried back`)
    }
  )
})
