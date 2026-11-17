import { describe, expect, it } from 'vitest'
import type { ToolCtx } from '../context'
import { inspectedKey } from './hotspots'
import { OPEN_BEFORE_RELYING_AGAIN, openBeforeRelying, unopenedLinks, withLinkReminder } from './linkReminder'

const ctxOf = (inspected: Set<string> | undefined): ToolCtx => ({
  api: (async () => ({ markets: [] })) as ToolCtx['api'],
  ui: async () => ({}),
  activeDb: 'M',
  inspected
})

const pp = { name: 'polypropylene', database: 'ei', code: 'pp' }
const steel = { name: 'steel', database: 'ei', code: 'steel' }

describe('unopenedLinks', () => {
  it('names each unopened background dataset once and leaves the model itself out', () => {
    const opened = new Set([inspectedKey('ei', 'steel')])
    expect(unopenedLinks([pp, steel, pp, { database: 'M', code: 'sub' }], 'M', opened)).toEqual([pp])
    expect(unopenedLinks([pp], 'M', undefined)).toEqual([])
  })
})

describe('the link-time reminder explains itself once per run', () => {
  it('carries the paragraph on the first answer, one sentence and the list afterwards', async () => {
    const ctx = ctxOf(new Set())
    const first = JSON.parse(await withLinkReminder('{"uid":"u1"}', [pp], 'M', ctx))
    expect(first).toEqual({ uid: 'u1', not_yet_opened: [pp], open_before_relying: openBeforeRelying(1) })

    const second = JSON.parse(await withLinkReminder('{"uid":"u2"}', [pp, steel], 'M', ctx))
    expect(second).toEqual({
      uid: 'u2',
      not_yet_opened: [pp, steel],
      open_before_relying: OPEN_BEFORE_RELYING_AGAIN
    })
    // Under a quarter of the paragraph, and still naming the tool to call.
    expect(OPEN_BEFORE_RELYING_AGAIN.length * 4).toBeLessThan(openBeforeRelying(2).length)
    expect(OPEN_BEFORE_RELYING_AGAIN).toContain('get_process_details')
  })

  it('does not spend the explanation on an answer that carries no reminder', async () => {
    const ctx = ctxOf(new Set([inspectedKey('ei', 'pp')]))
    expect(await withLinkReminder('{"uid":"u1"}', [pp], 'M', ctx)).toBe('{"uid":"u1"}')
    expect(await withLinkReminder('{"uid":"u0"}', [], 'M', ctx)).toBe('{"uid":"u0"}')
    expect(await withLinkReminder('not json', [steel], 'M', ctx)).toBe('not json')
    const later = JSON.parse(await withLinkReminder('{"uid":"u2"}', [steel], 'M', ctx))
    expect(later.open_before_relying).toBe(openBeforeRelying(1))
  })

  it('starts over in a new run', async () => {
    const said = ctxOf(new Set())
    await withLinkReminder('{}', [pp], 'M', said)
    const fresh = JSON.parse(await withLinkReminder('{}', [pp], 'M', ctxOf(new Set())))
    expect(fresh.open_before_relying).toBe(openBeforeRelying(1))
  })
})
