import { describe, expect, it, vi } from 'vitest'
import { chat } from './test/fakeStream'

/**
 * The chapter writer, with `streamChat` mocked — offline, deterministic and free. What matters here is
 * the prompt it builds (the placeholder paths have to reach the model, or the "no literal numbers" rule
 * is unfollowable) and that it strips the wrappers models add despite being told not to.
 *
 * The scripted stream lives in test/fakeStream.ts. The writer dialect: every round bills the same
 * fixed usage, a scripted round without text still streams (an empty delta), a run past the end of
 * the script answers with the standing fallback text, and tool calls are only emitted when tools
 * were offered — honouring that is what makes the writer's "withdraw the tools when the budget is
 * spent" guarantee testable at all.
 */
vi.mock('./client', async () => (await import('./test/fakeStream')).clientModuleMock())
chat.alwaysDelta = true
chat.gateCallsOnTools = true
chat.defaultUsage = { cost: 0.0004, prompt_tokens: 900 }
chat.defaultFinish = 'stop'
chat.fallbackText = 'A chapter.'

/** What the writer sent per call — the fixture's record, under this file's historical name. */
const sent = chat.seen

const {
  writeSection,
  writeAll,
  expandAbbreviations,
  translateStudyTexts,
  translationBatches,
  parseMap,
  clean,
  lookupBudget,
  applyPatch,
  FALLBACK_MODEL,
  DEADLINE_REASON,
  DEADLINE_NOTE,
  reportDeadlineMs,
  translationAnswers,
  sectionAnswers,
  writeAllAnswers,
  MAX_SECTION_ANSWERS,
  MAX_CONTINUATIONS,
  ANSWER_BUDGET_MS,
  incompleteReason,
  joinContinuation
} = await import('./reportWriter')

const brief = {
  kind: 'prose',
  title: 'Interpretation',
  language: 'German',
  prompt: 'Write the interpretation chapter.',
  invariants: 'Rules that always apply:\n- Write in German.\n- Never write a number as a literal.',
  study: { goal: 'PCF of a bottle', functional_unit: '1 bottle' },
  placeholders: ['results.0.score', 'contribution.top.share_percent'],
  data: {
    activity: { name: 'bottle', database: 'm', code: 'c' },
    amount: 1,
    results: [{ method_label: 'IPCC / GWP', unit: 'kg CO2-eq', score: 0.412 }],
    contribution: {
      dimension: 'Phase',
      unit: 'kg CO2-eq',
      groups: Array.from({ length: 25 }, (_, i) => ({ key: `g${i}`, impact: 25 - i })),
      top: { key: 'g0' }
    },
    subjects: [],
    parameters: [{ name: 'mass', amount: 1 }],
    scenarios: [{ name: 'high' }]
  }
}

describe('writeSection', () => {
  it('hands the model the placeholder paths, the assignment and the numbers', async () => {
    sent.length = 0
    await writeSection({ brief })
    const [call] = sent
    expect(call.model).toBe(FALLBACK_MODEL)
    const user = String(call.messages[1].content)
    // Without the real paths a model invents plausible ones and every placeholder fails to resolve.
    expect(user).toContain('results.0.score')
    expect(user).toContain('Write the interpretation chapter.')
    expect(user).toContain('0.412')
    expect(user).toContain('in German')
    // The invariants ride in the system message, so an edited prompt cannot drop them.
    expect(String(call.messages[0].content)).toContain('Never write a number as a literal')
  })

  it('trims the contribution tail and leaves out what prose never cites', async () => {
    sent.length = 0
    await writeSection({ brief })
    const user = String(sent[0].messages[1].content)
    expect(user).toContain('"g0"')
    expect(user).not.toContain('"g15"') // the tail is noise for prose
    expect(user).not.toContain('scenarios') // not what an interpretation chapter cites
  })

  it('prefers the server-side facts selection over its own legacy one', async () => {
    // `brief.facts` is built next to the prompts and the gate (report_prompts.brief_facts), so the
    // writer must hand it over verbatim — the local selection had drifted from what the prompts
    // promised (checks, trade_offs, the process notes) and stays only as a fallback.
    sent.length = 0
    await writeSection({
      brief: {
        ...brief,
        facts: {
          checks: { sensitivity: [{ spread_percent: 3.1 }] },
          trade_offs: [{ method_label: 'IPCC', highest: 'B' }],
          foreground: [{ name: 'Filling', description: 'estimate from BREF FDM' }]
        }
      }
    })
    const user = String(sent[0].messages[1].content)
    expect(user).toContain('spread_percent')
    expect(user).toContain('estimate from BREF FDM')
    expect(user).not.toContain('0.412') // the legacy selection from `data` must not also ride along
  })

  it('reports its cost under its own model', async () => {
    const booked: { id: string; cost?: number }[] = []
    await writeSection({ brief, onCost: (id, u) => booked.push({ id, cost: u.cost }) })
    expect(booked).toEqual([{ id: FALLBACK_MODEL, cost: 0.0004 }])
  })

  it('sends the writer’s own reply ceiling, not the chat’s', async () => {
    sent.length = 0
    await writeSection({ brief, maxTokens: 100_000 })
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.every((c) => c.maxTokens === 100_000)).toBe(true)
  })

  it('honours an explicit model override', async () => {
    sent.length = 0
    await writeSection({ brief, model: 'google/gemini-3.8-flash' })
    expect(sent[0].model).toBe('google/gemini-3.8-flash')
  })

  it('marks the system prompt as a cache breakpoint only where the provider needs one (V399)', async () => {
    // Anthropic caches nothing without the marker: nine chapters on Sonnet 5.5 read 0 of 1.02 M prompt
    // tokens from the cache. Everyone else caches on their own and would reject the part.
    sent.length = 0
    await writeSection({ brief, model: 'anthropic/claude-sonnet-5.5' })
    const system = sent[0].messages.find((m) => m.role === 'system')
    expect(system?.content).toEqual([
      { type: 'text', text: expect.any(String), cache_control: { type: 'ephemeral' } }
    ])
    sent.length = 0
    await writeSection({ brief, model: 'google/gemini-3.8-flash' })
    expect(typeof sent[0].messages.find((m) => m.role === 'system')?.content).toBe('string')
  })

  it('strips the wrappers models add despite being asked not to', () => {
    expect(clean('```markdown\nThe chapter.\n```')).toBe('The chapter.')
    expect(clean('## Interpretation\n\nThe chapter.')).toBe('The chapter.')
    expect(clean('Here is the chapter:\n\nThe chapter.')).toBe('The chapter.')
    expect(clean('  Already clean.  ')).toBe('Already clean.')
  })

  it('applies the cleanup to what the model actually returned', async () => {
    chat.fallbackText = '### Auswertung\n\nDas Ergebnis liegt bei {{results.0.score}}.'
    const out = await writeSection({ brief })
    expect(out.text.startsWith('Das Ergebnis')).toBe(true)
    chat.fallbackText = 'A chapter.'
  })
})

describe('expandAbbreviations', () => {
  it('asks only for meanings and returns the map', async () => {
    sent.length = 0
    chat.fallbackText =
      '{"GWP100": "Global warming potential over 100 years", "AP": "Acidification potential"}'
    const out = await expandAbbreviations({ candidates: ['GWP100', 'AP'], language: 'German' })
    expect(out.resolved.GWP100).toContain('Global warming')
    const user = String(sent[0].messages[1].content)
    expect(user).toContain('GWP100')
    expect(user).toContain('German')
    chat.fallbackText = 'A chapter.'
  })

  it('does not call the model for an empty list', async () => {
    sent.length = 0
    const out = await expandAbbreviations({ candidates: [] })
    expect(out.resolved).toEqual({})
    expect(sent).toEqual([])
  })

  it('reads a map out of a fenced or chatty reply, and gives up quietly on nonsense', () => {
    expect(parseMap('```json\n{"A": "Alpha"}\n```')).toEqual({ A: 'Alpha' })
    expect(parseMap('Sure! {"A": "Alpha"} — hope that helps')).toEqual({ A: 'Alpha' })
    expect(parseMap('{"A": 5, "B": "Beta"}')).toEqual({ B: 'Beta' })
    expect(parseMap('no json here')).toEqual({})
  })
})

describe('translateStudyTexts', () => {
  it('hands over id-keyed texts and the target language, and returns the map', async () => {
    sent.length = 0
    chat.fallbackText = '{"k1": "Production and filling", "k2": "already English"}'
    const out = await translateStudyTexts({
      candidates: [
        { key: 'k1', text: 'Produktion und Abfüllung' },
        { key: 'k2', text: 'already English' }
      ],
      language: 'en'
    })
    expect(out.resolved.k1).toBe('Production and filling')
    const user = String(sent[0].messages[1].content)
    expect(user).toContain('k1: Produktion und Abfüllung')
    expect(user).toContain('Target language: en')
    chat.fallbackText = 'A chapter.'
  })

  it('does not call the model for an empty list', async () => {
    sent.length = 0
    const out = await translateStudyTexts({ candidates: [] })
    expect(out.resolved).toEqual({})
    expect(sent).toEqual([])
  })

  const fill = (n: number): string => 'x'.repeat(n)
  /** Three texts of 40 characters each with a 50-character limit — one batch per text. */
  const three = [
    { key: 'k1', text: fill(40) },
    { key: 'k2', text: fill(40) },
    { key: 'k3', text: fill(40) }
  ]

  it('cuts the list into batches by characters, not by count', () => {
    expect(translationBatches([], 100)).toEqual([])
    // Exactly at the limit still fits: key (2) + text (8) = 10.
    expect(translationBatches([{ key: 'k1', text: fill(8) }], 10)).toHaveLength(1)
    // A single text larger than the whole limit rides alone rather than being split mid-sentence.
    expect(
      translationBatches(
        [
          { key: 'k1', text: fill(50) },
          { key: 'k2', text: 'ab' }
        ],
        10
      ).map((b) => b.map((c) => c.key))
    ).toEqual([['k1'], ['k2']])
    // Five scenario names are one call; two paragraphs of the same count are two.
    const labels = Array.from({ length: 5 }, (_, i) => ({ key: `s${i}`, text: 'Wenige Umläufe (5)' }))
    expect(translationBatches(labels, 200)).toHaveLength(1)
    const paragraphs = Array.from({ length: 5 }, (_, i) => ({ key: `p${i}`, text: fill(150) }))
    expect(translationBatches(paragraphs, 200)).toHaveLength(5)
  })

  it('sends one call per batch, bills each one, and merges what comes back', async () => {
    sent.length = 0
    const costs: string[] = []
    chat.rounds = [{ text: '{"k1": "One"}' }, { text: '{"k2": "Two"}' }]
    const out = await translateStudyTexts({
      candidates: three.slice(0, 2),
      language: 'en',
      batchChars: 50,
      lanes: 1,
      onCost: (model) => costs.push(model)
    })
    expect(sent).toHaveLength(2)
    expect(out.resolved).toEqual({ k1: 'One', k2: 'Two' })
    // A batch carries its own texts and nobody else's — the whole point of splitting the reply up.
    expect(String(sent[0].messages[1].content)).not.toContain('k2:')
    // V166: every call is billed, not only the last one to answer.
    expect(costs).toHaveLength(2)
    chat.rounds = []
  })

  it('gives a broken batch one second go, and loses nothing but that batch', async () => {
    sent.length = 0
    // Batch one answers; batch two comes back cut off twice; batch three stumbles once, then lands.
    chat.rounds = [
      { text: '{"k1": "One"}' },
      { text: '{"k2": "Tw' },
      { text: 'still nothing' },
      { text: 'sorry?' },
      { text: '{"k3": "Three"}' }
    ]
    const out = await translateStudyTexts({ candidates: three, batchChars: 50, lanes: 1 })
    expect(out.resolved).toEqual({ k1: 'One', k3: 'Three' })
    expect(sent).toHaveLength(5) // two attempts each for the broken and the stumbling batch
    chat.rounds = []
  })

  it('reports progress per batch and stops where the signal was aborted', async () => {
    sent.length = 0
    const controller = new AbortController()
    const seen: Array<{ done: number; total: number; batches: number }> = []
    chat.rounds = [{ text: '{"k1": "One"}' }, { text: '{"k2": "Two"}' }, { text: '{"k3": "Three"}' }]
    const out = await translateStudyTexts({
      candidates: three,
      batchChars: 50,
      lanes: 1,
      signal: controller.signal,
      onProgress: (p) => {
        seen.push(p)
        controller.abort() // the author pressed Stop while the first batch was landing
      }
    })
    expect(seen).toEqual([{ done: 1, total: 3, batches: 3 }])
    expect(sent).toHaveLength(1)
    // What was already paid for survives the cancel instead of being thrown away with it.
    expect(out.resolved).toEqual({ k1: 'One' })
    chat.rounds = []
  })
})

describe('looking things up while writing', () => {
  const call = (name: string, args: Record<string, unknown>, id = 't1') => ({
    id,
    name,
    arguments: JSON.stringify(args)
  })

  it('offers only the three read-only tools, and only when a backend client is available', async () => {
    sent.length = 0
    chat.rounds = []
    await writeSection({ brief })
    expect(sent[0].tools).toBeUndefined() // no client → write from the brief alone

    sent.length = 0
    await writeSection({ brief, api: async () => ({}) })
    const names = (sent[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    // A search tool is deliberately absent: a writer that can discover datasets the study never used
    // can furnish an explanation out of the database instead of out of this model.
    expect(names.sort()).toEqual(['compare_scenarios', 'explain_result', 'get_process_details'])
    expect(names.some((n) => n.startsWith('search'))).toBe(false)
  })

  it('runs a lookup and hands the result back for the gate to check against', async () => {
    sent.length = 0
    chat.rounds = [
      { calls: [call('get_process_details', { database: 'm', code: 'abc' })] },
      { text: 'The chapter.' }
    ]
    const seen: string[] = []
    const out = await writeSection({
      brief,
      api: async (_m, path) => {
        seen.push(path)
        return { activity: { name: 'incineration' }, comment: 'Municipal solid waste incinerator.' }
      }
    })
    expect(seen.some((p) => p.includes('abc'))).toBe(true)
    expect(out.text).toBe('The chapter.')
    expect(out.lookups).toHaveLength(1)
    expect(out.lookups[0].name).toBe('get_process_details')
    // The gate only accepts facts that were supplied, so the result has to travel back.
    expect(out.lookups[0].result).toContain('Municipal solid waste incinerator')
  })

  it("stops at the chapter's allowance and says so instead of looping", async () => {
    chat.rounds = []
    // One more attempt than the allowance: the last comes after it is spent, when the tools are
    // already withdrawn. The interpretation fixture reports one indicator, so its allowance is 6.
    const allowance = lookupBudget(brief)
    for (let i = 0; i <= allowance; i++)
      chat.rounds.push({ calls: [call('get_process_details', { code: `c${i}` }, `t${i}`)] })
    chat.rounds.push({ text: 'Written from what I have.' })
    const out = await writeSection({ brief, api: async () => ({ activity: { name: 'x' } }) })
    expect(out.lookups).toHaveLength(allowance)
    expect(out.text).toBe('Written from what I have.')
  })

  it('keeps two lookups that differ only past the stored cut of their arguments', async () => {
    const codes = (last: string): string[] => [...Array.from({ length: 60 }, (_, i) => `code-${i}`), last]
    chat.rounds = [
      { calls: [call('get_process_details', { database: 'm', codes: codes('a') }, 't1')] },
      { calls: [call('get_process_details', { database: 'm', codes: codes('b') }, 't2')] },
      { text: 'Done.' }
    ]
    const out = await writeSection({ brief, api: async () => ({ activity: { name: 'x' } }) })
    expect(out.lookups).toHaveLength(2)
    expect(out.lookups[0].args).toBe(out.lookups[1].args) // the stored form is cut, the lookups are not one
  })

  it('refuses a tool that is not on the writer list', async () => {
    chat.rounds = [{ calls: [call('delete_model', { database: 'm' })] }, { text: 'ok' }]
    const out = await writeSection({ brief, api: async () => ({}) })
    expect(out.lookups).toHaveLength(0) // nothing was run
    expect(out.text).toBe('ok')
  })

  it('blocks a byte-identical repeat without charging the budget (the guard the agent loop had)', async () => {
    // The budget alone bounded the damage of a model re-sending the same lookup — it still paid
    // one of the chapter's few lookups per repeat. Four identical calls: three run (and are charged),
    // the fourth is refused with the block message and costs nothing.
    chat.rounds = []
    for (let i = 0; i < 4; i++)
      chat.rounds.push({ calls: [call('get_process_details', { database: 'm', code: 'same' }, `t${i}`)] })
    chat.rounds.push({ text: 'Done.' })
    let ran = 0
    const out = await writeSection({
      brief,
      api: async () => {
        ran++
        return { activity: { name: 'x' } }
      }
    })
    expect(ran).toBe(3)
    // The evidence holds one answer per lookup: a lookup made again replaces its earlier answer.
    expect(out.lookups).toHaveLength(1)
    expect(out.text).toBe('Done.')
  })

  it('turns a failed lookup into a sentence rather than throwing', async () => {
    chat.rounds = [{ calls: [call('get_process_details', { code: 'gone' })] }, { text: 'ok' }]
    const out = await writeSection({
      brief,
      // The chapter is written for one model, so the writer passes it as activeDb (see index.ts) and
      // the lookup needs no `database` argument of its own — what is under test here is that a
      // *failing* lookup is reported to the model as text instead of aborting the chapter.
      activeDb: 'm',
      api: async () => {
        throw new Error('Activity not found.')
      }
    })
    expect(out.lookups[0].result).toContain('Activity not found')
    expect(out.text).toBe('ok')
  })
})

describe('the lookup allowance', () => {
  it('follows what the chapter has to explain', () => {
    // One flat number fitted no chapter. The explaining chapters scale with the thing they explain —
    // the foreground for the inventory, the FURTHER indicators for the result chapters, because a
    // hotspot list exists for the leading one only and every other has to be opened.
    const three = { results: [1, 2, 3], contributions: [1, 2, 3], foreground: new Array(7).fill(0) }
    expect(lookupBudget({ ...brief, kind: 'inventory', data: three })).toBe(13) // 6 + 7 processes
    expect(lookupBudget({ ...brief, kind: 'prose', data: three })).toBe(10) // 6 + 2 further indicators
    expect(lookupBudget({ ...brief, kind: 'lcia', data: three })).toBe(8) // 4 + 2 × 2
    expect(lookupBudget({ ...brief, kind: 'contribution', data: three })).toBe(8)
    // The ceilings hold on a large study.
    const big = { results: new Array(11).fill(0), foreground: new Array(40).fill(0) }
    expect(lookupBudget({ ...brief, kind: 'inventory', data: big })).toBe(19)
    expect(lookupBudget({ ...brief, kind: 'lcia', data: big })).toBe(17)
    // The summarising chapters keep a small reserve; an unlisted kind gets the default.
    expect(lookupBudget({ ...brief, kind: 'conclusions', data: three })).toBe(4)
    expect(lookupBudget({ ...brief, kind: 'references', data: three })).toBe(3)
  })

  it('gives the scope and method chapters a small allowance of their own', () => {
    // They used to get none, with assignments that forbade what they could not see. Now they can
    // look — a parameter's note, an indicator's factors — and the allowance stays small.
    expect(lookupBudget({ ...brief, kind: 'goal_scope', data: { results: [1, 2, 3] } })).toBe(4)
    expect(lookupBudget({ ...brief, kind: 'methods', data: { results: [1, 2, 3] } })).toBe(6)
  })

  it('gives the method chapter the factors to look at, and says when to use them', async () => {
    sent.length = 0
    chat.rounds = []
    await writeSection({ brief: { ...brief, kind: 'methods' }, api: async () => ({}) })
    const names = (sent[0].tools ?? []).map((t) => (t as { function: { name: string } }).function.name)
    expect(names).toEqual(expect.arrayContaining(['get_method_factors', 'get_characterization_factors']))
    expect(names).not.toContain('compare_scenarios')
    const system = String(sent[0].messages[0].content)
    expect(system).toContain('get_characterization_factors')
    expect(system).not.toContain('compare_scenarios') // only the occasions of the tools it carries
  })

  it('tells the model the number it actually has', async () => {
    sent.length = 0
    chat.rounds = []
    await writeSection({
      brief: { ...brief, kind: 'lcia', data: { results: new Array(9).fill(0) } },
      api: async () => ({})
    })
    const system = String(sent[0].messages[0].content)
    // The wording moved with V258 — the allowance is now stated as a ceiling after the occasions to
    // use it, not as the first thing the writer reads. The number still has to be the real one.
    expect(system).toContain('The allowance is 17 calls for this chapter')
    expect(system).toContain('it is a ceiling, not a target')
    // And why a figure from a lookup must not be written down: it has no placeholder to keep it correct.
    expect(system).toContain('has none')
  })
})

describe('the str_replace contract', () => {
  const text = 'The bag is incinerated. The share is 90 %. The bag is heavy.'

  it('replaces an exact, unique match', () => {
    const r = applyPatch(text, [{ old: 'The share is 90 %.', new: 'The share is {{c.share_text}}.' }])
    expect(r.ok && r.text).toContain('{{c.share_text}}')
  })

  it('refuses a search string that occurs twice, and says how to fix it', () => {
    const r = applyPatch(text, [{ old: 'The bag is', new: 'A bag is' }])
    expect(r.ok).toBe(false)
    // The single most important safeguard of the pattern: an ambiguous match is never guessed at.
    expect(!r.ok && r.error).toMatch(/more than once/i)
    expect(!r.ok && r.error).toMatch(/surrounding words|all/i)
  })

  it('replaces every occurrence only when asked explicitly', () => {
    const r = applyPatch(text, [{ old: 'The bag is', new: 'A bag is', all: true }])
    expect(r.ok && r.text.match(/A bag is/g)).toHaveLength(2)
  })

  it('refuses a search string that is not there, and tells it to quote verbatim', () => {
    const r = applyPatch(text, [{ old: 'the Bag  is', new: 'x' }])
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/not found/i)
    expect(!r.ok && r.error).toMatch(/exactly/i)
  })

  it('treats a no-op as an error rather than a success', () => {
    const r = applyPatch(text, [{ old: 'The bag is heavy.', new: 'The bag is heavy.' }])
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/identical/i)
  })

  it('never applies a patch halfway', () => {
    const r = applyPatch(text, [
      { old: 'The share is 90 %.', new: 'ok' },
      { old: 'not present', new: 'x' }
    ])
    expect(r.ok).toBe(false) // the first replacement is discarded with the second
  })
})

describe('correction after the gate refuses', () => {
  it('feeds the findings back, patches, and stops once the gate is clean', async () => {
    const posted: unknown[] = []
    let checks = 0
    chat.rounds = [
      { text: 'The share is 90 % of the total.' },
      { text: '{"replacements": [{"old": "90 %", "new": "{{contribution.groups.0.share_text}}"}]}' }
    ]
    const out = await writeSection({
      brief,
      api: async (_m, path, body) => {
        if (path.endsWith('/proposal')) {
          posted.push(body)
          checks++
          // First look: a literal number. After the patch: clean.
          return checks === 1
            ? { ok: false, findings: [{ kind: 'literal_number', detail: 'The number 90 is written out.' }] }
            : { ok: true, findings: [] }
        }
        return {}
      },
      checkPath: '/api/v1/report/one/m/rep/sections/s1/proposal'
    })
    // The gate is asked with store=false — nothing is written until it is clean.
    expect((posted[0] as { store: boolean }).store).toBe(false)
    expect(out.attempts).toBe(2)
    expect(out.findings).toEqual([])
    expect(out.text).not.toContain('90 %')
  })

  it('gives up after two revisions and hands the findings to the author', async () => {
    chat.rounds = [
      { text: 'Still 90 % here and 80 % there.' },
      { text: '{"replacements": [{"old": "90 %", "new": "ninety"}]}' },
      { text: '{"replacements": [{"old": "80 %", "new": "eighty"}]}' }
    ]
    const out = await writeSection({
      brief,
      api: async (_m, path) =>
        path.endsWith('/proposal')
          ? { ok: false, findings: [{ kind: 'literal_number', detail: 'The number 90 is written out.' }] }
          : {},
      checkPath: '/api/v1/report/one/m/rep/sections/s1/proposal'
    })
    expect(out.attempts).toBe(3) // one write plus two revisions
    expect(out.findings).toHaveLength(1) // shown rather than swallowed
  })

  it('does not revise a chapter the gate accepted with advisory findings', async () => {
    let checks = 0
    chat.rounds = [{ text: 'Transport dominates the result.' }]
    const out = await writeSection({
      brief,
      api: async (_m, path) => {
        if (path.endsWith('/proposal')) {
          checks++
          // The gate's three advisory kinds are notes for the author, not a refusal: `ok` stays true.
          return { ok: true, findings: [{ kind: 'value_judgement', detail: '"dominates" is a judgement.' }] }
        }
        return {}
      },
      checkPath: '/api/v1/report/one/m/rep/sections/s1/proposal'
    })
    expect(out.attempts).toBe(1) // no revision was paid for
    expect(out.text).toBe('Transport dominates the result.') // and the wording the author will read is untouched
    expect(out.findings).toHaveLength(1) // the note still reaches them
    // Exactly one look by the gate: an accepted chapter is done. (A read-through pass could once
    // make it two; that pass is gone — see reportWriter.)
    expect(checks).toBe(1)
  })
})

describe('a chapter may ask for one figure', () => {
  it('splits the request off the prose and hands it over as a spec', async () => {
    chat.rounds = [
      {
        text:
          'End of life dominates the result.\n' +
          'FIGURE: {"kind": "bar", "source": "contribution.groups", "value": "share_percent", "caption": "By phase"}'
      }
    ]
    const out = await writeSection({ brief })
    // The prose must not keep the JSON: the gate would read it as a sentence full of literal numbers.
    expect(out.text).toBe('End of life dominates the result.')
    expect(out.figure).toEqual({
      kind: 'bar',
      source: 'contribution.groups',
      value: 'share_percent',
      caption: 'By phase'
    })
  })

  it('treats no request and a malformed one alike — as no figure', async () => {
    chat.rounds = [{ text: 'A chapter that argues in words.' }]
    expect((await writeSection({ brief })).figure).toBeNull()

    chat.rounds = [{ text: 'Prose.\nFIGURE: {kind: bar, oops}' }]
    const broken = await writeSection({ brief })
    expect(broken.figure).toBeNull()
    expect(broken.text).toBe('Prose.')
  })

  it('offers the sources and kinds it was given, and says a chart is optional', async () => {
    sent.length = 0
    chat.rounds = []
    await writeSection({
      brief: {
        ...brief,
        figure_kinds: ['bar', 'stacked_bar'],
        figure_sources: { 'contribution.groups': ['impact'] }
      }
    })
    const user = String(sent[0].messages[1].content)
    expect(user).toContain('FIGURE:')
    expect(user).toContain('contribution.groups')
    expect(user).toContain('bar | stacked_bar')
    // A chart drawn because it was possible is decoration — the prompt has to say so.
    expect(user).toContain('decoration')
  })

  it('names the label the requested chart will carry, so the paragraph can point at it', async () => {
    // The label depends on what the chapter already draws — index `n` of its figure list, or the bare
    // `f-section-<id>` of a chapter that carries the single legacy key — so a writer cannot guess it, and
    // a guess that missed bought an `unknown_reference` for the chart the write had itself commissioned.
    sent.length = 0
    chat.rounds = []
    await writeSection({
      brief: {
        ...brief,
        figure_kinds: ['bar'],
        figure_sources: { 'contribution.groups': ['impact'] },
        figure_ref: 'f-section-sec-1-2'
      }
    })
    expect(String(sent[0].messages[1].content)).toContain('{{ref:f-section-sec-1-2}}')
  })
})

describe('what an early review pinned down', () => {
  it('reads a spec pretty-printed across lines, nested braces and all', async () => {
    chat.rounds = [
      {
        text:
          'Prose.\n' +
          'FIGURE: {\n  "kind": "bar",\n  "source": "contribution.groups",\n  "value": "share_percent",\n  "caption": "By {phase}"\n}'
      }
    ]
    const out = await writeSection({ brief })
    // The lazy regex stopped at the first line-ending `}`, mangled the spec AND left an orphan brace as prose.
    expect(out.figure).toMatchObject({ kind: 'bar', caption: 'By {phase}' })
    expect(out.text).toBe('Prose.')
  })

  it('forwards the report cautions into the system message', async () => {
    sent.length = 0
    chat.rounds = [{ text: 'Prose.' }]
    await writeSection({ brief: { ...brief, cautions: ['Never write that one variant is better.'] } })
    // The backend always sent them; the writer never forwarded them — the ISO 14044 §7.3.3 guard was mute.
    expect(String(sent[0].messages[0].content)).toContain('Never write that one variant is better.')
  })

  it('an abort mid-write throws instead of returning a half chapter', async () => {
    chat.rounds = [{ text: 'Half a chap' }]
    const controller = new AbortController()
    controller.abort()
    await expect(writeSection({ brief, signal: controller.signal })).rejects.toThrow(/cancelled/)
  })

  it('a failing gate check keeps the text instead of destroying it', async () => {
    chat.rounds = [{ text: 'A finished chapter.' }]
    const out = await writeSection({
      brief,
      api: async () => {
        throw new Error('backend restarting')
      },
      checkPath: '/api/v1/report/one/m/rep/sections/s1/proposal'
    })
    expect(out.text).toBe('A finished chapter.')
    expect(out.findings.some((f) => f.kind === 'check_failed')).toBe(true)
  })
})

describe('writeAll — the run owned by the main process', () => {
  const record = (): { calls: string[]; api: (m: string, p: string, b?: unknown) => Promise<unknown> } => {
    const calls: string[] = []
    return {
      calls,
      api: async (_m: string, path: string, body?: unknown): Promise<unknown> => {
        const section = path.split('/').at(-2) ?? '?'
        const b = body as { store?: boolean } | undefined
        if (path.endsWith('/brief')) {
          calls.push(`brief:${section}`)
          return { ...brief }
        }
        calls.push(`${b?.store ? 'store' : 'check'}:${section}`)
        return b?.store ? { ok: true, stored: true, findings: [] } : { ok: true, findings: [] }
      }
    }
  }

  it('waves are barriers: the summarising chapter starts only after the first wave landed', async () => {
    chat.rounds = Array.from({ length: 8 }, () => ({ text: 'Prose.' }))
    const { calls, api } = record()
    const out = await writeAll({
      base: '/api/v1/report/one/m/rep',
      waves: [[{ id: 'a' }, { id: 'b' }, { id: 'c' }], [{ id: 'z' }]],
      api,
      lanes: 2
    })
    expect(out).toHaveLength(4)
    expect(out.every((o) => o.stored)).toBe(true)
    const zBrief = calls.indexOf('brief:z')
    for (const id of ['a', 'b', 'c']) expect(calls.indexOf(`store:${id}`)).toBeLessThan(zBrief)
  })

  it('a refused chapter keeps its text for the draft and is not counted as stored', async () => {
    chat.rounds = [{ text: 'Prose.' }]
    const { api } = record()
    const refusing = async (m: string, p: string, b?: unknown): Promise<unknown> => {
      const answer = (await api(m, p, b)) as Record<string, unknown>
      return (b as { store?: boolean } | undefined)?.store ? { ...answer, stored: false } : answer
    }
    const [out] = await writeAll({ base: '/x', waves: [[{ id: 'a' }]], api: refusing })
    expect(out.stored).toBe(false)
    expect(out.text).toBe('Prose.') // the paid-for text survives for the draft
  })

  it('a cancelled run reports errors instead of half chapters, and skips later waves', async () => {
    chat.rounds = [{ text: 'ignored' }]
    const { api } = record()
    const controller = new AbortController()
    controller.abort()
    const out = await writeAll({
      base: '/x',
      waves: [[{ id: 'a' }, { id: 'b' }], [{ id: 'z' }]],
      api,
      signal: controller.signal
    })
    expect(out).toHaveLength(2) // wave 2 never started
    expect(out.every((o) => !o.stored && /cancelled/.test(o.error ?? ''))).toBe(true)
  })
})

describe('a lapsed deadline is not a Stop click (V178)', () => {
  // Measured in a live run: a chapter's row in the correction dialog read
  // "Refused: The correction was cancelled" while nobody had pressed anything. The backstop's clock
  // had run out — a fact the author can act on, and the opposite of what they were told.
  const timedOut = (): AbortSignal => {
    const controller = new AbortController()
    controller.abort(DEADLINE_REASON)
    return controller.signal
  }

  it('never blames the author in the deadline wording', () => {
    expect(DEADLINE_NOTE).not.toMatch(/cancel/i)
  })

  it('carries the same distinction into a written chapter', async () => {
    chat.rounds = [{ text: 'Half a chap' }]
    await expect(writeSection({ brief, signal: timedOut() })).rejects.toThrow(/ran past its time limit/)
  })

  it('carries it into every chapter of a "Write all" run', async () => {
    chat.rounds = [{ text: 'ignored' }]
    const out = await writeAll({
      base: '/x',
      waves: [[{ id: 'a' }]],
      api: async () => ({}),
      signal: timedOut()
    })
    expect(out.every((o) => /ran past its time limit/.test(o.error ?? ''))).toBe(true)
  })
})

describe('reportDeadlineMs — one clock per answer the call waits for', () => {
  it('gives a single-answer helper the plain budget', () => {
    expect(reportDeadlineMs(1)).toBe(ANSWER_BUDGET_MS)
  })

  it('gives a correction two, because an empty answer is drawn again (V177)', () => {
    // The whole of V178: both draws have to fit inside one clock, or the second one is cut off and
    // reported as an abort.
    expect(reportDeadlineMs(2)).toBe(2 * ANSWER_BUDGET_MS)
  })

  it('never goes below one answer, whatever it is handed', () => {
    expect(reportDeadlineMs(0)).toBe(ANSWER_BUDGET_MS)
    expect(reportDeadlineMs(-3)).toBe(ANSWER_BUDGET_MS)
  })

  it('counts a translation by its batches, not by its texts — the lanes shorten the wait', () => {
    const many = Array.from({ length: 36 }, (_, i) => ({ key: `k${i}`, text: 'x'.repeat(600) }))
    expect(translationBatches(many)).toHaveLength(4)
    // Four batches, four lanes: they run at once, so the wait is one batch long — two answers of it,
    // because a batch whose reply came back unreadable is asked once more.
    expect(translationAnswers(many)).toBe(2)
    // Sequential lanes are the honest worst case, and then every batch adds to the clock.
    expect(translationAnswers(many, { lanes: 1 })).toBe(8)
    expect(reportDeadlineMs(translationAnswers(many, { lanes: 1 }))).toBe(8 * ANSWER_BUDGET_MS)
  })

  it('leaves a short translation on the plain budget', () => {
    expect(reportDeadlineMs(translationAnswers([{ key: 'a', text: 'kurz' }]))).toBe(2 * ANSWER_BUDGET_MS)
  })
})

describe('the write backstop is a chapter long, not one answer long (V185)', () => {
  // One live run wrote its longest chapter in 324 s and three more in over 200 s, against a
  // flat ten-minute clock — and a chapter cut off by that clock is one that was paid for and lost.
  it('counts a chapter as its lookup rounds, its prose round and its revisions', () => {
    // The interpretation fixture, one indicator: 6 lookups, the round that writes, two revisions.
    // …plus the continuations an answer cut off at the output limit may ask for.
    // …and the one forced answer after an empty first round.
    expect(sectionAnswers(brief)).toBe(lookupBudget(brief) + 3 + MAX_CONTINUATIONS + 1)
    expect(sectionAnswers(brief)).toBe(12)
  })

  it('grows with the allowance, so a chapter with more to open gets the longer clock', () => {
    const many = { ...brief, data: { ...brief.data, results: Array.from({ length: 7 }, () => ({})) } }
    // Derived from the constants, not written down: the wider lookup allowance moves the clock too.
    expect(sectionAnswers(many)).toBe(lookupBudget(many) + 3 + MAX_CONTINUATIONS + 1)
    // And the plan-time clock, set before any brief is fetched, assumes the widest allowance there is.
    const widest = { ...brief, kind: 'inventory', data: { foreground: new Array(40).fill(0) } }
    expect(reportDeadlineMs(sectionAnswers(widest))).toBe(MAX_SECTION_ANSWERS * ANSWER_BUDGET_MS)
  })

  it('counts a "Write all" run by waves and lanes, not by chapters', () => {
    // Four chapters in one wave are four lanes: one chapter's wait, not four.
    expect(writeAllAnswers([[1, 2, 3, 4]])).toBe(MAX_SECTION_ANSWERS)
    // Waves are barriers — the summarising chapters wait for the ordinary ones — so they do add up.
    expect(writeAllAnswers([[1, 2, 3, 4], [5]])).toBe(2 * MAX_SECTION_ANSWERS)
    // Five chapters in one wave need a second pass through the lanes.
    expect(writeAllAnswers([[1, 2, 3, 4, 5]])).toBe(2 * MAX_SECTION_ANSWERS)
    expect(writeAllAnswers([[1, 2]], 1)).toBe(2 * MAX_SECTION_ANSWERS)
  })

  it('never asks for less than one answer, even for an empty plan', () => {
    expect(reportDeadlineMs(writeAllAnswers([]))).toBe(ANSWER_BUDGET_MS)
  })
})

describe('the writer says what it is doing while it does it', () => {
  /**
   * A single chapter took 158 s and 385 s in live runs behind a still spinner. The
   * panel's line is a pure function of these events (views/writeStatus.test.ts); what is under test
   * here is that the events describe the run truthfully — and that they are few.
   *
   * The throttle (PHASE_TICK_MS) drops repeats within 400 ms, so a test that runs in two milliseconds
   * sees exactly the phase CHANGES, which is the guarantee worth pinning: no flicker, no per-token
   * flood, and every step of a chapter named once.
   */
  const phases = async (opts: Parameters<typeof writeSection>[0]): Promise<string[]> => {
    const seen: string[] = []
    await writeSection({ ...opts, onPhase: (p) => seen.push(p.phase) })
    return seen
  }

  it('reports an open request, then thinking, then the chapter arriving', async () => {
    chat.rounds = [{ reasoning: [120, 340], text: 'The chapter.' }]
    expect(await phases({ brief })).toEqual(['sent', 'thinking', 'writing'])
  })

  // Without the reasoning ticks "waiting" and "thinking" are the same picture, and they are different
  // problems: one is a provider queue, the other is work being done.
  it('stays at “sent” for a model that never reasons', async () => {
    chat.rounds = [{ text: 'The chapter.' }]
    expect(await phases({ brief })).toEqual(['sent', 'writing'])
  })

  it('names each lookup and counts it against the allowance', async () => {
    chat.rounds = [
      { calls: [{ id: 't1', name: 'explain_result', arguments: '{}' }] },
      { text: 'The chapter.' }
    ]
    const seen: Array<Record<string, unknown>> = []
    await writeSection({
      brief,
      api: async () => ({ ok: true }),
      onPhase: (p) => seen.push(p as unknown as Record<string, unknown>)
    })
    expect(seen.find((p) => p.phase === 'lookup')).toEqual({
      phase: 'lookup',
      name: 'explain_result',
      spent: 1,
      allowance: lookupBudget(brief)
    })
  })

  it('reports the second attempt that a refused chapter costs', async () => {
    let checks = 0
    chat.rounds = [
      { text: 'The share is 90 % of the total.' },
      { text: '{"replacements": [{"old": "90 %", "new": "{{contribution.groups.0.share_text}}"}]}' }
    ]
    const seen: Array<{ phase: string; attempt?: number }> = []
    await writeSection({
      brief,
      api: async (_m, path) => {
        if (!path.endsWith('/proposal')) return {}
        checks++
        return checks === 1
          ? { ok: false, findings: [{ kind: 'literal_number', detail: 'The number 90 is written out.' }] }
          : { ok: true, findings: [] }
      },
      checkPath: '/api/v1/report/one/m/rep/sections/s1/proposal',
      onPhase: (p) => seen.push(p as { phase: string; attempt?: number })
    })
    // The revision reply is JSON, not chapter: it deliberately reports no character count, because
    // "1,240 characters so far" of a patch instruction would read as the chapter being rewritten.
    expect(seen.map((p) => p.phase)).toEqual(['sent', 'writing', 'checking', 'revising', 'checking'])
    expect(seen.find((p) => p.phase === 'revising')?.attempt).toBe(2)
  })

  it('costs nothing when nobody is listening', async () => {
    chat.rounds = [{ reasoning: [120], text: 'The chapter.' }]
    // No sink, no events: a caller that does not want the commentary must not pay for it.
    await expect(writeSection({ brief })).resolves.toMatchObject({ text: 'The chapter.' })
  })

  /**
   * One mechanism, two callers. A run's four lanes each write a chapter, so their phases are stamped
   * with the chapter they belong to — that stamp is what lets the panel draw the commentary for the
   * one chapter being written on its own and ignore the four talking at once.
   */
  it('stamps a run’s phases with the chapter they came from', async () => {
    chat.rounds = [{ text: 'One.' }, { text: 'Two.' }]
    const seen: Array<{ id: string; phase: string }> = []
    await writeAll({
      base: '/api/v1/report/one/m/rep',
      waves: [[{ id: 'a' }, { id: 'b' }]],
      api: async () => ({ stored: true }),
      lanes: 1,
      onPhase: (p) => seen.push(p as { id: string; phase: string })
    })
    expect([...new Set(seen.map((p) => p.id))].sort()).toEqual(['a', 'b'])
  })
})

describe("a lookup answers in the document's language (V260)", () => {
  const call = (name: string, args: Record<string, unknown>, id = 't1') => ({
    id,
    name,
    arguments: JSON.stringify(args)
  })

  it('rewrites the stored names in a tool result before the model reads it', async () => {
    // The snapshot a writer gets is translated; `get_process_details` answers out of the MODEL, whose
    // names never move. With lookups encouraged, eleven of them in one chapter carried four German
    // process names into an English report's prose — two chapters after the table printed them in
    // English. A rewrite, not an instruction: the name in front of a model is the name it writes.
    chat.rounds = [{ calls: [call('get_process_details', { code: 'c' }, 't1')] }, { text: 'The chapter.' }]
    const out = await writeSection({
      brief: {
        ...brief,
        printed_names: { 'Nutzung — Anstrich 1 m²': 'Use — coating 1 m²', kurz: 'short' }
      },
      activeDb: 'm',
      api: async () => ({ activity: { name: 'Nutzung — Anstrich 1 m²', comment: 'Der kurz Kommentar.' } })
    })
    expect(out.lookups[0].result).toContain('Use — coating 1 m²')
    expect(out.lookups[0].result).not.toContain('Nutzung')
    // A source of three characters or fewer never reaches the pairs (it would match inside words);
    // this one is four, so it does, and that is the intended reach.
    expect(out.lookups[0].result).toContain('short')
  })

  it("does no work when the study is already in the report's language", async () => {
    chat.rounds = [{ calls: [call('get_process_details', { code: 'c' }, 't1')] }, { text: 'The chapter.' }]
    const out = await writeSection({
      brief,
      activeDb: 'm',
      api: async () => ({ activity: { name: 'Use — coating' } })
    })
    expect(out.lookups[0].result).toContain('Use — coating')
  })
})

describe('an answer has to end properly', () => {
  // Until then the loop took whatever had arrived as the chapter: a stream that closed without a
  // finish event, an answer cut off at the output limit, an empty one — all went to the gate, and the
  // empty one was stored over the chapter it replaced.
  it('keeps an answer that ended without a finish signal as an unchecked draft', async () => {
    chat.defaultFinish = undefined
    try {
      chat.rounds = [{ text: 'Half a chapter that' }]
      const out = await writeSection({ brief })
      expect(out.incomplete).toBe(true)
      expect(out.text).toBe('Half a chapter that')
      expect(out.findings.map((f) => f.kind)).toEqual(['incomplete_answer'])
      expect(out.findings[0].detail).toContain('not checked and not stored')
    } finally {
      chat.defaultFinish = 'stop'
    }
  })

  it('asks a model cut off at the output limit to go on, and joins the halves without the overlap', async () => {
    sent.length = 0
    chat.rounds = [
      { text: 'The first half of the chapter ends mid', finish: 'length' },
      { text: 'ends mid-sentence and goes on here.', finish: 'stop' }
    ]
    const out = await writeSection({ brief })
    expect(out.incomplete).toBeUndefined()
    expect(out.text).toBe('The first half of the chapter ends mid-sentence and goes on here.')
    expect(sent).toHaveLength(2)
    expect(String(sent[1].messages.at(-1)?.content)).toContain('Continue exactly where you stopped')
  })

  it('gives up after the allowed continuations and keeps the draft', async () => {
    chat.rounds = Array.from({ length: MAX_CONTINUATIONS + 1 }, (_, i) => ({
      text: `part ${i} `,
      finish: 'length'
    }))
    const out = await writeSection({ brief })
    expect(out.incomplete).toBe(true)
    expect(out.findings[0].kind).toBe('incomplete_answer')
    expect(out.findings[0].detail).toContain('output limit')
  })

  it('reports an empty answer instead of handing it to the gate', async () => {
    chat.rounds = [{ text: '', finish: 'stop' }]
    const out = await writeSection({ brief })
    expect(out.incomplete).toBe(true)
    expect(out.findings.map((f) => f.kind)).toEqual(['empty_answer'])
  })

  it('no longer cuts a long chapter at 6 000 characters', async () => {
    const long = 'A sentence that carries a reservation at the very end. '.repeat(140).trim()
    expect(long.length).toBeGreaterThan(6_000)
    chat.rounds = [{ text: long }]
    const out = await writeSection({ brief })
    expect(out.text).toBe(long)
  })

  it('names each way an answer can fail to be a chapter', () => {
    expect(incompleteReason('stop', 'text')).toBeNull()
    expect(incompleteReason('tool_calls', 'text')).toBeNull()
    expect(incompleteReason(null, 'text')?.kind).toBe('incomplete_answer')
    expect(incompleteReason('content_filter', 'text')?.detail).toContain('content_filter')
    expect(incompleteReason('stop', '  ')?.kind).toBe('empty_answer')
  })

  it('joins a continuation with or without an overlap', () => {
    expect(joinContinuation('The result is', ' lower than expected.')).toBe(
      'The result is lower than expected.'
    )
    expect(joinContinuation('The result is lower than expected', ', as the table shows.')).toBe(
      'The result is lower than expected, as the table shows.'
    )
    expect(
      joinContinuation('abc '.repeat(10) + 'the overlap of twenty+', 'the overlap of twenty+ more')
    ).toBe('abc '.repeat(10) + 'the overlap of twenty+ more')
  })
})

describe('a proposal is bound to the brief it was written from', () => {
  it('hands the snapshot id to the check and both ids to the store', async () => {
    const bodies: Record<string, unknown>[] = []
    chat.rounds = [{ text: 'A chapter without figures.' }]
    await writeSection({
      brief: { ...brief, snapshot_id: 'snap-1', text_version: 'v-old' },
      api: async (_m, path, body) => {
        if (path.endsWith('/proposal')) bodies.push(body as Record<string, unknown>)
        return { ok: true, findings: [] }
      },
      checkPath: '/api/v1/report/one/m/rep/sections/s1/proposal'
    })
    expect(bodies[0].snapshot_id).toBe('snap-1')
    const outcomes = await writeAll({
      base: '/api/v1/report/one/m/rep',
      waves: [[{ id: 's1' }]],
      api: async (_m, path, body) => {
        if (path.endsWith('/brief')) return { ...brief, snapshot_id: 'snap-2', text_version: 'v-2' }
        if (path.endsWith('/proposal')) {
          bodies.push(body as Record<string, unknown>)
          return { ok: true, stored: true, findings: [] }
        }
        return {}
      }
    })
    expect(outcomes[0].stored).toBe(true)
    const stored = bodies.find((b) => b.store === true)
    expect(stored?.snapshot_id).toBe('snap-2')
    expect(stored?.expected_text_version).toBe('v-2')
  })
})
