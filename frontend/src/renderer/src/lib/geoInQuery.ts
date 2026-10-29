/**
 * Spot a place name in a search query — and do nothing else with it.
 *
 * The geography of a dataset is in NEITHER search index: the backend embeds name │ reference
 * product │ comment │ type keyword, and BM25 covers name + reference product (see
 * `search/indexer.py`, `search/lexical.py`). A region lives only as metadata and as the filter.
 * So "electricity from the German grid" — the most natural phrasing there is — cannot work: the
 * word "German" matches nothing and only pulls the query vector towards words no dataset carries.
 *
 * This runs in the renderer on purpose. Doing it in the backend would put code
 * in the search path for the sake of a remark, and the search has to stay exactly what it was, to
 * the line and to the millisecond. Nothing here touches the query: it is sent as typed, the hits
 * are untouched, and the note is a remark beside the field. The user is never overruled.
 */

/**
 * Written-out places and the adjectives people actually type. Deliberately short and
 * common-language: this feeds a remark, not a lookup, and a missed country costs nothing but a
 * missing remark. No database vocabulary is stored here — the codes come from the user's own
 * index, handed in as `regionOptions`.
 */
const PLACE_WORDS = new Set([
  'germany',
  'german',
  'switzerland',
  'swiss',
  'france',
  'french',
  'italy',
  'italian',
  'spain',
  'spanish',
  'austria',
  'austrian',
  'netherlands',
  'dutch',
  'belgium',
  'belgian',
  'poland',
  'polish',
  'sweden',
  'swedish',
  'norway',
  'norwegian',
  'denmark',
  'danish',
  'finland',
  'finnish',
  'portugal',
  'portuguese',
  'greece',
  'greek',
  'britain',
  'british',
  'england',
  'english',
  'ireland',
  'irish',
  'china',
  'chinese',
  'india',
  'indian',
  'japan',
  'japanese',
  'korea',
  'korean',
  'brazil',
  'brazilian',
  'canada',
  'canadian',
  'mexico',
  'mexican',
  'russia',
  'russian',
  'turkey',
  'turkish',
  'australia',
  'australian',
  'europe',
  'european',
  'america',
  'american',
  'africa',
  'african',
  'asia',
  'asian'
])

/**
 * ISO 3166-1 alpha-3 country codes — but only the ones that cannot be mistaken for something else.
 *
 * PrismLCA's own databases speak alpha-2 plus their aggregates (RER, GLO, RoW …), and those arrive at
 * runtime through `regionOptions`. These three-letter codes are the case somebody types from
 * habit, so they are worth catching — but the full list is a minefield in an LCA search: PER is
 * "per kg", TON is "ton kilometre", CAN is a beverage can, VAT a dyeing vat, FIN a heat-sink fin,
 * PAN a steel pan. Every one of the 249 codes was checked against the en_US spelling dictionary
 * and against a list of LCA and unit terms; 50 fell out that way, and six more by hand — PER and
 * BEL (a unit) because the dictionary does not carry them, plus DOM, PNG, SUR and CIV. What is
 * left is 193 codes that mean nothing else.
 */
const ISO3_CODES = new Set([
  'abw',
  'afg',
  'aia',
  'arg',
  'asm',
  'ata',
  'atf',
  'atg',
  'aus',
  'aut',
  'aze',
  'bdi',
  'bes',
  'bfa',
  'bgd',
  'bgr',
  'bhr',
  'bhs',
  'bih',
  'blm',
  'blr',
  'blz',
  'bmu',
  'bol',
  'brb',
  'brn',
  'btn',
  'bvt',
  'bwa',
  'caf',
  'cck',
  'chl',
  'chn',
  'cmr',
  'cok',
  'cpv',
  'cri',
  'cuw',
  'cxr',
  'cym',
  'cyp',
  'cze',
  'deu',
  'dji',
  'dma',
  'dnk',
  'dza',
  'egy',
  'eri',
  'esh',
  'fji',
  'flk',
  'fra',
  'fsm',
  'gbr',
  'ggy',
  'gha',
  'gib',
  'glp',
  'gmb',
  'gnb',
  'gnq',
  'grc',
  'grd',
  'grl',
  'gtm',
  'guf',
  'hkg',
  'hmd',
  'hnd',
  'hrv',
  'hti',
  'idn',
  'imn',
  'iot',
  'irl',
  'irn',
  'irq',
  'isr',
  'ita',
  'jey',
  'jor',
  'kaz',
  'kgz',
  'khm',
  'kir',
  'kna',
  'kor',
  'kwt',
  'lbn',
  'lbr',
  'lby',
  'lka',
  'lso',
  'ltu',
  'lva',
  'maf',
  'mco',
  'mda',
  'mdg',
  'mdv',
  'mhl',
  'mkd',
  'mli',
  'mlt',
  'mmr',
  'mne',
  'mng',
  'mnp',
  'moz',
  'mrt',
  'msr',
  'mtq',
  'mus',
  'mwi',
  'mys',
  'myt',
  'ncl',
  'ner',
  'nfk',
  'nga',
  'nic',
  'niu',
  'nld',
  'npl',
  'nru',
  'nzl',
  'omn',
  'pak',
  'pcn',
  'phl',
  'plw',
  'pri',
  'prk',
  'prt',
  'pse',
  'pyf',
  'qat',
  'reu',
  'rou',
  'rus',
  'rwa',
  'sau',
  'sdn',
  'sen',
  'sgp',
  'sgs',
  'shn',
  'sjm',
  'slb',
  'sle',
  'slv',
  'smr',
  'som',
  'spm',
  'srb',
  'ssd',
  'stp',
  'svk',
  'swe',
  'swz',
  'sxm',
  'syc',
  'syr',
  'tca',
  'tcd',
  'tgo',
  'tha',
  'tjk',
  'tkl',
  'tls',
  'tto',
  'tur',
  'tuv',
  'twn',
  'tza',
  'uga',
  'ukr',
  'umi',
  'ury',
  'uzb',
  'vct',
  'ven',
  'vgb',
  'vir',
  'vnm',
  'vut',
  'wlf',
  'wsm',
  'yem',
  'zaf',
  'zmb',
  'zwe'
])

/** Multi-word places and the aggregates, matched as phrases. */
const PLACE_PHRASES = [
  'rest of the world',
  'rest of world',
  'united kingdom',
  'united states',
  'south africa',
  'south korea',
  'new zealand',
  'czech republic',
  'saudi arabia'
]

/**
 * Codes that are also everyday English words. These are caught ONLY when written as a code —
 * capitals — because "electricity used in a factory" or "what it costs us" would otherwise light
 * the remark up on half of all queries, and a remark that cries wolf is one nobody reads.
 * Everything else (DE, ES, CH, RER, GLO, RoW …) is caught however it is spelled.
 */
const AMBIGUOUS = new Set([
  'in',
  'it',
  'at',
  'no',
  'us',
  'is',
  'as',
  'be',
  'by',
  'do',
  'so',
  'to',
  'me',
  'my',
  'am',
  'an',
  'or',
  'on',
  'of',
  'if'
])

/**
 * The place-ish terms in a query, in the user's own spelling. Empty when there are none.
 *
 * @param regionOptions the regions the loaded databases actually contain — the app already fetches
 *        them for the region filter, so no codes have to be written down here.
 * @param complete the query is finished — it has been sent. While somebody is still typing, the
 *        LAST word is not judged: "de" is the beginning of "detergent" as often as it is Germany,
 *        and a remark that blinks on and off under the field is worse than one that comes a moment
 *        later. A word followed by a space, or written in capitals, counts
 *        either way — then it is plainly finished.
 */
export function geoTermsInQuery(query: string, regionOptions: string[] = [], complete = false): string[] {
  const q = query.trim()
  if (!q) return []
  const found: string[] = []
  const seen = new Set<string>()
  const add = (t: string): void => {
    const key = t.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      found.push(t)
    }
  }

  const lower = q.toLowerCase()
  for (const phrase of PLACE_PHRASES) {
    if (lower.includes(phrase)) add(phrase)
  }

  // Words as the user typed them, so a code keeps its capitals.
  const words = q.split(/[^A-Za-z-]+/).filter(Boolean)
  // Is the word still under the cursor? Only then is it unfinished — and only if the user has not
  // already put a space behind it, and is not shouting a code in capitals.
  const tail = /[^A-Za-z-]$/.test(query) ? -1 : words.length - 1
  const codes = new Set(regionOptions)
  const lowerCodes = new Set(regionOptions.map((c) => c.toLowerCase()))

  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const lw = w.toLowerCase()
    const isCode = codes.has(w) || (lowerCodes.has(lw) && !AMBIGUOUS.has(lw)) || ISO3_CODES.has(lw)
    const isPlace = PLACE_WORDS.has(lw)
    if (!isCode && !isPlace) continue
    // The word being typed is judged only once it is settled: sent, or shouted as a code.
    if (i === tail && !complete && w === lw) continue
    add(w)
  }
  return found
}
