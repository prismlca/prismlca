import { describe, expect, it } from 'vitest'

import {
  TRANSCRIPT_MAX_BYTES,
  boundTranscript,
  closeOpenCalls,
  historyTail,
  sameHistory,
  wellPaired
} from './agent'
import type { ChatMessage } from './providers/types'

const call = (id: string, name: string, args = '{}'): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: args } }]
})
const result = (id: string, content: string): ChatMessage => ({ role: 'tool', tool_call_id: id, content })

describe('wellPaired', () => {
  it('accepts a transcript where every call has its result, and only then', () => {
    expect(wellPaired([{ role: 'user', content: 'hi' }, call('a', 'list_models'), result('a', '[]')])).toBe(
      true
    )
    expect(wellPaired([call('a', 'list_models')])).toBe(false)
    expect(wellPaired([result('zz', '{}')])).toBe(false)
  })
})

describe('closeOpenCalls', () => {
  it('gives every unanswered call a "not executed" result, right behind its siblings', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'search_background', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'edit_exchange', arguments: '{}' } }
        ]
      },
      result('a', '{"hits":[]}')
    ]
    expect(closeOpenCalls(messages)).toBe(1)
    expect(wellPaired(messages)).toBe(true)
    expect(messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'b' })
    expect(String(messages[3].content)).toContain('not executed')
    // Idempotent: nothing left to close.
    expect(closeOpenCalls(messages)).toBe(0)
  })
})

describe('sameHistory', () => {
  it('ignores an assistant turn without text on either side', () => {
    const a = [
      { role: 'user' as const, content: 'go' },
      { role: 'assistant' as const, content: '' }
    ]
    const b = [{ role: 'user' as const, content: 'go' }]
    expect(sameHistory(a, b)).toBe(true)
    expect(sameHistory(a, [{ role: 'user', content: 'other' }])).toBe(false)
  })
})

describe('boundTranscript', () => {
  const plan = {
    title: 'T',
    steps: [{ step: 'A', status: 'in_progress' as const }],
    revision: 2,
    updated: 'x'
  }

  it('returns a copy unchanged when it fits', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      call('a', 'list_models'),
      result('a', '[]')
    ]
    const out = boundTranscript(messages, TRANSCRIPT_MAX_BYTES, null)
    expect(out).toEqual(messages)
    expect(out).not.toBe(messages)
  })

  it('drops whole oldest rounds — never bytes — and keeps the pairs valid', () => {
    const big = 'x'.repeat(2000)
    const messages: ChatMessage[] = [{ role: 'user', content: 'go' }]
    for (let i = 0; i < 6; i++) {
      messages.push(call(`c${i}`, 'get_process_details'), result(`c${i}`, big))
    }
    messages.push({ role: 'assistant', content: 'done' })
    const out = boundTranscript(messages, 6000, null)
    expect(out).not.toBeNull()
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(6000)
    expect(wellPaired(out!)).toBe(true)
    expect(out![0]).toEqual({ role: 'user', content: 'go' }) // the task statement stays
    expect(out![out!.length - 1]).toEqual({ role: 'assistant', content: 'done' })
    expect(JSON.stringify(out)).not.toMatch(/x{10}"[^,]*truncat/) // no mid-string cuts
  })

  it('refuses when even the last round does not fit', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      call('a', 'x'),
      result('a', 'y'.repeat(10_000))
    ]
    expect(boundTranscript(messages, 500, null)).toBeNull()
  })

  it('puts the plan back when the round that carried its result was dropped', () => {
    const big = 'x'.repeat(3000)
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      call('p', 'plan'),
      result('p', 'Plan updated · 0/1'),
      call('a', 'get_process_details'),
      result('a', big),
      call('b', 'get_process_details'),
      result('b', big),
      { role: 'assistant', content: 'done' }
    ]
    const out = boundTranscript(messages, 4000, plan)
    expect(out).not.toBeNull()
    expect(JSON.stringify(out)).toContain('Current plan (carried over)')
    expect(wellPaired(out!)).toBe(true)
  })
})

describe('historyTail', () => {
  const stored = [
    { role: 'user' as const, content: 'build' },
    { role: 'assistant' as const, content: 'done' }
  ]
  it('is empty when the histories match, the trailing user turns when the user typed on, null otherwise', () => {
    expect(historyTail(stored, stored)).toEqual([])
    expect(historyTail(stored, [...stored, { role: 'user', content: 'and now the cap' }])).toEqual([
      { role: 'user', content: 'and now the cap' }
    ])
    // An answered follow-up is a different history — the transcript of two turns ago is not it.
    expect(
      historyTail(stored, [...stored, { role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }])
    ).toBeNull()
    expect(historyTail(stored, [{ role: 'user', content: 'other' }])).toBeNull()
  })
})

describe('boundTranscript keeps prose', () => {
  it('evicts tool-call groups only — a user instruction between rounds survives', () => {
    const big = 'x'.repeat(2500)
    const messages: ChatMessage[] = [
      { role: 'user', content: 'build the bottle' },
      call('a', 'get_process_details'),
      result('a', big),
      { role: 'assistant', content: 'First answer.' },
      { role: 'user', content: 'Keep the existing functional unit unchanged' },
      call('b', 'get_process_details'),
      result('b', big),
      call('c', 'get_process_details'),
      result('c', big),
      { role: 'assistant', content: 'done' }
    ]
    const out = boundTranscript(messages, 4500, null)
    expect(out).not.toBeNull()
    const texts = out!.map((m) => (typeof m.content === 'string' ? m.content : ''))
    expect(texts).toContain('Keep the existing functional unit unchanged')
    expect(texts).toContain('First answer.')
    expect(wellPaired(out!)).toBe(true)
  })
})
