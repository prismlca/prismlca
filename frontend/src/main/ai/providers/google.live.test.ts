/**
 * LIVE checks of the Google transport against the real Gemini API — what the fixtures in
 * google.test.ts cannot show: that Google accepts our real tool schemas, that a tool round carried
 * back with its replay validates, that search citations resolve to real pages, and that voice input
 * transcribes. **Opt-in**: skipped unless PRISM_GOOGLE_LIVE=1 and GEMINI_API_KEY is set. Sized for a
 * free-tier key, where it costs nothing (five requests at most):
 *
 *     PRISM_GOOGLE_LIVE=1 GEMINI_API_KEY=… npx vitest run src/main/ai/providers/google.live.test.ts
 *
 * PRISM_GOOGLE_LIVE_MODEL picks the chat model (default gemini-3.8-flash; the free tier sometimes
 * answers "high demand" for it, gemini-3.6-flash speaks the same API). The search check runs on
 * PRISM_GOOGLE_LIVE_SEARCH_MODEL, default gemini-2.5-flash, because a free-tier key grounds on 2.5
 * only; on a paid key set it to gemini-3.8-flash. PRISM_GOOGLE_LIVE_AUDIO names a short recording
 * (webm/wav/mp3/ogg) for the voice check, which is skipped without one.
 */
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/prism-google-live', getAppPath: () => '/tmp/prism-google-live' }
}))

const KEY = process.env.GEMINI_API_KEY?.trim() ?? ''
const LIVE = process.env.PRISM_GOOGLE_LIVE === '1' && !!KEY
const MODEL = process.env.PRISM_GOOGLE_LIVE_MODEL || 'gemini-3.8-flash'
const SEARCH_MODEL = process.env.PRISM_GOOGLE_LIVE_SEARCH_MODEL || 'gemini-2.5-flash'
const AUDIO = process.env.PRISM_GOOGLE_LIVE_AUDIO || ''

const { runChatStream } = await import('./engine')
const { googleTransport, transcribeGoogle } = await import('./google')
const { assistantToolTurn } = await import('./types')
const { toolSpecs } = await import('../tools/focus')
import type { ChatMessage, StreamChatOpts, StreamEvent } from './types'

async function collect(opts: Partial<StreamChatOpts> & { messages: ChatMessage[] }): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const ev of runChatStream(googleTransport, { model: MODEL, temperature: null, ...opts }, KEY))
    events.push(ev)
  return events
}

const textOf = (events: StreamEvent[]): string =>
  events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('')

describe.skipIf(!LIVE)('Google transport, live', () => {
  it(
    'takes every tool schema, and the next round validates with the replay',
    { timeout: 240_000 },
    async () => {
      const tools = toolSpecs(true)
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are the assistant of an LCA desktop app. Use the tools you are given.'
        },
        {
          role: 'user',
          content: 'Call the tool list_models exactly once, then tell me in one sentence what it returned.'
        }
      ]
      const first = await collect({ messages, tools, reasoningEffort: 'low', maxTokens: 4_000 })
      const round = first.find((e) => e.type === 'tool_calls')
      expect(round, `no tool call; text was: ${textOf(first)}`).toBeDefined()
      if (round?.type !== 'tool_calls') return
      expect(round.calls.map((c) => c.name)).toContain('list_models')
      // The step that makes the next round valid: a signed thought.
      expect(round.replay?.steps.some((s) => (s as { type?: string }).type === 'thought')).toBe(true)

      messages.push(assistantToolTurn(textOf(first) || null, round.calls, round.replay))
      for (const c of round.calls)
        messages.push({
          role: 'tool',
          tool_call_id: c.id,
          content: '{"models": ["Bottle (PET)", "Pavilion"]}'
        })
      const second = await collect({ messages, tools, reasoningEffort: 'low', maxTokens: 4_000 })
      expect(textOf(second)).toMatch(/Bottle|Pavilion/)
      const usage = second.find((e) => e.type === 'usage')
      expect(usage?.type === 'usage' && (usage.usage.prompt_tokens ?? 0) > 1_000).toBe(true)
    }
  )

  it('a search-only leg cites real pages, not Google’s redirect links', { timeout: 180_000 }, async () => {
    const events = await collect({
      model: SEARCH_MODEL,
      webSearch: true,
      reasoningEffort: 'low',
      maxTokens: 2_000,
      messages: [{ role: 'user', content: 'What is the density of PET in g/cm³? Answer in one sentence.' }]
    })
    const cites = events.flatMap((e) => (e.type === 'citations' ? e.citations : []))
    expect(cites.length).toBeGreaterThan(0)
    const resolved = cites.filter((c) => !c.url.includes('vertexaisearch.cloud.google.com'))
    expect(resolved.length, JSON.stringify(cites)).toBeGreaterThan(0)
    const usage = events.find((e) => e.type === 'usage')
    expect(usage?.type === 'usage' && usage.usage.server_tool_use?.web_search_requests).toBeGreaterThan(0)
  })

  it.skipIf(!AUDIO)('transcribes a recording with the speech model', { timeout: 120_000 }, async () => {
    const out = await transcribeGoogle(
      { data: readFileSync(AUDIO).toString('base64'), format: extname(AUDIO).slice(1), language: 'de' },
      KEY
    )
    expect(out.text.length).toBeGreaterThan(10)
    expect(out.model).toBe('gemini-3.5-transcribe')
    expect(out.cost).toBeGreaterThan(0)
  })
})
