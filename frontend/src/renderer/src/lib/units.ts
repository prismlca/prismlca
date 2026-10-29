/**
 * Long ecoinvent unit name → international short form, for compact canvas-arrow labels and the
 * unit column of the inspector's flow rows.
 *
 * Conventions: typeset exponents (m², m³), litre = L,
 * "-year" = a (annum), compound units without a separator (tkm, pkm, m²a). Keys are matched
 * case-insensitively. A unit with no entry here falls back to its long form (see `shortUnit`).
 */
export const UNIT_SHORT: Record<string, string> = {
  // present in ecoinvent 3.12 (scanned)
  kilogram: 'kg',
  megajoule: 'MJ',
  'kilowatt hour': 'kWh',
  meter: 'm',
  kilometer: 'km',
  'square meter': 'm²',
  'cubic meter': 'm³',
  litre: 'L',
  hour: 'h',
  hectare: 'ha',
  'ton kilometer': 'tkm',
  'person kilometer': 'pkm',
  'kilo becquerel': 'kBq',
  becquerel: 'Bq', // BAFU:20XY writes some radionuclides in Bq
  'standard cubic meter': 'Sm³',
  'square meter-year': 'm²a',
  'cubic meter-year': 'm³a',
  'meter-year': 'ma',
  'kilometer-year': 'kma',
  'kilogram day': 'kgd',
  // (unit, guest night, EUR2005 intentionally left out → long form shown)

  // added pre-emptively for units that may appear later
  gram: 'g',
  watt: 'W',
  gigawatt: 'GW',
  gigajoule: 'GJ',
  terajoule: 'TJ',
  ton: 't', // metric ton / tonne
  millimeter: 'mm',
  mile: 'mi'
}

/**
 * Compact display form of a unit for canvas arrows and inspector rows: the international short form
 * if we have one, otherwise the long form — trimmed to 7 chars (+ …) so it never bloats a label.
 */
export const shortUnit = (unit?: string | null): string | null => {
  if (!unit) return null
  const mapped = UNIT_SHORT[unit.trim().toLowerCase()]
  if (mapped) return mapped
  return unit.length > 7 ? `${unit.slice(0, 7)}…` : unit
}
