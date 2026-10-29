import { describe, expect, it } from 'vitest'
import { heatColor as appHeat } from './heat'
import {
  figureInk,
  fromOklch,
  heatColor,
  mix,
  onColor,
  PRISM_PALETTE,
  seriesColors,
  toOklch
} from './reportColors'

/** Perceptual colour maths for report figures. Pure, and every incident below is in a code comment. */

const hexOf = (s: string): string => s.trim().toLowerCase()

describe('toOklch / fromOklch', () => {
  it('round-trips the palette without drifting', () => {
    for (const hex of [PRISM_PALETTE.accent, PRISM_PALETTE.deep, PRISM_PALETTE.paper]) {
      const { l, c, h } = toOklch(hex)
      expect(hexOf(fromOklch(l, c, h))).toBe(hexOf(hex))
    }
  })

  it('places black, white and grey where they belong', () => {
    expect(toOklch('#000000').l).toBeCloseTo(0, 3)
    expect(toOklch('#ffffff').l).toBeCloseTo(1, 3)
    expect(toOklch('#808080').c).toBeLessThan(0.01) // grey has no chroma to speak of
  })

  it('clips back into sRGB rather than emitting a broken hex', () => {
    // Asking for a chroma sRGB cannot reach must still produce six valid digits.
    expect(fromOklch(0.7, 0.9, 140)).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('mix', () => {
  it('returns the coloured end exactly, and the near-grey end within a rounding step', () => {
    // t=1 is exact. t=0 is NOT, and cannot be: the near-grey guard rotates the paper onto the
    // accent's hue, so the endpoint comes back as the paper's lightness and chroma at a different
    // hue — #f8f9fa → #f9f9f8, one unit per channel. That is the price of the guard, and it is the
    // right trade: without it the ramp travelled through blue. Pinned so the difference stays a
    // rounding step and never grows into something visible.
    expect(hexOf(mix(PRISM_PALETTE.paper, PRISM_PALETTE.accent, 1))).toBe(hexOf(PRISM_PALETTE.accent))

    const channels = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    const got = channels(mix(PRISM_PALETTE.paper, PRISM_PALETTE.accent, 0))
    const want = channels(PRISM_PALETTE.paper)
    got.forEach((v, i) => expect(Math.abs(v - want[i])).toBeLessThanOrEqual(2))
  })

  it('is exact at both ends when neither of them is grey', () => {
    expect(hexOf(mix(PRISM_PALETTE.accent, PRISM_PALETTE.deep, 0))).toBe(hexOf(PRISM_PALETTE.accent))
    expect(hexOf(mix(PRISM_PALETTE.accent, PRISM_PALETTE.deep, 1))).toBe(hexOf(PRISM_PALETTE.deep))
  })

  it('does not travel through a foreign hue when one end is near-grey', () => {
    // The incident, quoted from the code: a ramp from an almost-white paper towards lime green came
    // out pale BLUE, because the paper's nominal hue is ~250° and the interpolation believed it.
    const half = mix(PRISM_PALETTE.paper, PRISM_PALETTE.accent, 0.5)
    const accentHue = toOklch(PRISM_PALETTE.accent).h
    const gotHue = toOklch(half).h
    const delta = Math.abs(((gotHue - accentHue + 540) % 360) - 180)
    expect(delta).toBeLessThan(20) // holds the accent's hue; only chroma moves
  })

  it('goes the short way around the hue circle', () => {
    // 350° → 10° is a 20° step, not a 340° one; the midpoint must be near 0°, not near 180°.
    const a = fromOklch(0.6, 0.1, 350)
    const b = fromOklch(0.6, 0.1, 10)
    const h = toOklch(mix(a, b, 0.5)).h
    expect(Math.min(Math.abs(h), Math.abs(h - 360))).toBeLessThan(15)
  })
})

describe('seriesColors', () => {
  it('starts from the document’s own two, for the common two-series chart', () => {
    expect(seriesColors(2)).toEqual([PRISM_PALETTE.accent, PRISM_PALETTE.deep])
    expect(seriesColors(1)).toEqual([PRISM_PALETTE.accent])
  })

  it('returns exactly n and no visual duplicates at the lengths a study reaches', () => {
    // Eleven life-cycle phases is an ordinary chart; two identical "colours" in one legend is not.
    for (const n of [3, 8, 11, 16]) {
      const cols = seriesColors(n)
      expect(cols).toHaveLength(n)
      expect(new Set(cols.map(hexOf)).size).toBe(n)
    }
  })

  it('keeps chroma inside the printable band — a document, not a dashboard', () => {
    // Left at the accent's own chroma the derived hues came out as highlighter neon.
    for (const hex of seriesColors(12).slice(2)) {
      const { c } = toOklch(hex)
      expect(c).toBeGreaterThan(0.03) // never a grey among colours
      expect(c).toBeLessThan(0.16)
    }
  })
})

describe('onColor', () => {
  it('picks the ink that stays readable on the fill', () => {
    expect(onColor('#000000')).toBe(PRISM_PALETTE.paper)
    expect(onColor('#ffffff')).toBe(PRISM_PALETTE.deep)
  })

  it('flips at the documented lightness, not somewhere near it', () => {
    const dark = fromOklch(0.55, 0.05, 250)
    const light = fromOklch(0.7, 0.05, 250)
    expect(onColor(dark)).toBe(PRISM_PALETTE.paper)
    expect(onColor(light)).toBe(PRISM_PALETTE.deep)
  })
})

describe('heatColor (report)', () => {
  it('runs pale → accent → deep and clamps outside 0..1', () => {
    expect(hexOf(heatColor(0.5))).toBe(hexOf(PRISM_PALETTE.accent))
    expect(hexOf(heatColor(1))).toBe(hexOf(PRISM_PALETTE.deep))
    expect(hexOf(heatColor(2))).toBe(hexOf(heatColor(1)))
    expect(hexOf(heatColor(-1))).toBe(hexOf(heatColor(0)))
  })

  it('gets darker as the value rises, which is the whole signal', () => {
    const ls = [0, 0.25, 0.5, 0.75, 1].map((t) => toOklch(heatColor(t)).l)
    for (let i = 1; i < ls.length; i++) expect(ls[i]).toBeLessThan(ls[i - 1])
  })

  it('is no longer what the report draws — that is the app’s ramp now', () => {
    // This function still exists and still works; the report figure simply stopped using it on
    // 2026-08-12, when green-to-red became the one heat scale everywhere. Kept as a test so the
    // palette-derived ramp is not mistaken for dead code, and so the divergence stays visible: if
    // something starts drawing a heatmap from THIS, it will not match the Results table.
    expect(hexOf(heatColor(0.5))).not.toBe(hexOf(appHeat(0.5)))
  })
})

describe('figureInk', () => {
  it('gives a figure its ink from the document, both ways round', () => {
    // The incident: the same report exported twice, once with the APP in dark mode, produced charts
    // with different axis colours. The paper decides, not the window.
    expect(figureInk(true).ink).not.toBe(figureInk(false).ink)
    expect(toOklch(figureInk(true).ink).l).toBeGreaterThan(toOklch(figureInk(false).ink).l)
    for (const dark of [true, false]) {
      const ink = figureInk(dark)
      expect(ink.ink).toMatch(/^#[0-9a-f]{6}$/i)
      expect(ink.grid).toMatch(/^rgba\(/) // the grid is translucent so it sits on any paper
    }
  })
})
