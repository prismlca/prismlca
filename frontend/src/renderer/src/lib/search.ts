import { useEffect, useMemo, useState } from 'react'
import { api, type DatabaseInfo } from './api'
import { errMsg } from './errors'
import { fmtInt } from './format'

/** Shared semantic-search machinery used by the canvas search panel and the
 * add-background-dataset dialog: result types, database pickers and the search
 * state hook (query, filters, geo-variant collapse). */

export interface GeoVariant {
  code: string
  geography: string | null
  database: string
}

export interface SearchHit {
  code: string
  name: string
  database: string
  geography: string | null
  activity_type: string
  product?: string | null // reference product — distinguishes multi-output twins (co-generation)
  unit?: string | null
  variants?: GeoVariant[]
  score?: number
  /** Below the similarity threshold: a neighbour the search had to offer, not a match. The backend
   *  has always set this; the UI shows it as a weak-match flag. */
  weak?: boolean
}

/** What the backend says about the answer as a whole, beyond the hits themselves. */
interface SearchAnswer {
  hits: SearchHit[]
  weak_match?: boolean
  terms_not_in_results?: string[]
  outside_geography_filter?: string
  /** Set when the query carried an abbreviation the backend also searched spelled out ("PET" →
   *  "polyethylene terephthalate", derived from the database's own synonyms). */
  searched_as?: { query: string; replaced: Record<string, string> }
}

/**
 * The answer's honesty signals, as short lines for a person.
 *
 * The backend has computed these for a long time and the panel threw all of them away, keeping only
 * `hits` — so a search that found nothing resembling the query looked exactly like one that found
 * the right dataset. Deliberately NOT the same wording the assistant gets: those sentences argue a
 * model out of a mistake and run three lines; someone reading a list wants the fact.
 *
 * The per-database word count (`databases_searched[].best_match_words`, "No result from X contains a
 * word of your search") is deliberately NOT among them, though the backend still sends it and the
 * assistant still reads it. It counts literal words, so the lorry/truck case reads as a verdict on a
 * database that in fact holds the right dataset under another name — and the rows it speaks about
 * sit at the bottom of the list anyway, where they already look like what they are.
 * Nothing about them is filtered or demoted; the line only ever described the result.
 */
export function searchNotes(res: SearchAnswer): string[] {
  const notes: string[] = []
  if (res.weak_match) notes.push('Nothing here really resembles your search — read these as neighbours.')
  if (res.terms_not_in_results?.length)
    notes.push(
      `No result's name or product contains: ${res.terms_not_in_results.map((t) => `“${t}”`).join(', ')}. ` +
        'It may be listed under another name.'
    )
  if (res.outside_geography_filter) notes.push(res.outside_geography_filter)
  return notes
}

/** Databases you can search: process inventories only. The biosphere holds elementary flows,
 * not processes, and isn't semantically indexed — never offer it in the process search. */
export function searchableDbs(dbs: DatabaseInfo[]): DatabaseInfo[] {
  return dbs.filter((d) => d.kind !== 'biosphere')
}

/** What the dataset search offers as a place to look: the background inventories and the project's
 *  library. NOT the models — you are searching for something to put INTO the model you are editing,
 *  and a checkbox per model turned a two-line list into fifty-three. */
export function searchTargets(dbs: DatabaseInfo[]): DatabaseInfo[] {
  // Backgrounds first (largest on top), the library always last — the same order as the chat's
  // "+" menu, so the two lists read alike.
  const backgrounds = dbs.filter((d) => d.kind === 'background').sort((a, b) => b.node_count - a.node_count)
  const libraries = dbs.filter((d) => d.kind === 'library')
  return [...backgrounds, ...libraries]
}

/** Default the search at the largest read-only (background inventory) DB — that's what you
 * search. biosphere is excluded (see searchableDbs). */
export function bestSearchDb(dbs: DatabaseInfo[]): string {
  const searchable = searchableDbs(dbs)
  const ro = searchable.filter((d) => d.read_only).sort((a, b) => b.node_count - a.node_count)
  return (ro[0] ?? searchable[0])?.name ?? ''
}

/** What the search covers before anybody touches a checkbox: the background inventory and, if the
 *  project has one, the library. Both, because a dataset you built yourself is exactly as valid an
 *  answer to "what do I put here" as one from ecoinvent — and a library nobody searches is a
 *  library nobody uses. */
export function defaultSearchDbs(dbs: DatabaseInfo[]): string[] {
  const best = bestSearchDb(dbs)
  const library = dbs.find((d) => d.kind === 'library')?.name
  return [best, library].filter((n): n is string => !!n && n !== '')
}

/** A short, human label for a background database name: `ecoinvent-3.12-cutoff` → "ecoinvent 3.12",
 *  `bafu-2026-v1` → "BAFU 2026". Used where two backgrounds sit side by side and a hit must say
 *  whose it is; the full name stays where it is quoted (prompts, provenance). */
export function shortDbLabel(name: string): string {
  const m = /^(ecoinvent|bafu)[-_ ](\d+(?:\.\d+)?)/i.exec(name)
  if (!m) return name
  const provider = m[1].toLowerCase() === 'bafu' ? 'BAFU' : 'ecoinvent'
  return `${provider} ${m[2]}`
}

/** A hit's name as the result list prints it: cut after 100 characters with an ellipsis, the full
 *  name in the tooltip. Some BAFU datasets carry names of 150+ characters that turned a result row into
 *  a paragraph. Prompt, provenance and details keep the full name. */
export const NAME_CLIP = 100
export function clipName(name: string): string {
  return name.length > NAME_CLIP ? `${name.slice(0, NAME_CLIP).trimEnd()}…` : name
}

/** The chip's classes for a background database: navy for ecoinvent, violet for BAFU
 *  — so two backgrounds side by side differ by colour before the label is read. Unknown
 *  families keep the plain background chip. */
export function bgChipClass(name: string): string {
  return /^bafu[-_ ]/i.test(name) ? 'chip bg bafu' : 'chip bg'
}

/** The other background databases beside the one searched by default (only
 *  the largest is pre-ticked; a second one — BAFU beside ecoinvent — is opt-in, in the search panel
 *  and in the chat alike). */
export function secondaryBackgrounds(dbs: DatabaseInfo[]): string[] {
  const primary = bestSearchDb(dbs)
  return dbs.filter((d) => d.kind === 'background' && d.name !== primary).map((d) => d.name)
}

/** The regions that lead a hit's region picker: the global dataset, then the rest-of-the-world one — the
 *  two a modeller looks for when the study's own region is missing. The others stay alphabetical. */
export const VARIANT_PICKER_PINS = ['GLO', 'RoW'] as const

/** One collapsed result groups an activity's geo-variants under this key. Mirrors the backend's
 * collapse key (name + reference product + type): without the product, two multi-output twins
 * (e.g. co-generation producing heat vs. electricity) would share one picked-geo state. */
export function groupKey(h: SearchHit): string {
  return `${h.database}|${h.name}|${h.product ?? ''}|${h.activity_type}`
}

/** The concrete region variant to use — undefined for a multi-region result until the user picks
 * one (no default selection); a single-region result resolves directly. */
export function variantFor(h: SearchHit, pickedGeo: Record<string, string>): GeoVariant | undefined {
  const vs = h.variants ?? []
  if (vs.length <= 1) return vs[0] ?? { code: h.code, geography: h.geography, database: h.database }
  const code = pickedGeo[groupKey(h)]
  return code ? vs.find((v) => v.code === code) : undefined
}

/** Search state + actions shared by both search UIs. Errors are routed through `onError`
 * (message, or null when a new search starts) so each host surfaces them its own way. */
export function useActivitySearch(
  /** One database, or several — the search panel lets the user tick ecoinvent and their library. */
  searchDb: string | string[],
  onError?: (message: string | null) => void
): {
  query: string
  /** The query as it was last sent — not what is in the field now. */
  sentQuery: string
  setQuery: (q: string) => void
  hits: SearchHit[]
  /** Short lines about the ANSWER — see `searchNotes`. Empty when there is nothing to say. */
  notes: string[]
  searching: boolean
  searched: boolean
  typeSel: string[]
  toggleType: (t: string) => void
  regionSel: string[]
  addRegion: (r: string) => void
  removeRegion: (r: string) => void
  regionOptions: string[]
  pickedGeo: Record<string, string>
  pickGeo: (key: string, code: string) => void
  pickedVariant: (h: SearchHit) => GeoVariant | undefined
  resolveHit: (h: SearchHit) => SearchHit
  doSearch: () => void
  /** What the last search ALSO looked for, besides the text as typed — null when it added nothing. */
  alsoSearchedAs: string | null
  /** The query the last search took literally (after "Search only for …"); null otherwise. */
  searchedLiterally: string | null
  /** Repeat the last search with the text exactly as typed — for this one search, not a setting. */
  searchLiteral: () => void
  /** Show a whole database instead of a search result — see `listAll`. */
  listAll: (database: string) => void
  /** What is on screen when it did not come from a query ("all 42 in My processes"). */
  listing: string | null
} {
  // JSON, not join: a database name may contain any character, and this only feeds effect deps.
  const dbs = useMemo(() => (Array.isArray(searchDb) ? searchDb : [searchDb]).filter(Boolean), [searchDb])
  const dbKey = JSON.stringify(dbs)
  const [query, setQuery] = useState('')
  const [typeSel, setTypeSel] = useState<string[]>([]) // P/M/G, empty = all
  const [regionSel, setRegionSel] = useState<string[]>([])
  const [regionOptions, setRegionOptions] = useState<string[]>([])
  const [hits, setHits] = useState<SearchHit[]>([])
  const [notes, setNotes] = useState<string[]>([])
  const [pickedGeo, setPickedGeo] = useState<Record<string, string>>({}) // group key → chosen variant code
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false) // a query has been run at least once
  // What was actually SENT, as opposed to what stands in the field. The geography remark uses it to
  // tell a finished word from one still under the cursor (see lib/geoInQuery.ts).
  const [sentQuery, setSentQuery] = useState('')
  const [listing, setListing] = useState<string | null>(null) // set while showing a whole database
  const [alsoSearchedAs, setAlsoSearchedAs] = useState<string | null>(null)
  const [searchedLiterally, setSearchedLiterally] = useState<string | null>(null)

  // Region autocomplete for whatever is being searched (silent if not indexed). The union across
  // the ticked databases: a region the library uses is worth offering even when ecoinvent has more.
  useEffect(() => {
    const names = JSON.parse(dbKey) as string[]
    if (!names.length) return
    void (async () => {
      const lists = await Promise.all(
        names.map((db) =>
          api<string[]>('GET', `/api/v1/search/geographies/${encodeURIComponent(db)}`).catch(() => [])
        )
      )
      setRegionOptions([...new Set(lists.flat())].sort())
    })()
  }, [dbKey])

  /** Everything in one database, no query. "What have I actually got in there" is a question
   *  with no search term, and making somebody invent one is how a library stays unused. */
  const listAll = (database: string): void => {
    if (searching) return
    setSearching(true)
    setSearched(true)
    setQuery('')
    void (async () => {
      try {
        onError?.(null)
        setNotes([]) // a full listing answers no query, so it carries no signals about one
        setAlsoSearchedAs(null)
        setSearchedLiterally(null)
        const res = await api<{ hits: SearchHit[]; count: number; total: number }>(
          'GET',
          `/api/v1/search/list?database=${encodeURIComponent(database)}`
        )
        setHits(res.hits)
        setListing(
          res.count < res.total
            ? `The first ${fmtInt(res.count)} of ${fmtInt(res.total)} in ${database}`
            : `All ${fmtInt(res.count)} in ${database}`
        )
      } catch (e) {
        onError?.(errMsg(e))
      } finally {
        setSearching(false)
      }
    })()
  }

  const run = (text: string, literal: boolean): void => {
    // An empty list is not "everything": the backend reads it as its default ecoinvent, and Enter
    // searched a database the user had just unticked. The button was disabled.
    if (searching || !text.trim() || !dbs.length) return
    setSearching(true)
    setSearched(true)
    setSentQuery(text)
    setListing(null) // a query replaces a listing; the line above the results must not lie
    void (async () => {
      try {
        onError?.(null)
        const res = await api<SearchAnswer>('POST', '/api/v1/search/activities', {
          query: text,
          // Only for the one search the "Search only for …" link starts; the next query expands again.
          literal: literal || undefined,
          databases: dbs,
          activity_types: typeSel.length ? typeSel : undefined,
          geographies: regionSel.length ? regionSel : undefined,
          // Per BACKGROUND database: the backend lengthens the list when a second one is ticked, so
          // a second box adds datasets instead of crowding out the first. 150 is where it stops.
          limit: 50,
          limit_cap: 150,
          reserve: 3,
          // Every region of a collapsed hit: a person picks one from the list, so the assistant's cap of
          // twelve — which left Germany out of the electricity market's list (V347) — does not apply.
          variants_cap: 0
        })
        setHits(res.hits)
        setNotes(searchNotes(res))
        setAlsoSearchedAs(res.searched_as?.query ?? null)
        setSearchedLiterally(literal ? text : null)
      } catch (e) {
        onError?.(errMsg(e))
      } finally {
        setSearching(false)
      }
    })()
  }

  const doSearch = (): void => run(query, false)
  const searchLiteral = (): void => run(sentQuery, true)

  const toggleType = (t: string): void =>
    setTypeSel((s) => (s.includes(t) ? s.filter((x) => x !== t) : [...s, t]))
  const addRegion = (r: string): void => {
    const v = r.trim()
    if (v && !regionSel.includes(v)) setRegionSel((s) => [...s, v])
  }
  const removeRegion = (r: string): void => setRegionSel((s) => s.filter((x) => x !== r))
  const pickGeo = (key: string, code: string): void => setPickedGeo((s) => ({ ...s, [key]: code }))

  const pickedVariant = (h: SearchHit): GeoVariant | undefined => variantFor(h, pickedGeo)
  const resolveHit = (h: SearchHit): SearchHit => {
    const v = pickedVariant(h)
    return v ? { ...h, ...v } : h
  }

  return {
    query,
    sentQuery,
    setQuery,
    hits,
    notes,
    searching,
    searched,
    typeSel,
    toggleType,
    regionSel,
    addRegion,
    removeRegion,
    regionOptions,
    pickedGeo,
    pickGeo,
    pickedVariant,
    resolveHit,
    doSearch,
    alsoSearchedAs,
    searchedLiterally,
    searchLiteral,
    listAll,
    listing
  }
}
