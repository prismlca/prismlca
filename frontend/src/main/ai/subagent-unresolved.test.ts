import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chat } from './test/fakeStream'

/**
 * What the parent gets for a component the research found no mass for, end to end: the leg's note
 * bounded and marked, and the addresses it names as pages — a provider's link resolved to the page
 * the engine cited, one that leads nowhere left out.
 */
vi.mock('./client', async () => (await import('./test/fakeStream')).clientModuleMock())
chat.alwaysDelta = true

const { researchBom } = await import('./researchBom')

beforeEach(() => {
  chat.seen.length = 0
  chat.rounds = []
})

const LINK = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZ1'
const DEAD = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/MANGLED'

describe('researchBom, unresolved components', () => {
  it('keeps the addresses of a cut note, as pages', async () => {
    const note =
      'No frame mass is published. ' +
      'The datasheet gives tube sizes only. '.repeat(30) +
      `Datasheet: ${LINK} — spare parts: https://maker.example/parts.pdf (page 14); also ${DEAD}.`
    chat.rounds = [
      {
        before: [{ type: 'citations', citations: [{ url: 'https://maker.example/sheet.pdf', via: [LINK] }] }],
        text: JSON.stringify([{ component: 'frame', material: 'steel tube', mass_kg: null, note }])
      },
      // The follow-up pass finds nothing either.
      { text: '[]' }
    ]
    const r = await researchBom({ product: 'wheelbarrow', components: ['frame'], totalMassKg: 20.7 })
    expect(chat.seen).toHaveLength(2)
    expect(r.items).toEqual([])
    expect(r.unresolved).toHaveLength(1)
    expect(r.unresolved[0].see_also).toEqual([
      'https://maker.example/sheet.pdf',
      'https://maker.example/parts.pdf'
    ])
    expect(r.unresolved[0].note).toMatch(/not shown; the links it names are in see_also\]$/)
    expect(r.follow_up).toEqual({ asked: 1, resolved: 0 })
  })

  it('drops see_also, and the note’s pointer to it, when every address leads nowhere', async () => {
    chat.rounds = [
      { text: JSON.stringify([{ component: 'frame', mass_kg: null, note: `Only seen at ${DEAD}.` }]) },
      { text: '[]' },
      {
        text: JSON.stringify([
          {
            component: 'rim',
            mass_kg: null,
            note: `${'No figure for the rim. '.repeat(45)}Only seen at ${DEAD}`
          }
        ])
      },
      { text: '[]' }
    ]
    const r = await researchBom({ product: 'wheelbarrow', components: ['frame'] })
    expect(r.unresolved[0]).toEqual({ component: 'frame', reason: 'no_mass', note: `Only seen at ${DEAD}.` })
    const cut = await researchBom({ product: 'wheelbarrow', components: ['rim'] })
    expect(cut.unresolved[0].see_also).toBeUndefined()
    expect(cut.unresolved[0].note).toMatch(
      /for the rim\. … \[note cut here: \d+ more characters not shown\]$/
    )
  })
})
