import { describe, expect, it } from 'vitest'
import { REGION_NOTE, reviewDecision } from './ImportWizard'

/**
 * A region pick is not a material pick: the reason the material was matched —
 * the model's or the rules' — has to survive the step every multi-region process forces on the
 * reviewer, because it ends up in the exchange comment and the dataset's metadata.
 */
const steel = {
  confidence: 'medium' as const,
  evidence: 'same product and technology: electric arc furnace route; converter steel excluded',
  target: { database: 'ei', code: 'steel-GLO' }
}

describe('what a review decision records', () => {
  it('keeps the band and the reason when only the region is picked', () => {
    const d = reviewDecision(steel as never, { database: 'ei', code: 'steel-CH', regionChosen: true })
    expect(d.confidence).toBe('medium')
    expect(d.evidence).toBe(`${steel.evidence} · ${REGION_NOTE}`)
  })

  it('does not stack the region note when the region is picked again', () => {
    const once = reviewDecision(steel as never, { database: 'ei', code: 'steel-CH', regionChosen: true })
    const twice = reviewDecision({ ...steel, evidence: once.evidence } as never, {
      database: 'ei',
      code: 'steel-RER',
      regionChosen: true
    })
    expect(twice.evidence).toBe(once.evidence)
  })

  it('carries a stated density along when the region changes', () => {
    // Without it the backend recomputed the conversion from a decision that had none, and the factor
    // fell back to 1: a 1 000-fold wrong amount, committable once the region was picked.
    const water = {
      confidence: 'low' as const,
      evidence: 'same substance',
      target: { database: 'ei', code: 'water-GLO' },
      factor: 0.001,
      scale: 'kg → cubic meter via liquid water, 1 kg/L (0.001 cubic meter/kg)'
    }
    const d = reviewDecision(water as never, { database: 'ei', code: 'water-CH', regionChosen: true })
    expect(d.assumption).toEqual({ quantity: 0.001, what: 'liquid water, 1 kg/L' })
  })

  it('records a material pick as the reviewer’s own', () => {
    expect(reviewDecision(steel as never, { database: 'ei', code: 'other' })).toEqual({
      confidence: 'medium',
      evidence: 'chosen in review'
    })
  })

  it('records a cleared match as cleared', () => {
    expect(reviewDecision(steel as never, null)).toEqual({
      confidence: 'open',
      evidence: 'cleared by the reviewer'
    })
  })
})
