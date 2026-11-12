import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatMessage } from './providers/types'
import {
  argumentsProblem,
  argumentsRefusal,
  logUnsendableArguments,
  QUOTED_CHARS,
  sendableArguments,
  withSendableArguments
} from './toolArguments'

/** What a host delivered once, verbatim from a recorded stream: the value of a list field never came. */
const CUT = '{"filtered_queries": '

describe('argumentsProblem', () => {
  it('passes a JSON object, empty or not', () => {
    expect(argumentsProblem('{}')).toBeNull()
    expect(argumentsProblem('{"queries":["a"],"limit":5}')).toBeNull()
  })

  it('names what is wrong with everything else', () => {
    expect(argumentsProblem(CUT)).toBe('syntax')
    expect(argumentsProblem('{"steps": [{"step": "a"')).toBe('syntax')
    expect(argumentsProblem('')).toBe('syntax')
    expect(argumentsProblem('   ')).toBe('syntax')
    expect(argumentsProblem('[]')).toBe('array')
    expect(argumentsProblem('null')).toBe('null')
    expect(argumentsProblem('"x"')).toBe('string')
    expect(argumentsProblem('3')).toBe('number')
    expect(argumentsProblem('true')).toBe('boolean')
  })
})

describe('sendableArguments', () => {
  it('keeps an object byte for byte — spacing and key order included', () => {
    const raw = '{ "b": 1,\n  "a": [ {"x": "ü"} ] }'
    expect(sendableArguments(raw)).toBe(raw)
  })

  it('sends {} for anything that is not a JSON object', () => {
    for (const raw of [CUT, '', ' ', '[]', 'null', '"x"', '3', '{not json'])
      expect(sendableArguments(raw), raw).toBe('{}')
  })
})

describe('withSendableArguments', () => {
  const ok = { id: 'a', type: 'function' as const, function: { name: 'f', arguments: '{"x":1}' } }
  const cut = { id: 'b', type: 'function' as const, function: { name: 'g', arguments: CUT } }

  it('hands back the same message when every call is sendable', () => {
    const m = { role: 'assistant' as const, content: null, tool_calls: [ok] }
    expect(withSendableArguments(m)).toBe(m)
    const plain: ChatMessage = { role: 'user', content: 'hi' }
    expect(withSendableArguments(plain)).toBe(plain)
  })

  it('replaces only the broken call, in a copy — the transcript keeps what the host sent', () => {
    const m = { role: 'assistant' as const, content: 'x', tool_calls: [ok, cut] }
    const sent = withSendableArguments(m)
    expect(sent).not.toBe(m)
    expect(sent.tool_calls?.[0]).toBe(ok)
    expect(sent.tool_calls?.[1]).toEqual({ ...cut, function: { name: 'g', arguments: '{}' } })
    expect(m.tool_calls[1].function.arguments).toBe(CUT)
  })
})

describe('logUnsendableArguments', () => {
  afterEach(() => vi.restoreAllMocks())

  it('logs host, tool, kind and length — never the content', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    logUnsendableArguments('Fireworks', [
      { name: 'search_background', arguments: CUT },
      { name: 'list_models', arguments: '{}' },
      { name: 'get_current_model', arguments: '' }
    ])
    expect(log).toHaveBeenCalledTimes(1)
    const line = String(log.mock.calls[0][0])
    expect(line).toContain('Fireworks')
    expect(line).toContain('search_background')
    expect(line).toContain(`${CUT.length} chars`)
    expect(line).not.toContain('filtered_queries')
  })
})

describe('argumentsRefusal', () => {
  it('names the tool, quotes what arrived and asks for the whole call again', () => {
    const text = argumentsRefusal('search_background', CUT, 'syntax')
    expect(text).toContain('search_background')
    expect(text).toContain(`What arrived: \`${CUT}\`.`)
    expect(text).toMatch(/Send the complete call again/)
  })

  it('quotes at most the head of a long string', () => {
    const raw = `{"steps": [${'{"step": "a long step", "status": "completed"}, '.repeat(20)}`
    const text = argumentsRefusal('plan', raw, 'syntax')
    expect(text).toContain(`${raw.slice(0, QUOTED_CHARS)}…`)
    expect(text).not.toContain(raw.slice(0, QUOTED_CHARS + 1))
  })

  it('says what kind of value came when it was JSON but no object', () => {
    expect(argumentsRefusal('model_info', '[]', 'array')).toMatch(/must be a JSON object .* an array/)
    expect(argumentsRefusal('model_info', 'null', 'null')).toMatch(/what arrived was null/)
  })
})
