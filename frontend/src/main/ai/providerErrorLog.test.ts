import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiProviderError } from './providers/types'
import {
  logProviderError,
  logRetriedError,
  maskQuoted,
  maskSecrets,
  STORED_ERROR_CHARS,
  storedError
} from './providerErrorLog'

afterEach(() => vi.restoreAllMocks())

describe('what stays of a failed request', () => {
  it('stores status and the provider’s words', () => {
    const e = new AiProviderError('ZDR violation (account settings): 4 endpoints excluded — First, …', 'http')
    e.status = 404
    expect(storedError(e)).toBe(
      'HTTP 404 — ZDR violation (account settings): 4 endpoints excluded — First, …'
    )
    // No status where there was none: the kind of failure stands in.
    expect(storedError(new AiProviderError('The connection dropped.', 'network'))).toBe(
      'network — The connection dropped.'
    )
    expect(storedError(new Error('boom'))).toBe('error — boom')
  })

  it('cuts a long message and masks anything that looks like a key', () => {
    const long = new AiProviderError(
      `Incorrect API key provided: sk-or-v1-abcdef123456. ${'x'.repeat(900)}`,
      'auth'
    )
    long.status = 401
    const stored = storedError(long)
    expect(stored.length).toBe(STORED_ERROR_CHARS)
    expect(stored).not.toContain('abcdef123456')
    expect(maskSecrets('Bearer abcdefghijkl, key AIzaSyA1234567890abcdef, ?key=secret123&x=1')).toBe(
      'Bearer …, key AIza…, ?key=…&x=1'
    )
  })

  it('logs one line per error, also when the loop meets it twice', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const e = new AiProviderError('No endpoints found.', 'http')
    e.status = 404
    logProviderError(e, { provider: 'openrouter', model: 'test/model', servedBy: 'Widgets Inc' })
    logProviderError(e, { provider: 'openrouter', model: 'test/model' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(
      /\[prism-ai\] provider error: openrouter\/Widgets Inc test\/model — HTTP 404 — No endpoints found\.$/
    )
  })

  it('keeps request content a provider quotes back out of the log line', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const quoted = 'Please model 1 kg of widget, plastic, granulate with the recipe from our supplier'
    const e = new AiProviderError(
      `Invalid value at 'messages[3].content': "${quoted}" is not valid; args {"query": "${quoted}"}`,
      'http'
    )
    e.status = 400
    logProviderError(e, { provider: 'openai', model: 'test/model' })
    const line = String(warn.mock.calls[0][0])
    expect(line).not.toContain('widget')
    // What the line is read for stays: the status and the field the provider named.
    expect(line).toContain(
      'HTTP 400 — Invalid value at \'messages[3].content\': "…" is not valid; args {"query": "…"}'
    )
    // Short values and our own quoted setting names are no request content.
    expect(maskQuoted('unknown field "zdr" — “Only use providers that keep nothing” is on')).toBe(
      'unknown field "zdr" — “Only use providers that keep nothing” is on'
    )
  })

  it('logs a retried attempt each time, never marking the error as said', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const e = new AiProviderError('overloaded', 'http')
    e.status = 529
    const ctx = {
      transport: 'anthropic',
      model: 'test/model',
      attempt: 1,
      waitMs: 2000,
      detail: 'overloaded (529)'
    }
    logRetriedError(e, ctx)
    logProviderError(e, { provider: 'anthropic', model: 'test/model' })
    expect(warn.mock.calls.map((c) => String(c[0]).replace(/^.*\[prism-ai\] /, ''))).toEqual([
      'provider error, retrying: anthropic test/model — HTTP 529 (overloaded (529)) — overloaded — attempt 1, next in 2000 ms',
      'provider error: anthropic test/model — HTTP 529 — overloaded'
    ])
  })
})
