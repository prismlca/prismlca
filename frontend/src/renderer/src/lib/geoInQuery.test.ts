import { describe, expect, it } from 'vitest'
import { geoTermsInQuery } from './geoInQuery'

/**
 * The remark exists because geography is in neither search index. What matters just as much is when
 * it stays quiet: a remark that fires on ordinary queries is one nobody reads, and this one sits
 * right above the results.
 */
describe('geoTermsInQuery', () => {
  const REGIONS = ['CH', 'DE', 'ES', 'RER', 'RoW', 'GLO', 'IN', 'IT', 'US']

  it('spots a written-out place and the adjective people actually type', () => {
    expect(geoTermsInQuery('electricity from the German grid', REGIONS)).toEqual(['German'])
    expect(geoTermsInQuery('glass production in Switzerland', REGIONS)).toEqual(['Switzerland'])
  })

  it('spots a database code, in the spelling the database uses', () => {
    expect(geoTermsInQuery('electricity medium voltage DE', REGIONS)).toEqual(['DE'])
    expect(geoTermsInQuery('steel RER', REGIONS)).toEqual(['RER'])
  })

  it('spots a code written in lower case too, once it is settled', () => {
    // The typical ones: es, de, rer, row, glo. None of them is an English word, so the spelling
    // does not have to be shouted — it only has to be finished.
    expect(geoTermsInQuery('steel rer ', REGIONS)).toEqual(['rer'])
    expect(geoTermsInQuery('electricity de ', REGIONS)).toEqual(['de'])
    expect(geoTermsInQuery('olive oil es ', REGIONS)).toEqual(['es'])
    expect(geoTermsInQuery('aluminium row ', REGIONS)).toEqual(['row'])
    expect(geoTermsInQuery('steel glo', REGIONS, true)).toEqual(['glo'])
  })

  it('holds its tongue while a word is still being typed', () => {
    // "de" is the start of "detergent" as often as it is Germany. A remark that blinks on and off
    // under the field is worse than one that arrives a moment later.
    expect(geoTermsInQuery('detergent for de', REGIONS)).toEqual([])
    // …but a space behind it settles the matter, and so do capitals.
    expect(geoTermsInQuery('detergent for de ', REGIONS)).toEqual(['de'])
    expect(geoTermsInQuery('detergent for DE', REGIONS)).toEqual(['DE'])
    // And once the search has been sent, the last word counts like any other.
    expect(geoTermsInQuery('detergent for de', REGIONS, true)).toEqual(['de'])
  })

  it('judges every word but the last one right away', () => {
    // The place is mid-sentence, so it is finished whatever comes after it.
    expect(geoTermsInQuery('de electri', REGIONS)).toEqual(['de'])
  })

  it('stays quiet on a query with no place in it', () => {
    expect(geoTermsInQuery('freight transport by truck', REGIONS)).toEqual([])
    expect(geoTermsInQuery('corrugated board box production', REGIONS)).toEqual([])
    expect(geoTermsInQuery('', REGIONS)).toEqual([])
  })

  it('does not mistake English words for country codes', () => {
    // "in", "it" and "us" are country codes AND ordinary words. Matching case-insensitively would
    // fire the remark on half of all queries — which is why a code has to be written as a code.
    expect(geoTermsInQuery('electricity used in a factory', REGIONS)).toEqual([])
    expect(geoTermsInQuery('what it costs us', REGIONS)).toEqual([])
  })

  it('catches an unambiguous three-letter code, even without a loaded index', () => {
    expect(geoTermsInQuery('electricity DEU', [])).toEqual(['DEU'])
    expect(geoTermsInQuery('steel from CHN ', [])).toEqual(['CHN'])
    expect(geoTermsInQuery('cement fra ', [])).toEqual(['fra'])
  })

  it('keeps quiet on the three-letter codes that are also LCA words', () => {
    // The whole reason the alpha-3 list was filtered: these are ordinary search queries, not
    // countries. PER (Peru), TON (Tonga), CAN (Canada), VAT (Vatican), FIN (Finland), PAN (Panama).
    for (const q of [
      'emissions per kg ',
      'transport, ton kilometre ',
      'aluminium can production ',
      'dyeing vat ',
      'heat sink fin ',
      'steel pan ',
      'and the rest ',
      'these are the values '
    ]) {
      expect(geoTermsInQuery(q, [], true), q).toEqual([])
    }
  })

  it('catches the aggregate names, which are the ones people write out', () => {
    expect(geoTermsInQuery('aluminium, rest of world', REGIONS)).toEqual(['rest of world'])
  })

  it('reports each place once, in the user’s own spelling', () => {
    expect(geoTermsInQuery('German electricity for a German plant', REGIONS)).toEqual(['German'])
  })

  it('works without a region list — the remark must not depend on a loaded index', () => {
    expect(geoTermsInQuery('electricity from the German grid')).toEqual(['German'])
  })
})
