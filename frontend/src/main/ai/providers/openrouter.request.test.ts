import { describe, expect, it } from 'vitest'

import { openrouterTransport } from './openrouter'
import type { StreamChatOpts } from './types'

/**
 * What the OpenRouter request carries for web access.
 *
 * The two server tools are not a cheap side call: OpenRouter runs the model again over the whole
 * conversation after every lookup and reports the passes as ONE usage figure. In one
 * live run that read as 375k prompt tokens (0.24 $) for an 85k conversation — three passes,
 * invisible in the app (V398). `parameters.max_uses` on each tool is the bound; 0/undefined sends none.
 * It has to be nested: a top-level `max_uses` is accepted and ignored (measured: three
 * searches billed despite a cap of 1).
 */
const base: StreamChatOpts = {
  model: 'anthropic/claude-sonnet-5.5',
  messages: [{ role: 'user', content: 'hi' }],
  temperature: null,
  maxTokens: 20_000
}

function toolsOf(opts: StreamChatOpts): Array<Record<string, unknown>> {
  const body = JSON.parse(openrouterTransport.buildRequest(opts, 'k').body) as {
    tools?: Array<Record<string, unknown>>
  }
  return body.tools ?? []
}

describe('openrouter buildRequest — web lookups', () => {
  it('sends no server tools when web access is off', () => {
    expect(toolsOf({ ...base, webSearch: false })).toEqual([])
    expect(toolsOf(base)).toEqual([])
  })

  it('attaches both server tools without a cap when none is set', () => {
    expect(toolsOf({ ...base, webSearch: true })).toEqual([
      { type: 'openrouter:web_search' },
      { type: 'openrouter:web_fetch' }
    ])
  })

  it('puts the cap on each server tool as parameters.max_uses', () => {
    expect(toolsOf({ ...base, webSearch: true, webLookupsCap: 5 })).toEqual([
      { type: 'openrouter:web_search', parameters: { max_uses: 5 } },
      { type: 'openrouter:web_fetch', parameters: { max_uses: 5 } }
    ])
  })

  it('never puts max_uses on tool level (silently ignored by the API)', () => {
    for (const t of toolsOf({ ...base, webSearch: true, webLookupsCap: 5 }))
      expect(t).not.toHaveProperty('max_uses')
  })

  it('treats 0 as "no cap of ours"', () => {
    expect(toolsOf({ ...base, webSearch: true, webLookupsCap: 0 })).toEqual([
      { type: 'openrouter:web_search' },
      { type: 'openrouter:web_fetch' }
    ])
  })

  it('puts a domain allow list under parameters, beside the cap, on both tools', () => {
    expect(
      toolsOf({ ...base, webSearch: true, webLookupsCap: 2, webDomains: ['destatis.de', 'ral.de'] })
    ).toEqual([
      {
        type: 'openrouter:web_search',
        parameters: { max_uses: 2, allowed_domains: ['destatis.de', 'ral.de'] }
      },
      {
        type: 'openrouter:web_fetch',
        parameters: { max_uses: 2, allowed_domains: ['destatis.de', 'ral.de'] }
      }
    ])
    // An empty list is "no restriction", not an allow list that permits nothing.
    expect(toolsOf({ ...base, webSearch: true, webDomains: [] })).toEqual([
      { type: 'openrouter:web_search' },
      { type: 'openrouter:web_fetch' }
    ])
  })

  it('keeps the function tools in front of the server tools', () => {
    const fn = {
      type: 'function' as const,
      function: { name: 'list_models', description: 'x', parameters: {} }
    }
    const tools = toolsOf({ ...base, webSearch: true, webLookupsCap: 2, tools: [fn] })
    expect(tools[0]).toEqual(fn)
    expect(tools.slice(1).map((t) => t.type)).toEqual(['openrouter:web_search', 'openrouter:web_fetch'])
  })
})

describe('openrouter interpret — citations', () => {
  const chunk = (delta: Record<string, unknown>): unknown => ({
    id: 'gen-1',
    provider: 'Exa',
    choices: [{ delta, finish_reason: null }]
  })

  it('turns url_citation annotations on the delta into a citations event with the excerpt', () => {
    const state = openrouterTransport.createState({} as StreamChatOpts)
    const events = openrouterTransport.interpret(
      chunk({
        content: '',
        annotations: [
          {
            type: 'url_citation',
            url_citation: {
              url: 'https://a.de/p',
              title: 'A',
              content: 'mass 2 kg',
              start_index: 0,
              end_index: 3
            }
          },
          { type: 'url_citation', url_citation: { url: 'https://b.de/q' } },
          { type: 'file_citation', file_citation: { id: 'x' } }
        ]
      }),
      state
    )
    expect(events.find((e) => e.type === 'citations')).toEqual({
      type: 'citations',
      citations: [{ url: 'https://a.de/p', title: 'A', excerpt: 'mass 2 kg' }, { url: 'https://b.de/q' }]
    })
  })

  it('reads the flat annotation shape too, and sends nothing without annotations', () => {
    const state = openrouterTransport.createState({} as StreamChatOpts)
    const flat = openrouterTransport.interpret(
      chunk({ annotations: [{ type: 'url_citation', url: 'https://c.de', content: 'x' }] }),
      state
    )
    expect(flat.find((e) => e.type === 'citations')).toEqual({
      type: 'citations',
      citations: [{ url: 'https://c.de', excerpt: 'x' }]
    })
    expect(
      openrouterTransport.interpret(chunk({ content: 'hi' }), state).some((e) => e.type === 'citations')
    ).toBe(false)
  })
})
