/**
 * SSE framing by the spec: events end at a blank line, data lines join, comments and other fields
 * are skipped — and the last event of a stream counts without its closing blank line.
 */
import { describe, expect, it } from 'vitest'
import { parseEventData, SseFramer } from './sse'

describe('SSE framing', () => {
  it('joins an event’s data lines and skips comments and other fields', () => {
    const f = new SseFramer()
    expect(f.push(': ping\n\nevent: step.delta\ndata: {"a":\ndata: 1}\nid: 7\n\n')).toEqual(['{"a":\n1}'])
  })

  it('survives chunks that cut lines in half, and CRLF line ends', () => {
    const f = new SseFramer()
    expect(f.push('data: {"x"')).toEqual([])
    expect(f.push(':2}\r\n\r\ndata: [DONE]\r\n')).toEqual(['{"x":2}'])
    expect(f.end()).toEqual(['[DONE]'])
  })

  it('keeps streaming when a provider separates events by newline only', () => {
    const f = new SseFramer()
    expect(f.push('data: {"a":1}\ndata: {"b":2}\n')).toEqual(['{"a":1}'])
    expect(f.end()).toEqual(['{"b":2}'])
  })

  it('reads one JSON value per event, two objects on two lines as a fallback, and nothing else', () => {
    expect(parseEventData('{"a":1}')).toEqual([{ a: 1 }])
    expect(parseEventData('{"a":\n1}')).toEqual([{ a: 1 }])
    expect(parseEventData('{"a":1}\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }])
    expect(parseEventData('{not json')).toBeNull()
  })
})
