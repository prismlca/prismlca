/**
 * The four Eurostat waste datasets the assistant may ask for, described once — the words the tool
 * result carries under `dataset_metadata` and the vocabulary the service filters by.
 *
 * Source: Eurostat dissemination API (JSON-stat 2.0), free, no key; the metadata sentences follow
 * the Eurostat reference metadata (env_wasgt_esms, env_waspac_esms, env_wasmun_esms), reworded for a
 * model that has to decide which dataset answers an end-of-life question. Codes are Eurostat's own
 * (EWC-Stat waste categories, waste-management operations R/D of Directive 2008/98/EC) and are read
 * back from the API's dimension labels at runtime — nothing here duplicates a code list.
 */

export const EUROSTAT_DATASETS = ['env_wasoper', 'env_wastrt', 'env_waspac', 'env_wasmun'] as const
export type EurostatDataset = (typeof EUROSTAT_DATASETS)[number]

export const isEurostatDataset = (v: unknown): v is EurostatDataset =>
  EUROSTAT_DATASETS.includes(v as EurostatDataset)

export interface DatasetInfo {
  /** Eurostat's own table title. */
  title: string
  /** What is counted and where the system boundary sits — the sentence the model reads. */
  description: string
  /** Which end-of-life question it answers best. */
  use_for: string
  /** Whether the table has a `waste` dimension, and the code that means "all of it" when it does. */
  wasteDimension: { total: string; scheme: string } | null
  /** Fixed filters that keep one answer to one slice (the hazard total for env_wastrt). */
  fixedFilters: Record<string, string>
  /** Reporting rhythm — tells the model why an odd year comes back empty. */
  periodicity: string
}

export const DATASET_INFO: Record<EurostatDataset, DatasetInfo> = {
  env_wasoper: {
    title: 'Management of waste excluding major mineral waste, by waste management operations',
    description:
      'Waste management indicators: the FINAL treatment of the waste GENERATED in the reporting country — treatment inside the country plus exports minus imports of waste (trade corrected with COMEXT). Major mineral wastes (construction & demolition, mining, soils, dredging) are excluded. Operations: landfill (D1, D5, D12), incineration without energy recovery (D10), other disposal, energy recovery (R1), recycling, backfilling. Units: tonnes, kg per capita, and percent of total treatment.',
    use_for:
      'The end-of-life mix of ALL waste a country generates (share landfilled / incinerated / energy-recovered / recycled), industrial waste included, with no breakdown by material — a coarse fallback when neither the packaging table, municipal waste nor one waste category fits the product. Not the default for a consumer product.',
    wasteDimension: null,
    fixedFilters: {},
    periodicity: 'Biennial (even years, e.g. 2020, 2022); odd years have no data.'
  },
  env_wastrt: {
    title: 'Treatment of waste by waste category, hazardousness and waste management operations',
    description:
      'Absolute amounts of waste TREATED in facilities located in the reporting country, whatever the waste’s origin — imports are included, exports are not, so this is the treatment mix of the country’s plants, not of the waste its residents generated. Broken down by EWC-Stat waste category (metals, glass, paper, plastics, wood, textiles, household waste, mineral wastes, …) and hazardousness; this tool asks for hazardous + non-hazardous together. Units: tonnes and kg per capita.',
    use_for:
      'Treatment shares for ONE specific waste category (e.g. plastic wastes W074, glass wastes W071, paper and cardboard W072) — the table for material collected separately as that category, such as scrap metal taken to a recycling yard. It pools industrial scrap and imports, so it overstates recycling for a product thrown away with household waste.',
    wasteDimension: {
      total: 'TOTAL',
      scheme: 'EWC-Stat (Waste Statistics Regulation) categories, codes W011 … W128_13'
    },
    fixedFilters: { hazard: 'HAZ_NHAZ' },
    periodicity: 'Biennial (even years, e.g. 2020, 2022); odd years have no data.'
  },
  env_waspac: {
    title: 'Packaging waste by waste management operations',
    description:
      'Packaging waste GENERATED and RECOVERED/RECYCLED as reported under the Packaging and Packaging Waste Directive (94/62/EC), by packaging material: paper & cardboard, plastic, wood, metal (aluminium, steel, incl. metals recovered from incineration bottom ash), glass, other. Operations: generation, recovery, energy recovery, recycling (in the Member State / in other EU countries / outside the EU), repair. Units: tonnes, kg per capita, and two recycling RATES — "2008 target" (older calculation point) and "2025 target and onwards" (recycling measured at the input to the final recycling process, i.e. after sorting; lower and closer to what is actually recycled).',
    use_for:
      'Collection and recycling quotas of packaging materials for FMCG and packaging LCAs. Prefer the "2025 target" rate where both exist.',
    wasteDimension: { total: 'W1501', scheme: 'Packaging waste codes W1501 (all) … W150199' },
    fixedFilters: {},
    periodicity: 'Annual, published with about two years’ delay.'
  },
  env_wasmun: {
    title: 'Municipal waste by waste management operations',
    description:
      'Municipal waste (household and similar waste collected by or on behalf of municipalities) generated and treated in the reporting country. Operations: generation, total treatment, landfill and other disposal, incineration, energy recovery, recycling (material; composting & digestion), preparing for reuse. Units: thousand tonnes and kg per capita; shares have to be computed from the tonnes.',
    use_for:
      'Post-consumer end-of-life of consumer goods disposed of via household collection. For residual waste take the incineration and landfill shares; the recycling share is the separately collected fractions. No breakdown by material.',
    wasteDimension: null,
    fixedFilters: {},
    periodicity: 'Annual, published with about one to two years’ delay.'
  }
}

/**
 * Eurostat’s observation flags. The API answers with the labels for the flags it actually used
 * (`extension.status.label`), and those win; this table is the fallback for a combined flag such as
 * "bp" that the answer does not spell out.
 */
export const FLAG_LEGEND: Record<string, string> = {
  b: 'break in time series',
  c: 'confidential',
  d: 'definition differs',
  e: 'estimated',
  f: 'forecast',
  i: 'value imputed by Eurostat or the receiving agency',
  m: 'missing value; data cannot exist',
  n: 'not significant',
  p: 'provisional',
  r: 'revised',
  s: 'Eurostat estimate',
  u: 'low reliability',
  z: 'not applicable'
}

/** Flags that leave a number but change how much it can be trusted — the ones the user is warned about. */
export const CAVEAT_FLAGS = new Set(['b', 'd', 'e', 'f', 'i', 'n', 'p', 'r', 's', 'u'])

/** The sentence about sorting losses that rides with every answer. */
export const LCA_NOTE =
  'Eurostat recycling figures are mostly amounts ENTERING sorting or recycling operations, not secondary material produced. Sorting yields and process losses are still to be accounted for in the LCA’s recycling datasets; the "2025 target" packaging rate is the exception, measured after sorting.'

export const EUROSTAT_ATTRIBUTION =
  'Source: Eurostat (© European Union), reused under Eurostat’s free re-use policy (CC BY 4.0).'

export const EUROSTAT_API = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data'
export const browserUrl = (dataset: EurostatDataset): string =>
  `https://ec.europa.eu/eurostat/databrowser/view/${dataset}/default/table`

/** A day: the tables change a few times a year, and a chat asks the same slice many times. */
export const EUROSTAT_CACHE_TTL_MS = 24 * 60 * 60 * 1000
