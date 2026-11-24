import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AiProviderError } from './providers/types'
import {
  ResearchTimeout,
  extractJson,
  figureLine,
  legFailure,
  narrowDomains,
  retryCanHelp,
  needsUpgradePass,
  normalizeDomain,
  normalizeDomains,
  parseFindings,
  researchWeb,
  splitAuthoritativeDomains,
  type WebFinding
} from './subagent'
import { chat } from './test/fakeStream'

// Only the upgrade-pass block at the end runs legs; every other test here is pure parsing.
vi.mock('./client', async () => (await import('./test/fakeStream')).clientModuleMock())

/**
 * The research sub-agent's fragile part is not the LLM call but what comes back: models wrap JSON in
 * prose or fences and leave statements unsourced. These tests pin the shared JSON extraction, the
 * web researcher's parsing and its upgrade pass; the bill of materials has its own (bomAnswer.test.ts,
 * bomBalance.test.ts).
 * (The live end-to-end run is in live-eval.test.ts.)
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

  it("narrows a caller's allow list by the hosts a leg suggests, and never widens it", () => {
    expect(narrowDomains([], ['destatis.de'])).toEqual(['destatis.de'])
    expect(narrowDomains(['meffert.de'], [])).toEqual(['meffert.de'])
    expect(narrowDomains(['meffert.de'], ['destatis.de'])).toEqual(['meffert.de'])
    expect(narrowDomains(['meffert.de', 'hornbach.de'], ['shop.meffert.de', 'destatis.de'])).toEqual([
      'shop.meffert.de'
    ])
    expect(narrowDomains(['shop.meffert.de'], ['meffert.de'])).toEqual(['shop.meffert.de'])
    // Ending in the same letters does not make a host part of a domain.
    expect(narrowDomains(['meffert.de'], ['notmeffert.de'])).toEqual(['meffert.de'])
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

describe('a failed research leg', () => {
  it('is retried unless the provider refused the key, the account or the model', () => {
    expect(retryCanHelp(new ResearchTimeout('ran past'))).toBe(true)
    expect(retryCanHelp(new Error('connection reset'))).toBe(true)
    expect(retryCanHelp(new AiProviderError('busy', 'rate_limit', true))).toBe(true)
    for (const code of ['auth', 'no_key', 'credits', 'no_endpoint'] as const)
      expect(retryCanHelp(new AiProviderError('refused', code))).toBe(false)
  })

  it('says "ran out of time" only when it did, and the error otherwise', () => {
    expect(legFailure(new ResearchTimeout('The research ran past its 6-minute budget.'))).toBe(
      'ran out of time'
    )
    expect(legFailure(new AiProviderError('OpenRouter API key invalid or missing.', 'auth'))).toBe(
      'OpenRouter API key invalid or missing'
    )
    expect(legFailure(new Error('x'.repeat(200)))).toMatch(/^x{87}…$/)
  })
})

/**
 * The upgrade pass on scripted legs: where it searches, when it stays out, what it is asked to confirm,
 * and what counts as the stronger source it went for.
 */
describe('the upgrade pass', () => {
  const blog = 'https://pavilion-blog.example/guide'
  const weak = (url = blog, text = 'Garden pavilions last 1-3 years'): string =>
    `- ${text} (${url}) [media, medium: two retailer blogs agree]`
  const strong = (url: string, text = 'A steel pavilion is rated for 5 years'): string =>
    `- ${text} (${url}) [industry, high: the manufacturer's datasheet]`
  /** The question each leg was asked, and the system brief it ran under. */
  const asked = (): string[] => chat.seen.map((c) => String(c.messages.at(-1)?.content ?? ''))
  const system = (i: number): string => String(chat.seen[i]?.messages[0]?.content ?? '')
  const question = 'How long does a garden pavilion last?'

  beforeEach(() => {
    chat.seen.length = 0
    chat.rounds = []
  })

  it('searches only inside the hosts the caller restricted the call to', async () => {
    // A suggestion on the caller's domain narrows the search to it; the foreign one is left out.
    chat.rounds = [
      { text: `${weak()}\nauthoritative_domains: shop.meffert.de, destatis.de` },
      { text: 'not found' }
    ]
    await researchWeb({ question, domains: ['meffert.de'] })
    expect(chat.seen.map((c) => c.webDomains)).toEqual([['meffert.de'], ['shop.meffert.de']])

    // Suggestions all elsewhere: the caller's hosts alone.
    chat.seen.length = 0
    chat.rounds = [{ text: `${weak()}\nauthoritative_domains: destatis.de` }, { text: 'not found' }]
    const r = await researchWeb({ question, domains: ['meffert.de'] })
    expect(chat.seen[1].webDomains).toEqual(['meffert.de'])
    expect(asked()[1]).toContain('restricted to these hosts: meffert.de.')
    expect(r.note).toContain('(searched on meffert.de)')
    expect(r.suggested_domains).toEqual(['destatis.de'])

    // No list from the caller: the leg's own suggestion is the list.
    chat.seen.length = 0
    chat.rounds = [{ text: `${weak()}\nauthoritative_domains: destatis.de` }, { text: 'not found' }]
    await researchWeb({ question })
    expect(chat.seen.map((c) => c.webDomains)).toEqual([undefined, ['destatis.de']])
  })

  it('stays out when the clock ended the first pass, whatever that pass had written', async () => {
    vi.useFakeTimers()
    try {
      chat.rounds = [{ text: weak(), stall: true }, { text: strong('https://maker.example/sheet.pdf') }]
      const run = researchWeb({ question })
      await vi.advanceTimersByTimeAsync(360_000)
      const r = await run
      expect(chat.seen).toHaveLength(1)
      expect(r.findings.map((f) => f.source_class)).toEqual(['media'])
      expect(r.note ?? '').not.toMatch(/upgrade/)

      // Cut off before anything sourced was written: the short retry follows, not the long pass again,
      // and no upgrade after it either.
      chat.seen.length = 0
      chat.rounds = [
        { text: 'Garden pavilions usually last a few years, according to', stall: true },
        { text: weak() }
      ]
      const retried = researchWeb({ question })
      await vi.advanceTimersByTimeAsync(360_000)
      const r2 = await retried
      expect(chat.seen).toHaveLength(2)
      expect(asked()[1]).toMatch(/BE BRIEF: the three most decisive findings/)
      expect(system(1)).toMatch(/Time budget: about 2 minutes/)
      expect(r2.findings).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is handed every figure with its URL, also a long one', async () => {
    const long = `A 3 x 3 m garden pavilion with a powder-coated steel frame ${'and a polyester roof '.repeat(20)}lasts 1-3 years`
    // Google's redirect links run to a couple of hundred characters on their own.
    const redirect = `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${'A'.repeat(180)}`
    chat.rounds = [
      { text: `${weak(blog, long)}\n${weak(redirect, 'Cheap pavilions last one season')}` },
      { text: 'not found' }
    ]
    await researchWeb({ question })
    const figures = asked()[1].split('Figures to confirm:\n')[1].split('\n')
    expect(figures).toHaveLength(2)
    expect(figures[0]).toMatch(
      /^- A 3 x 3 m garden pavilion .*… \(https:\/\/pavilion-blog\.example\/guide\)$/
    )
    expect(figures[0].length).toBeLessThan(long.length)
    expect(figures[1]).toBe(`- Cheap pavilions last one season (${redirect})`)
  })

  it('cuts the statement of a long figure, never its sources', () => {
    const a = 'https://a.example/1'
    const b = 'https://b.example/2'
    expect(figureLine({ text: `${'x'.repeat(390)} (${a}; ${b}) more`, sources: [a, b] })).toBe(
      `${'x'.repeat(390)} more (${a}, ${b})`
    )
    expect(figureLine({ text: `${'y'.repeat(500)} (${a})`, sources: [a] })).toBe(`${'y'.repeat(400)}… (${a})`)
    expect(figureLine({ text: `short (${a})`, sources: [a] })).toBe(`short (${a})`)
  })

  it('counts only a page the first pass did not cite as the stronger source', async () => {
    // The same blog in other words, tagged "industry" this time, is no upgrade.
    chat.rounds = [
      { text: weak() },
      { text: strong('http://www.pavilion-blog.example/guide/', 'Pavilions are rated for 1-3 years') }
    ]
    let r = await researchWeb({ question })
    expect(r.findings).toHaveLength(1)
    expect(r.note).toMatch(/found no official or industry source/)

    // Nor when the pass quotes the provider's link to that page.
    const redirect = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZ9xyz'
    chat.seen.length = 0
    chat.rounds = [
      { text: weak() },
      { text: strong(redirect), after: [{ type: 'citations', citations: [{ url: blog, via: [redirect] }] }] }
    ]
    r = await researchWeb({ question })
    expect(r.findings).toHaveLength(1)

    // Nor when it quotes a provider's link whose resolution failed: it may lead to that same blog.
    chat.seen.length = 0
    chat.rounds = [
      { text: weak() },
      { text: strong(redirect), after: [{ type: 'citations', citations: [{ url: redirect }] }] }
    ]
    r = await researchWeb({ question })
    expect(r.findings).toHaveLength(1)

    // Nor when the first pass quoted a link it could not resolve and the upgrade pass, resolving it,
    // finds the page behind it.
    chat.seen.length = 0
    chat.rounds = [
      { text: weak(redirect), after: [{ type: 'citations', citations: [{ url: redirect }] }] },
      { text: strong(blog), after: [{ type: 'citations', citations: [{ url: blog, via: [redirect] }] }] }
    ]
    r = await researchWeb({ question })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].sources).toEqual([blog])

    // The manufacturer's datasheet on the host of its shop page is a new page, and it counts.
    chat.seen.length = 0
    chat.rounds = [
      { text: weak('https://maker.example/shop/pavilion-3x3', 'The 3x3 pavilion lasts 1-3 years') },
      { text: strong('https://maker.example/downloads/pavilion-3x3-datasheet.pdf') }
    ]
    r = await researchWeb({ question })
    expect(r.findings.map((f) => f.source_class)).toEqual(['media', 'industry'])
    expect(r.note).toMatch(/1 official\/industry finding\(s\) came from an upgrade pass/)
  })
})
