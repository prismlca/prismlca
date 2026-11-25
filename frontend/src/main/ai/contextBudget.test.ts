import { describe, expect, it } from 'vitest'
import { estimateChars, projectTokens, sizeOfRound } from './contextBudget'
import { searchNote } from './providers/searchNote'
import type { ChatMessage } from './providers/types'

describe('estimateChars and projectTokens — what a request carries', () => {
  const web = {
    counts: { web_search_requests: 1 },
    searches: [{ query: 'roll weight', results: [{ url: 'https://a.de' }] }]
  }
  const asked: ChatMessage = { role: 'user', content: 'How heavy is a roll?' }
  const answer: ChatMessage = { role: 'assistant', content: 'About 300 g.' }

  it("counts the record of a reply's web lookups, which goes ahead of its text", () => {
    const plain = estimateChars([asked, answer])
    expect(estimateChars([asked, { ...answer, web }])).toBe(plain + searchNote(web)!.length)
  })

  it('does not count it beside a replay, which is sent instead of it', () => {
    const replay = { provider: 'anthropic' as const, steps: [{ type: 'text', text: 'About 300 g.' }] }
    const withReplay = estimateChars([asked, { ...answer, replay }])
    expect(estimateChars([asked, { ...answer, replay, web }])).toBe(withReplay)
  })

  it('counts the tool definitions before the first count, and through it after', () => {
    const chars = estimateChars([asked, answer])
    expect(projectTokens([asked, answer], null, 40_000)).toBe(Math.round((chars + 40_000) / 4))
    // A count taken on the same messages and definitions is the figure itself.
    expect(projectTokens([asked, answer], { promptTokens: 12_345, chars: chars + 40_000 }, 40_000)).toBe(
      12_345
    )
  })
})

describe('sizeOfRound — what a usage report says about the size of the conversation', () => {
  const before = { promptTokens: 40_000, chars: 100_000 }

  it('takes the count of a round without lookups as the new measurement', () => {
    expect(sizeOfRound({ prompt_tokens: 42_000 }, 108_000, before)).toEqual({
      measured: { promptTokens: 42_000, chars: 108_000 },
      tokens: 42_000
    })
  })

  it('takes the first pass where the provider names it, not the sum', () => {
    const usage = {
      prompt_tokens: 160_000,
      context_tokens: 41_000,
      server_tool_use: { web_search_requests: 3 }
    }
    expect(sizeOfRound(usage, 104_000, before)).toEqual({
      measured: { promptTokens: 41_000, chars: 104_000 },
      tokens: 41_000
    })
  })

  it('keeps the last count and estimates a round whose figure has no first pass beside it', () => {
    // OpenAI and OpenRouter: the lookups' results and passes billed as one figure. The 8,000 characters
    // added since the last count are 2,000 tokens on top of it.
    const usage = {
      prompt_tokens: 170_000,
      server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 }
    }
    expect(sizeOfRound(usage, 108_000, before)).toEqual({ measured: before, tokens: 42_000 })
  })

  it('estimates from the characters alone when nothing was counted yet, and never above the sum', () => {
    const usage = { prompt_tokens: 30_000, server_tool_use: { web_search_requests: 1 } }
    expect(sizeOfRound(usage, 80_000, null)).toEqual({ measured: null, tokens: 20_000 })
    expect(sizeOfRound({ ...usage, prompt_tokens: 15_000 }, 80_000, null)?.tokens).toBe(15_000)
  })

  it('reads a zero counter as no lookup, and a report without a prompt as no reading', () => {
    expect(
      sizeOfRound({ prompt_tokens: 42_000, server_tool_use: { web_search_requests: 0 } }, 108_000, before)
    ).toEqual({ measured: { promptTokens: 42_000, chars: 108_000 }, tokens: 42_000 })
    expect(sizeOfRound({ server_tool_use: { web_search_requests: 2 } }, 108_000, before)).toBeNull()
    expect(sizeOfRound({ prompt_tokens: 0 }, 108_000, before)).toBeNull()
  })
})
