/**
 * The Eurostat service against a faked API: JSON-stat decoding, the year fallback, the flags the
 * user must be warned about, confidential cells that stay unknown, the all-countries answer, the
 * code lists on an unknown code, and the cache that makes the second question free.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeJsonStat, resetEurostatCache, type JsonStat } from './client'
import { flagsOf, normaliseQuery, queryEurostatEol } from './service'

/** A tiny Eurostat: three countries, two units, three operations, even years only. */
const GEOS: Record<string, string> = { DE: 'Germany', FR: 'France', EL: 'Greece' }
const OPS: Record<string, string> = {
  TRT: 'Waste treatment',
  DSP_L: 'Disposal - landfill',
  RCV_R: 'Recovery - recycling'
}
const UNITS: Record<string, string> = { T: 'Tonne', PC: 'Percentage' }
const YEARS = ['2018', '2020', '2022']
const WASTES: Record<string, string> = { TOTAL: 'Total waste', W074: 'Plastic wastes' }

interface FakeOpts {
  /** status per (geo, op, unit, year) key, e.g. 'DE|RCV_R|PC|2022' → 'ep' */
  status?: Record<string, string>
  /** cells that carry no number, same key → status ('c' confidential, 'm' missing) */
  blank?: Record<string, string>
  /** countries without any data in a year */
  silent?: Array<[string, string]>
}

function cube(url: URL, o: FakeOpts): JsonStat {
  const dataset = url.pathname.split('/').pop() as string
  const p = url.searchParams
  const pick = (all: Record<string, string>, code: string | null): string[] =>
    code === null ? Object.keys(all) : code in all ? [code] : []
  const geos = pick(GEOS, p.get('geo'))
  let times = p.get('time')
    ? YEARS.includes(p.get('time') as string)
      ? [p.get('time') as string]
      : []
    : YEARS
  const last = p.get('lastTimePeriod')
  if (last) times = YEARS.slice(-Number(last))
  const hasWaste = dataset === 'env_wastrt'
  const wastes = hasWaste ? pick(WASTES, p.get('waste')) : ['']
  const ids = hasWaste
    ? ['freq', 'unit', 'hazard', 'wst_oper', 'waste', 'geo', 'time']
    : ['freq', 'wst_oper', 'unit', 'geo', 'time']
  const dims: Record<string, [string[], Record<string, string>]> = {
    freq: [['A'], { A: 'Annual' }],
    unit: [Object.keys(UNITS), UNITS],
    hazard: [['HAZ_NHAZ'], { HAZ_NHAZ: 'Hazardous and non-hazardous - total' }],
    wst_oper: [Object.keys(OPS), OPS],
    waste: [wastes, WASTES],
    geo: [geos, GEOS],
    time: [times, Object.fromEntries(times.map((t) => [t, t]))]
  }
  const size = ids.map((d) => dims[d][0].length)
  const value: Record<string, number> = {}
  const status: Record<string, string> = {}
  const total = size.reduce((a, b) => a * b, 1)
  for (let n = 0; n < total; n++) {
    let rest = n
    const cell: Record<string, string> = {}
    for (let k = ids.length - 1; k >= 0; k--) {
      cell[ids[k]] = dims[ids[k]][0][rest % size[k]]
      rest = Math.floor(rest / size[k])
    }
    const key = `${cell.geo}|${cell.wst_oper}|${cell.unit}|${cell.time}`
    if (o.silent?.some(([g, t]) => g === cell.geo && t === cell.time)) continue
    if (o.blank?.[key]) {
      status[String(n)] = o.blank[key]
      continue
    }
    value[String(n)] =
      cell.unit === 'PC' ? (cell.wst_oper === 'TRT' ? 100 : 40) : 1000 * (Number(cell.time) - 2000)
    if (o.status?.[key]) status[String(n)] = o.status[key]
  }
  return {
    version: '2.0',
    class: 'dataset',
    label: `Fake ${dataset}`,
    updated: '2026-01-01T00:00:00+0100',
    id: ids,
    size,
    value,
    status,
    dimension: Object.fromEntries(
      ids.map((d) => [
        d,
        {
          label: d,
          category: {
            index: Object.fromEntries(dims[d][0].map((c, i) => [c, i])),
            label: Object.fromEntries(dims[d][0].map((c) => [c, dims[d][1][c] ?? c]))
          }
        }
      ])
    ),
    extension: { status: { label: { ep: 'estimated, provisional', c: 'confidential' } } }
  }
}

function fakeFetch(o: FakeOpts = {}): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input))
    return new Response(JSON.stringify(cube(url, o)), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  })
}

const ask = (args: unknown, fetchImpl: ReturnType<typeof vi.fn>) =>
  queryEurostatEol(args, { client: { fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch } } })

beforeEach(() => resetEurostatCache())

describe('JSON-stat decoding', () => {
  it('maps the row-major index back to codes, last dimension fastest', () => {
    const d = decodeJsonStat({
      id: ['a', 'b'],
      size: [2, 3],
      value: { '0': 1, '5': 6 },
      status: { '5': 'p' },
      dimension: {
        a: { category: { index: { a1: 0, a2: 1 } } },
        b: { category: { index: { b1: 0, b2: 1, b3: 2 } } }
      }
    })
    expect(d.rows).toHaveLength(6)
    expect(d.rows[0]).toEqual({ codes: { a: 'a1', b: 'b1' }, value: 1, status: null })
    expect(d.rows[5]).toEqual({ codes: { a: 'a2', b: 'b3' }, value: 6, status: 'p' })
    expect(d.rows[1].value).toBeNull()
  })
})

describe('the request', () => {
  it('normalises codes and refuses what it cannot ask for', () => {
    expect(
      normaliseQuery({ dataset: 'env_wasoper', country: ' gr ', year: '2022', waste_code: 'w074' })
    ).toEqual({
      dataset: 'env_wasoper',
      country: 'EL',
      year: 2022,
      waste_code: 'W074'
    })
    expect(normaliseQuery({ dataset: 'env_wasmun' }).country).toBeUndefined()
    expect(() => normaliseQuery({ dataset: 'env_nope' })).toThrow(/Unknown dataset/)
    expect(() => normaliseQuery({ dataset: 'env_wasmun', year: 'latest' })).toThrow(/four-digit/)
  })

  it('splits Eurostat status strings into flags', () => {
    expect(flagsOf(null)).toEqual([])
    expect(flagsOf('ep')).toEqual(['e', 'p'])
    expect(flagsOf('|C')).toEqual(['c'])
  })
})

describe('one country', () => {
  it('answers a table with units, lookups and no warning when every value is final', async () => {
    const f = fakeFetch()
    const r = await ask({ dataset: 'env_wasoper', country: 'DE', year: 2022 }, f)
    expect(f).toHaveBeenCalledTimes(1)
    expect(String(f.mock.calls[0][0])).toContain('geo=DE')
    expect(String(f.mock.calls[0][0])).toContain('time=2022')
    expect(r.scope).toBe('DE')
    expect(r.year).toBe(2022)
    expect(r.values.columns).toEqual(['country', 'operation', 'unit', 'value', 'flags'])
    expect(r.values.count).toBe(6)
    expect(r.values.rows).toContainEqual(['DE', 'RCV_R', 'PC', 40, ''])
    expect(r.lookups.units.PC).toMatch(/total waste treatment/)
    expect(r.lookups.operations.RCV_R).toBe('Recovery - recycling')
    expect(r.lookups.countries.DE).toBe('Germany')
    expect(r.flags_and_status.warning).toBeNull()
    expect(r.dataset_metadata.attribution).toMatch(/Eurostat/)
    expect(r.dataset_metadata.description).toMatch(/exports minus imports/)
    expect(r.lca_note).toMatch(/sorting/i)
  })

  it("derives each operation's share of total treatment from the tonnes rows (V415)", async () => {
    const r = await ask({ dataset: 'env_wasoper', country: 'DE', year: 2022 }, fakeFetch())
    const tonnes = Object.fromEntries(r.values.rows.filter((v) => v[2] === 'T').map((v) => [v[1], v[3]]))
    expect(r.shares?.DE.RCV_R).toBeCloseTo(tonnes.RCV_R / tonnes.TRT, 4)
    expect(r.shares?.DE.TRT).toBeUndefined()
    expect(r.shares_note).toMatch(/RCV_E \(R1, energy recovery\) \+ DSP_I \(D10\)/)
  })

  it('warns about provisional/estimated values and spells the flag out', async () => {
    const f = fakeFetch({ status: { 'DE|RCV_R|PC|2022': 'ep', 'DE|DSP_L|T|2022': 'b' } })
    const r = await ask({ dataset: 'env_wasoper', country: 'DE', year: 2022 }, f)
    expect(r.flags_and_status.flagged_values).toBe(2)
    expect(r.flags_and_status.warning).toMatch(/NOT final/)
    expect(r.flags_and_status.warning).toMatch(/"p" \(provisional\)/)
    expect(r.flags_and_status.warning).toMatch(/"e" \(estimated\)/)
    expect(r.flags_and_status.warning).toMatch(/break in time series/)
    expect(r.values.rows).toContainEqual(['DE', 'RCV_R', 'PC', 40, 'ep'])
    expect(r.lookups.flags.ep).toBe('estimated, provisional')
    expect(r.lookups.flags['']).toMatch(/final/)
  })

  it('lists a confidential cell under not_available instead of a number', async () => {
    const f = fakeFetch({ blank: { 'DE|RCV_R|T|2022': 'c' } })
    const r = await ask({ dataset: 'env_wasoper', country: 'DE', year: 2022 }, f)
    expect(r.values.count).toBe(5)
    expect(r.not_available).toEqual({
      count: 1,
      sample: [{ country: 'DE', operation: 'RCV_R', unit: 'T', reason: 'confidential' }]
    })
    expect(r.flags_and_status.warning).toBeNull()
  })

  it('falls back to the latest year with data when the asked year has none, and says so', async () => {
    const f = fakeFetch()
    const r = await ask({ dataset: 'env_wasoper', country: 'DE', year: 2023 }, f)
    expect(f).toHaveBeenCalledTimes(2)
    expect(String(f.mock.calls[1][0])).toContain('lastTimePeriod=3')
    expect(r.year).toBe(2022)
    expect(r.year_note).toMatch(/No data for 2023/)
    expect(r.year_note).toMatch(/even years/)
    expect(r.other_years_in_answer).toEqual([2020, 2018])
  })

  it('takes the latest year when none is given', async () => {
    const r = await ask({ dataset: 'env_wasoper', country: 'FR' }, fakeFetch())
    expect(r.year).toBe(2022)
    expect(r.year_note).toBeUndefined()
  })

  it('prefers a complete year over a published stub, and says so', async () => {
    // env_wasoper DE 2022 came with 5 cells where 2020 had 21: a "latest year" with no
    // landfill, incineration or recycling row is not an answer.
    const blank: Record<string, string> = {}
    for (const op of ['DSP_L', 'RCV_R']) for (const unit of ['T', 'PC']) blank[`DE|${op}|${unit}|2022`] = 'm'
    blank['DE|TRT|T|2022'] = 'm'
    const r = await ask({ dataset: 'env_wasoper', country: 'DE' }, fakeFetch({ blank }))
    expect(r.year).toBe(2020)
    expect(r.notes.join(' ')).toMatch(/2022 is published but thin .* 2020 is shown instead/)
    // Asked for explicitly, the stub is shown as it is.
    const asked = await ask({ dataset: 'env_wasoper', country: 'DE', year: 2022 }, fakeFetch({ blank }))
    expect(asked.year).toBe(2022)
  })

  it('maps GR to Eurostat’s EL and notes it', async () => {
    const f = fakeFetch()
    const r = await ask({ dataset: 'env_wasoper', country: 'GR' }, f)
    expect(String(f.mock.calls[0][0])).toContain('geo=EL')
    expect(r.scope).toBe('EL')
    expect(r.notes.join(' ')).toMatch(/codes GR as EL/)
  })

  it('names the known countries on an unknown one', async () => {
    const f = fakeFetch()
    await expect(ask({ dataset: 'env_wasoper', country: 'XX' }, f)).rejects.toThrow(/DE, FR, EL/)
  })

  it('ignores waste_code on a table without a waste dimension, and says so', async () => {
    const f = fakeFetch()
    const r = await ask({ dataset: 'env_wasoper', country: 'DE', waste_code: 'W074' }, f)
    expect(String(f.mock.calls[0][0])).not.toContain('waste=')
    expect(r.waste_code).toBeUndefined()
    expect(r.notes.join(' ')).toMatch(/no breakdown by waste category/)
  })
})

describe('by waste category', () => {
  it('filters env_wastrt by the code and the hazard total', async () => {
    const f = fakeFetch()
    const r = await ask({ dataset: 'env_wastrt', country: 'DE', waste_code: 'w074', year: 2022 }, f)
    const url = String(f.mock.calls[0][0])
    expect(url).toContain('waste=W074')
    expect(url).toContain('hazard=HAZ_NHAZ')
    expect(r.waste_code).toBe('W074')
    expect(r.waste_label).toBe('Plastic wastes')
    expect(r.dataset_metadata.waste_scheme).toMatch(/EWC-Stat/)
  })

  it('defaults to TOTAL and lists the known codes on an unknown one', async () => {
    const f = fakeFetch()
    const r = await ask({ dataset: 'env_wastrt', country: 'DE' }, f)
    expect(String(f.mock.calls[0][0])).toContain('waste=TOTAL')
    expect(r.waste_code).toBe('TOTAL')
    await expect(ask({ dataset: 'env_wastrt', country: 'DE', waste_code: 'W999' }, f)).rejects.toThrow(
      /W074 = Plastic wastes/
    )
  })
})

describe('all countries', () => {
  it('lists every reporting country when none is given, and names the silent ones', async () => {
    const f = fakeFetch({ silent: [['EL', '2022']] })
    const r = await ask({ dataset: 'env_wasoper' }, f)
    expect(String(f.mock.calls[0][0])).not.toContain('geo=')
    expect(r.scope).toBe('all reporting countries (2)')
    expect(r.year).toBe(2022)
    expect(Object.keys(r.lookups.countries).sort()).toEqual(['DE', 'FR'])
    expect(r.values.count).toBe(12)
    expect(r.notes.join(' ')).toMatch(/No country given/)
    expect(r.notes.join(' ')).toMatch(/No values for 2022: EL/)
  })
})

describe('the cache', () => {
  it('answers the same slice from memory for a day and re-fetches after', async () => {
    const f = fakeFetch()
    let t = 1_000_000
    const opts = { client: { fetchOpts: { fetchImpl: f as unknown as typeof fetch }, now: () => t } }
    await queryEurostatEol({ dataset: 'env_wasmun', country: 'DE', year: 2022 }, opts)
    await queryEurostatEol({ dataset: 'env_wasmun', country: 'DE', year: 2022 }, opts)
    expect(f).toHaveBeenCalledTimes(1)
    await queryEurostatEol({ dataset: 'env_wasmun', country: 'FR', year: 2022 }, opts)
    expect(f).toHaveBeenCalledTimes(2)
    t += 25 * 60 * 60 * 1000
    await queryEurostatEol({ dataset: 'env_wasmun', country: 'DE', year: 2022 }, opts)
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('does not remember a failure', async () => {
    let fail = true
    const f = vi.fn(async (input: string | URL) => {
      if (fail) return new Response('{"error":[{"status":500,"label":"boom"}]}', { status: 500 })
      return new Response(JSON.stringify(cube(new URL(String(input)), {})), { status: 200 })
    })
    const opts = { client: { fetchOpts: { fetchImpl: f as unknown as typeof fetch } } }
    await expect(
      queryEurostatEol({ dataset: 'env_wasmun', country: 'DE', year: 2022 }, opts)
    ).rejects.toThrow(/boom/)
    fail = false
    const r = await queryEurostatEol({ dataset: 'env_wasmun', country: 'DE', year: 2022 }, opts)
    expect(r.year).toBe(2022)
  })
})
