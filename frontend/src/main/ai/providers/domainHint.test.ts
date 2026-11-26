import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/prism-domainhint-test', getAppPath: () => '/tmp/prism-domainhint-test' }
}))

const { anthropicTransport } = await import('./anthropic')
import { domainHint, withDomainHint } from './domainHint'
import type { ChatMessage, StreamChatOpts } from './types'

const HOSTS = ['plasticseurope.org', 'iso.org']
const SYSTEM_BLOCK = { type: 'text', text: 'You research facts.', cache_control: { type: 'ephemeral' } }
const system = { role: 'system', content: [SYSTEM_BLOCK] } as ChatMessage
const user: ChatMessage = { role: 'user', content: 'PET density?' }

/** The body of the Anthropic request these options build. */
const anthropicBody = (opts: Partial<StreamChatOpts>): Record<string, any> =>
  JSON.parse(
    anthropicTransport.buildRequest(
      { model: 'claude-haiku-5-5', messages: [system, user], temperature: null, ...opts },
      'test-key'
    ).body
  )

describe('the host hint', () => {
  it('asks for site: in the queries and for pages of those hosts only; nothing without a list', () => {
    expect(domainHint(undefined)).toBeUndefined()
    expect(domainHint([])).toBeUndefined()
    expect(domainHint(HOSTS)).toContain('site:')
    expect(domainHint(HOSTS)).toContain('plasticseurope.org, iso.org')
    expect(withDomainHint('System.', HOSTS)).toBe(`System.\n\n${domainHint(HOSTS)}`)
    expect(withDomainHint('System.', undefined)).toBe('System.')
    expect(withDomainHint(undefined, HOSTS)).toBe(domainHint(HOSTS))
  })
})

describe('the host hint in an Anthropic request', () => {
  it('follows the system prompt when the search is restricted, and leaves its breakpoint where it was', () => {
    const body = anthropicBody({ webSearch: true, webDomains: HOSTS })
    expect(body.system).toEqual([SYSTEM_BLOCK, { type: 'text', text: domainHint(HOSTS) }])
    // The allow list stays on the tools as well: the words add to the filter, they do not replace it.
    expect(body.tools[0].allowed_domains).toEqual(HOSTS)
  })

  it('stays out without a list, and without the search a list would restrict', () => {
    expect(anthropicBody({ webSearch: true }).system).toEqual([SYSTEM_BLOCK])
    expect(anthropicBody({ webDomains: HOSTS }).system).toEqual([SYSTEM_BLOCK])
  })

  it('stands once in the continuation of a paused reply, as in the request before it', () => {
    const paused: ChatMessage = {
      role: 'assistant',
      content: null,
      replay: {
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        steps: [
          {
            type: 'server_tool_use',
            id: 'srvtoolu_1',
            name: 'web_search',
            input: { query: 'site:plasticseurope.org PET density' }
          },
          { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] }
        ]
      }
    }
    const first = anthropicBody({ webSearch: true, webDomains: HOSTS })
    const next = anthropicBody({ webSearch: true, webDomains: HOSTS, messages: [system, user, paused] })
    expect(next.system).toEqual(first.system)
    expect(next.messages.at(-1).role).toBe('assistant')
  })
})
