import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chat, type ScriptedRound } from './test/fakeStream'
import type { MatchRow } from './importMatcher'

/**
 * The matcher is judged on what it REFUSES. Its whole reason for existing is the asymmetry that an
 * unmatched flow is reported in three places while a wrongly matched one becomes a number that
 * looks finished — so a test suite that only measured hit rate would be measuring the wrong thing.
 *
 * Offline against the shared scripted stream: no key, no network, no cost.
 */
vi.mock('./client', async () => (await import('./test/fakeStream')).clientModuleMock())

const { matchBatch, MatchStopped } = await import('./importMatcher')

const CO2 = {
  dataset: 'Widget production',
  index: 1,
  kind: 'biosphere',
  name: 'Carbon dioxide, fossil',
  unit: 'kg',
  compartment: ['air'],
  candidates: [
    {
      database: 'biosphere3',
      code: 'co2-air',
      label: 'Carbon dioxide, fossil · air',
      name: 'Carbon dioxide, fossil',
      categories: ['air'],
      location: '',
      unit: 'kilogram'
    },
    {
      database: 'biosphere3',
      code: 'ch4-air',
      label: 'Methane, fossil · air',
      name: 'Methane, fossil',
      categories: ['air'],
      location: '',
      unit: 'kilogram'
    }
  ]
}

function script(...rounds: ScriptedRound[]): void {
  chat.rounds = [...rounds]
  chat.seen = []
}

beforeEach(() => {
  chat.rounds = []
  chat.seen = []
})

describe('the import matcher', () => {
  it('throws MatchStopped when the run was stopped while an answer was still arriving', async () => {
    // No finish event: the stream was cut, and its partial text must not be read as an answer.
    script({ text: '{"answers":[{"item":1,"choi' })
    const controller = new AbortController()
    controller.abort()
    await expect(matchBatch([CO2], { model: 'm', signal: controller.signal })).rejects.toThrow(MatchStopped)
  })

  it('returns the answers of a batch that had finished before the stop', async () => {
    script(
      {
        text: '{"answers":[{"item":1,"choice":1,"evidence":"same substance name and compartment"}]}',
        finish: 'stop'
      },
      { text: '{"checks":[{"item":1,"verdict":"yes"}]}', finish: 'stop' }
    )
    const controller = new AbortController()
    controller.abort()
    const [decision] = await matchBatch([CO2], { model: 'm', signal: controller.signal })
    expect(decision.code).toBe('co2-air')
  })

  it('sends the user’s reply ceiling with the proposal and the verification', async () => {
    script(
      { text: '{"answers":[{"item":1,"choice":1,"evidence":"same substance name and compartment"}]}' },
      { text: '{"checks":[{"item":1,"verdict":"yes"}]}' }
    )
    await matchBatch([CO2], { model: 'm', maxTokens: 30_000 })
    expect(chat.seen.map((c) => c.maxTokens)).toEqual([30_000, 30_000])
  })

  it('takes a verified match, but only to “medium”', async () => {
    script(
      { text: '{"answers":[{"item":1,"choice":1,"evidence":"same substance name and compartment"}]}' },
      { text: '{"checks":[{"item":1,"verdict":"yes"}]}' }
    )
    const [decision] = await matchBatch([CO2], { model: 'm' })
    expect(decision.code).toBe('co2-air')
    // "good" is reserved for what a RULE established — an identifier that hit, or an exact name in
    // an exact compartment. A model agreeing with itself twice is not that kind of evidence.
    expect(decision.confidence).toBe('medium')
  })

  it('keeps a doubted match at the lowest band, with the objection attached', async () => {
    script(
      { text: '{"answers":[{"item":1,"choice":2,"evidence":"both are fossil gases"}]}' },
      { text: '{"checks":[{"item":1,"verdict":"no","why":"methane is not carbon dioxide"}]}' }
    )
    const [decision] = await matchBatch([CO2], { model: 'm' })
    // Not dropped: a thrown-out match leaves the reviewer nothing to look at, and one wording away
    // from its useful range the check discarded fourteen good matches in a single run.
    expect(decision.code).toBe('ch4-air')
    expect(decision.confidence).toBe('low')
    // The reviewer gets the check's OWN sentence. Writing our own over it cost us the one clue
    // that says whether the rejection was right.
    expect(decision.evidence).toContain('methane is not carbon dioxide')
  })

  it('keeps an unconfirmed match but marks it low', async () => {
    script(
      { text: '{"answers":[{"item":1,"choice":1,"evidence":"same CAS number"}]}' },
      { text: '{"checks":[{"item":1,"verdict":"unsure"}]}' }
    )
    const [decision] = await matchBatch([CO2], { model: 'm' })
    expect(decision.confidence).toBe('low')
    expect(decision.evidence).toContain('could not confirm')
  })

  it('honours a zero without asking the verifier', async () => {
    script({ text: '{"answers":[{"item":1,"choice":0,"evidence":""}]}' })
    const [decision] = await matchBatch([CO2], { model: 'm' })
    expect(decision.code).toBeNull()
    expect(decision.confidence).toBe('open')
    // One call, not two: there is nothing to verify.
    expect(chat.seen.length).toBe(1)
  })

  it('refuses a choice that comes without evidence', async () => {
    script({ text: '{"answers":[{"item":1,"choice":1}]}' })
    const [decision] = await matchBatch([CO2], { model: 'm' })
    expect(decision.code).toBeNull()
    expect(decision.evidence).toContain('no evidence')
  })

  it('refuses a choice that is not on the list', async () => {
    /* Constrained choice is the one technique that holds by construction — but only if the code
       enforces it. An index past the end is a hallucinated candidate in disguise. */
    script({ text: '{"answers":[{"item":1,"choice":7,"evidence":"the seventh one"}]}' })
    const [decision] = await matchBatch([CO2], { model: 'm' })
    expect(decision.code).toBeNull()
  })

  it('treats an unparseable answer as no answer, never as the first candidate', async () => {
    script({ text: 'Sure! I think the first one looks right.' })
    const [decision] = await matchBatch([CO2], { model: 'm' })
    expect(decision.code).toBeNull()
    expect(decision.evidence).toContain('no usable answer')
  })

  it('asks nothing when there is nothing to choose from', async () => {
    const decisions = await matchBatch([{ ...CO2, candidates: [] }], { model: 'm' })
    expect(decisions).toEqual([])
    expect(chat.seen.length).toBe(0)
  })

  it('offers “none of these” as item zero, inside the list', async () => {
    script({ text: '{"answers":[{"item":1,"choice":0}]}' })
    await matchBatch([CO2], { model: 'm' })
    const prompt = JSON.stringify(chat.seen[0])
    expect(prompt).toContain('0. none of these')
  })
})

describe('regions are not the model’s decision', () => {
  const ELEC = {
    dataset: 'Widget production',
    index: 2,
    kind: 'technosphere',
    name: 'Electricity, medium voltage',
    unit: 'MJ',
    compartment: [],
    candidates: [
      {
        database: 'eco',
        code: 'elec-glo',
        label: 'market for electricity, medium voltage · GLO',
        name: 'market for electricity, medium voltage',
        location: 'GLO',
        unit: 'kilowatt hour'
      },
      {
        database: 'eco',
        code: 'elec-de',
        label: 'market for electricity, medium voltage · DE',
        name: 'market for electricity, medium voltage',
        location: 'DE',
        unit: 'kilowatt hour'
      },
      {
        database: 'eco',
        code: 'coal-glo',
        label: 'electricity production, hard coal · GLO',
        name: 'electricity production, hard coal',
        location: 'GLO',
        unit: 'kilowatt hour'
      }
    ]
  }

  it('shows one line per activity, without the region, and maps the answer back', async () => {
    script(
      { text: '{"answers":[{"item":1,"choice":1,"evidence":"same product, same unit family"}]}' },
      { text: '{"checks":[{"item":1,"verdict":"yes"}]}' }
    )
    const [decision] = await matchBatch([ELEC], { model: 'm' })

    // Two regions of one activity collapsed to one option; the other activity kept its own.
    const asked = chat.seen[0].messages[1].content as string
    expect(asked).toContain('1. market for electricity, medium voltage [kilowatt hour]')
    expect(asked).toContain('2. electricity production, hard coal [kilowatt hour]')
    expect(asked).not.toContain('GLO')
    expect(asked).not.toContain('DE')

    // …and choice 1 lands on the concrete dataset the backend put first, region and all.
    expect(decision.code).toBe('elec-glo')
  })

  it('tells the model when the shortlist came from a spelled-out abbreviation, in both steps', async () => {
    // The reading reached the backend candidate but never the model.
    const PET: MatchRow = {
      dataset: 'Water bottle',
      index: 1,
      kind: 'technosphere',
      name: 'PET resin, at plant',
      unit: 'kg',
      compartment: [],
      candidates: [
        {
          database: 'eco',
          code: 'pet',
          label: 'market for polyethylene terephthalate, granulate · GLO',
          name: 'market for polyethylene terephthalate, granulate',
          location: 'GLO',
          unit: 'kilogram',
          why: 'semantic search (also searched as “polyethylene terephthalate resin, at plant”)'
        }
      ]
    }
    script(
      { text: '{"answers":[{"item":1,"choice":1,"evidence":"PET is polyethylene terephthalate"}]}' },
      { text: '{"checks":[{"item":1,"verdict":"yes"}]}' }
    )
    await matchBatch([PET], { model: 'm' })
    const reading = 'also searched as “polyethylene terephthalate resin, at plant”'
    expect(chat.seen[0].messages[1].content as string).toContain(reading)
    expect(chat.seen[1].messages[1].content as string).toContain(reading)
  })

  it('says nothing about a reading when the search added none', async () => {
    script(
      { text: '{"answers":[{"item":1,"choice":1,"evidence":"same product, same unit family"}]}' },
      { text: '{"checks":[{"item":1,"verdict":"yes"}]}' }
    )
    await matchBatch([ELEC], { model: 'm' })
    expect(chat.seen[0].messages[1].content as string).not.toContain('also searched as')
  })

  it('does not let a collapsed list shift what a later index means', async () => {
    // The trap this guards: indexing the answer into row.candidates instead of the offered list
    // would turn "the second activity" into "the same activity in another region" — a wrong dataset
    // that looks perfectly plausible in the review table.
    script(
      { text: '{"answers":[{"item":1,"choice":2,"evidence":"hard coal is what the source names"}]}' },
      { text: '{"checks":[{"item":1,"verdict":"yes"}]}' }
    )
    const [decision] = await matchBatch([ELEC], { model: 'm' })
    expect(decision.code).toBe('coal-glo')
  })
})

describe('what the model is shown', () => {
  it('shows a flow its compartment, and a process not its region', async () => {
    script({ text: '{"answers":[{"item":1,"choice":0,"evidence":""}]}' }, { text: '{"checks":[]}' })
    await matchBatch([CO2], { model: 'm' })
    const asked = chat.seen[0].messages[1].content as string
    // A compartment is part of what a flow IS — two compartments are two substances as far as a
    // characterisation factor is concerned, and the imported line states its own.
    expect(asked).toContain('1. Carbon dioxide, fossil [kilogram] · air')
  })
})

describe('two tasks, two prompts', () => {
  const ELEC_ROW = {
    dataset: 'Widget production',
    index: 5,
    kind: 'technosphere',
    name: 'Electricity, medium voltage',
    unit: 'MJ',
    compartment: [],
    candidates: [
      {
        database: 'eco',
        code: 'elec',
        label: 'market for electricity, medium voltage · GLO',
        name: 'market for electricity, medium voltage',
        location: 'GLO',
        unit: 'kilowatt hour'
      }
    ]
  }

  it('gives a flow the flow instructions and a process the process ones', async () => {
    // One prompt served both until now, and its evidence rules were pure chemistry — "a CAS
    // number, an identical chemical formula". A market for electricity has none of those, so a
    // strict model had to answer 0 to every process and a lax one had to invent something.
    script({ text: '{"answers":[]}' })
    await matchBatch([CO2], { model: 'm' })
    const flowPrompt = chat.seen[0].messages[0].content as string
    expect(flowPrompt).toContain('elementary flows')
    expect(flowPrompt).toContain('CAS number')
    // The compartment rule the convention prescribes (bw2io: drop_unspecified_subcategories).
    expect(flowPrompt).toContain('the candidate WITHOUT a')

    script({ text: '{"answers":[]}' })
    await matchBatch([ELEC_ROW], { model: 'm' })
    const processPrompt = chat.seen[0].messages[0].content as string
    expect(processPrompt).toContain('technosphere input')
    expect(processPrompt).toContain('a market is a consumption mix')
    expect(processPrompt).not.toContain('CAS number')
    // A process has no compartment, and its region is deliberately not its business.
    expect(processPrompt).toContain('not choosing a country')
  })

  it('says a quantity clash out loud and hands over what the source states', async () => {
    const gas = {
      dataset: 'Widget production',
      index: 2,
      kind: 'biosphere',
      name: 'Gas, natural, in ground',
      unit: 'kg',
      quantity: 'mass',
      properties: [{ name: 'Volume', amount: 1.29, unit: 'm3' }],
      compartment: ['natural resource'],
      candidates: [
        {
          database: 'biosphere3',
          code: 'gas',
          label: 'Gas, natural · natural resource / in ground',
          name: 'Gas, natural',
          categories: ['natural resource', 'in ground'],
          location: '',
          unit: 'standard cubic meter',
          quantity: 'volume'
        }
      ]
    }
    script({ text: '{"answers":[{"item":1,"choice":0,"evidence":""}]}' })
    await matchBatch([gas], { model: 'm' })
    const asked = String(chat.seen[0].messages[1].content)
    // Two unit strings whose quantities differ are easy to read past — the prompt says it out loud.
    expect(asked).toContain('measures volume, the imported line measures mass')
    // And the file's own number is on the table, so a bridge is reading, not remembering.
    expect(asked).toContain('the source also states: Volume 1.29 m3 per kg')
  })

  it('passes on a substance property the model supplies to bridge two quantities', async () => {
    script(
      {
        text: '{"answers":[{"item":1,"choice":1,"evidence":"same gas","bridge":{"quantity":1.29,"what":"density of natural gas, 0.775 kg/Sm3"}}]}'
      },
      { text: '{"checks":[{"item":1,"verdict":"yes"}]}' }
    )
    const [decision] = await matchBatch([CO2], { model: 'm' })
    expect(decision.assumption).toEqual({ quantity: 1.29, what: 'density of natural gas, 0.775 kg/Sm3' })
  })

  it('drops a bridge that cannot be printed beside the factor', async () => {
    script(
      { text: '{"answers":[{"item":1,"choice":1,"evidence":"same gas","bridge":{"quantity":0,"what":""}}]}' },
      { text: '{"checks":[{"item":1,"verdict":"yes"}]}' }
    )
    const [decision] = await matchBatch([CO2], { model: 'm' })
    expect(decision.assumption).toBeUndefined()
  })
})

describe('the import matcher — edge cases', () => {
  it('leaves a row open on a fractional choice instead of crashing the run', async () => {
    script({ text: '{"answers":[{"item":1,"choice":1.5,"evidence":"same substance"}]}' })
    const [decision] = await matchBatch([CO2], { model: 'm' })
    expect(decision.code).toBeNull()
    expect(decision.confidence).toBe('open')
    expect(chat.seen.length).toBe(1)
  })

  it('keeps two subcompartments of one flow apart for the model', async () => {
    const twoAirs = {
      ...CO2,
      candidates: [
        { ...CO2.candidates[0], code: 'co2-air', categories: ['air'] },
        { ...CO2.candidates[0], code: 'co2-urban', categories: ['air', 'urban air close to ground'] }
      ]
    }
    script(
      { text: '{"answers":[{"item":1,"choice":2,"evidence":"the source names urban air"}]}' },
      { text: '{"checks":[{"item":1,"verdict":"yes"}]}' }
    )
    const [decision] = await matchBatch([twoAirs], { model: 'm' })
    expect(decision.code).toBe('co2-urban')
  })
})

describe('two datasets of one name', () => {
  it('sends each decision back with the dataset key of its row', async () => {
    // The same activity in two regions: one name, one exchange index, two rows. Without the key
    // the backend resolved both decisions onto the last row.
    const de = { ...CO2, dataset_key: 'widget-de' }
    const fr = { ...CO2, dataset_key: 'widget-fr' }
    script(
      {
        text:
          '{"answers":[{"item":1,"choice":1,"evidence":"same substance and compartment"},' +
          '{"item":2,"choice":0,"evidence":"not this flow"}]}'
      },
      { text: '{"checks":[{"item":1,"verdict":"yes"}]}' }
    )
    const decisions = await matchBatch([de, fr], { model: 'm' })
    const byKey = decisions
      .map((d) => [d.dataset_key, d.code])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    expect(byKey).toEqual([
      ['widget-de', 'co2-air'],
      ['widget-fr', null]
    ])
  })

  it('leaves the key out for a row that has none', async () => {
    script({ text: '{"answers":[{"item":1,"choice":0,"evidence":"none of these"}]}' })
    const [decision] = await matchBatch([CO2], { model: 'm' })
    expect('dataset_key' in decision).toBe(false)
  })
})
