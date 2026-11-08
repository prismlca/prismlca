/**
 * The capability table (shared/providerCaps.ts) against the requests the transports actually build: a
 * capability the table claims must show in the request, one it denies must not. Without this the table
 * is a second opinion about the transports that nothing checks, and the settings would promise what a
 * provider does not do — or hide what it does.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/prism-caps-test', getAppPath: () => '/tmp/prism-caps-test' }
}))

import { AI_PROVIDERS, PROVIDER_CAPS } from '../../../shared/providerCaps'
import type { AiProviderId } from '../../../shared/aiDefaults'
import { anthropicTransport } from './anthropic'
import { googleTransport } from './google'
import { openaiTransport } from './openai'
import { openrouterTransport } from './openrouter'
import type { ChatTransport, StreamChatOpts } from './types'

const TRANSPORT: Record<AiProviderId, ChatTransport<unknown>> = {
  openrouter: openrouterTransport as ChatTransport<unknown>,
  anthropic: anthropicTransport as ChatTransport<unknown>,
  openai: openaiTransport as ChatTransport<unknown>,
  google: googleTransport as ChatTransport<unknown>
}

/** How each request spells its web-search tool. */
const SEARCH_TOOL: Record<AiProviderId, string> = {
  openrouter: 'openrouter:web_search',
  anthropic: '"type":"web_search_20250305"',
  openai: '"type":"web_search"',
  google: '"type":"google_search"'
}

const tool = {
  type: 'function' as const,
  function: {
    name: 'list_models',
    description: 'List models',
    parameters: { type: 'object', properties: {} }
  }
}

function bodyOf(p: AiProviderId, opts: Partial<StreamChatOpts>): string {
  return TRANSPORT[p].buildRequest(
    { model: 'm', messages: [{ role: 'user', content: 'hi' }], temperature: null, ...opts },
    'k'
  ).body
}

describe.each(AI_PROVIDERS)('the %s transport keeps to the capability table', (p) => {
  const caps = PROVIDER_CAPS[p]

  it('caps web lookups per reply exactly when the table says it can', () => {
    const body = bodyOf(p, { webSearch: true, webLookupsCap: 3 })
    expect(/max_uses|max_tool_calls/.test(body)).toBe(caps.webLookupsCap)
  })

  it('filters search by domain exactly when the table says it can', () => {
    const body = bodyOf(p, { webSearch: true, webDomains: ['plasticseurope.org'] })
    expect(body.includes('allowed_domains')).toBe(caps.webDomainFilter)
  })

  it('sends its search beside function tools exactly when the table says it can', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = bodyOf(p, { webSearch: true, tools: [tool] })
    expect(body.includes(SEARCH_TOOL[p])).toBe(caps.searchBesideTools)
    // A search-only request carries it on every provider — the research tools depend on that.
    expect(bodyOf(p, { webSearch: true }).includes(SEARCH_TOOL[p])).toBe(true)
  })

  it('carries OpenRouter’s routing rules exactly when the table says they apply', () => {
    expect(bodyOf(p, {}).includes('data_collection')).toBe(caps.routing)
  })
})
