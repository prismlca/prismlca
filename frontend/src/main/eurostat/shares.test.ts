import { describe, expect, it } from 'vitest'
import type { ValueRow } from './service'
import { sharesOf } from './shares'

const rows = (geo: string, unit: string, values: Record<string, number>): ValueRow[] =>
  Object.entries(values).map(([op, v]) => [geo, op, unit, v, ''])

const topSum = (shares: Record<string, number>, codes: string[]): number =>
  codes.reduce((s, c) => s + (shares[c] ?? 0), 0)

// Real answers (Eurostat, 2022), so the nesting the note claims is the nesting the data has.
const WASMUN_DE = rows('DE', 'THS_T', {
  GEN: 50606,
  TRT: 50606,
  DSP_I_RCV_E: 15226,
  DSP_L_OTH: 414,
  DSP_I: 565,
  RCV_E: 14661,
  RCY: 35244,
  RCY_M: 23788,
  RCY_C_D: 11177,
  PRP_REU: 278
})
const WASPAC_DE_PLASTIC = rows('DE', 'T', {
  GEN: 3309130,
  RCV: 3280874,
  RCV_E_PAC: 1599914,
  RCV_OTH: 16600,
  RCY: 1664360,
  RCY_NAT: 1489811,
  RCY_EU_FOR: 153337,
  RCY_NEU: 21212,
  FMKT: 3309100,
  FMKT_S: 2087100
})

describe('Eurostat shares per table', () => {
  it('env_wasmun: thermal and recycling totals hold their parts, GEN is no share', () => {
    const { shares, shares_note } = sharesOf('env_wasmun', [
      ...WASMUN_DE,
      ...rows('DE', 'KG_HAB', { GEN: 608, TRT: 608 })
    ])
    const de = shares!.DE
    expect(de.GEN).toBeUndefined()
    expect(de.TRT).toBeUndefined()
    // From the thousand-tonnes rows, which carry more digits than kg per capita.
    expect(de.DSP_L_OTH).toBeCloseTo(414 / 50606, 4)
    expect(topSum(de, ['DSP_I_RCV_E', 'DSP_L_OTH', 'RCY'])).toBeCloseTo(1, 1)
    expect(shares_note).toContain('from the thousand tonnes rows')
    expect(shares_note).toContain('DSP_I_RCV_E contains DSP_I and RCV_E')
    expect(shares_note).toContain('RCY contains RCY_M, RCY_C_D and PRP_REU')
    expect(shares_note).toContain('DSP_I_RCV_E, DSP_L_OTH and RCY sum to 1')
    expect(shares_note).toContain('GEN is the waste generated')
    // The env_wastrt codes are not in this table and are not claimed for it.
    expect(shares_note).not.toContain('RCV_R_B')
    expect(shares_note).not.toMatch(/do not add up/)
  })

  it('env_waspac: shares of GEN with the unrecovered rest as its own key, summing to 1', () => {
    const { shares, shares_note } = sharesOf('env_waspac', [
      ...WASPAC_DE_PLASTIC,
      ...rows('DE', 'PC', { GEN: 100, RCV: 99.1 })
    ])
    const de = shares!.DE
    expect(de.GEN).toBeUndefined()
    expect(de.FMKT).toBeUndefined()
    expect(de.FMKT_S).toBeUndefined()
    expect(de.not_recovered).toBeCloseTo(1 - (1599914 + 16600 + 1664360) / 3309130, 4)
    expect(topSum(de, ['RCY', 'RCV_E_PAC', 'RCV_OTH', 'not_recovered'])).toBeCloseTo(1, 3)
    expect(de.RCV).toBeCloseTo(3280874 / 3309130, 4)
    expect(shares_note).toContain('Share of packaging waste generated (GEN)')
    expect(shares_note).toContain('RCV contains RCV_E_PAC, RCV_OTH and RCY')
    expect(shares_note).toContain('RCY contains RCY_NAT, RCY_EU_FOR and RCY_NEU')
    expect(shares_note).toContain('RCY, RCV_E_PAC, RCV_OTH and not_recovered sum to 1')
    expect(shares_note).toContain('keep both apart from energy recovery')
  })

  it('env_waspac: more recovered than generated gives no negative share, and is named', () => {
    // Cyprus metal packaging, 2022 (proportions): RCV above GEN.
    const { shares, shares_note } = sharesOf(
      'env_waspac',
      rows('CY', 'T', { GEN: 1000, RCV: 1374, RCV_E_PAC: 0, RCV_OTH: 0, RCY: 1374 })
    )
    expect(shares!.CY.not_recovered).toBeUndefined()
    expect(shares_note).toMatch(/Here they do not: CY 1\.374 — the reported operations do not add up/)
  })

  it('env_waspac: no remainder where an operation of the top level is not reported', () => {
    const { shares, shares_note } = sharesOf('env_waspac', rows('LU', 'T', { GEN: 1000, RCV: 600, RCY: 600 }))
    expect(shares!.LU.not_recovered).toBeUndefined()
    expect(shares_note).toMatch(/Here they do not: LU 0\.6 — /)
  })

  it('env_wastrt and env_wasoper: each its own nesting, both with the thermal reading', () => {
    const trt = sharesOf(
      'env_wastrt',
      rows('DE', 'T', {
        TRT: 2837096,
        DSP_L_OTH: 2151,
        DSP_L: 2151,
        DSP_I: 5367,
        DSP_OTH: 0,
        RCV_E: 548925,
        RCV_R_B: 2280653,
        RCV_R: 2280653,
        RCV_B: 0
      })
    )
    expect(topSum(trt.shares!.DE, ['RCV_R_B', 'RCV_E', 'DSP_L_OTH', 'DSP_I'])).toBeCloseTo(1, 3)
    expect(trt.shares_note).toContain(
      'RCV_R_B contains RCV_R and RCV_B; DSP_L_OTH contains DSP_L and DSP_OTH'
    )
    expect(trt.shares_note).toMatch(/RCV_E \(R1, energy recovery\) \+ DSP_I \(D10\)/)

    // France 2020: six operations, no grouping, the top level is TRT exactly.
    const oper = sharesOf(
      'env_wasoper',
      rows('FR', 'T', {
        TRT: 87140919,
        DSP_L: 19250704,
        DSP_I: 3932598,
        DSP_OTH: 519362,
        RCV_E: 22230917,
        RCV_R: 41207338,
        RCV_B: 0
      })
    )
    expect(topSum(oper.shares!.FR, ['DSP_L', 'DSP_I', 'DSP_OTH', 'RCV_E', 'RCV_R', 'RCV_B'])).toBeCloseTo(
      1,
      4
    )
    expect(oper.shares_note).not.toContain('contains')
    expect(oper.shares_note).toContain('DSP_L, DSP_I, DSP_OTH, RCV_E, RCV_R and RCV_B sum to 1')
  })

  it('names the countries whose top level falls short, and counts past eight', () => {
    const many = ['BG', 'IS', 'NO', 'AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG'].flatMap((geo) =>
      rows(geo, 'THS_T', { TRT: 100, DSP_I_RCV_E: 40, DSP_L_OTH: 10, RCY: 30 })
    )
    const { shares_note } = sharesOf('env_wasmun', [...WASMUN_DE, ...many])
    expect(shares_note).toMatch(/Here they do not: BG 0\.8, IS 0\.8, .*, and 2 more — /)
    expect(shares_note).not.toMatch(/DE \d/)
  })

  it('gives nothing without a total to divide by', () => {
    expect(sharesOf('env_wasmun', rows('DE', 'THS_T', { RCY: 1, DSP_L_OTH: 2 }))).toEqual({})
    expect(sharesOf('env_waspac', rows('DE', 'PC', { GEN: 100, RCY: 50 }))).toEqual({})
  })
})
