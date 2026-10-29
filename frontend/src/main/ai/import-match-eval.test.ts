/**
 * LIVE trap suite for the import matcher. **Opt-in** — skipped unless PRISM_MATCH_EVAL_LIVE=1:
 *
 *     PRISM_MATCH_EVAL_LIVE=1 npm run eval:match
 *     PRISM_MATCH_EVAL_LIVE=1 PRISM_MATCH_EVAL_MODEL=gpt-6-luna npm run eval:match
 *
 * What it measures is **not the hit rate**. The number that decides whether this feature is fit to
 * ship is how many *traps* it takes: items with no correct candidate, where the only way to be
 * wrong is to answer at all. A matcher that places 95 % correctly and also places three invented
 * substances has produced a database whose errors are invisible; one that places 80 % and refuses
 * the rest has produced a database with a to-do list.
 *
 * Both halves are asserted, because a model that answers 0 to everything would pass the trap half
 * perfectly and be useless.
 */
import { describe, expect, it } from 'vitest'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const LIVE = process.env.PRISM_MATCH_EVAL_LIVE === '1'
const MODEL = process.env.PRISM_MATCH_EVAL_MODEL || 'gpt-6-luna'

// The dev key file the app itself falls back to, read here because there is no Electron around.
const KEY_FILE = join(__dirname, '..', '..', '..', '..', '.secrets', 'openai-key')
if (LIVE && !process.env.OPENAI_API_KEY && existsSync(KEY_FILE)) {
  process.env.OPENAI_API_KEY = readFileSync(KEY_FILE, 'utf-8').trim()
}

const air = (name: string, unit = 'kilogram') => ({
  database: 'biosphere3',
  code: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  label: `${name} · air`,
  name,
  location: '', // an elementary flow has a compartment, never a region
  unit
})

/** Items that DO have a right answer — the half that stops "always 0" from passing. */
const REAL = [
  {
    name: 'Carbon dioxide, fossil',
    unit: 'kg',
    compartment: ['air'],
    expect: 'carbon-dioxide-fossil',
    candidates: [air('Carbon dioxide, fossil'), air('Carbon monoxide, fossil'), air('Methane, fossil')]
  },
  {
    name: 'Sulphur dioxide',
    unit: 'kg',
    compartment: ['air'],
    expect: 'sulfur-dioxide',
    candidates: [air('Sulfur dioxide'), air('Sulfur hexafluoride'), air('Nitrogen oxides')]
  },
  {
    name: 'Distickstoffmonoxid',
    unit: 'kg',
    compartment: ['air'],
    expect: 'dinitrogen-monoxide',
    candidates: [air('Dinitrogen monoxide'), air('Nitrogen oxides'), air('Ammonia')]
  }
]

/** Traps: nothing on the list is the same thing. The only wrong answer is any answer. */
const TRAPS = [
  {
    name: 'Kryptonite dust',
    unit: 'kg',
    compartment: ['air'],
    candidates: [air('Krypton-85', 'kilo Becquerel'), air('Chromium'), air('Cadmium')]
  },
  {
    name: 'Carbon dioxide, fossil',
    unit: 'kg',
    // Right substance, WRONG medium — the single most expensive kind of near miss.
    compartment: ['water'],
    candidates: [air('Carbon dioxide, fossil'), air('Carbon monoxide, fossil')]
  },
  {
    name: 'Perfluorohexanoic acid',
    unit: 'kg',
    compartment: ['air'],
    // A plausible-sounding neighbour family, none of them the same substance.
    candidates: [air('Perfluoropentanoic acid'), air('Perfluorooctanoic acid'), air('Acetic acid')]
  },
  {
    name: 'Electricity from fusion reactor',
    unit: 'kWh',
    compartment: ['air'],
    candidates: [air('Heat, waste', 'megajoule'), air('Radioactive species, unspecified', 'kilo Becquerel')]
  },
  {
    name: 'Bogusane, technical grade',
    unit: 'kg',
    compartment: ['air'],
    candidates: [air('Butane'), air('Propane'), air('Hexane')]
  },
  {
    name: 'Creosol',
    unit: 'kg',
    compartment: ['air'],
    // One letter from a real neighbour, from a real dataset (USLCI "Iron, sand casted"): creosol is
    // 2-methoxy-4-methylphenol, C8H10O2; cresol is methylphenol, C7H8O; guaiacol (2-methoxyphenol)
    // lacks the methyl. GLM 5.3 Flash took Cresol as a "spelling variant" and the verifier agreed,
    // so the dataset booked twice the cresol. The prompt already forbids it —
    // gemini-3.7-flash refused on the unchanged text — so this is a trap for models, not a prompt fix.
    candidates: [air('Cresol'), air('Phenol'), air('Phenol, 2-methoxy-')]
  }
]

describe.skipIf(!LIVE)('import matcher, live trap suite', () => {
  it('refuses every trap and still places what is really there', async () => {
    // Headless there is no Settings panel to read the provider from, and the dispatcher takes it
    // from module state rather than from the model id. Point it at whoever owns this model.
    const { setActiveProvider } = await import('./client')
    const { modelBelongsTo } = await import('./models')
    setActiveProvider(modelBelongsTo(MODEL, 'openai') ? 'openai' : 'openrouter')

    const { matchBatch } = await import('./importMatcher')
    const rows = [...REAL, ...TRAPS].map((item, i) => ({
      dataset: 'eval',
      index: i,
      kind: 'biosphere',
      name: item.name,
      unit: item.unit,
      compartment: item.compartment,
      candidates: item.candidates
    }))

    let spend = 0
    const decisions = await matchBatch(rows, {
      model: MODEL,
      onCost: (_m, sample) => {
        spend += sample.cost ?? 0
      }
    })
    const byIndex = new Map(decisions.map((d) => [d.index, d]))

    const wrongTraps = TRAPS.map((trap, n) => ({ trap, d: byIndex.get(REAL.length + n) }))
      .filter(({ d }) => d?.code)
      .map(({ trap, d }) => `${trap.name} → ${d?.code} (${d?.evidence})`)
    const missedReal = REAL.map((real, n) => ({ real, d: byIndex.get(n) })).filter(
      ({ real, d }) => d?.code !== real.expect
    )

    // Written to a file as well: a live eval is run once and its numbers are quoted afterwards,
    // and vitest keeps console output to itself unless coaxed.
    appendFileSync(
      join(__dirname, '..', '..', '..', 'match-eval.log'),
      `[match-eval ${MODEL}] traps taken ${wrongTraps.length}/${TRAPS.length} · ` +
        `real placed ${REAL.length - missedReal.length}/${REAL.length} · $${spend.toFixed(4)}\n` +
        wrongTraps.map((l) => `  TRAP TAKEN: ${l}\n`).join('') +
        missedReal
          .map(({ real, d }) => `  MISSED: ${real.name} -> ${d?.code ?? 'none'} (${d?.evidence ?? ''})\n`)
          .join('')
    )

    console.log(
      `[match-eval ${MODEL}] traps taken ${wrongTraps.length}/${TRAPS.length} · ` +
        `real placed ${REAL.length - missedReal.length}/${REAL.length} · $${spend.toFixed(4)}`
    )
    for (const line of wrongTraps) console.log(`  TRAP TAKEN: ${line}`)
    for (const { real, d } of missedReal) console.log(`  MISSED: ${real.name} → ${d?.code ?? 'none'}`)

    expect(wrongTraps, 'a trap taken is a silently wrong database').toEqual([])
    // Not all three: a model may reasonably hesitate on a German name or a spelling variant, and
    // hesitating is the behaviour we asked for. Answering nothing at all is not.
    expect(REAL.length - missedReal.length).toBeGreaterThanOrEqual(2)
  }, 180_000)
})
