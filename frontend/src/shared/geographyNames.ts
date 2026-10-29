/**
 * Names for location codes ("DE", "RER", "CA-QC", "Europe without Switzerland").
 *
 * The authoritative names are the workspace's own: the backend reads them from the user's ecoinvent
 * release (`GET /api/v1/search/geography-names`, engine/geography_names.py), so no ecoinvent list
 * ships with PrismLCA. Where that has nothing — a workspace with BAFU only, or a code the release does
 * not know — countries are named by the runtime's ICU data and a handful of region codes by the short
 * list below. Shared by the renderer's pickers and the assistant's `list_geographies` tool.
 */

/** code → name, as the backend returns it. */
export type GeoNames = Readonly<Record<string, string>>

/**
 * Region codes that ecoinvent 2-era and BAFU datasets use, in our own words — the fallback for a
 * workspace without an ecoinvent release. Short on purpose: anything longer belongs to the release.
 */
const REGION_NAMES: GeoNames = {
  GLO: 'Global',
  RoW: 'Rest of the world',
  RER: 'Europe',
  RAS: 'Asia',
  RAF: 'Africa',
  RLA: 'Latin America and the Caribbean',
  RNA: 'North America',
  RME: 'Middle East',
  OCE: 'Oceania',
  APAC: 'Asia-Pacific',
  CPA: 'Centrally Planned Asia (IMAGE region)',
  EEU: 'Eastern Europe (IMAGE region)',
  UCTE: 'UCTE area (former European transmission grid)',
  ENTSO: 'ENTSO-E area (European transmission grid)',
  'ENTSO-E': 'ENTSO-E area (European transmission grid)',
  NORDEL: 'NORDEL area (Nordic transmission grid)',
  CENTREL: 'CENTREL area (Central European transmission grid)',
  ASCC: 'Alaska Systems Coordinating Council (US grid region)',
  ERCOT: 'Electric Reliability Council of Texas (US grid region)',
  FRCC: 'Florida Reliability Coordinating Council (US grid region)',
  RFC: 'ReliabilityFirst Corporation (US grid region)',
  SERC: 'SERC Reliability Corporation (US grid region)',
  SPP: 'Southwest Power Pool (US grid region)'
}

let countryNames: Intl.DisplayNames | null | undefined

function countryName(code: string): string | undefined {
  if (!/^[A-Z]{2}$/.test(code)) return undefined
  if (countryNames === undefined) {
    try {
      countryNames = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' })
    } catch {
      countryNames = null // a runtime without ICU region names: codes stay codes
    }
  }
  return countryNames?.of(code) ?? undefined
}

/** A map's own entry — a location code is free text, and "constructor" must not find a prototype. */
function own(map: GeoNames, code: string): string | undefined {
  const value = Object.prototype.hasOwnProperty.call(map, code) ? map[code] : undefined
  return typeof value === 'string' ? value : undefined
}

/** The name of a code, or undefined when nobody knows one. */
export function geoName(code: string, names: GeoNames = {}): string | undefined {
  return own(names, code) ?? own(REGION_NAMES, code) ?? countryName(code)
}

/**
 * A region or market area rather than a country or one of its provinces — what the pickers group on
 * top. Read from the shape of the code: two letters are an ISO country, two plus two letters a
 * province or state (Australia's take two or three), anything else (RER, RoW, "US-NPCC",
 * "Europe without Switzerland") an aggregate.
 */
export function isAggregate(code: string): boolean {
  return !/^[A-Z]{2}$/.test(code) && !/^[A-Z]{2}-[A-Z]{2}$/.test(code) && !/^AU-[A-Z]{2,3}$/.test(code)
}
