/**
 * The options of a geography picker, in the order it lists them: aggregations and regions first, then
 * countries and their provinces, each group alphabetical by its label — except the `pinned` codes, which
 * lead the first group in the order given.
 */
import { type GeoNames, geoName, isAggregate } from '../../../shared/geographyNames'

export interface GeoItem {
  value: string // what onPick returns (a geo code, or an activity code for the variant picker)
  geo: string // the geography code used for label + grouping
}

/** "Name (CODE)", or the bare code when nobody knows a name. */
export function geoLabel(geo: string, names: GeoNames): string {
  const name = geoName(geo, names)
  return name ? `${name} (${geo})` : geo
}

export function groupGeoItems(
  items: readonly GeoItem[],
  names: GeoNames,
  pinned: readonly string[] = []
): { aggs: GeoItem[]; countries: GeoItem[] } {
  const rank = (it: GeoItem): number => {
    const i = pinned.indexOf(it.geo)
    return i < 0 ? pinned.length : i
  }
  const byLabel = (a: GeoItem, b: GeoItem): number =>
    geoLabel(a.geo, names).localeCompare(geoLabel(b.geo, names))
  return {
    aggs: items.filter((it) => isAggregate(it.geo)).sort((a, b) => rank(a) - rank(b) || byLabel(a, b)),
    countries: items.filter((it) => !isAggregate(it.geo)).sort(byLabel)
  }
}
