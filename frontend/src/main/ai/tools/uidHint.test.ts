import { describe, expect, it } from 'vitest'
import { isNearUid, uidDifference, uidNotFound } from './uidHint'

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
    const refusal = uidNotFound(GRANULATE + '9', 'Bottle', acts)
    expect(refusal).toContain('Malformed uid (33 characters)')
    expect(refusal).toContain(`Did you mean ${GRANULATE} (input: widget granulate — yours has "9" too many`)
    expect(refusal).toContain('not used in its place')
    expect(refusal).not.toContain(SHEET)
  })

  it('names a well-formed near uid without the malformed note, and no near uid when nothing is near', () => {
    expect(uidNotFound(GRANULATE.slice(0, -1) + 'b', 'Bottle', { activities: acts })).not.toContain(
      'Malformed'
    )
    expect(uidNotFound(GRANULATE.slice(0, -1) + 'b', 'Bottle', { activities: acts })).toContain(GRANULATE)
    const none = uidNotFound('f'.repeat(32), 'Bottle', acts)
    expect(none).not.toContain('Did you mean')
    expect(none).toContain('the exchange may have been removed, or replaced')
    expect(uidNotFound('abc', 'Bottle', acts)).toContain('Malformed uid (3 characters)')
  })

  it('says where the near uid differs, and puts it before "removed or replaced"', () => {
    // Two characters swapped: the two uids look the same, and a caller told only the right one read it
    // as the one it had sent — and sent the wrong one again.
    const swapped = GRANULATE.slice(0, 27) + GRANULATE[28] + GRANULATE[27] + GRANULATE.slice(29)
    const refusal = uidNotFound(swapped, 'Bottle', acts)
    expect(refusal).toContain('at character 28 yours has "bc" where it has "cb"')
    expect(refusal.indexOf('Did you mean')).toBeLessThan(refusal.indexOf('removed, or replaced'))
    expect(refusal).toContain('If it is not, the exchange may have been removed, or replaced')
    expect(uidDifference(GRANULATE.slice(0, -1), GRANULATE)).toBe('yours lacks "a" after character 31')
    expect(uidDifference(GRANULATE.slice(0, -1) + 'b', GRANULATE)).toBe(
      'at character 32 yours has "b" where it has "a"'
    )
    // The same first eight characters and nothing else: no slip, and it says so.
    expect(uidDifference(GRANULATE.slice(0, 8) + '0'.repeat(24), GRANULATE)).toBe(
      'it shares only its first 8 characters with yours'
    )
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
    expect(String(await run)).toContain(`Did you mean ${GRANULATE} (input: widget granulate — `)
  })

  it('localize_dataset names it too', async () => {
    const { TOOL_BY_NAME } = await import('.')
    const out = String(await TOOL_BY_NAME.localize_dataset.run({ uid: GRANULATE + '9', location: 'DE' }, ctx))
    expect(out).toContain('Malformed uid (33 characters)')
  })
})
