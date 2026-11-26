/**
 * What one research leg's pages say about the parts the OTHER legs research. The legs run in parallel and none sees
 * what another found, so a datasheet one leg reads for the frame may state the axle's mass and the axle's leg never
 * learns of it. Each leg reports such figures (`for_others`, bomAnswer.ts); after the first round they serve twice:
 * a part still without a mass hands the page to its follow-up ("open it first"), and a part with a figure of its own
 * is held against the page's, agreeing or contradicting it, as a hint. Never summed, never in place of the part's
 * own figure: the leg that researches a part answers for it.
 *
 * Only pages the search engine delivered, or the caller named, are used: a page a leg read can carry any address
 * in its text, and one leg's word must not send another leg there.
 */
import type { BomItem, BomLeg, OtherPartFigure } from './bomAnswer'
import { resolveName, type LegOutcome } from './bomBalance'
import { onePerName } from './bomEntries'
import { urlKey, type CitationBook } from './citationBook'
import { linksIn } from './researchNote'

/**
 * Two pages' figures for one part this close tell the same story — sources round differently. Further apart, one
 * page describes another version or scope of the part, or a figure is wrong.
 */
const AGREE = 0.1
/** Pages handed to one follow-up: what its short question can open in its time. */
const MAX_LEADS = 2

/** A figure for another leg's part, settled to the request it belongs to and to a page that may be handed on. */
export interface CrossFigure extends OtherPartFigure {
  /** The requested component the figure belongs to: the part itself, or the group the call named it in. */
  request: string
  /** The requested component whose leg read the page. */
  read_for: string
}

/** How a page read for one part compares with another part's own figure. */
export interface CrossCheck {
  /** The part the page states a figure for: a listed entry, an open component, or the request as a whole. */
  component: string
  /** The requested component it belongs to, when that is a group named differently. */
  in_request?: string
  /** The page's figure, for all the part's pieces. */
  page_kg: number
  source_url: string
  /** The requested component whose leg read the page. */
  read_for: string
  /** The part's own figure, when it has one. */
  own_kg?: number
  /** `agrees`: within a tenth of the own figure or inside its researched range; `differs`: outside; `no_own_figure`:
   *  the part came back without a mass (or not at all), and the page is where one stands. */
  verdict: 'agrees' | 'differs' | 'no_own_figure'
  /** The own figure came from this same page, read differently. */
  same_page?: true
  /** The part's leg already listed the page's figure as an alternative to the one it counted. */
  among_alternatives?: true
}

/** The words of a name, for telling "the request itself" from one part of it. */
const words = (s: string): string =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(' ')
/** How many words a name has besides its bracketed qualifier: "Achse (massiv)" is one, "axle and bearings" three. */
const span = (s: string): number =>
  words(s.replace(/\([^)]*\)/g, ' '))
    .split(' ')
    .filter(Boolean).length

/**
 * The page a leg's address may be passed on as, or null: one the search engine delivered to any leg of the call
 * (the citation book), or one the caller named in the product or its context — in the spelling it was delivered or
 * named in, never the leg's: the comparable key ignores case, a server does not.
 */
export function admissiblePage(book: CitationBook, callerText: string): (url: string) => string | null {
  const named = new Map(linksIn(callerText).map((u) => [urlKey(u), u]))
  return (url) => {
    const page = book.page(url)
    const delivered = page ? book.delivered(page) : null
    return delivered ?? named.get(urlKey(url)) ?? null
  }
}

/**
 * The figures the legs' pages gave for the other requested components, each settled to the request it belongs to
 * and to a page that may be passed on. A name that belongs to no other request (the leg's own part, the whole
 * product, a part nobody asked for) and a page that is not admissible are left out, as is the same figure from the
 * same page twice.
 */
export function crossFigures(
  outcomes: LegOutcome[],
  admissible: (url: string) => string | null
): CrossFigure[] {
  const requests = outcomes.map((o) => o.request).filter((r): r is string => r !== null)
  const out: CrossFigure[] = []
  const seen = new Set<string>()
  for (const o of outcomes) {
    if (o.request === null) continue
    const own = o.request
    for (const f of o.leg?.for_others ?? []) {
      const request = resolveName(
        f.component,
        requests.filter((r) => r !== own)
      )
      const page = admissible(f.source_url)
      if (!request || !page) continue
      const key = `${words(f.component)}\n${urlKey(page)}\n${f.mass_kg}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ ...f, source_url: page, request, read_for: own })
    }
  }
  return out
}

/**
 * The pages another leg read that state a figure for this open part — its own name, or the request it belongs to:
 * what its follow-up opens first. A page for the whole group may not give the one part alone; the follow-up is told
 * to say so and search on.
 */
export function leadsFor(figures: CrossFigure[], request: string | null, part: string): CrossFigure[] {
  const out: CrossFigure[] = []
  for (const f of figures)
    if (
      f.request === request &&
      resolveName(f.component, [part]) &&
      !out.some((o) => urlKey(o.source_url) === urlKey(f.source_url))
    )
      out.push(f)
  return out.slice(0, MAX_LEADS)
}

/** What a follow-up is told about the pages another leg found for its part. */
export function leadWords(leads: CrossFigure[]): string {
  if (!leads.length) return ''
  const pages =
    leads.length === 1
      ? `a page that states a mass for "${leads[0].component}": ${leads[0].source_url}`
      : `pages that state a mass for this part: ${leads.map((l) => `${l.source_url} ("${l.component}")`).join(', ')}`
  return (
    `\nAnother researcher read ${pages}. Open ${leads.length === 1 ? 'it' : 'them'} first and take your figure ` +
    'from there when it is given for this part alone; when it is not, say so in the note and search on.'
  )
}

const r6 = (n: number): number => Number(n.toFixed(6))
const close = (a: number, b: number): boolean => Math.abs(a - b) <= AGREE * Math.max(a, b)

/**
 * What a figure is held against, read from the entries the balance keeps (a repeat once, a contradiction open): the
 * request's entries together when the figure names the request and nothing of it is open, else the entry it names.
 * Null when the part has no figure of its own — open, partly open, or not listed — and `broader` when the only entry
 * it names covers more than the figure does ("axle and bearings" for "axle"): no comparison, the page stays a lead.
 */
function ownFigure(
  f: CrossFigure,
  raw: BomLeg | undefined
): { name: string; items: BomItem[] } | 'broader' | null {
  const leg = raw ? onePerName(raw).leg : undefined
  const items = (leg?.items ?? []).filter((i) => i.group !== 'recipe')
  const open = (leg?.unresolved ?? []).map((u) => u.component)
  if (words(f.component) === words(f.request))
    return items.length && !open.length ? { name: f.request, items } : null
  if (resolveName(f.component, open)) return null
  const entry = resolveName(
    f.component,
    items.map((i) => i.component)
  )
  if (!entry) return null
  return span(entry) > span(f.component)
    ? 'broader'
    : { name: entry, items: items.filter((i) => i.component === entry) }
}

/**
 * Hold every figure the pages gave for a part against the part's own figure, once the follow-up is in — and its
 * researched range when it carries one. A page that agrees with a figure taken from that same page confirms nothing
 * and is left out; whether it is the same page is asked of the page each address stands for (`canonical`), since a
 * leg may cite a provider's link to it.
 */
export function crossChecks(
  figures: CrossFigure[],
  outcomes: LegOutcome[],
  canonical: (url: string) => string = (u) => u
): CrossCheck[] {
  const out: CrossCheck[] = []
  for (const f of figures) {
    const leg = outcomes.find((o) => o.request === f.request)?.leg
    const own = ownFigure(f, leg)
    if (own === 'broader') continue
    const name = own?.name ?? f.component
    const base = {
      component: name,
      ...(words(name) !== words(f.request) ? { in_request: f.request } : {}),
      page_kg: f.mass_kg,
      source_url: f.source_url,
      read_for: f.read_for
    }
    if (!own) {
      out.push({ ...base, verdict: 'no_own_figure' })
      continue
    }
    const sum = r6(own.items.reduce((s, i) => s + i.mass_kg, 0))
    const lo = own.items.reduce((s, i) => s + (i.mass_range_kg?.[0] ?? i.mass_kg), 0)
    const hi = own.items.reduce((s, i) => s + (i.mass_range_kg?.[1] ?? i.mass_kg), 0)
    const agrees = close(f.mass_kg, sum) || (f.mass_kg >= lo && f.mass_kg <= hi)
    const page = urlKey(canonical(f.source_url))
    const samePage = own.items.every((i) => i.source_url && urlKey(canonical(i.source_url)) === page)
    if (agrees && samePage) continue
    // An alternative stands for the one entry it was given on: only a figure held against one entry is compared.
    const amongAlternatives =
      !agrees &&
      own.items.length === 1 &&
      (own.items[0].alternatives ?? []).some((a) => close(a.mass_kg, f.mass_kg))
    out.push({
      ...base,
      own_kg: sum,
      verdict: agrees ? 'agrees' : 'differs',
      ...(samePage ? { same_page: true as const } : {}),
      ...(amongAlternatives ? { among_alternatives: true as const } : {})
    })
  }
  return out
}

/** The hint the result's note carries: contradictions first, then pages for parts without a mass, then confirmations. */
export function crossCheckNote(checks: CrossCheck[]): string | undefined {
  const differs = checks
    .filter((c) => c.verdict === 'differs')
    .map(
      (c) =>
        `"${c.component}" counts ${c.own_kg} kg, but ${c.same_page ? 'the page it came from' : 'a page'} read for ` +
        `"${c.read_for}" gives ${c.page_kg} kg (${c.source_url})` +
        (c.among_alternatives ? ' — already among its alternatives' : '')
    )
  const open = checks
    .filter((c) => c.verdict === 'no_own_figure')
    .map((c) => `"${c.component}" (${c.page_kg} kg on ${c.source_url}, read for "${c.read_for}")`)
  const agree = [...new Set(checks.filter((c) => c.verdict === 'agrees').map((c) => `"${c.component}"`))]
  return (
    [
      differs.length
        ? `Pages read for other parts disagree: ${differs.join('; ')} — another version or scope, or one figure ` +
          'is wrong; check which fits before booking.'
        : '',
      open.length
        ? `A page read for another part states a mass for a part without one of its own: ${open.join('; ')} — not ` +
          'checked and not counted; open it before booking that figure.'
        : '',
      agree.length ? `Pages read for other parts confirm the figures of ${agree.join(', ')}.` : ''
    ]
      .filter(Boolean)
      .join(' ') || undefined
  )
}
