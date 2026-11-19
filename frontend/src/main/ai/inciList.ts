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

/** A bracket in a text: where it opens, and where it closes — nowhere when the text never closes it. */
interface Bracket {
  open: number
  close?: number
}

/** The brackets of a text, round or square, each closed by the first closing one not another's. */
function bracketsOf(text: string): Bracket[] {
  const all: Bracket[] = []
  const open: Bracket[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(' || text[i] === '[') {
      const b: Bracket = { open: i }
      all.push(b)
      open.push(b)
    } else if ((text[i] === ')' || text[i] === ']') && open.length) open.pop()!.close = i
  }
  return all
}

/** The bracket around a "may contain" part, its marker before the first name: "[+/- Mica, …]", "(May contain: …)". */
const framesMay = (inside: string): boolean => inside.split(/,(?!\d)/)[0].search(MAY_CONTAIN) >= 0

/**
 * A text split at its commas — never before a digit ("1,2-Hexanediol") nor inside a bracket the text closes, which
 * holds what one entry is made of or another name of it ("Chocolate (Sugar, Cocoa Mass)", "Iron Oxides (CI 77491, CI
 * 77492)"). The bracket around a "may contain" part is no entry's: its names are entries of their own. A bracket the
 * text never closes holds nothing together.
 */
function splitAtCommas(text: string): string[] {
  const held = bracketsOf(text).filter(
    (b): b is Required<Bracket> => b.close !== undefined && !framesMay(text.slice(b.open + 1, b.close))
  )
  const out: string[] = []
  let from = 0
  for (const { index } of text.matchAll(/,(?!\d)/g)) {
    if (held.some((b) => b.open < index && index < b.close)) continue
    out.push(text.slice(from, index))
    from = index + 1
  }
  out.push(text.slice(from))
  return out.map((e) => e.trim()).filter(Boolean)
}

/**
 * The list as printed, one name per entry. The list is read as one text, whether sent as one string or already split
 * by the caller, and split at its commas (`splitAtCommas`): a compound split inside its bracket is one entry again.
 */
export function inciEntries(list: readonly string[] | undefined): string[] {
  return splitAtCommas((list ?? []).map(String).join(', '))
}

/**
 * The bracket that ends a printed name — before the punctuation a list may close with ("Titanium Dioxide (CI 77891).",
 * an asterisk for organic) — with the name before it and the names inside it, at their commas. Open when the text was
 * cut inside it ("Chocolate (Sugar"). None for a bracket inside a name ("Butyrospermum Parkii (Shea) Butter") or with
 * no name before it.
 */
export function endBracket(printed: string): { head: string; inside: string[]; closed: boolean } | undefined {
  const t = printed.replace(/[^\p{L}\p{N}()[\]]+$/u, '')
  const brackets = bracketsOf(t)
  const b = brackets.find((x) => x.close === undefined) ?? brackets.find((x) => x.close === t.length - 1)
  if (!b) return undefined
  const head = t.slice(0, b.open).trim()
  if (!/[\p{L}\p{N}]$/u.test(head)) return undefined
  return { head, inside: splitAtCommas(t.slice(b.open + 1, b.close)), closed: b.close !== undefined }
}

/** An entry of the list as the coverage reads it. */
export interface ListName {
  name: string
  /** Of a "may contain" part: the product need not contain it — a shade has some of them. */
  may: boolean
}

/**
 * A name of a "may contain" part without the bracket around the part: "CI 77499]" is "CI 77499", "Iron Oxides (CI
 * 77491, CI 77492))" is "Iron Oxides (CI 77491, CI 77492)".
 */
const unbracket = (s: string): string => {
  let t = s.trim().replace(/[.;]+$/, '')
  const count = (c: string): number => t.split(c).length - 1
  for (const [open, close] of ['[]', '()']) {
    if (t.startsWith(open) && count(open) > count(close)) t = t.slice(1).trim()
    if (t.endsWith(close) && count(close) > count(open)) t = t.slice(0, -1).trim()
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
