/**
 * A cosmetic's recipe held against the order of the product's INCI list. An EU label lists the ingredients above
 * 1 % by descending mass as added (Regulation (EC) No 1223/2009, Art. 19), the rest after them in any order; a recipe
 * whose shares put two of those ingredients the other way round is not this product's recipe as labelled, even when
 * it closes. The result is a hint beside the balance, never part of its verdict. Pure, like recipeBalance.ts.
 *
 * Compared is what the recipe states, per substance: a trade form taken apart into the constituents its datasheet
 * states, and every contribution of one substance together (the water added and the water of a surfactant solution).
 * A share known only within bounds — a range, the rest that a range moves or that carries a line dosed without an
 * amount — counts as those bounds. The mass of a trade form whose composition is not stated, in full or in part, could
 * be any listed ingredient (an unknown surfactant solution is mostly water): a contradiction is named only where it is
 * wider than all of that mass. A substance without a share, or not certainly above 1 %, is not compared.
 *
 * Names are identities: a line or constituent is placed at the entry of the same name, spelling aside — its INCI name
 * as the leg wrote it first, then its own — never at one that merely shares a part ("Dimethicone" is not
 * "Dimethicone/Vinyl Dimethicone Crosspolymer"). The one equivalence is water, which INCI writes "Aqua" and a
 * datasheet "water". A name that matches no entry is taken as an ingredient the list does not have, and named.
 *
 * No contradiction is not a match: it says only that no two listed ingredients stand the other way round in every
 * reading of the shares given — some readings may still turn them, and the recipe need not be the product's.
 */
import type { RecipeLine } from './bomRecipe'

/** Above this share, in percent, the label's order is the order of mass. */
const ORDERED_ABOVE = 1
/** A trade form's stated constituents are taken apart up to this sum — the rounding of a datasheet. */
const CONSTITUENTS_MAX = 102
/** Float noise: 2 against 2.0000000001 is no contradiction. */
const EPS = 1e-9
/** Contradictions and unplaced ingredients handed on; the rest are counted. */
const MAX_NAMED = 12

/** One recipe line with its share of the mixture as weighed by recipeBalance.ts. */
export interface LineShare {
  line: RecipeLine
  /** Percent of the mixture, [min, max]; absent when the recipe gives the line no share. */
  share?: [number, number]
  /** The rest line carrying lines dosed without an amount: its own substance's share has no lower bound. */
  carries?: boolean
}

/** An entry of the INCI list with what the recipe gives it. */
export interface InciPlace {
  inci: string
  /** 1 = the first name printed. */
  position: number
  /** Percent of the mixture: a figure, or [min, max] where the recipe bounds it. */
  share_pct: number | [number, number]
  /** The recipe lines the share comes from. */
  lines: string[]
}

export interface InciContradiction {
  listed_first: InciPlace
  /** Listed after `listed_first`, but certainly heavier in the recipe. */
  listed_later: InciPlace
}

/** The `inci_order` block of a recipe: where its shares contradict the order of the INCI list passed. */
export interface InciOrder {
  /** Entries of the list the recipe puts certainly above 1 % — compared with each other. */
  compared: number
  contradictions: InciContradiction[]
  /** More contradictions than handed on. */
  more?: number
  /** Recipe ingredients with a share that match no name of the list, so are in no comparison. */
  unplaced?: string[]
  note: string
}

/** Which list the shares were held against: the one the caller passed, or a label list the research found. */
export interface InciListOrigin {
  list: 'passed' | 'found'
  /** For a found list: the product it belongs to, as its page names it. */
  product?: string
  /** For a found list: its page. */
  source_url?: string
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
/** The words a label or a datasheet writes water with, alone or together: "Aqua", "Aqua (Water)", "Water/Aqua/Eau". */
const WATER = new Set(['aqua', 'water', 'eau'])
/** One name, one identity: water under any of its labels, everything else by its whole name. */
const identity = (s: string | undefined): string => {
  if (!s) return ''
  const parts = s.split(/[/()]/).map(norm).filter(Boolean)
  return parts.length && parts.every((p) => WATER.has(p)) ? 'aqua' : norm(s)
}
const r4 = (n: number): number => Number(n.toPrecision(4))
const shareOf = (lo: number, hi: number): number | [number, number] =>
  Math.abs(hi - lo) <= EPS ? r4(lo) : [r4(lo), r4(Math.min(hi, 100))]
const shareWords = (s: number | [number, number]): string =>
  typeof s === 'number' ? `${s} %` : `${s[0]}–${s[1]} %`

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

/**
 * Each line's share of the mixture as [min, max] in percent, for the comparison; undefined where it has none. A range
 * moves its own share and, through the rest or through the lines' own sum, every other: the booking keeps the printed
 * point, the comparison may not ("glycerin 30, range 5–30" beside "aqua ad 100" leaves the water anywhere in 30–55).
 * `points` are the amounts on the recipe's basis as weighed (the rest's included); `rest` is the line taken as the
 * rest, when one was.
 */
export function shareBounds(
  lines: readonly RecipeLine[],
  points: readonly (number | undefined)[],
  o: {
    rest?: RecipeLine
    den?: number
    sharesFrom: 'denominator' | 'sum_of_lines'
    inBasis: (l: RecipeLine, x: number) => number
  }
): Array<[number, number] | undefined> {
  const amount = lines.map((l, i): [number, number] | undefined => {
    if (l === o.rest) return undefined
    if (l.range) return [o.inBasis(l, l.range[0]), o.inBasis(l, l.range[1])]
    const p = points[i]
    return p === undefined ? undefined : [p, p]
  })
  const lo = amount.reduce((s, a) => s + (a?.[0] ?? 0), 0)
  const hi = amount.reduce((s, a) => s + (a?.[1] ?? 0), 0)
  const den = o.den
  if (o.sharesFrom === 'denominator' && den !== undefined && den > 0)
    return lines.map((l, i): [number, number] | undefined => {
      // The rest is what the others leave: their heaviest reading leaves it least.
      if (l === o.rest)
        return points[i] === undefined
          ? undefined
          : [(Math.max(0, den - hi) / den) * 100, ((den - lo) / den) * 100]
      const a = amount[i]
      return a ? [(a[0] / den) * 100, (a[1] / den) * 100] : undefined
    })
  // Of the lines' own sum: a line is lightest beside the others at their heaviest, and the other way round.
  return amount.map((a): [number, number] | undefined => {
    if (!a) return undefined
    const least = a[0] + hi - a[1]
    const most = a[1] + lo - a[0]
    return [least > 0 ? (a[0] / least) * 100 : 0, most > 0 ? (a[1] / most) * 100 : 100]
  })
}

/** One contradiction in words, the way a reader checks it against the label. */
export function contradictionWords(c: InciContradiction): string {
  return (
    `${c.listed_first.inci} (no. ${c.listed_first.position}) is listed before ${c.listed_later.inci} ` +
    `(no. ${c.listed_later.position}), but the recipe gives ${shareWords(c.listed_first.share_pct)} against ` +
    shareWords(c.listed_later.share_pct)
  )
}

interface Contribution {
  /** The identities it is tried under, in order: the INCI name first, then the line's own. */
  names: string[]
  lo: number
  hi: number
  line: string
  /** How the contribution is named when it matches no entry. */
  label: string
}

/** Mass whose ingredient is not known: the unstated part of trade forms, in percent of the mixture. */
interface Unknown {
  pct: number
  /** The trade forms it sits in, with that part. */
  of: string[]
}

/** What one recipe line contributes, substance by substance; what it leaves unnamed goes to `unknown`. */
function contributions(ls: LineShare, unknown: Unknown): Contribution[] {
  const l = ls.line
  const lo = ls.share && !ls.carries ? ls.share[0] : 0
  const hi = ls.share ? ls.share[1] : Infinity
  const tf = l.trade_form
  const parts = tf?.constituents ?? []
  const stated = parts.reduce((s, c) => s + c.pct, 0)
  const usable = parts.length > 0 && stated <= CONSTITUENTS_MAX
  if (tf) {
    // The part a datasheet does not name — all of it when it names nothing or more than 100 % — may be any ingredient.
    const open = usable ? (hi * Math.max(0, 100 - stated)) / 100 : hi
    if (open > EPS) {
      unknown.pct += open
      unknown.of.push(`${tf.name || l.name} (${Number.isFinite(open) ? `up to ${r4(open)} %` : 'no share'})`)
    }
  }
  if (usable)
    return parts.map((c) => ({
      names: [identity(c.inci), identity(c.name)].filter(Boolean),
      lo: (lo * c.pct) / 100,
      hi: (hi * c.pct) / 100,
      line: l.name,
      label: `${c.name} (in ${tf?.name || l.name})`
    }))
  if (tf) return []
  return [
    { names: [identity(l.inci), identity(l.name)].filter(Boolean), lo, hi, line: l.name, label: l.name }
  ]
}

/**
 * Hold the recipe's shares against the order of the INCI list. `entries` is the list as printed (inciEntries);
 * `unaccounted_pct` is the recipe's own gap, which is in no comparison and is said so.
 */
export function inciOrder(
  entries: readonly string[],
  lines: readonly LineShare[],
  opts: { unaccounted_pct?: number } = {}
): InciOrder {
  const listNames = entries.map(identity)
  const placeOf = (c: Contribution): number => {
    for (const name of c.names) {
      const i = listNames.indexOf(name)
      if (i >= 0) return i
    }
    return -1
  }
  const unknown: Unknown = { pct: 0, of: [] }
  const at = new Map<number, { lo: number; hi: number; lines: string[] }>()
  const unplaced: string[] = []
  for (const ls of lines)
    for (const c of contributions(ls, unknown)) {
      const i = placeOf(c)
      if (i < 0) {
        if (Number.isFinite(c.hi) && c.hi > 0) unplaced.push(`${c.label} ${shareWords(shareOf(c.lo, c.hi))}`)
        continue
      }
      const p = at.get(i) ?? { lo: 0, hi: 0, lines: [] }
      p.lo += c.lo
      p.hi += c.hi
      if (!p.lines.includes(c.line)) p.lines.push(c.line)
      at.set(i, p)
    }
  // Only what is certainly above 1 % has a place in the order; below it the label may list in any order.
  const compared = [...at.entries()].filter(([, p]) => p.lo > ORDERED_ABOVE).sort((a, b) => a[0] - b[0])
  const place = (i: number, p: { lo: number; hi: number; lines: string[] }): InciPlace => ({
    inci: entries[i],
    position: i + 1,
    share_pct: shareOf(p.lo, p.hi),
    lines: p.lines
  })
  const found: InciContradiction[] = []
  for (let a = 0; a < compared.length; a++)
    for (let b = a + 1; b < compared.length; b++) {
      const [i, first] = compared[a]
      const [j, later] = compared[b]
      // Listed first, yet lighter whatever the bounds — even with every unnamed part of a trade form its own: no
      // reading of the recipe puts them in the label's order.
      if (first.hi + unknown.pct < later.lo - EPS)
        found.push({ listed_first: place(i, first), listed_later: place(j, later) })
    }

  const head = found.length
    ? `${found.length === 1 ? 'One contradiction' : `${found.length} contradictions`} with the order of the INCI list: ` +
      found.slice(0, MAX_NAMED).map(contradictionWords).join('; ') +
      (found.length > MAX_NAMED ? `; and ${found.length - MAX_NAMED} more` : '') +
      '.'
    : compared.length > 1
      ? `${compared.length} of its ingredients are certainly above 1 % and named in the INCI list; no certain ` +
        "contradiction with the list's order among them."
      : `Fewer than two of its ingredients are certainly above 1 % and named in the INCI list — nothing to compare.`
  const tail = [
    unknown.of.length
      ? Number.isFinite(unknown.pct)
        ? `Trade forms not stated in full could hold any listed ingredient in their unnamed part, so a contradiction ` +
          `is named only where it is wider than ${r4(unknown.pct)} %: ${unknown.of.join(', ')}.`
        : `A trade form without a share or a stated composition could hold any listed ingredient, so no contradiction ` +
          `can be named: ${unknown.of.join(', ')}.`
      : '',
    unplaced.length
      ? `Not in the list under the names the recipe uses, so in no comparison: ${unplaced.slice(0, MAX_NAMED).join(', ')}` +
        `${unplaced.length > MAX_NAMED ? ` and ${unplaced.length - MAX_NAMED} more` : ''}.`
      : '',
    opts.unaccounted_pct && opts.unaccounted_pct > 0
      ? `The ${r4(opts.unaccounted_pct)} % the recipe leaves unaccounted is in no comparison.`
      : ''
  ]
  return {
    compared: compared.length,
    contradictions: found.slice(0, MAX_NAMED),
    ...(found.length > MAX_NAMED ? { more: found.length - MAX_NAMED } : {}),
    ...(unplaced.length ? { unplaced: unplaced.slice(0, MAX_NAMED) } : {}),
    note: [head, ...tail].filter(Boolean).join(' ')
  }
}
