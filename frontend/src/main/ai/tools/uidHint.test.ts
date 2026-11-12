import { describe, expect, it } from 'vitest'
import { isNearUid, uidMiss } from './uidHint'

const GRANULATE = '378d2ed8cdfc4d60abeaea33550cba9a'
const SHEET = '9f0c1b2a3d4e5f60718293a4b5c6d7e8'
const acts = [
  {
    code: 'bottle',
    exchanges: [
      { uid: GRANULATE, type: 'technosphere', input: { name: 'widget granulate' } },
      { uid: SHEET, type: 'technosphere', input: { name: 'widget sheet' } }
    ]
  }
]

describe('uid hints (V487)', () => {
  it('calls a 33-character uid malformed and names the one it was meant to be — never more', () => {
    const extra = uidMiss(GRANULATE + '9', acts)
    expect(extra).toContain('Malformed uid (33 characters)')
    expect(extra).toContain(`Did you mean ${GRANULATE} (input: widget granulate)?`)
    expect(extra).toContain('not used in its place')
    expect(extra).not.toContain(SHEET)
  })

  it('names a well-formed near uid without the malformed note, and adds nothing when nothing is near', () => {
    expect(uidMiss(GRANULATE.slice(0, -1) + 'b', { activities: acts })).not.toContain('Malformed')
    expect(uidMiss(GRANULATE.slice(0, -1) + 'b', { activities: acts })).toContain(GRANULATE)
    expect(uidMiss('f'.repeat(32), acts)).toBe('')
    expect(uidMiss('abc', acts)).toContain('Malformed uid (3 characters)')
  })

  it('counts one edit or the same first eight characters as near', () => {
    expect(isNearUid(GRANULATE, GRANULATE.slice(1))).toBe(true)
    expect(isNearUid(GRANULATE, 'x' + GRANULATE.slice(1))).toBe(true)
    expect(isNearUid(GRANULATE.slice(0, 8), GRANULATE)).toBe(true)
    expect(isNearUid(GRANULATE, GRANULATE)).toBe(false)
    expect(isNearUid(GRANULATE, SHEET)).toBe(false)
    expect(isNearUid(GRANULATE, undefined)).toBe(false)
  })
})

describe('the model-wide uid lookups use it', () => {
  const ctx = {
    api: async () => acts,
    ui: async () => ({}),
    activeDb: 'Bottle'
  } as unknown as import('./context').ToolCtx

  it('edit_exchange without a process names the near uid', async () => {
    const { TOOL_BY_NAME } = await import('.')
    const run = TOOL_BY_NAME.edit_exchange.run(
      { action: 'set_formula', uid: GRANULATE + '9', formula: 'mass' },
      ctx
    )
    expect(String(await run)).toContain(`Did you mean ${GRANULATE} (input: widget granulate)?`)
  })

  it('localize_dataset names it too', async () => {
    const { TOOL_BY_NAME } = await import('.')
    const out = String(await TOOL_BY_NAME.localize_dataset.run({ uid: GRANULATE + '9', location: 'DE' }, ctx))
    expect(out).toContain('Malformed uid (33 characters)')
  })
})
