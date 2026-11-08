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

describe('openrouter buildRequest — automatic caching', () => {
  const bodyOf = (opts: StreamChatOpts): Record<string, unknown> =>
    JSON.parse(openrouterTransport.buildRequest(opts, 'k').body) as Record<string, unknown>

  it('asks for the moving breakpoint at the top level when told to, and not otherwise', () => {
    expect(bodyOf({ ...base, cacheTail: true }).cache_control).toEqual({ type: 'ephemeral' })
    expect(bodyOf(base)).not.toHaveProperty('cache_control')
  })

  it('carries the conversation’s routing key as session_id, and nothing when there is none', () => {
    expect(bodyOf({ ...base, sessionId: 'k-1' }).session_id).toBe('k-1')
    expect(bodyOf(base)).not.toHaveProperty('session_id')
  })
})

describe('what the transcript carries for other providers', () => {
  it('never sends another provider’s replay data to OpenRouter', () => {
    const body = JSON.parse(
      openrouterTransport.buildRequest(
        {
          ...base,
          messages: [
            { role: 'user', content: 'Weather?' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
              replay: { provider: 'google', steps: [{ type: 'thought', signature: 'secret-ish' }] }
            },
            { role: 'tool', tool_call_id: 'c1', content: 'ok' }
          ]
        },
        'k'
      ).body
    ) as { messages: Array<Record<string, unknown>> }
    expect(body.messages[1].replay).toBeUndefined()
    expect(body.messages[1].tool_calls).toHaveLength(1)
  })
})

describe('reasoning blocks across a tool round', () => {
  const call = { id: 'c1', type: 'function' as const, function: { name: 'f', arguments: '{}' } }
  const steps = [{ type: 'reasoning.text', text: 'I should call f.', signature: 'sig', index: 0 }]
  const msgs = (model: string) =>
    JSON.parse(
      openrouterTransport.buildRequest(
        {
          ...base,
          model,
          messages: [
            { role: 'user', content: 'Go' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [call],
              replay: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', steps }
            },
            { role: 'tool', tool_call_id: 'c1', content: 'ok' }
          ]
        },
        'k'
      ).body
    ).messages as Array<Record<string, unknown>>

  it('go back unchanged on their assistant message, to the model that wrote them', () => {
    expect(msgs('anthropic/claude-sonnet-5.5')[1].reasoning_details).toEqual(steps)
  })

  it('stay out when the conversation moved to another model', () => {
    expect(msgs('z-ai/glm-5.3')[1].reasoning_details).toBeUndefined()
  })

  it('are assembled from their streamed pieces and handed on with the calls', async () => {
    const state = openrouterTransport.createState({ ...base, model: 'google/gemini-3.8-flash' })
    const chunk = (delta: Record<string, unknown>, finish?: string) => ({
      choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }]
    })
    openrouterTransport.interpret(
      chunk({
        reasoning_details: [
          {
            type: 'reasoning.text',
            text: 'I should ',
            index: 0,
            format: 'google-gemini-v1',
            signature: null
          }
        ]
      }),
      state
    )
    openrouterTransport.interpret(
      chunk({ reasoning_details: [{ type: 'reasoning.text', text: 'call f.', index: 0 }] }),
      state
    )
    openrouterTransport.interpret(
      chunk({ reasoning_details: [{ type: 'reasoning.text', index: 0, signature: 'sig' }] }),
      state
    )
    openrouterTransport.interpret(
      chunk(
        { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        'tool_calls'
      ),
      state
    )
    const [ev] = await openrouterTransport.finish(state)
    expect(ev).toMatchObject({
      type: 'tool_calls',
      replay: {
        provider: 'openrouter',
        model: 'google/gemini-3.8-flash',
        steps: [
          {
            type: 'reasoning.text',
            text: 'I should call f.',
            signature: 'sig',
            index: 0,
            format: 'google-gemini-v1'
          }
        ]
      }
    })
  })
})

describe('reasoning blocks that share an index', () => {
  it('stay separate blocks in arrival order — two encrypted blobs are never glued together', async () => {
    const state = openrouterTransport.createState({ ...base, model: 'openai/gpt-6-luna' })
    const pieces = [
      { type: 'reasoning.summary', summary: 'First ', index: 0, format: 'google-gemini-v1' },
      { type: 'reasoning.summary', summary: 'thought.', index: 0 },
      { type: 'reasoning.encrypted', data: 'blob-A', id: 'rs_A', index: 0, format: 'google-gemini-v1' },
      { type: 'reasoning.summary', summary: 'Second thought.', index: 0 },
      { type: 'reasoning.encrypted', data: 'blob-B', id: 'rs_B', index: 0, format: 'google-gemini-v1' }
    ]
    for (const p of pieces)
      openrouterTransport.interpret({ choices: [{ delta: { reasoning_details: [p] } }] }, state)
    openrouterTransport.interpret(
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }]
            },
            finish_reason: 'tool_calls'
          }
        ]
      },
      state
    )
    const [ev] = await openrouterTransport.finish(state)
    const steps = ev.type === 'tool_calls' ? (ev.replay?.steps as Array<Record<string, unknown>>) : []
    expect(steps.map((s) => [s.type, s.summary ?? s.data])).toEqual([
      ['reasoning.summary', 'First thought.'],
      ['reasoning.encrypted', 'blob-A'],
      ['reasoning.summary', 'Second thought.'],
      ['reasoning.encrypted', 'blob-B']
    ])
  })

  it('go back only for the rounds of the current turn', () => {
    const call = { id: 'c1', type: 'function' as const, function: { name: 'f', arguments: '{}' } }
    const replay = {
      provider: 'openrouter' as const,
      model: 'm',
      steps: [{ type: 'reasoning.text', text: 't' }]
    }
    const body = JSON.parse(
      openrouterTransport.buildRequest(
        {
          ...base,
          model: 'm',
          messages: [
            { role: 'user', content: 'first turn' },
            { role: 'assistant', content: null, tool_calls: [call], replay },
            { role: 'tool', tool_call_id: 'c1', content: 'ok' },
            { role: 'assistant', content: 'done' },
            { role: 'user', content: 'second turn' },
            { role: 'assistant', content: null, tool_calls: [{ ...call, id: 'c2' }], replay },
            { role: 'tool', tool_call_id: 'c2', content: 'ok' }
          ]
        },
        'k'
      ).body
    ) as { messages: Array<Record<string, unknown>> }
    expect(body.messages[1].reasoning_details).toBeUndefined()
    expect(body.messages[5].reasoning_details).toEqual(replay.steps)
  })

  it('stay with their round when a screenshot comes back as a user message inside it', () => {
    const call = {
      id: 'c1',
      type: 'function' as const,
      function: { name: 'screenshot_canvas', arguments: '{}' }
    }
    const replay = {
      provider: 'openrouter' as const,
      model: 'm',
      steps: [{ type: 'reasoning.text', text: 't' }]
    }
    const image = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }]
    const body = JSON.parse(
      openrouterTransport.buildRequest(
        {
          ...base,
          model: 'm',
          messages: [
            { role: 'user', content: 'look at my canvas' },
            { role: 'assistant', content: null, tool_calls: [call], replay },
            { role: 'tool', tool_call_id: 'c1', content: 'screenshot attached' },
            { role: 'user', content: image },
            { role: 'user', content: image }
          ]
        },
        'k'
      ).body
    ) as { messages: Array<Record<string, unknown>> }
    expect(body.messages[1].reasoning_details).toEqual(replay.steps)
  })
})

describe('which reasoning formats travel back', () => {
  it('only the measured ones: a round in another format keeps no replay', async () => {
    for (const format of ['anthropic-claude-v1', 'openai-responses-v1']) {
      const state = openrouterTransport.createState({ ...base, model: 'x/y' })
      openrouterTransport.interpret(
        {
          choices: [
            { delta: { reasoning_details: [{ type: 'reasoning.text', text: 't', index: 0, format }] } }
          ]
        },
        state
      )
      openrouterTransport.interpret(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        },
        state
      )
      const [ev] = await openrouterTransport.finish(state)
      expect(ev.type === 'tool_calls' && ev.replay, format).toBeFalsy()
    }
  })
})
