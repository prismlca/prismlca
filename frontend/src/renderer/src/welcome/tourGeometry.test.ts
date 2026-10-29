import { describe, expect, it } from 'vitest'
import { computeArrow, spotFor } from './tourGeometry'

/**
 * The callout's geometry. On a fresh install the second card's anchor — the start screen's import
 * tiles — lies in the middle of the window, under the card: the ring was drawn behind the card, there
 * was no arrow, and the note sat on the card's text. The other half of each case is the control: an
 * anchor beside the card keeps its ring, arrow and note.
 */
const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect

const VIEW_W = 1600
// The card as the CSS places it in a 1600 × 900 window: 820 × 620, centred.
const CARD = rect(390, 140, 820, 620)

describe('tour callout geometry', () => {
  it('drops an anchor that lies under the card — the gate tiles on a fresh install', () => {
    expect(spotFor(rect(560, 380, 480, 140), CARD)).toBeNull()
  })

  it('drops an anchor the card covers only in part', () => {
    expect(spotFor(rect(300, 400, 120, 40), CARD)).toBeNull()
  })

  it('drops a collapsed anchor', () => {
    expect(spotFor(rect(20, 20, 0, 300), CARD)).toBeNull()
  })

  it('rings an anchor beside the card, with an arrow and the note under it', () => {
    const spot = spotFor(rect(10, 120, 220, 600), CARD) // the rail, left of the card
    expect(spot).not.toBeNull()
    const arrow = computeArrow(CARD, spot!, VIEW_W)
    expect(arrow.path).not.toBeNull()
    expect(arrow.note).not.toBeNull()
  })

  it('keeps the note under a toolbar button when there is room above the card', () => {
    const spot = spotFor(rect(700, 30, 110, 30), CARD)!
    expect(computeArrow(CARD, spot, VIEW_W).note).toEqual({ x: 692, y: 84 })
  })

  it('leaves the note out where it would land on the card, and keeps the ring', () => {
    // A small window: the card reaches up to just under the toolbar.
    const card = rect(32, 80, 820, 620)
    const spot = spotFor(rect(300, 40, 110, 30), card)
    expect(spot).not.toBeNull()
    expect(computeArrow(card, spot!, 884).note).toBeNull()
  })
})
