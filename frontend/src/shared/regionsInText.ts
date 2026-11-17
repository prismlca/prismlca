/**
 * The regions a piece of prose names, as the location codes datasets carry: "made in Belgium, sold in
 * Germany" → ["BE", "DE"], "Verkauf und Entsorgung in Deutschland" → ["DE"], "electricity DE" → ["DE"].
 *
 * Only the codes handed in can be found — the regions the searched databases actually hold — so nothing
 * here lists places, and a name that is no dataset location ("European Union") is never returned. A code is
 * recognised as written ("DE", "RoW", "Europe without Switzerland") and by its name: the workspace's own and
 * our short list (geographyNames.ts), and for a country the runtime's ICU names in the languages a study is
 * most likely written in — the study's geography is free text, and the runs that needed this wrote it in
 * German. Whole words only, case as written, so "jersey fabric" names no island; where two names overlap the
 * longer one wins, so "Papua New Guinea" is not also Guinea and "Europe without Switzerland" not also Europe.
 * The overlap is settled over every country the runtime knows BEFORE the databases' regions are applied: a
 * database without Papua New Guinea must not hear Guinea in its name.
 */
import { type GeoNames, geoName } from './geographyNames'

/** Languages whose country names are recognised besides the workspace's English ones. */
const STUDY_LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'pt']

const displayNames = new Map<string, Intl.DisplayNames | null>()

function countryName(code: string, locale: string): string | undefined {
  let names = displayNames.get(locale)
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' })
    } catch {
      names = null // a runtime without ICU region names: codes and workspace names still work
    }
    displayNames.set(locale, names)
  }
  try {
    return names?.of(code) ?? undefined
  } catch {
    return undefined
  }
}

const WORD_CHAR = /[\p{L}\p{N}]/u

let icuCountries: string[] | undefined

/** Every two-letter code the runtime has an English name for — computed once. */
function knownCountries(): string[] {
  if (!icuCountries) {
    icuCountries = []
    for (let a = 65; a <= 90; a++)
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b)
        if (countryName(code, 'en')) icuCountries.push(code)
      }
  }
  return icuCountries
}

function spellings(code: string, names: GeoNames): Set<string> {
  const out = new Set<string>([code])
  const own = geoName(code, names)
  if (own) out.add(own)
  if (/^[A-Z]{2}$/.test(code))
    for (const locale of STUDY_LANGUAGES) {
      const name = countryName(code, locale)
      if (name) out.add(name)
    }
  return out
}

/** The regions `text` names, in the order it first names them. */
export function regionsInText(text: string, codes: Iterable<string>, names: GeoNames = {}): string[] {
  if (!text.trim()) return []
  const held = new Set(codes)
  const spans: Array<{ start: number; end: number; code: string }> = []
  for (const code of new Set([...held, ...knownCountries()])) {
    if (!code) continue
    for (const spelling of spellings(code, names)) {
      for (let at = text.indexOf(spelling); at >= 0; at = text.indexOf(spelling, at + 1)) {
        const end = at + spelling.length
        if (!WORD_CHAR.test(text[at - 1] ?? '') && !WORD_CHAR.test(text[end] ?? ''))
          spans.push({ start: at, end, code })
      }
    }
  }
  // Longest first: a match inside a longer one is the shorter name of something else.
  spans.sort((x, y) => y.end - y.start - (x.end - x.start) || x.start - y.start)
  const kept: typeof spans = []
  for (const s of spans) if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s)
  kept.sort((x, y) => x.start - y.start)
  return [...new Set(kept.filter((k) => held.has(k.code)).map((k) => k.code))]
}
