/**
 * One entry point for the assistant's `eurostat_eol` tool: validate the request, fetch the slice,
 * pick the year, and answer in the shape the model was promised — values with units, the flags
 * spelled out, and what the dataset actually measures.
 *
 * Doctrine from the research and distances tools: nothing is silently dropped or filled in. A year
 * without data says so and shows the latest one instead; an unknown code answers with the codes the
 * table knows; a confidential or missing cell is listed as such, never as zero.
 *
 * The values are a TABLE (columns + rows + lookups), not one object per cell: without a country the
 * answer covers every reporting country, and ~35 countries × 7 operations ×
 * 3 units as objects would be 100 kB of repeated keys. Same shape for one country, so the model
 * learns one reading.
 */
import { eurostatUrl, fetchSlice, type ClientOpts, type Decoded } from './client'
import {
  browserUrl,
  CAVEAT_FLAGS,
  DATASET_INFO,
  EUROSTAT_ATTRIBUTION,
  EUROSTAT_DATASETS,
  FLAG_LEGEND,
  isEurostatDataset,
  LCA_NOTE,
  type EurostatDataset
} from './datasets'

export interface EolQuery {
  dataset: EurostatDataset
  /** Eurostat geo code; undefined = every reporting country. */
  country?: string
  year?: number
  waste_code?: string
}

export const VALUE_COLUMNS = ['country', 'operation', 'unit', 'value', 'flags'] as const
export type ValueRow = [string, string, string, number, string]

export interface EolResult {
  dataset: EurostatDataset
  dataset_title: string
  /** "DE" for one country, "all reporting countries (34)" otherwise. */
  scope: string
  year: number
  /** Set when the requested year had no data and the latest one is shown instead. */
  year_note?: string
  other_years_in_answer: number[]
  waste_code?: string
  waste_label?: string
  notes: string[]
  values: {
    columns: typeof VALUE_COLUMNS
    rows: ValueRow[]
    count: number
  }
  /** Each operation's share of total treatment per country, from the tonnes rows (V415, `sharesOf`). */
  shares?: Record<string, Record<string, number>>
  shares_note?: string
  lookups: {
    countries: Record<string, string>
    operations: Record<string, string>
    units: Record<string, string>
    /** Every flag string that occurs in `rows`, with its meaning. "" (no flag) = final value. */
    flags: Record<string, string>
  }
  /** Cells that exist in the table but carry no number (confidential, missing) — never zero. */
  not_available: {
    count: number
    sample: Array<{ country: string; operation: string; unit: string; reason: string }>
  }
  flags_and_status: {
    flagged_values: number
    total_values: number
    flags_present: Array<{ flag: string; meaning: string; values: number }>
    /** The sentence to relay to the user, or null when every value is final. */
    warning: string | null
  }
  dataset_metadata: {
    description: string
    use_for: string
    periodicity: string
    waste_scheme?: string
    last_update: string | null
    table: string
    api_query: string
    attribution: string
  }
  lca_note: string
}

/** How many periods to ask for when no year is given: the latest with data is shown, the rest named. */
const FALLBACK_PERIODS = '3'
const NOT_AVAILABLE_SAMPLE = 40

/** Eurostat's own spelling of a few countries the model is likely to write the ISO way. */
const GEO_ALIASES: Record<string, string> = { GR: 'EL', GB: 'UK', EU: 'EU27_2020', EU27: 'EU27_2020' }

export interface ServiceOpts {
  client?: ClientOpts
}

export function normaliseQuery(raw: unknown): EolQuery {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (!isEurostatDataset(a.dataset))
    throw new Error(
      `Unknown dataset "${String(a.dataset ?? '')}". Expected one of: ${EUROSTAT_DATASETS.join(' | ')}.`
    )
  const countryRaw = typeof a.country === 'string' ? a.country.trim().toUpperCase() : ''
  const country = countryRaw && countryRaw !== 'ALL' ? (GEO_ALIASES[countryRaw] ?? countryRaw) : undefined
  let year: number | undefined
  if (a.year !== undefined && a.year !== null && a.year !== '') {
    const n = Number(a.year)
    if (!Number.isInteger(n) || n < 1990 || n > 2100)
      throw new Error(`year must be a four-digit year such as 2022, not "${String(a.year)}".`)
    year = n
  }
  const wasteRaw = a.waste_code ?? a.waste_category
  const waste_code =
    typeof wasteRaw === 'string' && wasteRaw.trim() ? wasteRaw.trim().toUpperCase() : undefined
  return { dataset: a.dataset, country, year, waste_code }
}

const isYear = (s: string): boolean => /^\d{4}$/.test(s)

/** Split a Eurostat status string into its flags: "ep" → ["e","p"], "|C" → ["c"]. */
export function flagsOf(status: string | null): string[] {
  if (!status) return []
  if (status.includes('|')) return [status.replace('|', '').toLowerCase()]
  return [...status.toLowerCase()]
}

function meaningOf(status: string, statusLabels: Record<string, string>): string {
  const own = statusLabels[status]
  if (own) return own
  return flagsOf(status)
    .map((f) => FLAG_LEGEND[f] ?? `flag "${f}"`)
    .join(', ')
}

function baseFilters(q: EolQuery): Record<string, string> {
  const info = DATASET_INFO[q.dataset]
  const filters: Record<string, string> = { ...info.fixedFilters }
  if (q.country) filters.geo = q.country
  if (info.wasteDimension) filters.waste = q.waste_code ?? info.wasteDimension.total
  return filters
}

/** The codes one dimension knows, read from a one-period slice of the same table (cached like any other). */
async function knownCodes(
  dim: 'geo' | 'waste',
  q: EolQuery,
  opts: ServiceOpts
): Promise<Array<{ code: string; label: string }>> {
  const info = DATASET_INFO[q.dataset]
  const filters: Record<string, string> = { ...info.fixedFilters, lastTimePeriod: '1' }
  if (dim === 'waste' && q.country) filters.geo = q.country
  if (dim === 'geo' && info.wasteDimension) filters.waste = info.wasteDimension.total
  const d = await fetchSlice(q.dataset, filters, opts.client)
  return (d.codes[dim] ?? []).map((code) => ({ code, label: d.labels[dim]?.[code] ?? code }))
}

export async function queryEurostatEol(raw: unknown, opts: ServiceOpts = {}): Promise<EolResult> {
  const q = normaliseQuery(raw)
  const info = DATASET_INFO[q.dataset]
  const notes: string[] = []
  const given = (raw as { country?: unknown })?.country
  const countryGiven = typeof given === 'string' ? given.trim().toUpperCase() : ''
  if (q.country && countryGiven && countryGiven !== q.country)
    notes.push(`Eurostat codes ${countryGiven} as ${q.country}; that code was used.`)
  if (!q.country)
    notes.push(
      'No country given — every reporting country is listed. Pass country="DE" (or EU27_2020 for the EU aggregate) for one.'
    )
  if (q.waste_code && !info.wasteDimension) {
    notes.push(
      `${q.dataset} has no breakdown by waste category — waste_code "${q.waste_code}" was ignored. For one category use env_wastrt (EWC-Stat codes) or env_waspac (packaging materials).`
    )
    q.waste_code = undefined
  }

  const filters = baseFilters(q)
  let d: Decoded
  let yearNote: string | undefined
  let usedFilters: Record<string, string>
  if (q.year !== undefined) {
    usedFilters = { ...filters, time: String(q.year) }
    d = await fetchSlice(q.dataset, usedFilters, opts.client)
    const dimsKnown =
      (!q.country || (d.codes.geo ?? []).length > 0) &&
      (!info.wasteDimension || (d.codes.waste ?? []).length > 0)
    if (dimsKnown && (d.codes.time ?? []).length === 0) {
      // The year exists in the calendar but not in the table — show the latest that does, and say so.
      usedFilters = { ...filters, lastTimePeriod: FALLBACK_PERIODS }
      d = await fetchSlice(q.dataset, usedFilters, opts.client)
      yearNote = `No data for ${q.year} in ${q.dataset} (${info.periodicity}) — the latest available year is shown instead.`
    }
  } else {
    usedFilters = { ...filters, lastTimePeriod: FALLBACK_PERIODS }
    d = await fetchSlice(q.dataset, usedFilters, opts.client)
  }

  if (q.country && (d.codes.geo ?? []).length === 0) {
    const known = await knownCodes('geo', q, opts).catch(() => [])
    throw new Error(
      `Eurostat has no reporting country "${q.country}" in ${q.dataset}. Known codes: ${
        known.map((k) => k.code).join(', ') || 'ISO-2 codes (EL for Greece, UK), EU27_2020'
      }. Leave country empty for all of them.`
    )
  }
  if (info.wasteDimension && (d.codes.waste ?? []).length === 0) {
    const known = await knownCodes('waste', q, opts).catch(() => [])
    throw new Error(
      `Unknown waste code "${q.waste_code}" for ${q.dataset} (${info.wasteDimension.scheme}). Known codes: ${
        known.map((k) => `${k.code} = ${k.label}`).join('; ') || 'see the table'
      }.`
    )
  }

  // The year shown: the newest with at least one number in it — unless that year is a stub. Eurostat
  // publishes a new period before every operation is in: env_wasoper DE 2022 carried 5 cells where
  // 2020 carried 21, and "the latest year" was an answer with no landfill, incineration or recycling
  // row in it (seen with an external agent). A year the caller asked for is shown as it is.
  const years = (d.codes.time ?? [])
    .filter(isYear)
    .map(Number)
    .sort((a, b) => b - a)
  const filled = (y: number): number =>
    d.rows.filter((r) => r.codes.time === String(y) && r.value !== null).length
  const counts = new Map(years.map((y) => [y, filled(y)]))
  const fullest = Math.max(0, ...counts.values())
  let yearWithData = years.find((y) => (counts.get(y) ?? 0) > 0)
  if (yearWithData !== undefined && q.year === undefined && fullest > 0) {
    const complete = years.find((y) => (counts.get(y) ?? 0) * 2 >= fullest)
    if (complete !== undefined && complete !== yearWithData) {
      notes.push(
        `${yearWithData} is published but thin for this selection (${counts.get(yearWithData)} of the ` +
          `${fullest} cells ${complete} has) — ${complete} is shown instead. Pass year=${yearWithData} to read what there is.`
      )
      yearWithData = complete
    }
  }
  if (yearWithData === undefined) {
    throw new Error(
      `${q.dataset} has no values for ${q.country ?? 'any country'}${q.waste_code ? ` / ${q.waste_code}` : ''}${
        q.year !== undefined ? ` around ${q.year}` : ' in its latest periods'
      } — every cell is empty or confidential. Try another year, the total category, or the EU aggregate (EU27_2020).`
    )
  }
  const rows = d.rows.filter((r) => r.codes.time === String(yearWithData))

  const valueRows: ValueRow[] = []
  const notAvailable: EolResult['not_available']['sample'] = []
  let notAvailableCount = 0
  const flagCount = new Map<string, number>()
  const flagStrings = new Map<string, string>()
  const countries: Record<string, string> = {}
  const operations: Record<string, string> = {}
  const units: Record<string, string> = {}
  for (const r of rows) {
    const geo = r.codes.geo ?? ''
    const op = r.codes.wst_oper ?? ''
    const unit = r.codes.unit ?? ''
    if (r.value === null) {
      if (r.status) {
        notAvailableCount += 1
        if (notAvailable.length < NOT_AVAILABLE_SAMPLE)
          notAvailable.push({
            country: geo,
            operation: op,
            unit,
            reason: meaningOf(r.status, d.statusLabels)
          })
      }
      continue
    }
    const status = r.status ?? ''
    for (const f of flagsOf(r.status)) flagCount.set(f, (flagCount.get(f) ?? 0) + 1)
    if (status && !flagStrings.has(status)) flagStrings.set(status, meaningOf(status, d.statusLabels))
    countries[geo] = d.labels.geo?.[geo] ?? geo
    operations[op] = d.labels.wst_oper?.[op] ?? op
    units[unit] = unitLabel(q.dataset, unit, d.labels.unit?.[unit] ?? unit)
    valueRows.push([geo, op, unit, r.value, status])
  }
  const flagged = valueRows.filter((v) => flagsOf(v[4] || null).some((f) => CAVEAT_FLAGS.has(f))).length
  const flagsPresent = [...flagCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([flag, n]) => ({ flag, meaning: FLAG_LEGEND[flag] ?? d.statusLabels[flag] ?? flag, values: n }))
  const warning = flagged
    ? `${flagged} of ${valueRows.length} values are NOT final — flagged ${flagsPresent
        .filter((f) => CAVEAT_FLAGS.has(f.flag))
        .map((f) => `"${f.flag}" (${f.meaning})`)
        .join(', ')}. Tell the user this explicitly before building a scenario on them.`
    : null

  const wasteCode = info.wasteDimension ? (q.waste_code ?? info.wasteDimension.total) : undefined
  const nCountries = Object.keys(countries).length
  if (!q.country) {
    // Countries the table knows but that have no number for the year shown — named, not just absent.
    const silent = (d.codes.geo ?? []).filter((g) => !(g in countries))
    if (silent.length) notes.push(`No values for ${yearWithData}: ${silent.join(', ')}.`)
  }
  return {
    dataset: q.dataset,
    dataset_title: d.label || info.title,
    scope: q.country ?? `all reporting countries (${nCountries})`,
    year: yearWithData,
    ...(yearNote ? { year_note: yearNote } : {}),
    other_years_in_answer: years.filter((y) => y !== yearWithData),
    ...(wasteCode ? { waste_code: wasteCode, waste_label: d.labels.waste?.[wasteCode] ?? wasteCode } : {}),
    notes,
    values: { columns: VALUE_COLUMNS, rows: valueRows, count: valueRows.length },
    ...sharesOf(valueRows),
    lookups: {
      countries,
      operations,
      units,
      flags: { '': 'final value (no flag)', ...Object.fromEntries(flagStrings) }
    },
    not_available: { count: notAvailableCount, sample: notAvailable },
    flags_and_status: {
      flagged_values: flagged,
      total_values: valueRows.length,
      flags_present: flagsPresent,
      warning
    },
    dataset_metadata: {
      description: info.description,
      use_for: info.use_for,
      periodicity: info.periodicity,
      ...(info.wasteDimension ? { waste_scheme: info.wasteDimension.scheme } : {}),
      last_update: d.updated,
      table: browserUrl(q.dataset),
      api_query: eurostatUrl(q.dataset, usedFilters),
      attribution: EUROSTAT_ATTRIBUTION
    },
    lca_note: LCA_NOTE
  }
}

/**
 * Each operation's share of total treatment (TRT), per country, from the tonnes rows.
 *
 * The model used to derive these by hand from the tonnes (V415) and had to decide alone
 * what "incineration" is. The arithmetic belongs here; the decision is named beside it: energy
 * recovery (R1, RCV_E) and disposal by incineration (D10, DSP_I) are both thermal, and an LCA
 * incineration share is usually their sum — for plastics R1 includes co-incineration in cement kilns.
 * Tonnes first, kilograms per capita where a table has no tonnes; the percent unit of env_wasoper is
 * already a share and is left alone.
 */
export function sharesOf(rows: ValueRow[]): {
  shares?: Record<string, Record<string, number>>
  shares_note?: string
} {
  const unit = rows.some((r) => r[2] === 'T') ? 'T' : rows.some((r) => r[2] === 'KG_HAB') ? 'KG_HAB' : null
  if (!unit) return {}
  const shares: Record<string, Record<string, number>> = {}
  for (const [geo, op, u, value] of rows) {
    if (u !== unit || op === 'TRT') continue
    const total = rows.find((r) => r[0] === geo && r[1] === 'TRT' && r[2] === unit)?.[3]
    if (!total) continue
    ;(shares[geo] ??= {})[op] = Math.round((value / total) * 10000) / 10000
  }
  if (!Object.keys(shares).length) return {}
  return {
    shares,
    shares_note:
      `Share of total treatment (TRT) per operation, from the ${unit === 'T' ? 'tonnes' : 'kg per capita'} ` +
      'rows. RCV_R_B contains RCV_R and RCV_B; DSP_L_OTH contains DSP_L and DSP_OTH. An LCA ' +
      '"incineration" share is usually RCV_E (R1, energy recovery) + DSP_I (D10) — both are thermal ' +
      'treatment, and for plastics R1 includes co-incineration in cement kilns. Shares of the top-level ' +
      'operations (RCV_R_B, RCV_E, DSP_L_OTH, DSP_I) sum to 1 up to rounding.'
  }
}

/** The API's unit label, sharpened where it is ambiguous for a model computing shares. */
function unitLabel(dataset: EurostatDataset, unit: string, apiLabel: string): string {
  if (unit === 'PC' && dataset === 'env_wasoper') return 'Percentage of total waste treatment'
  if (unit === 'PC' && dataset === 'env_waspac') return 'Percentage of packaging waste generated'
  if (unit === 'RT_T2008') return 'Recycling rate, % (2008 target definition — before sorting)'
  if (unit === 'RT_TGT2025')
    return 'Recycling rate, % (2025 target definition — measured after sorting, at input to recycling)'
  return apiLabel
}
