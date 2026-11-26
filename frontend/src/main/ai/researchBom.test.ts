import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeOpenRouterError, chat } from './test/fakeStream'
import type { StreamEvent } from './providers/types'

/**
 * The researcher end to end on scripted legs: which answer belongs to which request, what a leg that dies
 * leaves behind, and what every leg is told about the others and about the total.
 */
vi.mock('./client', async () => (await import('./test/fakeStream')).clientModuleMock())
chat.alwaysDelta = true

const { researchBom } = await import('./researchBom')
const { researchWeb } = await import('./subagent')

const asked = (): string[] => chat.seen.map((c) => String(c.messages.at(-1)?.content ?? ''))
const answer = (o: unknown): { text: string } => ({ text: JSON.stringify(o) })

beforeEach(() => {
  chat.seen.length = 0
  chat.rounds = []
  chat.fallbackText = ''
})

describe('researchBom', () => {
  // T5: the coating's follow-up came back as "Oberflächenschutz/Verzinkung des Stahlrahmens", the gap was
  // called "… (Zinkschichtgewicht) des Rahmens", neither name contained the other — and the found figure
  // stood in the items while its gap stayed open beside it.
  it('books a follow-up answer to the gap it was asked for, whatever the leg called the part', async () => {
    chat.rounds = [
      answer({
        items: [{ component: 'frame', material: 'steel', mass_kg: 7, source_url: 'https://e.org/f' }]
      }),
      answer({ items: [{ component: 'Verzinkung (Zinkschichtgewicht) des Rahmens', mass_kg: null }] }),
      answer({
        items: [
          { component: 'Oberflächenschutz des Stahlrahmens', mass_kg: 0.14, source_url: 'https://e.org/z' }
        ]
      })
    ]
    const r = await researchBom({ product: 'rack', components: ['frame', 'zinc coating'] })
    expect(r.follow_up).toEqual({ asked: 1, resolved: 1 })
    expect(r.unresolved).toEqual([])
    expect(r.requests).toEqual([
      { component: 'frame', status: 'with_mass' },
      { component: 'zinc coating', status: 'with_mass' }
    ])
    expect(r.sum_kg).toBeCloseTo(7.14, 6)
  })

  it('keeps what a follow-up again found no mass for, and does not count the gap as resolved', async () => {
    chat.rounds = [
      answer({ items: [{ component: 'wheel', mass_kg: null }] }),
      answer({
        items: [
          { component: 'tyre', mass_kg: 1.4, source_url: 'https://e.org/t' },
          { component: 'hub', mass_kg: null }
        ]
      })
    ]
    const r = await researchBom({ product: 'barrow', components: ['wheel'] })
    expect(r.follow_up).toEqual({ asked: 1, resolved: 0 })
    expect(r.unresolved.map((u) => u.component)).toEqual(['hub'])
    expect(r.requests).toEqual([{ component: 'wheel', status: 'partial' }])
  })

  it('treats a part answered only with the whole product as a gap, and asks for the part alone', async () => {
    chat.rounds = [
      answer({ items: [], product_mass: [{ mass_kg: 13, basis: 'net', source_url: 'https://e.org/p' }] }),
      answer({ items: [{ component: 'frame', mass_kg: null }] })
    ]
    const r = await researchBom({ product: 'rack', components: ['frame'] })
    expect(asked()[1]).toMatch(
      /ONLY the component "frame": the mass of that part alone in kg — not of the whole product/
    )
    expect(r.unresolved).toEqual([
      expect.objectContaining({ component: 'frame', reason: 'whole_product_only' })
    ])
    expect(r.summary).toMatch(/frame \(only the whole product's mass found\)/)
  })

  it('names a leg that never came back, with its reason, under its request', async () => {
    chat.rounds = [
      answer({ items: [{ component: 'shelves', mass_kg: 6, source_url: 'https://e.org/s' }] }),
      { throws: new Error('connection reset') },
      { throws: new Error('connection reset') }
    ]
    const r = await researchBom({ product: 'rack', components: ['shelves', 'feet'], totalMassKg: 7 })
    expect(r.coverage).toEqual({ requested: 2, with_mass: 1 })
    expect(r.unresolved).toEqual([{ component: 'feet', reason: 'failed', note: 'connection reset' }])
    expect(r.balance_ok).toBeNull()
    expect(r.summary).toMatch(/open: feet \(research failed\)/)
  })

  it('keeps a part without a source in the sum and says apart from the balance that nothing backs it', async () => {
    chat.rounds = [
      answer({
        items: [{ component: 'frame', material: 'steel', mass_kg: 9, source_url: 'https://e.org/f' }]
      }),
      answer({ items: [{ component: 'shelves', material: 'HDF', mass_kg: 4 }] })
    ]
    const r = await researchBom({ product: 'rack', components: ['frame', 'shelves'], totalMassKg: 13 })
    expect(r.sum_kg).toBe(13)
    expect(r.balance_ok).toBe(true)
    expect(r.all_sourced).toBe(false)
    expect(r.unsourced).toEqual(['shelves'])
    expect(r.items.find((i) => i.component === 'shelves')).toMatchObject({ mass_kg: 4, unsourced: true })
    expect(r.summary).toMatch(
      /the parts add up \(.*\)\. Not every figure has a source: "shelves" has no usable source — kept in the sums all the same/
    )
  })

  it('tells every leg what the others research, and fences the total off from the parts', async () => {
    chat.fallbackText = '{"items": []}'
    await researchBom({ product: 'rack', components: ['frame', 'shelves', 'feet'], totalMassKg: 13 })
    const frame = asked().find((q) => q.includes('ONLY the component "frame"')) ?? ''
    expect(frame).toContain('Researched separately, by other researchers: "shelves", "feet".')
    expect(frame).toContain("about 13 kg — given to identify the product; never derive a part's mass from it")
    expect(frame).not.toMatch(/other researchers: [^\n]*"frame"/)
  })

  it('checks the parts against a whole-product mass a leg found when the caller had none', async () => {
    const total = {
      mass_kg: 13,
      basis: 'net',
      version: 'EAN 5400431601480',
      source_url: 'https://www.praxis.example/rack'
    }
    chat.rounds = [
      answer({
        items: [{ component: 'frame', mass_kg: 7, source_url: 'https://e.org/f' }],
        product_mass: [total]
      }),
      answer({
        items: [{ component: 'shelves', count: 5, mass_each_kg: 1.2, source_url: 'https://e.org/s' }],
        product_mass: [total]
      })
    ]
    const r = await researchBom({ product: 'rack', components: ['frame', 'shelves'] })
    expect(r.total_used).toMatchObject({ mass_kg: 13, source: 'researched', basis: 'net' })
    expect(r.sum_kg).toBeCloseTo(13, 6)
    expect(r.balance_ok).toBe(true)
    expect(r.sources).toContain('https://www.praxis.example/rack')
  })

  it('names the components over the limit instead of dropping them silently', async () => {
    chat.fallbackText = '{"items": [{"component": "x", "mass_kg": 1, "source_url": "https://e.org"}]}'
    const r = await researchBom({ product: 'x', components: Array.from({ length: 10 }, (_, i) => `c${i}`) })
    expect(asked()).toHaveLength(8)
    expect(r.not_researched).toEqual(['c8', 'c9'])
    expect(r.coverage).toEqual({ requested: 10, with_mass: 8 })
    expect(r.balance_ok).toBeNull()
  })

  it('counts a part once and keeps its other figures with their pages, telling the leg where they go', async () => {
    chat.rounds = [
      answer({
        items: [
          {
            component: 'pouch',
            material: 'PET/PE',
            mass_kg: 0.0102,
            source_url: 'https://e.org/alufrei',
            alternatives: [{ mass_kg: 0.0103, material: 'PET/ALU/PE', source_url: 'https://e.org/alu' }]
          }
        ]
      })
    ]
    const r = await researchBom({ product: 'refill pouch', components: ['pouch'], totalMassKg: 0.0102 })
    expect(asked()[0]).toContain(
      'Other figures for "pouch" itself — a variant, another source — go under "alternatives"'
    )
    expect(r.sum_kg).toBeCloseTo(0.0102, 6)
    expect(r.balance_ok).toBe(true)
    expect(r.items[0].alternatives).toEqual([
      { mass_kg: 0.0103, material: 'PET/ALU/PE', source_url: 'https://e.org/alu' }
    ])
    expect(r.sources).toEqual(['https://e.org/alufrei', 'https://e.org/alu'])
  })

  it('keeps the figures a gap came with beside the one its follow-up found', async () => {
    chat.rounds = [
      answer({
        items: [
          {
            component: 'label',
            mass_kg: null,
            alternatives: [
              { mass_kg: 0.0013, material: 'PP', source_url: 'https://e.org/pp' },
              { mass_kg: 0.0008, material: 'paper', source_url: 'https://e.org/paper' }
            ]
          }
        ]
      }),
      answer({ items: [{ component: 'label', mass_kg: 0.0011, source_url: 'https://e.org/label' }] })
    ]
    const r = await researchBom({ product: 'refill pouch', components: ['label'] })
    expect(r.follow_up).toEqual({ asked: 1, resolved: 1 })
    expect(r.unresolved).toEqual([])
    expect(r.items).toHaveLength(1)
    expect(r.items[0].mass_kg).toBe(0.0011)
    expect(r.items[0].alternatives?.map((a) => a.mass_kg)).toEqual([0.0013, 0.0008])
    expect(r.note).toMatch(/"label" 0\.0013 kg \(PP\), 0\.0008 kg \(paper\) \(counted: 0\.0011 kg\)/)
    expect(r.sources).toEqual(['https://e.org/label', 'https://e.org/pp', 'https://e.org/paper'])
  })

  it('leaves a gap open with its figures when the follow-up finds nothing', async () => {
    chat.rounds = [
      answer({
        items: [
          {
            component: 'label',
            mass_kg: null,
            alternatives: [{ mass_kg: 0.0013, material: 'PP', source_url: 'https://e.org/pp' }]
          }
        ]
      })
    ]
    chat.fallbackText = '{"items": []}'
    const r = await researchBom({ product: 'refill pouch', components: ['label'] })
    expect(r.items).toEqual([])
    expect(r.unresolved).toEqual([
      expect.objectContaining({
        component: 'label',
        reason: 'unclear_mass',
        alternatives: [{ mass_kg: 0.0013, material: 'PP', source_url: 'https://e.org/pp' }]
      })
    ])
  })

  it('still reads the bare array older answers come as', async () => {
    chat.rounds = [answer([{ component: 'body', mass_kg: 0.019, source_url: 'https://e.org/b' }])]
    const r = await researchBom({ product: 'bottle', components: ['body'], totalMassKg: 0.019 })
    expect(r.balance_ok).toBe(true)
  })

  // Expired keys: five legs reported "ran out of time" after 0 s and each tried a second, narrower request
  // that failed the same way.
  it('names a refused key in the trace and does not retry it', async () => {
    chat.rounds = [{ throws: new FakeOpenRouterError('OpenRouter API key invalid or missing.', 'auth') }]
    const progress: string[] = []
    const r = await researchBom({
      product: 'rack',
      components: ['frame'],
      onProgress: (n) => progress.push(n)
    })
    expect(chat.seen).toHaveLength(1)
    expect(progress).toContain('frame: OpenRouter API key invalid or missing')
    expect(progress.join(' ')).not.toMatch(/ran out of time/)
    expect(r.unresolved).toEqual([
      { component: 'frame', reason: 'failed', note: 'OpenRouter API key invalid or missing.' }
    ])
  })

  it('still retries a dropped connection once, naming it', async () => {
    chat.rounds = [
      { throws: new Error('connection reset') },
      answer({ items: [{ component: 'frame', mass_kg: 7, source_url: 'https://e.org/f' }] })
    ]
    const progress: string[] = []
    const r = await researchBom({
      product: 'rack',
      components: ['frame'],
      onProgress: (n) => progress.push(n)
    })
    expect(chat.seen).toHaveLength(2)
    expect(progress).toContain('frame: connection reset — retrying with a narrower question')
    expect(r.items).toHaveLength(1)
  })

  // A leg the clock cut off returns what it had written. When that does not parse, its time is spent all
  // the same: the next attempt is the short, narrow one, not the long question on a full budget again.
  it('asks a leg its clock cut off mid-answer the short question next', async () => {
    vi.useFakeTimers()
    try {
      chat.rounds = [
        { text: '{"items": [{"component": "frame", "mass_kg": 7, "source_url": "https://e.or', stall: true },
        answer({ items: [{ component: 'frame', mass_kg: 7, source_url: 'https://e.org/f' }] })
      ]
      const run = researchBom({ product: 'rack', components: ['frame'] })
      await vi.advanceTimersByTimeAsync(360_000)
      const r = await run
      expect(chat.seen).toHaveLength(2)
      expect(asked()[1]).toMatch(/BE BRIEF: the JSON object with one entry/)
      expect(String(chat.seen[1].messages[0].content)).toMatch(/Time budget: about 2 minutes/)
      expect(r.items).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  describe('with a recipe', () => {
    const soap = {
      formulation: { name: 'MP-01', kind: 'frame', source_url: 'https://pcc.example/mp01.pdf' },
      lines: [
        { name: 'water', amount: null, unit: '%', rest_to_total: true },
        { name: 'SLES 70 %', amount: 12, unit: '%' },
        { name: 'glycerin', amount: 2, unit: '%' }
      ]
    }

    it('researches the mixture in one leg of its own and tells the part legs it is taken', async () => {
      chat.rounds = [
        answer(soap),
        answer({
          items: [{ component: 'pouch', material: 'PE/PET', mass_kg: 0.02, source_url: 'https://e.org/p' }]
        })
      ]
      const r = await researchBom({
        product: 'liquid soap refill, 500 ml',
        components: ['pouch'],
        recipe: { of: 'liquid soap (contents of the pouch)', mass_kg: 0.5 },
        totalMassKg: 0.52
      })
      expect(chat.seen).toHaveLength(2)
      expect(String(chat.seen[0].messages[0].content)).toMatch(
        /You research the RECIPE \(formulation\) of a mixture/
      )
      expect(asked()[0]).toMatch(/Research ONLY the recipe of liquid soap \(contents of the pouch\)/)
      expect(asked()[0]).toMatch(
        /The product's other parts are researched separately, by other researchers: "pouch"/
      )
      expect(asked()[1]).toContain(
        'Researched separately, by other researchers: "the recipe of liquid soap (contents of the pouch)".'
      )
      expect(r.recipe).toMatchObject({ closes: true, mass_kg: 0.5, mass_source: 'given' })
      expect(r.items.map((i) => i.component)).toEqual(['pouch', 'water', 'SLES 70 %', 'glycerin'])
      expect(r.balance_ok).toBe(true)
      expect(r.sources).toContain('https://pcc.example/mp01.pdf')
    })

    it('keeps the recipe out of the follow-up pass, which would ask its ingredients one by one', async () => {
      chat.rounds = [
        answer({
          ...soap,
          lines: [...soap.lines, { name: 'perfume', amount: null, unit: '%', range: [0.5, 1] }]
        }),
        answer({ items: [{ component: 'cap', mass_kg: null }] }),
        answer({ items: [{ component: 'cap', mass_kg: 0.003, source_url: 'https://e.org/c' }] })
      ]
      const r = await researchBom({ product: 'soap', components: ['cap'], recipe: { mass_kg: 0.5 } })
      expect(chat.seen).toHaveLength(3)
      expect(asked()[2]).toMatch(/ONLY the component "cap"/)
      expect(r.follow_up).toEqual({ asked: 1, resolved: 1 })
      expect(r.recipe?.closes).toBeNull()
    })

    it('runs the recipe leg alone when no components are named, and says nothing else was researched', async () => {
      chat.rounds = [answer(soap)]
      const r = await researchBom({ product: 'liquid soap', recipe: {} })
      expect(chat.seen).toHaveLength(1)
      expect(asked()[0]).toMatch(/Research ONLY the recipe of liquid soap:/)
      expect(r.summary).toMatch(/Only the recipe was researched, no other part of the product/)
      expect(r.balance_ok).toBe(true)
      expect(r.note ?? '').not.toMatch(/no usable figures/)
    })

    it('asks a timed-out recipe leg again for one table, not for a mass', async () => {
      chat.rounds = [{ throws: new Error('connection reset') }, answer(soap)]
      const r = await researchBom({
        product: 'liquid soap',
        recipe: { ingredients: ['Aqua', 'Glycerin', 'Parfum'] }
      })
      expect(asked()[0]).toMatch(
        /Ingredients known from the product \(its printed list\): Aqua, Glycerin, Parfum\. Give one its line only/
      )
      expect(asked()[1]).toMatch(/BE BRIEF: one formulation table/)
      expect(asked()[1]).not.toMatch(/the mass in kg and one source URL/)
      expect(r.recipe?.missing_ingredients).toEqual(['Parfum'])
    })

    it('hands the leg an INCI list to write its names from, and covers the answer against it', async () => {
      chat.rounds = [answer(soap)]
      const r = await researchBom({
        product: 'liquid soap',
        recipe: { inci_list: ['Aqua', 'Glycerin', 'Sodium Laureth Sulfate'] }
      })
      expect(asked()[0]).toMatch(
        /THIS product's INCI list, as printed: Aqua, Glycerin, Sodium Laureth Sulfate\. Give one its line only where your one formulation names it, and write its name as printed here in "inci"/
      )
      // Nothing in the question asks the leg to fit its recipe to the list's order, and nothing compares them.
      expect(asked()[0]).not.toMatch(/order/i)
      expect(r.recipe).not.toHaveProperty('inci_order')
      // The leg wrote neither printed name in "inci": "water" is INCI's "Aqua" by its other name, "SLES 70 %" covers
      // nothing.
      expect(r.recipe?.missing_ingredients).toEqual(['Sodium Laureth Sulfate'])
    })

    it('hands the leg the names of a "may contain" part without the marker before each', async () => {
      chat.rounds = [answer(soap)]
      await researchBom({
        product: 'foundation',
        recipe: {
          inci_list: [
            'Aqua',
            'Glycerin',
            '+/- MAY CONTAIN: CI 77891 (TITANIUM DIOXIDE)',
            '+/- MAY CONTAIN: Mica'
          ]
        }
      })
      expect(asked()[0]).toMatch(
        /THIS product's INCI list, as printed: Aqua, Glycerin \[\+\/- CI 77891 \(TITANIUM DIOXIDE\), Mica\]\. Give one/
      )
    })

    it('covers the answer against a list the leg found, also when its page is a link that leads nowhere', async () => {
      const withList = (source_url: string) => ({
        ...soap,
        lines: [
          { name: 'water', inci: 'Aqua', amount: 90, unit: '%' },
          { name: 'Glycerin', amount: 2, unit: '%' },
          { name: 'Sodium Laureth Sulfate', amount: 8, unit: '%' }
        ],
        declared_ingredients: { names: ['Aqua', 'Glycerin', 'Sodium Laureth Sulfate', 'Parfum'], source_url }
      })
      chat.rounds = [answer(withList('https://shop.example/soap'))]
      const live = await researchBom({ product: 'liquid soap', recipe: {} })
      expect(live.recipe?.missing_ingredients).toEqual(['Parfum'])
      expect(live.recipe?.declared_source).toBe('https://shop.example/soap')
      // A provider's link the search never resolved is dropped as a source; what the list names is still covered.
      chat.rounds = [answer(withList('https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZ9'))]
      const dead = await researchBom({ product: 'liquid soap', recipe: {} })
      expect(dead.recipe?.missing_ingredients).toEqual(['Parfum'])
      expect(dead.recipe?.declared_source).toBeUndefined()
      // The shares are not held against the list's order: glycerin at 2 % before the surfactant at 8 % is no finding.
      expect(live.recipe).not.toHaveProperty('inci_order')
      expect(live.summary).not.toMatch(/contradict|order of/)
    })

    it('asks no recipe leg when the call names none', async () => {
      chat.fallbackText = '{"items": []}'
      const r = await researchBom({ product: 'rack', components: ['frame'] })
      expect(asked().some((q) => /recipe/i.test(q))).toBe(false)
      expect(r.recipe).toBeUndefined()
    })
  })

  it('does the same for a web research leg', async () => {
    chat.rounds = [{ throws: new FakeOpenRouterError('OpenRouter API key invalid or missing.', 'auth') }]
    const progress: string[] = []
    await expect(
      researchWeb({ question: 'Recycling rate of steel in Germany?', onProgress: (n) => progress.push(n) })
    ).rejects.toThrow(/API key invalid/)
    expect(chat.seen).toHaveLength(1)
    expect(progress.join(' ')).toMatch(/API key invalid or missing/)
    expect(progress.join(' ')).not.toMatch(/ran out of time/)
  })
})

describe('researchBom — pages one leg read for another part', () => {
  const SHEET = 'https://maker.example/sheet.pdf'
  const cited = (o: unknown, ...urls: string[]): { text: string; after: StreamEvent[] } => ({
    ...answer(o),
    after: [{ type: 'citations', citations: urls.map((url) => ({ url })) }]
  })

  it('hands a page the search delivered to the follow-up of the part it covers, and checks what it found', async () => {
    chat.rounds = [
      cited(
        {
          items: [{ component: 'frame', mass_kg: 7, source_url: SHEET }],
          for_others: [{ component: 'rim', mass_kg: 1.2, source_url: SHEET }]
        },
        SHEET
      ),
      answer({ items: [{ component: 'rim', mass_kg: null }] }),
      cited(
        { items: [{ component: 'rim', mass_kg: 1.25, source_url: 'https://e.org/rim' }] },
        'https://e.org/rim'
      )
    ]
    const r = await researchBom({ product: 'barrow', components: ['frame', 'rim'] })
    expect(asked()[2]).toContain(
      `Another researcher read a page that states a mass for "rim": ${SHEET}. Open it first and take your figure ` +
        'from there when it is given for this part alone; when it is not, say so in the note and search on.'
    )
    expect(r.follow_up).toEqual({ asked: 1, resolved: 1 })
    expect(r.cross_checks).toEqual([
      {
        component: 'rim',
        page_kg: 1.2,
        source_url: SHEET,
        read_for: 'frame',
        own_kg: 1.25,
        verdict: 'agrees'
      }
    ])
    expect(r.note).toContain('Pages read for other parts confirm the figures of "rim".')
    expect(r.sum_kg).toBeCloseTo(8.25, 6)
  })

  it('hands on no address the search never delivered', async () => {
    chat.rounds = [
      answer({
        items: [{ component: 'frame', mass_kg: 7, source_url: SHEET }],
        for_others: [{ component: 'rim', mass_kg: 1.2, source_url: 'https://planted.example/rim' }]
      }),
      answer({ items: [{ component: 'rim', mass_kg: null }] }),
      answer({ items: [{ component: 'rim', mass_kg: null }] })
    ]
    const r = await researchBom({ product: 'barrow', components: ['frame', 'rim'] })
    expect(asked()[2]).not.toContain('Another researcher')
    expect(r.cross_checks).toBeUndefined()
  })

  it('names a contradiction as a hint and leaves the sum alone', async () => {
    chat.rounds = [
      cited(
        {
          items: [{ component: 'frame', mass_kg: 7, source_url: SHEET }],
          for_others: [{ component: 'rim', mass_kg: 2.4, source_url: SHEET }]
        },
        SHEET
      ),
      answer({ items: [{ component: 'rim', mass_kg: 1.2, source_url: 'https://e.org/rim' }] })
    ]
    const r = await researchBom({ product: 'barrow', components: ['frame', 'rim'], totalMassKg: 8.2 })
    expect(r.cross_checks?.[0]).toMatchObject({
      component: 'rim',
      own_kg: 1.2,
      page_kg: 2.4,
      verdict: 'differs'
    })
    expect(r.note).toContain(
      `Pages read for other parts disagree: "rim" counts 1.2 kg, but a page read for "frame" gives 2.4 kg (${SHEET})`
    )
    expect(r.sum_kg).toBeCloseTo(8.2, 6)
    expect(r.balance_ok).toBe(true)
  })

  it('takes a gap another leg found a page for into the follow-up first', async () => {
    chat.rounds = [
      ...['a', 'b', 'c', 'd'].map((c) => answer({ items: [{ component: c, mass_kg: null }] })),
      cited(
        {
          items: [{ component: 'frame', mass_kg: 7, source_url: SHEET }],
          for_others: [{ component: 'd', mass_kg: 0.5, source_url: SHEET }]
        },
        SHEET
      )
    ]
    chat.fallbackText = '{"items": []}'
    await researchBom({ product: 'barrow', components: ['a', 'b', 'c', 'd', 'frame'] })
    const followUps = asked().slice(5)
    expect(followUps).toHaveLength(3)
    expect(followUps[0]).toMatch(/Research ONLY the component "d"[\s\S]*Another researcher read a page/)
    expect(followUps.slice(1).map((q) => q.match(/ONLY the component "(\w)"/)?.[1])).toEqual(['a', 'b'])
  })
})
