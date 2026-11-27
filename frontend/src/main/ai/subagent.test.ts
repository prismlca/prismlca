import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AiProviderError } from './providers/types'
import {
  ResearchTimeout,
  extractJson,
  legFailure,
  retryCanHelp,
  normalizeDomain,
  normalizeDomains,
  parseFindings,
  researchWeb,
  splitAuthoritativeDomains
} from './subagent'
import { chat } from './test/fakeStream'

// Only the figure-check block at the end runs legs; every other test here is pure parsing.
vi.mock('./client', async () => (await import('./test/fakeStream')).clientModuleMock())

/**
 * The research sub-agent's fragile part is not the LLM call but what comes back: models wrap JSON in
 * prose or fences and leave statements unsourced. These tests pin the shared JSON extraction, the
 * web researcher's parsing and its figure check; the bill of materials has its own (bomAnswer.test.ts,
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

  it('reads the mark of a finding that answers the question itself, and only there', () => {
    const { findings } = parseFindings(
      '- The 3x3 pavilion lasts 1-3 years (https://example.org/a) [media, low, direct: one buying guide]\n' +
        '- Steel frames rust after 2 years (https://example.org/b) [community, low; direct]\n' +
        '- Pavilions in general last 2-5 years (https://example.org/c) [media, medium, directly from a forum]\n' +
        '- Polyester roofs fade (https://example.org/d) [media, medium: one guide]'
    )
    expect(findings.map((f) => f.direct)).toEqual([true, true, undefined, undefined])
    expect(findings[0].confidence_note).toBe('one buying guide')
    // A reason that merely begins with the word stays the reason.
    expect(findings[2].confidence_note).toBe('directly from a forum')
    for (const f of findings) expect(f.text).not.toContain('[')
  })

  // Where Haiku 5.5 put the mark in every leg of a live run: as the reason's last part.
  it('reads the mark at the end of the reason too, and keeps the reason', () => {
    const { findings } = parseFindings(
      '- Budget models last 2-5 seasons (https://example.org/a) [community, low: single blog, no test; direct]\n' +
        '- Steel 5-10, aluminium 20-30 years (https://example.org/b) [media, low: one table; direct for steel/alu]\n' +
        '- Tubs last 3 years (https://example.org/c) [media, low: indirect evidence only]'
    )
    expect(findings.map((f) => f.direct)).toEqual([true, true, undefined])
    expect(findings[0].confidence_note).toBe('single blog, no test')
    expect(findings[1].confidence_note).toBe('one table; direct for steel/alu')
    expect(findings[2].confidence_note).toBe('indirect evidence only')
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
 * The figure check on scripted legs: that a strong finding beside a weak one no longer blocks it, what the check
 * leg is asked and where it searches, what counts as a new source, and that the answer survives a failed check.
 */
describe('the figure check', () => {
  const blog = 'https://pavilion-blog.example/guide'
  const weak = (url = blog, text = 'Garden pavilions last 1-3 years', tag = 'media, medium'): string =>
    `- ${text} (${url}) [${tag}: two retailer blogs agree]`
  const strong = (url: string, text = 'A steel pavilion frame is rated for 5 years'): string =>
    `- ${text} (${url}) [official, high: the standard]`
  const line = (o: Record<string, unknown>): string => JSON.stringify(o)
  /** The question each leg was asked, and the system brief it ran under. */
  const asked = (): string[] => chat.seen.map((c) => String(c.messages.at(-1)?.content ?? ''))
  const system = (i: number): string => String(chat.seen[i]?.messages[0]?.content ?? '')
  /** The figures the check leg was handed, as data. */
  const handed = (i = 1): Array<Record<string, unknown>> => {
    const q = asked()[i]
    return JSON.parse(q.slice(q.indexOf('['), q.lastIndexOf(']') + 1))
  }
  const question = 'How long does a garden pavilion last?'

  beforeEach(() => {
    chat.seen.length = 0
    chat.rounds = []
  })

  it('checks a weak figure that stands beside an official one, and puts the verdict on it', async () => {
    const costs: number[] = []
    chat.rounds = [
      { text: `${strong('https://norm.example/en-1234')}\n${weak()}`, usage: { cost: 0.03 } as never },
      {
        text: line({
          id: 2,
          status: 'differs',
          value: '3-5',
          unit: 'years',
          refers_to: 'steel-frame pavilions, EU',
          url: 'https://maker.example/pavilion-datasheet.pdf',
          source_class: 'industry',
          independent: 'yes',
          note: 'manufacturer rates longer'
        }),
        usage: { cost: 0.01 } as never
      }
    ]
    const r = await researchWeb({ question, onCost: (_m, u) => costs.push(u.cost ?? 0) })
    expect(chat.seen).toHaveLength(2)
    expect(system(1)).toMatch(/^You check figures that an earlier web search found/)
    expect(system(1)).toMatch(/Time budget: about 2 minutes/)
    expect(handed()).toEqual([
      {
        id: 2,
        statement: 'Garden pavilions last 1-3 years',
        sources: [blog],
        source_class: 'media',
        confidence: 'medium'
      }
    ])
    expect(r.findings[0].check).toBeUndefined()
    expect(r.findings[1].check).toEqual({
      status: 'differs',
      value: '3-5',
      unit: 'years',
      refers_to: 'steel-frame pavilions, EU',
      source: 'https://maker.example/pavilion-datasheet.pdf',
      source_class: 'industry',
      stronger_source: true,
      independent: true,
      note: 'manufacturer rates longer'
    })
    expect(r.sources).toContain('https://maker.example/pavilion-datasheet.pdf')
    expect(r.note).toMatch(/1 weakly supported figure\(s\) — finding\(s\) 2 — were checked once/)
    // The log's record: why it ran, what it found, what it cost on its own.
    expect(r.web_check).toMatchObject({
      trigger: { findings: 2, weak: 1, direct: 0 },
      figures: [{ finding: 2, text: 'Garden pavilions last 1-3 years', status: 'differs' }],
      excluded_hosts: ['pavilion-blog.example'],
      usd: 0.01,
      requests: 1,
      outcome: 'done'
    })
    expect(costs).toEqual([0.03, 0.01])
  })

  it('leaves the weak hosts out of the search only, and only without an allow list', async () => {
    chat.rounds = [{ text: `${weak()}\nauthoritative_domains: destatis.de` }, { text: 'not found' }]
    await researchWeb({ question })
    expect(chat.seen.map((c) => c.webSearchExcluded)).toEqual([undefined, ['pavilion-blog.example']])
    expect(chat.seen.map((c) => c.webDomains)).toEqual([undefined, undefined])
    // The hosts the leg named are where to look, not a fence around the check.
    expect(asked()[1]).toMatch(/official or manufacturer source may be: destatis\.de\.$/)

    // Under the caller's allow list the check searches inside it, leaves nothing out, and gets no hint
    // it could not follow.
    chat.seen.length = 0
    chat.rounds = [
      { text: `${weak('https://shop.meffert.de/p')}\nauthoritative_domains: destatis.de` },
      { text: 'not found' }
    ]
    await researchWeb({ question, domains: ['meffert.de'] })
    expect(chat.seen.map((c) => c.webDomains)).toEqual([['meffert.de'], ['meffert.de']])
    expect(chat.seen[1].webSearchExcluded).toBeUndefined()
    expect(asked()[1]).not.toMatch(/destatis/)
  })

  it('runs on a lookup ceiling of its own, below the setting', async () => {
    chat.rounds = [{ text: weak() }, { text: 'not found' }]
    await researchWeb({ question, webLookups: 8 })
    expect(chat.seen.map((c) => c.webLookupsCap)).toEqual([8, 4])
    chat.seen.length = 0
    chat.rounds = [{ text: weak() }, { text: 'not found' }]
    await researchWeb({ question, webLookups: 2 })
    expect(chat.seen.map((c) => c.webLookupsCap)).toEqual([2, 2])
    chat.seen.length = 0
    chat.rounds = [{ text: weak() }, { text: 'not found' }]
    await researchWeb({ question })
    expect(chat.seen.map((c) => c.webLookupsCap)).toEqual([undefined, 4])
  })

  it('takes the marked figures first and at most three, also untagged and low-confidence ones', async () => {
    chat.rounds = [
      {
        text: [
          weak('https://a.example/1', 'Budget pavilions last 1 season', 'media, high'),
          `- Pavilions are popular in Germany (https://b.example/2) [community, low: one forum]`,
          `- Frames rust after 2 years (https://c.example/3)`,
          weak('https://d.example/4', 'A 3x3 pavilion lasts 2 years', 'community, low, direct'),
          weak('https://e.example/5', 'Roofs last 3 years', 'official, low')
        ].join('\n')
      },
      { text: 'not found' }
    ]
    const r = await researchWeb({ question })
    expect(handed().map((f) => f.id)).toEqual([4, 1, 3])
    // An answer with no line the check can read leaves every figure unchecked; nothing is lost.
    expect(r.findings).toHaveLength(5)
    expect(r.findings.map((f) => f.check?.status)).toEqual([
      'not_checked',
      undefined,
      'not_checked',
      'not_checked',
      undefined
    ])
    expect(r.web_check?.trigger).toEqual({ findings: 5, weak: 4, direct: 1 })
  })

  it('stays out when nothing is weak, when unsourced answers were allowed, and after a timeout', async () => {
    chat.rounds = [{ text: strong('https://norm.example/en-1234') }]
    let r = await researchWeb({ question })
    expect(chat.seen).toHaveLength(1)
    expect(r.web_check).toBeUndefined()

    chat.seen.length = 0
    chat.rounds = [{ text: weak() }]
    r = await researchWeb({ question, allowUnsourced: true })
    expect(chat.seen).toHaveLength(1)

    vi.useFakeTimers()
    try {
      chat.seen.length = 0
      chat.rounds = [{ text: weak(), stall: true }, { text: line({ id: 1, status: 'not_found' }) }]
      const run = researchWeb({ question })
      await vi.advanceTimersByTimeAsync(360_000)
      r = await run
      expect(chat.seen).toHaveLength(1)
      expect(r.findings[0].check).toBeUndefined()

      // Cut off before anything sourced was written: the short retry follows, and no check after it either.
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
      expect(r2.findings).toHaveLength(1)
      expect(r2.web_check).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps what a check cut off by its clock had written, and the rest says not checked', async () => {
    vi.useFakeTimers()
    try {
      chat.rounds = [
        { text: `${weak()}\n${weak('https://f.example/2', 'Pavilions last 4 years')}` },
        {
          text: line({ id: 1, status: 'confirmed', url: 'https://g.example/test', source_class: 'media' }),
          stall: true
        }
      ]
      const run = researchWeb({ question })
      await vi.advanceTimersByTimeAsync(90_000)
      const r = await run
      expect(r.findings.map((f) => f.check?.status)).toEqual(['confirmed', 'not_checked'])
      expect(r.web_check?.outcome).toBe('timeout')
      expect(r.note).toMatch(/\(the check ran out of time\)/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('costs the answer nothing when the check fails', async () => {
    chat.rounds = [
      { text: weak() },
      { throws: new AiProviderError('The provider refused the request.', 'auth') }
    ]
    const r = await researchWeb({ question })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].check).toEqual({ status: 'not_checked' })
    expect(r.web_check).toMatchObject({ outcome: 'failed', error: 'The provider refused the request' })
    expect(r.note).toMatch(/\(the check failed: The provider refused the request\)/)
  })

  it("counts a new page, not a new host — and never the provider's link to the original", async () => {
    const redirect = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZ9xyz'
    // The same blog, its address spelt differently.
    chat.rounds = [
      { text: weak() },
      {
        text: line({
          id: 1,
          status: 'confirmed',
          url: 'http://www.pavilion-blog.example/guide/',
          source_class: 'industry'
        })
      }
    ]
    let r = await researchWeb({ question })
    expect(r.findings[0].check).toEqual({ status: 'not_found', note: 'cited only the original page' })

    // The provider's link to that blog.
    chat.seen.length = 0
    chat.rounds = [
      { text: weak() },
      {
        text: line({ id: 1, status: 'confirmed', url: redirect, source_class: 'official' }),
        after: [{ type: 'citations', citations: [{ url: blog, via: [redirect] }] }]
      }
    ]
    r = await researchWeb({ question })
    expect(r.findings[0].check?.status).toBe('not_found')

    // A link whose resolution failed: it may lead to that very blog.
    chat.seen.length = 0
    chat.rounds = [
      { text: weak() },
      {
        text: line({ id: 1, status: 'confirmed', url: redirect, source_class: 'official' }),
        after: [{ type: 'citations', citations: [{ url: redirect }] }]
      }
    ]
    r = await researchWeb({ question })
    expect(r.findings[0].check).toEqual({ status: 'not_found', note: 'named no page that could be opened' })

    // A page the search never returned while it did return others: possibly made up, no verdict.
    chat.seen.length = 0
    chat.rounds = [
      { text: weak() },
      {
        text: line({
          id: 1,
          status: 'confirmed',
          url: 'https://stats.example/made-up',
          source_class: 'official'
        }),
        after: [{ type: 'citations', citations: [{ url: 'https://other.example/real' }] }]
      }
    ]
    r = await researchWeb({ question })
    expect(r.findings[0].check).toEqual({
      status: 'not_found',
      note: 'named a page the search did not return'
    })

    // The manufacturer's datasheet on the host of its shop page is a new page: it counts, as a stronger source,
    // and as no independent one.
    chat.seen.length = 0
    chat.rounds = [
      { text: weak('https://maker.example/shop/pavilion-3x3', 'The 3x3 pavilion lasts 1-3 years') },
      {
        text: line({
          id: 1,
          status: 'confirmed',
          url: 'https://maker.example/downloads/pavilion-3x3-datasheet.pdf',
          source_class: 'industry',
          independent: 'yes'
        }),
        after: [
          {
            type: 'citations',
            citations: [{ url: 'https://maker.example/downloads/pavilion-3x3-datasheet.pdf' }]
          }
        ]
      }
    ]
    r = await researchWeb({ question })
    expect(r.findings[0].check).toMatchObject({
      status: 'confirmed',
      source: 'https://maker.example/downloads/pavilion-3x3-datasheet.pdf',
      stronger_source: true,
      independent: false,
      cited_by_search: true
    })
  })
})
