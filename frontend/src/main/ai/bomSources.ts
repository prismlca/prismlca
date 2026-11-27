/**
 * Where a bill-of-materials result's figures come from, settled once every leg is in: each address stored as the
 * page it leads to, a link that leads to no page dropped, the search engine's record held against what the legs
 * wrote, and every figure left without a page marked and named — apart from whether the parts add up, because a
 * sum can close on a figure nobody can cite.
 */
import type { BomItem, UnresolvedComponent } from './bomAnswer'
import type { BomWeighing } from './bomBalance'
import type { CitationBook, Evidence } from './citationBook'
import { settleLinks } from './researchNote'

/** Figures without a source the summary names one by one; `unsourced` lists them all. */
const NAMED = 8

export interface SettledSources {
  /** The open components, with the addresses their notes name settled the same way. */
  unresolved: UnresolvedComponent[]
  sources: string[]
  evidence: Evidence[]
  /** Whether every figure in `items` names a page; absent when there is no figure. */
  all_sourced?: boolean
  /** The figures in `items` without a usable source, by name. */
  unsourced?: string[]
  /** What the summary adds when a figure has no source: which, and that the balance does not vouch for them. */
  sentence?: string
  /** On the sources themselves: pages the search never returned, links that lead to no page. */
  notes: string[]
}

/** An ingredient is named as one, so "water" in the recipe is not read as a part called water. */
const nameOf = (i: BomItem): string =>
  i.group === 'recipe' ? `${i.component} (recipe ingredient)` : i.component

/**
 * Settle the addresses of a weighed result in place — its items, their alternatives, the whole-product masses and
 * the recipe — and return what the answer adds about its sources. The weighing never reads an address, so settling
 * after it changes no sum.
 */
export function settleSources(
  weighed: BomWeighing,
  book: CitationBook,
  /** Whether a known part's page is on the chat's own record (bomKnownParts.ts `onChatRecord`). */
  onChatRecord?: (url: string) => boolean | undefined
): SettledSources {
  const { items } = weighed
  // A leg may quote the provider's link to a page instead of the page (Google): stored as the page —
  // and a link that leads to no page is no source at all, so the figure stays and loses it.
  let deadLinks = 0
  const settle = (url: string | undefined): string | undefined => {
    if (!url) return undefined
    const page = book.page(url) ?? undefined
    if (!page) deadLinks++
    return page
  }
  for (const i of items) {
    i.source_url = settle(i.source_url)
    for (const a of i.alternatives ?? []) if (a.source_url) a.source_url = settle(a.source_url)
  }
  for (const t of weighed.totals_found ?? []) if (t.source_url) t.source_url = settle(t.source_url)
  const mix = weighed.recipe
  if (mix) {
    if (mix.formulation?.source_url) mix.formulation.source_url = settle(mix.formulation.source_url)
    for (const l of mix.lines) if (l.source_url) l.source_url = settle(l.source_url)
    for (const c of mix.contents_found ?? []) if (c.source_url) c.source_url = settle(c.source_url)
    if (mix.declared_source) mix.declared_source = settle(mix.declared_source)
  }
  // The addresses an unresolved component's note names get the same treatment: the page, not the
  // provider's link to it, and no link that leads nowhere.
  const unresolved = weighed.unresolved.map((u) => {
    const s = settleLinks(u, (url) => book.page(url))
    const url = u.source_url ? book.page(u.source_url) : null
    const { source_url: _dropped, ...rest } = s
    const alternatives = u.alternatives?.map((a) => {
      const page = a.source_url ? book.page(a.source_url) : null
      const { source_url: _gone, ...figure } = a
      return page ? { ...figure, source_url: page } : figure
    })
    return {
      ...rest,
      ...(url ? { source_url: url } : {}),
      ...(alternatives ? { alternatives } : {})
    }
  })
  // A known part's page is held against the chat's own record — its lookups, what its research answers vouch for, the
  // log's verdicts (bomChatRecord.ts): the researchers' citations say nothing about a page they were never sent to.
  // Settled before the source list, which leaves out a known part's page that no lookup backs.
  for (const i of items) {
    if (!i.source_url || !i.origin) continue
    const seen = onChatRecord?.(i.source_url)
    if (seen !== undefined) i.cited_by_search = seen
  }
  const sources = [
    ...new Set(
      [
        // A known part's page no lookup backs is no source of the result: it stays on its item, marked.
        ...items.filter((i) => !(i.origin && i.cited_by_search === false)).map((i) => i.source_url),
        ...items.flatMap((i) => (i.alternatives ?? []).map((a) => a.source_url)),
        ...(weighed.totals_found ?? []).map((t) => t.source_url),
        mix?.formulation?.source_url,
        mix?.declared_source
      ].filter((u): u is string => !!u)
    )
  ]
  // The engine's record against the model's: an item whose URL the search never returned is marked,
  // not dropped — the leg may have opened the page directly or written it from memory, and the
  // parent should know which figures rest on a citation the engine can vouch for.
  if (book.size)
    for (const i of items) if (i.source_url && !i.origin) i.cited_by_search = book.has(i.source_url)
  const uncited = book.size ? items.filter((i) => i.source_url && !i.origin && !i.cited_by_search).length : 0
  const unseen = items.filter((i) => i.source_url && i.origin && i.cited_by_search === false).length
  // A figure with no page left behind it — none named, or a link that leads nowhere — stays in the result and in
  // its sums: dropped, it would take its part out of a balance that has to answer for it. Marked and named instead,
  // so neither a balance that closes nor a research log that lists only sourced figures can pass it off as sourced.
  // A part the user stated has the user as its source: it needs no page to be accounted for.
  const bare = items.filter((i) => !i.source_url && i.origin !== 'user')
  for (const i of bare) i.unsourced = true
  const names = [...new Set(bare.map(nameOf))]
  const one = names.length === 1
  const listed =
    names
      .slice(0, NAMED)
      .map((n) => `"${n}"`)
      .join(', ') + (names.length > NAMED ? ` and ${names.length - NAMED} more (see unsourced)` : '')
  return {
    unresolved,
    sources,
    evidence: book.evidenceFor(sources),
    ...(items.length ? { all_sourced: !bare.length } : {}),
    ...(names.length
      ? {
          unsourced: names,
          sentence:
            `Not every figure has a source: ${listed} ${one ? 'has' : 'have'} no usable source — ` +
            `kept in the sums all the same, so whether the parts add up says nothing about ${one ? 'it' : 'them'}.`
        }
      : {}),
    notes: [
      uncited
        ? `${uncited} item${uncited === 1 ? "'s" : "s'"} source_url was NOT among the pages the search engine returned (cited_by_search: false) — the leg opened it directly or wrote it from memory; verify before relying on it.`
        : '',
      unseen
        ? `${unseen} known part${unseen === 1 ? "'s" : "s'"} source_url is backed by no lookup (cited_by_search: false) — no search or page fetch of this chat returned it, no research answer vouches for it, or the research log already holds it as not backed. An address the user gave counts once you have opened it. Open the page before relying on the figure.`
        : '',
      deadLinks
        ? `${deadLinks} figure${deadLinks === 1 ? '' : 's'} named a search-result link that leads to no page — kept without a source_url; verify before relying on it.`
        : ''
    ].filter(Boolean)
  }
}
