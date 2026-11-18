/**
 * LIVE check of the OpenAI transport's web search against the real Responses API — what the fixtures in
 * openai.test.ts cannot show: that the API takes `include: ['web_search_call.action.sources']` beside the
 * web_search tool, and that each search then names what it looked for and the pages it returned.
 * **Opt-in and paid**: skipped unless PRISM_OPENAI_LIVE=1 and OPENAI_API_KEY is set. One request with one or
 * two searches on GPT-6 Luna, a few cents:
 *
 *     PRISM_OPENAI_LIVE=1 OPENAI_API_KEY=… npx vitest run src/main/ai/providers/openai.live.test.ts
 *
 * PRISM_OPENAI_LIVE_MODEL picks another model.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/prism-openai-live', getAppPath: () => '/tmp/prism-openai-live' }
}))

const KEY = process.env.OPENAI_API_KEY?.trim() ?? ''
const LIVE = process.env.PRISM_OPENAI_LIVE === '1' && !!KEY
const MODEL = process.env.PRISM_OPENAI_LIVE_MODEL || 'gpt-6-luna'

const { runChatStream } = await import('./engine')
const { openaiTransport } = await import('./openai')
import type { StreamEvent } from './types'

describe.skipIf(!LIVE)('OpenAI transport, live', () => {
  it(
    'names each web search with what it looked for and the pages it returned',
    { timeout: 180_000 },
    async () => {
      const events: StreamEvent[] = []
      for await (const ev of runChatStream(
        openaiTransport,
        {
          model: MODEL,
          temperature: null,
          webSearch: true,
          messages: [
            {
              role: 'user',
              content:
                'In which town does the Belgian shelving maker Avasco Industries have its production sites? ' +
                'Search the web and answer in one sentence with the source.'
            }
          ]
        },
        KEY
      ))
        events.push(ev)
      const found = events.find((e) => e.type === 'web_searches')
      const usage = events.find((e) => e.type === 'usage')
      console.log(
        JSON.stringify(
          {
            searches: found?.type === 'web_searches' ? found.searches : null,
            cost: usage?.type === 'usage' ? usage.usage.cost : null
          },
          null,
          1
        )
      )
      expect(found?.type).toBe('web_searches')
      if (found?.type !== 'web_searches') return
      const searched = found.searches.filter((s) => s.query)
      expect(searched.length).toBeGreaterThan(0)
      // The pages were asked for, so they are reported: a list, and pages in it.
      expect(searched.every((s) => Array.isArray(s.results))).toBe(true)
      expect(searched.some((s) => (s.results?.length ?? 0) > 0)).toBe(true)
      expect(searched.flatMap((s) => s.results ?? []).every((r) => /^https?:\/\//.test(r.url))).toBe(true)
    }
  )
})
