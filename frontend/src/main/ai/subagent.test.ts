import { describe, expect, it } from 'vitest'
import {
  CitationBook,
  extractJson,
  massBalance,
  needsUpgradePass,
  normalizeDomain,
  normalizeDomains,
  parseBomAnswer,
  parseBomItems,
  parseFindings,
  splitAuthoritativeDomains,
  urlKey,
  type BomItem,
  type WebFinding
} from './subagent'

/**
 * The research sub-agent's fragile part is not the LLM call but what comes back: models wrap JSON in
 * prose or fences, rename fields, and quietly return masses that do not add up. These tests pin the
 * parsing and the mass-balance check — the two things that decide whether the result is safe to
 * model with. (The live end-to-end run is in live-eval.test.ts.)
 */
describe('extractJson', () => {
  it('reads a bare array', () => {
    expect(extractJson('[{"a":1}]')).toEqual([{ a: 1 }])
  })

  it('reads JSON out of a fenced block', () => {
    const text = 'Here you go:\n```json\n[{"component":"cap"}]\n```\nHope that helps!'
    expect(extractJson(text)).toEqual([{ component: 'cap' }])
  })

  it('ignores prose before and after an unfenced array', () => {
    const text = 'Sure. [{"component":"body","mass_kg":0.02}] — sources above.'
    expect(extractJson(text)).toEqual([{ component: 'body', mass_kg: 0.02 }])
  })

  it('reads an object wrapper', () => {
    expect(extractJson('{"items":[{"component":"label"}]}')).toEqual({ items: [{ component: 'label' }] })
  })

  it('throws on answers with no JSON at all', () => {
    expect(() => extractJson('I could not find reliable data.')).toThrow()
    expect(() => extractJson('[{"component": "unterminated"')).toThrow()
  })
})

describe('parseBomItems', () => {
  it('accepts both a bare array and an {items} wrapper', () => {
    const one = parseBomItems([{ component: 'cap', material: 'HDPE', mass_kg: 0.002 }])
    const two = parseBomItems({ items: [{ component: 'cap', material: 'HDPE', mass_kg: 0.002 }] })
    expect(one).toEqual(two)
    expect(one[0]).toMatchObject({ component: 'cap', material: 'HDPE', mass_kg: 0.002 })
  })

  it('tolerates the field-name variants models produce', () => {
    const items = parseBomItems([
      { part: 'body', materials: 'PET', mass: 0.019, source: 'https://example.org/a' },
      { name: 'label', material: 'PP', mass_in_kg: '0.0005' }
    ])
    expect(items.map((i) => i.component)).toEqual(['body', 'label'])
    expect(items[0].source_url).toBe('https://example.org/a')
    expect(items[1].mass_kg).toBeCloseTo(0.0005, 6)
  })

  it('keeps the judgement fields only over the closed vocabularies', () => {
    const items = parseBomItems([
      { component: 'frame', mass_kg: 9, source_class: 'Industry', confidence: 'MEDIUM' },
      { component: 'roof', mass_kg: 2.2, source_class: 'very good', confidence: '4' }
    ])
    expect(items[0]).toMatchObject({ source_class: 'industry', confidence: 'medium' })
    // A numeric confidence is exactly what was refused — words or nothing.
    expect(items[1].source_class).toBeUndefined()
    expect(items[1].confidence).toBeUndefined()
  })

  it('drops entries without a usable component or mass', () => {
    const items = parseBomItems([
      { component: 'ok', mass_kg: 1 },
      { component: '', mass_kg: 2 },
      { component: 'no mass' },
      { component: 'bad mass', mass_kg: 'a lot' },
      'nonsense'
    ])
    expect(items.map((i) => i.component)).toEqual(['ok'])
  })

  // PCFBench (arXiv 2608.27716): 47–86 % of generated BOMs carry zero-mass "ghost" parts and a quarter
  // to a third of the parts go missing. A 0 used to pass as a researched figure and a
  // missing mass deleted the part — both invisible to the balance. Now both are named.
  it('keeps components without a mass as unresolved instead of deleting them or booking a ghost', () => {
    const { items, unresolved } = parseBomAnswer([
      { component: 'body', material: 'PET', mass_kg: 0.019 },
      { component: 'label', material: 'PP', mass_kg: null, note: 'no figure anywhere' },
      { component: 'adhesive', mass_kg: 0 },
      { component: 'ink', mass_kg: 'unknown' },
      { component: '', mass_kg: 1 }
    ])
    expect(items.map((i) => i.component)).toEqual(['body'])
    expect(unresolved).toEqual([
      { component: 'label', material: 'PP', reason: 'no_mass', note: 'no figure anywhere' },
      { component: 'adhesive', reason: 'zero_mass' },
      { component: 'ink', reason: 'no_mass' }
    ])
  })

  it('returns an empty list for non-list input instead of throwing', () => {
    expect(parseBomItems(null)).toEqual([])
    expect(parseBomItems({ nope: true })).toEqual([])
  })

  it('keeps a mass range only when it really brackets the point value', () => {
    const items = parseBomItems([
      { component: 'roof', mass_kg: 2.2, mass_range_kg: [1.8, 2.6] },
      { component: 'alias', mass_kg: 2.2, mass_range: [1.8, 2.6] },
      { component: 'outside', mass_kg: 3.5, mass_range_kg: [1.8, 2.6] },
      { component: 'inverted', mass_kg: 2.2, mass_range_kg: [2.6, 1.8] },
      { component: 'degenerate', mass_kg: 2.2, mass_range_kg: [2.2, 2.2] },
      { component: 'short', mass_kg: 2.2, mass_range_kg: [1.8] },
      { component: 'words', mass_kg: 2.2, mass_range_kg: ['about 2', 'maybe 3'] }
    ])
    expect(items[0].mass_range_kg).toEqual([1.8, 2.6])
    expect(items[1].mass_range_kg).toEqual([1.8, 2.6]) // the field-name variant still counts
    // A range that contradicts the point value is dropped, never "repaired" — the point value is
    // what everything downstream keys on.
    for (const i of items.slice(2)) expect(i.mass_range_kg).toBeUndefined()
    // The entries themselves survive; only the range is refused.
    expect(items).toHaveLength(7)
  })
})

describe('massBalance', () => {
  const items: BomItem[] = [
    { component: 'body', material: 'PET', mass_kg: 0.019 },
    { component: 'cap', material: 'HDPE', mass_kg: 0.0025 },
    { component: 'label', material: 'PP', mass_kg: 0.0005 }
  ]

  it('passes when the parts add up to the stated total', () => {
    const r = massBalance(items, 0.022)
    expect(r.sum_kg).toBeCloseTo(0.022, 6)
    expect(r.balance_ok).toBe(true)
    expect(r.note).toBeUndefined()
  })

  it('fails loudly when they do not, and says how far off', () => {
    const r = massBalance(items, 0.05)
    expect(r.balance_ok).toBe(false)
    expect(r.note).toMatch(/off/)
    expect(r.note).toContain('0.05')
  })

  it('cannot judge without a total, and says so', () => {
    const r = massBalance(items)
    expect(r.balance_ok).toBeNull()
    expect(r.note).toMatch(/No total mass/)
    expect(r.sum_kg).toBeCloseTo(0.022, 6)
  })

  it('treats a nonsensical total as "cannot judge"', () => {
    expect(massBalance(items, 0).balance_ok).toBeNull()
    expect(massBalance(items, -1).balance_ok).toBeNull()
  })

  // The measured case (live run, PVC window): four of six legs came back, summing to
  // 25.7 of 30 kg. 14.3 % fell inside the 15 % tolerance, so the result said `balance_ok: true` in the
  // same breath as "2 of 6 research legs failed" — and the model made the missing 4.3 kg the mass of
  // the PVC profile.
  it('cannot judge a balance when a component was never researched', () => {
    const partial: BomItem[] = [
      { component: 'glass', material: 'soda-lime glass', mass_kg: 20.9 },
      { component: 'steel', material: 'galvanized steel', mass_kg: 3.9 },
      { component: 'seals', material: 'EPDM', mass_kg: 0.4 },
      { component: 'hardware', material: 'steel', mass_kg: 0.5 }
    ]
    const r = massBalance(partial, 30, undefined, { lost: 2 })
    expect(r.balance_ok).toBeNull() // NOT true — this is the whole point
    expect(r.sum_kg).toBeCloseTo(25.7, 6)
    expect(r.residual_kg).toBeCloseTo(4.3, 6)
    expect(r.note).toMatch(/NOT checked/)
    // And it must say what the residual is not: a mass to give to some remaining part.
    expect(r.note).toMatch(/do NOT hand the remainder/i)
  })

  it('cannot judge a balance while a named component has no mass, and names it', () => {
    const r = massBalance(items, 0.022, undefined, { unresolved: ['adhesive', 'ink'] })
    expect(r.balance_ok).toBeNull()
    expect(r.note).toMatch(/no mass found for: adhesive, ink/)
    expect(r.note).toMatch(/do NOT hand the remainder/i)
  })

  it('reports the residual even when the balance passes', () => {
    // 8 % under, inside tolerance — the verdict stands, but 0.0018 kg belongs to nothing named.
    const r = massBalance(items, 0.0238)
    expect(r.balance_ok).toBe(true)
    expect(r.residual_kg).toBeCloseTo(0.0018, 6)
    expect(r.note).toMatch(/not covered by any listed component/)
  })

  it('stays quiet when the residual is negligible', () => {
    const r = massBalance(items, 0.0222)
    expect(r.balance_ok).toBe(true)
    expect(r.note).toBeUndefined()
  })

  it('keeps the residual signed, so over and under are distinguishable', () => {
    expect(massBalance(items, 0.05).residual_kg).toBeGreaterThan(0) // parts miss the total
    expect(massBalance(items, 0.01).residual_kg).toBeLessThan(0) // parts exceed it
  })

  it('reports what the parts can span when ranges came back — and stays silent when none did', () => {
    const ranged: BomItem[] = [
      { component: 'frame', material: 'steel', mass_kg: 9, mass_range_kg: [8, 10] },
      { component: 'roof', material: 'PES', mass_kg: 2.2, mass_range_kg: [1.8, 2.6] },
      { component: 'bag', material: 'PET', mass_kg: 0.7 } // point value, counts as [0.7, 0.7]
    ]
    expect(massBalance(ranged).sum_range_kg).toEqual([10.5, 13.3])
    expect(massBalance(items).sum_range_kg).toBeUndefined()
  })

  it('says on a failed balance whether the ranges could still reach the total', () => {
    const ranged: BomItem[] = [
      { component: 'frame', material: 'steel', mass_kg: 8, mass_range_kg: [8, 12] },
      { component: 'roof', material: 'PES', mass_kg: 1.8, mass_range_kg: [1.8, 2.6] }
    ]
    // Point sum 9.8 vs total 14 = 30 % off, but the spans [9.8, 14.6] contain 14: reachable.
    const reachable = massBalance(ranged, 14)
    expect(reachable.balance_ok).toBe(false)
    expect(reachable.note).toMatch(/ranges DO reach/)
    // Total 20 lies beyond even the maxima: not a placement problem, something is missing.
    const beyond = massBalance(ranged, 20)
    expect(beyond.balance_ok).toBe(false)
    expect(beyond.note).toMatch(/cannot reach/)
    expect(beyond.note).toMatch(/component is missing or the total is wrong/)
  })
})

/**
 * The upgrade pass must stay bounded: it fires only when the leg found something, the model
 * demonstrably uses the judgement tag, and nothing found is stronger than media/community —
 * otherwise every untagging model would buy an extra paid leg per question.
 */
describe('needsUpgradePass', () => {
  const f = (source_class?: string): WebFinding => ({
    text: 'x',
    sources: ['https://e.org/a'],
    ...(source_class ? { source_class } : {})
  })

  it('fires when everything judged is media/community', () => {
    expect(needsUpgradePass([f('media'), f('community')])).toBe(true)
  })

  it('stays quiet once one finding is official or industry', () => {
    expect(needsUpgradePass([f('media'), f('industry')])).toBe(false)
    expect(needsUpgradePass([f('official')])).toBe(false)
  })

  it('stays quiet when the model never tagged — no signal, no paid leg', () => {
    expect(needsUpgradePass([f(), f()])).toBe(false)
    expect(needsUpgradePass([])).toBe(false)
  })

  it('an untagged finding beside a weak tagged one does not block the pass', () => {
    expect(needsUpgradePass([f(), f('media')])).toBe(true)
  })
})

/**
 * The generic web researcher has no mass balance to fall back on, so the source requirement IS the
 * guard against a confidently invented figure — and it has to be enforced in code, not merely asked
 * for in the prompt.
 */
describe('parseFindings', () => {
  it('keeps sourced statements and pulls their URLs out', () => {
    const text = [
      '- German PET bottle collection rate is 98.4% in 2023 (https://example.org/pet-2023)',
      '* Average transport distance to the filler: 180 km (https://stats.example/transport, https://x.example/y)'
    ].join('\n')
    const { findings, dropped } = parseFindings(text)
    expect(dropped).toBe(0)
    expect(findings).toHaveLength(2)
    expect(findings[0].sources).toEqual(['https://example.org/pet-2023'])
    expect(findings[1].sources).toHaveLength(2)
    expect(findings[0].text).not.toMatch(/^[-*]/) // bullet markers stripped
  })

  it('discards an unsourced statement instead of passing it on', () => {
    const text = [
      'Recycled content is typically around 30% for this application.',
      '- Mechanical recycling yield is 72% (https://example.org/yield)'
    ].join('\n')
    const { findings, dropped } = parseFindings(text)
    expect(dropped).toBe(1)
    expect(findings.map((f) => f.text)).toEqual([
      'Mechanical recycling yield is 72% (https://example.org/yield)'
    ])
  })

  it('lets unsourced statements through only when explicitly allowed', () => {
    const { findings } = parseFindings(
      'Recycled content is typically around 30% for this application.',
      false
    )
    expect(findings).toHaveLength(1)
    expect(findings[0].sources).toEqual([])
  })

  it('lifts the judgement tag into fields and off the text', () => {
    const { findings } = parseFindings(
      '- Budget pavilions last 1-3 years (https://example.org/a) [media, medium: two retailer blogs agree]\n' +
        '- Steel recycling rate 98% (https://example.org/b)'
    )
    expect(findings[0]).toMatchObject({
      source_class: 'media',
      confidence: 'medium',
      confidence_note: 'two retailer blogs agree'
    })
    expect(findings[0].text).not.toContain('[media')
    expect(findings[0].sources).toEqual(['https://example.org/a'])
    // A missing tag stays missing — nothing is guessed on this side of the model.
    expect(findings[1].source_class).toBeUndefined()
  })

  // The three shapes the first evaluation run actually produced (z-ai/glm-5.3) — a tag inside
  // a full sentence with a trailing period, a semicolon before the reason, and a long reason. The
  // strict parser lost all 22 tags of that run to these; every finding scored "untagged".
  it('reads the tag through sentence punctuation, a semicolon reason, and a long reason', () => {
    const { findings } = parseFindings(
      '- Soft-top gazebos last 2–5 years (https://example.org/a) [industry, medium: manufacturer blog, but range matches three other independent sources].\n' +
        '- 2.5 Mt bulky waste in 2024 (https://example.org/b) [official, high; preliminary Destatis result, consistent with UBA Länder balances].\n' +
        '- No statistic splits the stream (https://example.org/c) [official, high: plant-survey tables only disaggregate by plant type, not by waste type].'
    )
    expect(findings.map((f) => [f.source_class, f.confidence])).toEqual([
      ['industry', 'medium'],
      ['official', 'high'],
      ['official', 'high']
    ])
    expect(findings[0].confidence_note).toMatch(/three other independent sources/)
    expect(findings[1].confidence_note).toMatch(/preliminary Destatis/)
    for (const f of findings) expect(f.text).not.toContain('[')
  })

  it('strips trailing punctuation from a URL and de-duplicates', () => {
    const { findings } = parseFindings('- Yield is 72% (https://example.org/a., https://example.org/a)')
    expect(findings[0].sources).toEqual(['https://example.org/a'])
  })

  it('ignores noise lines that carry no statement', () => {
    expect(parseFindings('\n- ok\nFindings:\n', false).findings).toEqual([])
  })
})

describe('extractJson — brackets inside strings', () => {
  it('does not end the array at a bracket that sits inside a note', () => {
    const answer =
      'Here you go:\n[{"component":"profile","material":"PVC","mass_kg":1.2,"note":"]-shaped section"}] done'
    expect(extractJson(answer)).toEqual([
      { component: 'profile', material: 'PVC', mass_kg: 1.2, note: ']-shaped section' }
    ])
  })
  it('honours escaped quotes inside strings', () => {
    expect(extractJson('{"a":"say \\"hi]\\"","b":[1]}')).toEqual({ a: 'say "hi]"', b: [1] })
  })
})

describe('domains the model names', () => {
  it('normalises whatever shape a host arrives in, and refuses what is not a host', () => {
    expect(normalizeDomain('https://www.destatis.de/DE/Themen/x.html')).toBe('destatis.de')
    expect(normalizeDomain(' Meffert.DE, ')).toBe('meffert.de')
    expect(normalizeDomain('environdec.com/library?x=1')).toBe('environdec.com')
    expect(normalizeDomain('not a host')).toBeNull()
    expect(normalizeDomain('localhost')).toBeNull()
    expect(normalizeDomain('')).toBeNull()
  })

  it('de-duplicates, drops junk and caps the list', () => {
    expect(normalizeDomains(['a.de', 'https://www.a.de/x', 'b.org', 42, 'nope'])).toEqual(['a.de', 'b.org'])
    expect(normalizeDomains(['a.de', 'b.de', 'c.de'], 2)).toEqual(['a.de', 'b.de'])
    expect(normalizeDomains('a.de')).toEqual([])
  })

  it('takes the authoritative_domains line off the answer so it is not dropped as unsourced', () => {
    const text =
      'Gazebos last 2–5 seasons (https://blog.example/x) [media, low: one buying guide]\n' +
      'authoritative_domains: destatis.de, https://www.ral.de/, example-maker.com\n'
    const r = splitAuthoritativeDomains(text)
    expect(r.domains).toEqual(['destatis.de', 'ral.de', 'example-maker.com'])
    expect(r.text).not.toMatch(/authoritative/)
    const parsed = parseFindings(r.text)
    expect(parsed.findings).toHaveLength(1)
    expect(parsed.dropped).toBe(0)
  })

  it('reads the line as a bullet, in either spelling, and ignores an answer without one', () => {
    expect(splitAuthoritativeDomains('- Authoritative domain: a.de').domains).toEqual(['a.de'])
    expect(splitAuthoritativeDomains('authoritative_domains: a.de; b.de c.de').domains).toEqual([
      'a.de',
      'b.de',
      'c.de'
    ])
    expect(splitAuthoritativeDomains('plain finding (https://x.y)')).toEqual({
      domains: [],
      text: 'plain finding (https://x.y)'
    })
  })
})

describe('evidence from the engine', () => {
  it('keys URLs so scheme, www, fragment and trailing punctuation do not make a different page', () => {
    expect(urlKey('https://www.Example.org/a/b/#top')).toBe('example.org/a/b')
    expect(urlKey('http://example.org/a/b).')).toBe('example.org/a/b')
    expect(urlKey('example.org/a/b')).toBe('example.org/a/b')
  })

  it('collects citations once per page, keeps the first excerpt and finds the pages behind sources', () => {
    const book = new CitationBook()
    book.add([{ url: 'https://a.de/p', title: 'A', excerpt: '  mass:   2 kg  ' }])
    book.add([{ url: 'http://www.a.de/p/', excerpt: 'later' }, { url: 'https://b.de/q' }])
    book.add([{ url: 'https://b.de/q', excerpt: 'B says 3 kg' }])
    expect(book.size).toBe(2)
    expect(book.has('https://A.de/p#x')).toBe(true)
    expect(book.has('https://c.de')).toBe(false)
    expect(book.evidenceFor(['https://b.de/q', 'https://a.de/p', 'https://c.de', 'https://b.de/q'])).toEqual([
      { url: 'https://b.de/q', excerpt: 'B says 3 kg' },
      { url: 'https://a.de/p', title: 'A', excerpt: 'mass: 2 kg' }
    ])
  })

  it('caps an excerpt so a whole page never rides along', () => {
    const book = new CitationBook()
    book.add([{ url: 'https://a.de', excerpt: 'x'.repeat(5000) }])
    expect(book.evidenceFor(['https://a.de'])[0].excerpt).toHaveLength(400)
  })
})
