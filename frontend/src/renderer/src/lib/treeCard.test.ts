import { describe, expect, it } from 'vitest'
import { CARD, contentW, ellipsise, fitLines, metaText, shareWidths, trackW, zonePath } from './treeCard'

/**
 * The numbers behind the contribution card. SVG has no box model, so every one of them is arithmetic
 * somebody can get wrong — and wrong here means a dataset name running under the chevron, or a bar
 * claiming a share the model does not have.
 *
 * `measure` is a stand-in for the canvas text metrics the app uses: six units per character. Exact
 * widths are the browser's business; what is tested is the fitting, not the font.
 */
const measure = (s: string): number => s.length * 6

describe('fitting a dataset name onto the card', () => {
  it('keeps a short name on one line', () => {
    expect(fitLines('Flat glass, coated', measure, [180, 180])).toEqual(['Flat glass, coated'])
  })

  it('breaks on words and uses the second line', () => {
    const lines = fitLines('market for transport, freight, lorry 16-32 metric ton', measure, [60, 60])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('market for')
    expect(lines[1].endsWith('…')).toBe(true)
    for (const l of lines) expect(measure(l)).toBeLessThanOrEqual(60)
  })

  it('never draws wider than the budget, not even for a word that has no spaces', () => {
    // Chemistry writes names like this, and refusing to break it would print past the card edge.
    const lines = fitLines('Polytetrafluoroethylenehexafluoropropylene', measure, [48, 48])
    expect(lines).toHaveLength(2)
    for (const l of lines) expect(measure(l)).toBeLessThanOrEqual(48)
  })

  it('survives an empty name rather than producing an empty tree', () => {
    expect(fitLines('', measure, [100, 100])).toEqual([''])
  })

  it('ellipsises without leaving a dangling separator', () => {
    // The rule, not a hand-counted string: no comma or space may sit against the ellipsis, and the
    // result has to fit the budget it was given.
    const out = ellipsise('Manufacturing, other, and repair of things', measure, 60)
    expect(out.endsWith('…')).toBe(true)
    expect(out).not.toMatch(/[\s,;·-]…$/)
    expect(measure(out)).toBeLessThanOrEqual(60)
  })
})

describe('the meta line', () => {
  it('says a model process is one, instead of showing a gap where a section would be', () => {
    expect(metaText({ own: true, geo: 'DE' }, measure, 180)).toBe('Model process · DE')
  })

  it('keeps the section letter and the geography, and gives up the gloss when it has to', () => {
    const line = metaText(
      { own: false, isic: 'C', isicName: 'Manufacture of chemicals and chemical products', geo: 'RER' },
      measure,
      120
    )
    expect(line.startsWith('C · ')).toBe(true)
    expect(line.endsWith(' · RER')).toBe(true)
    expect(measure(line)).toBeLessThanOrEqual(120)
  })

  it('names an unclassified background dataset rather than printing a dash', () => {
    expect(metaText({ own: false, geo: 'GLO' }, measure, 180)).toBe('Background dataset · GLO')
  })
})

describe('the two segments of the share bar', () => {
  it('measures both against the whole system, never against the parent', () => {
    const { fill, direct } = shareWidths({ impact: 21.8, direct: 0.98, total: 62.4 })
    expect(fill / trackW()).toBeCloseTo(0.349, 3)
    expect(direct / trackW()).toBeCloseTo(0.0157, 3)
  })

  it('keeps the solid head inside the pale fill', () => {
    // A rounding artefact or a direct value larger than the branch's own must not overdraw it.
    const { fill, direct } = shareWidths({ impact: 1, direct: 5, total: 10 })
    expect(direct).toBeLessThanOrEqual(fill)
  })

  it('draws a credit as a length, not as nothing and not backwards', () => {
    const { fill, direct } = shareWidths({ impact: -6.24, direct: -6.24, total: 62.4 })
    expect(fill).toBeGreaterThan(0)
    expect(direct).toBeGreaterThan(0)
    expect(fill / trackW()).toBeCloseTo(0.1, 3)
  })

  it('answers zero for a system whose total is zero rather than NaN', () => {
    expect(shareWidths({ impact: 3, direct: 1, total: 0 })).toEqual({ fill: 0, direct: 0 })
  })
})

describe('the card geometry', () => {
  it('leaves the content clear of the chevron zone', () => {
    expect(CARD.PAD + contentW(false) + CARD.RIGHT).toBe(CARD.W)
    expect(contentW(true)).toBeLessThan(contentW(false)) // the ⓘ takes its share of line one
    expect(CARD.INFO_X + CARD.INFO_R).toBeLessThanOrEqual(CARD.W - CARD.ZONE_W)
  })

  it('keeps every drawn row inside the card', () => {
    const bottom = CARD.H / 2
    expect(CARD.BAR_Y + CARD.BAR_TH).toBeLessThan(bottom)
    expect(CARD.SHARE_Y).toBeLessThan(CARD.BAR_Y)
    expect(CARD.TITLE1_Y).toBeGreaterThan(-CARD.H / 2 + CARD.BAR_H)
  })

  it('starts the zone under the colour bar, so the bar stays one unbroken line', () => {
    expect(zonePath()).toContain(`M${CARD.W - CARD.ZONE_W},${-CARD.H / 2 + CARD.BAR_H}`)
  })

  it('runs the zone flush to the card edge at the top, where the colour bar owns the corner', () => {
    // A rounded top-right corner here leaves a white notch between the zone and the bar above it.
    expect(zonePath()).toContain(`H${CARD.W} V`)
    expect(zonePath().indexOf('a')).toBeGreaterThan(zonePath().indexOf('V')) // the only arc is the bottom one
    expect(zonePath().match(/a/g) ?? []).toHaveLength(1)
  })
})
