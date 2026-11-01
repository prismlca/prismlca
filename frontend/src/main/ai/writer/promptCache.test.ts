import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chat } from '../test/fakeStream'

/**
 * A chapter's calls go out in one shape (promptCache.ts): the tool list heads the provider's cached
 * prefix, so a call that offers a different list re-bills the whole conversation. Offline, with the
 * scripted stream; tool calls are only emitted when tools were offered.
 */
vi.mock('../client', async () => (await import('../test/fakeStream')).clientModuleMock())
chat.alwaysDelta = true
chat.gateCallsOnTools = true
chat.defaultUsage = { cost: 0.0004, prompt_tokens: 900 }
chat.defaultFinish = 'stop'
chat.fallbackText = 'A chapter.'

const { writeSection, lookupBudget } = await import('../reportWriter')
const { NO_LOOKUP_NOW } = await import('./promptCache')

const sent = chat.seen
const CHECK = '/api/v1/report/one/m/rep/sections/s1/proposal'

const brief = {
  kind: 'summary',
  title: 'Summary',
  language: 'English',
  prompt: 'Summarise.',
  placeholders: ['results.0.score'],
  data: { results: [{ method_label: 'IPCC / GWP', unit: 'kg CO2-eq', score: 0.4 }] }
}

const lookup = (id: string, code = id) => ({
  id,
  name: 'get_process_details',
  arguments: JSON.stringify({ database: 'm', code })
})

/** A backend whose lookups answer and whose gate refuses the first look (a typed number), then passes. */
const backend = () => {
  let checks = 0
  const lookups: string[] = []
  const api = async (_m: string, path: string): Promise<unknown> => {
    if (path.endsWith('/proposal'))
      return ++checks === 1
        ? { ok: false, findings: [{ kind: 'literal_number', detail: 'The number 90 is written out.' }] }
        : { ok: true, findings: [] }
    lookups.push(path)
    return { activity: { name: 'steel' } }
  }
  return { api, lookups }
}

beforeEach(() => {
  sent.length = 0
  chat.rounds = []
})

describe('one shape for every call of a chapter', () => {
  it('offers the revision the same tools the lookup rounds offered', async () => {
    const { api } = backend()
    chat.rounds = [
      { calls: [lookup('t1')] },
      { text: 'The share is 90 %.' },
      { text: '{"replacements": [{"old": "90 %", "new": "{{results.0.score}}"}]}' }
    ]
    const out = await writeSection({ brief, api, checkPath: CHECK })
    expect(out.attempts).toBe(2)
    expect(sent).toHaveLength(3)
    expect(sent[0].tools?.length).toBeGreaterThan(0)
    // A revision without them re-billed the brief, the lookups and the draft on every provider.
    for (const c of sent) expect(c.tools).toEqual(sent[0].tools)
  })

  it('asks for the moving breakpoint on every call of a model that needs breakpoints, and only there', async () => {
    chat.rounds = [{ calls: [lookup('t1')] }, { text: 'Done.' }]
    await writeSection({ brief, model: 'anthropic/claude-sonnet-5.5', api: backend().api })
    expect(sent).toHaveLength(2)
    for (const c of sent) expect(c.cacheTail).toBe(true)
    sent.length = 0
    chat.rounds = [{ text: 'Done.' }]
    await writeSection({ brief, model: 'z-ai/glm-5.3', api: backend().api })
    expect(sent[0].cacheTail).toBeFalsy()
  })

  it('says beside the answer that the last lookup is spent, keeps it out of the evidence, and keeps the tools on', async () => {
    const allowance = lookupBudget(brief)
    chat.rounds = [
      { calls: Array.from({ length: allowance }, (_, i) => lookup(`t${i}`)) },
      { text: 'Written from what I have.' }
    ]
    const out = await writeSection({ brief, api: backend().api })
    expect(out.lookups).toHaveLength(allowance)
    expect(sent[1].tools).toEqual(sent[0].tools)
    const answers = sent[1].messages.filter((m) => m.role === 'tool').map((m) => String(m.content))
    expect(answers.at(-1)).toMatch(/last lookup this chapter allows/)
    expect(answers.slice(0, -1).some((a) => /last lookup/.test(a))).toBe(false)
    // The gate judges the text against the lookups: the note is not one of them.
    expect(out.lookups.some((l) => /last lookup/.test(l.result))).toBe(false)
  })

  it('withdraws the tools from a model that asks again after the allowance is spent', async () => {
    const allowance = lookupBudget(brief)
    chat.rounds = [
      { calls: Array.from({ length: allowance }, (_, i) => lookup(`t${i}`)) },
      { calls: [lookup('again')] },
      { text: 'Written from what I have.' }
    ]
    const out = await writeSection({ brief, api: backend().api })
    expect(out.lookups).toHaveLength(allowance) // the extra call was refused, not run
    expect(sent[1].tools).toEqual(sent[0].tools)
    expect(sent[2].tools).toBeUndefined()
    expect(out.text).toBe('Written from what I have.')
  })

  it('refuses a lookup asked for while revising in a tool answer, and asks once more', async () => {
    const { api, lookups } = backend()
    chat.rounds = [
      { text: 'The share is 90 %.' },
      { calls: [lookup('mid-revision')] },
      { text: '{"replacements": [{"old": "90 %", "new": "{{results.0.score}}"}]}' }
    ]
    const out = await writeSection({ brief, api, checkPath: CHECK })
    expect(lookups).toEqual([]) // nothing was looked up
    expect(out.text).toBe('The share is {{results.0.score}}.')
    const retry = sent[2].messages
    expect(retry.at(-2)?.tool_calls?.[0].id).toBe('mid-revision')
    expect(retry.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'mid-revision',
      content: NO_LOOKUP_NOW
    })
    expect(sent[2].tools).toEqual(sent[0].tools)
  })

  it('does not take the words beside a lookup for the revision', async () => {
    // "I will check first" plus a call used to be read as the answer, failed to parse and ended the repair.
    const { api, lookups } = backend()
    chat.rounds = [
      { text: 'The share is 90 %.' },
      { text: 'I will check the process first.', calls: [lookup('mid-revision')] },
      { text: '{"replacements": [{"old": "90 %", "new": "{{results.0.score}}"}]}' }
    ]
    const out = await writeSection({ brief, api, checkPath: CHECK })
    expect(lookups).toEqual([])
    expect(out.text).toBe('The share is {{results.0.score}}.')
    expect(sent[2].messages.at(-2)).toMatchObject({
      role: 'assistant',
      content: 'I will check the process first.'
    })
  })

  it('refuses a lookup in a continuation and continues', async () => {
    chat.rounds = [
      { text: 'The first half', finish: 'length' },
      { calls: [lookup('mid-continuation')], finish: 'tool_calls' },
      { text: ' and the second half.' }
    ]
    const out = await writeSection({ brief, api: backend().api })
    expect(out.incomplete).toBeFalsy()
    expect(out.text).toBe('The first half and the second half.')
    expect(sent[2].messages.at(-1)).toMatchObject({ role: 'tool', content: NO_LOOKUP_NOW })
    expect(sent[2].tools).toEqual(sent[0].tools)
  })

  it('keeps a continuation that ends in a lookup twice as a draft, not as a finished chapter', async () => {
    chat.rounds = [
      { text: 'The first half', finish: 'length' },
      { calls: [lookup('one')], finish: 'tool_calls' },
      { calls: [lookup('two')], finish: 'tool_calls' }
    ]
    const out = await writeSection({ brief, api: backend().api, checkPath: CHECK })
    expect(out.incomplete).toBe(true)
    expect(out.findings[0].kind).toBe('incomplete_answer')
    expect(out.text).toBe('The first half')
  })

  it('keeps every call of a chapter on one routing key, and gives another chapter its own', async () => {
    const { api } = backend()
    chat.rounds = [
      { calls: [lookup('t1')] },
      { text: 'The share is 90 %.' },
      { text: '{"replacements": [{"old": "90 %", "new": "{{results.0.score}}"}]}' }
    ]
    await writeSection({ brief, api, checkPath: CHECK })
    const keys = sent.map((c) => c.sessionId)
    expect(keys).toHaveLength(3)
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(new Set(keys).size).toBe(1)
    sent.length = 0
    chat.rounds = [{ text: 'Done.' }]
    await writeSection({ brief, api: backend().api, checkPath: CHECK.replace('s1', 's2') })
    expect(sent[0].sessionId).not.toBe(keys[0])
  })
})
