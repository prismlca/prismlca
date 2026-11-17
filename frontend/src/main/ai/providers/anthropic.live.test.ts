/**
 * LIVE checks of the Anthropic transport against the real Messages API — what the fixtures in
 * anthropic.test.ts cannot show: that Anthropic accepts our real tool schemas, that a tool round sent
 * back with its signed reasoning validates without a block dropped, that the breakpoints turn the second
 * round's prefix into a cache read, that a question after a run reads the run from the cache, and that a
 * search leg returns pages. **Opt-in and paid**: skipped unless PRISM_ANTHROPIC_LIVE=1 and
 * ANTHROPIC_API_KEY is set. About eight requests and two searches on Claude Haiku 5.5, a few cents all
 * told:
 *
 *     PRISM_ANTHROPIC_LIVE=1 ANTHROPIC_API_KEY=… npx vitest run src/main/ai/providers/anthropic.live.test.ts
 *
 * PRISM_ANTHROPIC_LIVE_MODEL picks another model (claude-sonnet-5-5 costs twenty times as much).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/prism-anthropic-live', getAppPath: () => '/tmp/prism-anthropic-live' }
}))

const KEY = process.env.ANTHROPIC_API_KEY?.trim() ?? ''
const LIVE = process.env.PRISM_ANTHROPIC_LIVE === '1' && !!KEY
const MODEL = process.env.PRISM_ANTHROPIC_LIVE_MODEL || 'claude-haiku-5-5'

const { runChatStream } = await import('./engine')
const { anthropicTransport } = await import('./anthropic')
const { assistantToolTurn } = await import('./types')
const { toolSpecs } = await import('../tools/focus')
const { withCacheBreakpoint, markCacheBreakpoints } = await import('../agent')
import type { ChatMessage, StreamChatOpts, StreamEvent } from './types'

/** A tool result with some bulk, so the run outweighs the system prompt and the tools it starts with. */
const rows = (tool: string): string =>
  JSON.stringify({
    tool,
    rows: Array.from({ length: 60 }, (_, i) => ({ id: `${tool}-${i}`, name: `Activity ${i}`, unit: 'kg' }))
  })

async function collect(opts: Partial<StreamChatOpts> & { messages: ChatMessage[] }): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const ev of runChatStream(anthropicTransport, { model: MODEL, temperature: null, ...opts }, KEY))
    events.push(ev)
  return events
}

const textOf = (events: StreamEvent[]): string =>
  events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('')
const usageOf = (events: StreamEvent[]) => {
  const u = events.find((e) => e.type === 'usage')
  return u?.type === 'usage' ? u.usage : {}
}

describe.skipIf(!LIVE)('Anthropic transport, live', () => {
  it(
    'takes every tool schema, the next round validates with its reasoning, and reads the prefix from the cache',
    { timeout: 240_000 },
    async () => {
      const warn = vi.spyOn(console, 'warn')
      const tools = toolSpecs(true)
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: withCacheBreakpoint(
            'You are the assistant of an LCA desktop app. Use the tools you are given.'
          )
        },
        {
          role: 'user',
          content: 'Call the tool list_models exactly once, then tell me in one sentence what it returned.'
        }
      ]
      const first = await collect({ messages, tools, reasoningEffort: 'medium', maxTokens: 8_000 })
      const round = first.find((e) => e.type === 'tool_calls')
      expect(round, `no tool call; text was: ${textOf(first)}`).toBeDefined()
      if (round?.type !== 'tool_calls') return
      expect(round.calls.map((c) => c.name)).toContain('list_models')

      messages.push(assistantToolTurn(textOf(first) || null, round.calls, round.replay))
      for (const c of round.calls)
        messages.push({
          role: 'tool',
          tool_call_id: c.id,
          content: '{"models": ["Bottle (PET)", "Pavilion"]}'
        })
      const second = await collect({ messages, tools, reasoningEffort: 'medium', maxTokens: 8_000 })
      expect(textOf(second)).toMatch(/Bottle|Pavilion/)
      // Nothing the API had to drop: the round went back as it came.
      expect(warn.mock.calls.some((c) => String(c[0]).includes('thinking block(s) dropped'))).toBe(false)
      // The tools and the system prompt, written in round one, are read in round two.
      expect(usageOf(second).prompt_tokens_details?.cached_tokens ?? 0).toBeGreaterThan(1_000)
      expect(usageOf(second).cost).toBeGreaterThan(0)
    }
  )

  it(
    'a question after a run reads the whole run from the cache, its search included',
    { timeout: 300_000 },
    async () => {
      // The agent's request shape: its breakpoints (system, task, last answer) plus the automatic one.
      const warn = vi.spyOn(console, 'warn')
      const opts = {
        tools: toolSpecs(true),
        reasoningEffort: 'medium' as const,
        maxTokens: 8_000,
        cacheTail: true,
        webSearch: true,
        webLookupsCap: 1
      }
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content: 'You are the assistant of an LCA desktop app. Use the tools you are given.'
        },
        {
          role: 'user',
          content:
            'Search the web once for the density of PET. Then call list_models, and after its result ' +
            'get_current_model — one tool per round. Then answer in one sentence.'
        }
      ]
      let lastRun: StreamEvent[] = []
      for (let round = 0; round < 6; round++) {
        markCacheBreakpoints(messages)
        lastRun = await collect({ messages, ...opts })
        const calls = lastRun.find((e) => e.type === 'tool_calls')
        if (calls?.type !== 'tool_calls' || !calls.calls.length) break
        messages.push(assistantToolTurn(textOf(lastRun) || null, calls.calls, calls.replay))
        for (const c of calls.calls)
          messages.push({ role: 'tool', tool_call_id: c.id, content: rows(c.name) })
      }
      expect(messages.filter((m) => m.replay).length, 'the run made no tool round').toBeGreaterThan(0)
      messages.push({ role: 'assistant', content: textOf(lastRun) })
      messages.push({ role: 'user', content: 'Which tools did you call, and did you search the web?' })
      markCacheBreakpoints(messages)
      const followUp = await collect({ messages, ...opts })
      // The last request of the run wrote its whole prompt to the cache; the question reads it back
      // and pays only for the answer and itself.
      const runPrompt = usageOf(lastRun).prompt_tokens ?? 0
      const cached = usageOf(followUp).prompt_tokens_details?.cached_tokens ?? 0
      expect(
        cached,
        `run prompt ${runPrompt}, follow-up ${JSON.stringify(usageOf(followUp))}`
      ).toBeGreaterThan(runPrompt * 0.9)
      expect(warn.mock.calls.some((c) => String(c[0]).includes('thinking block(s) dropped'))).toBe(false)
    }
  )

  it('a search-only leg returns pages and books the search', { timeout: 180_000 }, async () => {
    const events = await collect({
      webSearch: true,
      webLookupsCap: 2,
      reasoningEffort: 'low',
      maxTokens: 4_000,
      messages: [
        {
          role: 'user',
          content: 'Search the web: what is the density of PET in g/cm³? Answer in one sentence.'
        }
      ]
    })
    const cites = events.flatMap((e) => (e.type === 'citations' ? e.citations : []))
    expect(cites.length).toBeGreaterThan(0)
    expect(cites.every((c) => /^https?:\/\//.test(c.url))).toBe(true)
    expect(usageOf(events).server_tool_use?.web_search_requests).toBeGreaterThan(0)
  })
})
