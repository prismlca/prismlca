/**
 * A product's printed ingredient list read into its names: the list the caller passed (`recipe.ingredients`,
 * `recipe.inci_list`) or the one the recipe leg found on the product. The names are what a recipe is covered against
 * (recipeBalance.ts) and what the recipe leg is asked to copy (bomRecipe.ts).
 *
 * A cosmetic sold in several shades may print every colourant of the range behind "+/-" or "may contain": a shade
 * has some of them, so a name of that part is read as a name, but the product need not contain it. Pure.
 */

/**
 * The words a shade range's colourants follow, with the bracket or colon around them: "[+/- ", "May contain: ". A
 * label in several languages prints them more than once ("May contain/Peut contenir (+/-): ").
 */
const MAY_CONTAIN = /[[(]?\s*(?:\+\s*\/\s*[-–−]|±|\bmay\s+contain\b)\s*[)\]]?\s*:?\s*/giu

/**
 * The list as printed, one name per entry. A list sent as one string is split at its commas — but not inside a name
 * like "1,2-Hexanediol", where a digit follows the comma.
 */
export function inciEntries(list: readonly string[] | undefined): string[] {
  return (list ?? [])
    .flatMap((e) => String(e).split(/,(?!\d)/))
    .map((e) => e.trim())
    .filter(Boolean)
}

/** An entry of the list as the coverage reads it. */
export interface ListName {
  name: string
  /** Of a "may contain" part: the product need not contain it — a shade has some of them. */
  may: boolean
}

/** A name of a "may contain" part without the bracket around the part: "CI 77499]" is "CI 77499". */
const unbracket = (s: string): string => {
  let t = s.trim().replace(/[.;]+$/, '')
  for (const [open, close] of ['[]', '()']) {
    if (t.startsWith(open) && !t.includes(close)) t = t.slice(1).trim()
    if (t.endsWith(close) && !t.includes(open)) t = t.slice(0, -1).trim()
  }
  return t
}

/**
 * What stands before the first marker of an entry: a name, or the marker's heading in another language. A heading is
 * joined to the marker by a slash ("Peut contenir/May contain") or ends in the colon after it ("Kann enthalten [+/-]:
 * CI 77891"); a name before it ends at a full stop ("Phenoxyethanol. Peut contenir/May contain (+/-): …") or stands
 * before an open bracket ("Phenoxyethanol [+/- Mica").
 */
function beforeMarker(text: string, colon: boolean): string {
  const t = text.trim()
  if (!t.endsWith('/') && !colon) return t
  const stop = [...t.matchAll(/\.(?:\s+|$)/g)].pop()
  return stop ? t.slice(0, stop.index) : ''
}

/**
 * The names of the list in their printed order, each marked when it stands in a "may contain" part. The marker of
 * such a part is no name: "Phenoxyethanol [+/- CI 77891" is two entries, a lone "+/-" none.
 */
export function listNames(entries: readonly string[]): ListName[] {
  const out: ListName[] = []
  let shades = false
  const add = (raw: string): void => {
    const name = shades ? unbracket(raw) : raw.trim()
    if (name) out.push({ name, may: shades })
  }
  for (const e of entries) {
    const marks = [...e.matchAll(MAY_CONTAIN)]
    if (!marks.length) {
      add(e)
      continue
    }
    // Before the first marker the name it follows, unless a heading; after the last the name it introduces — or after
    // the colon that ends the marker in other languages ("May contain/Peut contenir: CI 15850"; never "CI 15850:1").
    const last = marks[marks.length - 1]
    const after = e.slice(last.index + last[0].length)
    const colon = [...after.matchAll(/:(?!\d)\s*/g)].pop()
    add(beforeMarker(e.slice(0, marks[0].index), !!colon || last[0].includes(':')))
    shades = true
    add(colon ? after.slice(colon.index + colon[0].length) : after)
  }
  return out
}
