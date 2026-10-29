/**
 * The model that places imported flows onto PrismLCA's vocabulary — and, more importantly, the one
 * that is allowed to say "none of these".
 *
 * Everything here is built around one asymmetry: **a flow left unmatched is reported in three
 * places (the review table, the health check, the report's limitations); a flow matched to the
 * wrong substance is a number that looks finished.** So the design is not "help the model decide",
 * it is "make deciding nothing the cheapest correct answer".
 *
 * Four of the five techniques the literature offers for abstention in entity linking are used; the
 * fifth is deliberately left out:
 *
 * 1. **A NIL option inside the candidate list**, not a caveat in the prose. `null` is item zero.
 * 2. **Evidence is mandatory.** A choice has to say what it hangs on — same substance name, same
 *    CAS number, same compartment. "Seems right" is not evidence and is scored as no match.
 * 3. **Two stages.** A second, separate call checks the first one's proposals against the raw line
 *    and answers yes / no / unsure. Only `yes` may reach the "good" band.
 * 4. **Constrained choice.** The model may only return an index into the list it was given, so an
 *    invented dataset name cannot be expressed at all.
 *
 * One thing the model is deliberately NOT asked: **which region.** An activity comes in up to
 * eight of them and the source line usually names none, so a forced country would be a guess
 * dressed as a decision — and eight near-identical candidates are eight ways to be wrong. The list
 * is collapsed to one line per activity before it is shown here (the backend puts the
 * best-justified region first); the person reviewing picks the region, in a dropdown that has all
 * of them.
 *
 * Not used: **logprob thresholds.** They would be the cleanest calibration signal, but OpenRouter
 * does not return logprobs across all models, and a criterion that disappears depending on which
 * provider served the request is not a criterion.
 *
 * The confidence band is assigned by the BACKEND, from rules. What the model returns is an input to
 * that, never the verdict — verbalised self-confidence is known to be overconfident.
 */

import { collectText, type CostSample } from './stream'

/** One reviewable line, as the backend's `/import/rows` hands it over. */
export interface MatchRow {
  dataset: string
  /** What identifies the dataset — two datasets can share a name, and then `dataset` + `index`
   *  names two rows. Sent back with every decision (the backend refuses a name-only one then). */
  dataset_key?: string
  index: number
  kind: string
  name: string
  unit: string
  compartment: string[]
  /** What the unit measures ("mass", "volume"), from the backend's unit table. "" for unknown. */
  quantity?: string
  /** What the source states about the flow beyond the amount — a density, a calorific value. */
  properties?: Array<{ name: string; amount: number; unit: string }>
  candidates: Array<{
    database: string
    code: string
    label: string
    /** The activity without its region — what the model is actually asked about. */
    name: string
    unit: string
    /** Compartment of a flow. Shown to the model; the region of a process is not (see below). */
    categories?: string[]
    location: string
    /** What the candidate's unit measures — flagged to the model when it differs from the row's. */
    quantity?: string
    /** What put it on the shortlist; carries "also searched as “…”" when the search spelled out an
     *  abbreviation in the name (backend search/abbrev.py). */
    why?: string
  }>
}

/** What we send back to `/import/decide`. */
export interface MatchDecision {
  dataset: string
  dataset_key?: string
  index: number
  code: string | null
  confidence: 'good' | 'medium' | 'low' | 'open'
  evidence: string
  /** The substance property bridging two quantities. See the prompt paragraph and units.py. */
  assumption?: { quantity: number; what: string }
}

/** The row's dataset key, when the backend sent one — see {@link MatchRow.dataset_key}. */
function keyOf(row: MatchRow): { dataset_key?: string } {
  return row.dataset_key ? { dataset_key: row.dataset_key } : {}
}

/** How many rows go into one request. Small enough that a long list cannot push the early rows out of
 *  attention, large enough that a 300-flow import is not 300 round trips. */
export const BATCH = 20

/** Thrown when the run was stopped while one of the batch's answers was still arriving. Its partial
 *  text would read as "no usable answer" for every row it had not reached; the caller drops the
 *  batch whole instead. A batch whose answers had both finished is NOT this — it was paid for
 *  in full and is returned, whatever happened to the run afterwards. */
export class MatchStopped extends Error {
  constructor() {
    super('stopped while the answer was arriving')
    this.name = 'MatchStopped'
  }
}

/**
 * Two tasks, two prompts. One prompt served both until now, and its evidence rules were pure
 * chemistry — "a CAS number, an identical chemical formula". A market for electricity has none of
 * those, so a strict model had to answer 0 to every process and a lax one had to invent something.
 * Both texts were tried on a weaker model first, with the negative cases:
 * the flow prompt refuses ammonia-in-water for ammonia-in-air, the process prompt refuses a waste
 * flow for a production dataset and a 3.5 t lorry for a 16 t one.
 */
const SYSTEM_FLOW = [
  'You place elementary flows from an imported life-cycle inventory onto the flow vocabulary of the',
  'receiving LCA database. An elementary flow is an exchange with the environment — an emission to',
  'it, or a resource taken from it — identified by a substance and by the compartment it enters or',
  'comes from.',
  '',
  'For each item you get the line as the source wrote it, with its unit and compartment, and a',
  'numbered list of candidates from our vocabulary. Answer with the number of the candidate that is',
  'THE SAME FLOW, or 0 for none.',
  '',
  'Answering 0 is a correct and often the correct answer. An unmatched flow is reported to the user',
  'and can be fixed by hand. A flow matched to the wrong substance silently changes the result of',
  'their study, and nothing downstream will catch it. When the candidates only resemble the item —',
  'a related substance, the same substance in a different medium, a broader or narrower material —',
  'answer 0.',
  '',
  'The compartment is part of what the flow IS: a characterisation factor is defined per',
  'compartment, so the same substance emitted to air and to water are two different flows carrying',
  'two different factors.',
  '',
  'When the imported line names no subcompartment, or names "unspecified", the candidate WITHOUT a',
  'subcompartment is the right one: that is the receiving database\'s own "unspecified", and it is',
  'what every importer maps it to. Choosing a specific subcompartment instead — "urban air close to',
  'ground" for a line that only said "air" — adds information the source did not give, and it',
  'changes the characterisation factor. Do that only if the imported line itself says so, and then',
  'say why.',
  '',
  'The other way round is common too: the imported line names a subcompartment — "low population',
  'density", "river", "ocean" — that none of the candidates carries, and the same substance is offered',
  'only in the bare compartment. That bare flow is its home: the receiving database\'s "unspecified" is',
  'where every importer puts a subcompartment it does not hold, and refusing would drop the emission',
  'altogether. Take it, and say that the subcompartment was not available. This holds only for the',
  'same substance in the same medium — air stays air, water stays water, soil stays soil.',
  '',
  'Sometimes the imported line is a group and we hold only one member of it — "Phenols, unspecified"',
  'against "Phenol". Strictly those are not the same flow. Often it is still the right place to put',
  'it, because the alternative is dropping the emission out of the inventory altogether. Take it',
  'when that member is what the group is mostly made of, leave it when the group is so broad that',
  'any member would be a guess ("Organic substances, unspecified"), and either way say which you',
  'judged it to be.',
  '',
  'The same holds for a substance our vocabulary splits where the source does not — methane and',
  'carbon monoxide come as fossil, non-fossil or from soil or biomass, and an imported line usually',
  'says none of that. What the dataset is doing normally settles it. Decide from that, and say what',
  'you decided from.',
  '',
  'That reasoning assumes there is a bare category to prefer. Sometimes there is none, and every',
  'candidate carries a subcompartment because that is the only way this database writes the flow',
  'down — natural resources are the usual case. Then the subcompartment is not precision the source',
  'withheld, and refusing would drop a flow that plainly exists. Judge what the substance itself',
  'implies, and say what you judged.',
  '',
  'When the imported line and the candidate do not state the same compartment word for word, your',
  'evidence must say why that compartment is the right one. If you cannot say, answer 0.',
  '',
  'The two databases name the same compound differently, and a different name is not a different',
  'substance. The same words in another order are the same thing ("Benzene, ethyl-" is "Ethyl',
  'benzene"). So is a trailing qualifier the receiving name omits ("NMVOC …, unspecified origin" is',
  '"NMVOC …"). And so is the identical compound under a systematic, trivial or trade name — say',
  'what identifies it: the molecular formula, the CAS number, or the synonym relation itself.',
  '',
  'What is NOT the same is a different compound, however close: a different substituent, a different',
  'position, a different count, a different element, a different oxidation state. "Benzene, chloro-"',
  'is not "Benzene", "5-methyl Chrysene" is not "Chrysene", and an unspeciated metal is neither of',
  'its oxidation states.',
  '',
  'When you answer 0, say in one short clause WHY — what the item is, and why none of the candidates',
  'is it. That sentence is shown to the person reviewing the import, and it is the only thing that',
  'tells them whether the vocabulary is missing the flow or the shortlist simply missed it.',
  '',
  'Every non-zero answer needs evidence: the shared substance name, a CAS number, an identical',
  'chemical formula, or an unambiguous synonym. "Looks similar" and "commonly used for this" are',
  'not evidence — if that is all you have, answer 0.',
  '',
  'Reply as JSON only: {"answers":[{"item":<number>,"choice":<number>,"evidence":"<short>"}]}'
].join('\n')

const SYSTEM_PROCESS = [
  'You place inputs from an imported life-cycle inventory onto datasets in the receiving LCA',
  'database. Each item is one technosphere input of an imported process — something it BUYS or',
  'CONSUMES: electricity, a material, a transport service, a waste treatment. The candidates are',
  "datasets from the background database or the user's own library. Answer with the number of the",
  'dataset that supplies THE SAME PRODUCT, or 0 for none.',
  '',
  'Answering 0 is a correct and often the correct answer. An unmatched input is reported to the user',
  'and can be fixed by hand. A wrong dataset silently changes the result of their study — it carries',
  'a whole supply chain behind it — and nothing downstream will catch it.',
  '',
  'These are NOT the same thing, however alike the names look:',
  '- a market dataset and a production dataset (a market is a consumption mix, with transport and losses),',
  '- a treatment or disposal dataset and a production dataset,',
  '- a broader material and a narrower one (plastic vs. ABS granulate),',
  '- the same product in another grade or physical state, where the source names one.',
  '',
  'Every non-zero answer needs evidence: the same product name, an unambiguous synonym, or a unit',
  'that measures the same quantity as the imported line. "Looks similar", "commonly used for this"',
  'and "the closest available" are not evidence — if that is all you have, answer 0.',
  '',
  'You are not choosing a country or a region. That is not part of this question.',
  '',
  'Reply as JSON only: {"answers":[{"item":<number>,"choice":<number>,"evidence":"<short>"}]}'
].join('\n')

const VERIFY_FLOW = [
  'You check proposed matches between the elementary flows of two LCA databases. For each pair you',
  'get the imported line, the flow it was matched to, and the reason given for the match.',
  '',
  'Say "no" when taking the match would put the burden in the wrong place: a different substance, a',
  'different compartment, or a quantity that does not measure the same thing (mass against volume,',
  'mass against radioactivity). Those are the mistakes that silently change the result of a study.',
  '',
  'A subcompartment the receiving vocabulary does not hold, placed on the same substance in its bare',
  'parent compartment — "air / low population density" on "air", "water / river" on "water" — is not a',
  'different compartment: that is where the receiving database keeps what it does not split.',
  '',
  'Do not say "no" merely because the two are not identical. The receiving database spells things',
  'differently, splits some substances the source leaves whole, and holds only one member of some',
  'groups. Where the reason given explains such a step and the flow is the closest true home for the',
  'emission, "yes" is right — the alternative is not a safer answer, it is the emission dropping out',
  'of the inventory altogether.',
  '',
  'Say "unsure" if you cannot tell from what is written.',
  '',
  'For anything other than "yes", say in one short sentence what is wrong with it. That sentence is',
  'read by a person reviewing the import, and it is the only thing they get.',
  '',
  'Reply as JSON only: {"checks":[{"item":<number>,"verdict":"yes"|"no"|"unsure","why":"<one sentence>"}]}'
].join('\n')

const VERIFY_PROCESS = [
  'You check proposed matches between an imported life-cycle inventory and datasets in an LCA',
  'database. For each pair you get the imported input and the dataset it was matched to.',
  '',
  'Answer "yes" only if the dataset supplies the same product: same product, same kind of dataset',
  '(a market is not a production, a treatment is not a production), and a unit that measures the',
  'same quantity. Answer "no" if they are different. Answer "unsure" if you cannot tell.',
  '',
  'Say "no" when the dataset would put the burden in the wrong place — another product, another kind',
  'of dataset, a unit measuring something else. Do not say "no" merely because the names differ or',
  'because a better dataset might exist elsewhere: weigh the reason given, and remember that the',
  'alternative to a defensible match is the input dropping out of the inventory altogether.',
  '',
  'For anything other than "yes", say in one short sentence what is wrong with it. That sentence is',
  'read by a person reviewing the import, and it is the only thing they get.',
  '',
  'Reply as JSON only: {"checks":[{"item":<number>,"verdict":"yes"|"no"|"unsure","why":"<one sentence>"}]}'
].join('\n')

function describe(row: MatchRow): string {
  const where = row.compartment.length ? ` · ${row.compartment.join(' / ')}` : ''
  // The source's own flow properties, when it states any: a density or a calorific value is
  // exactly what a bridge between two quantities needs, and the file vouching for the number
  // beats anything the model would have to remember.
  const stated = (row.properties ?? [])
    .map((p) => `${p.name} ${p.amount} ${p.unit} per ${row.unit}`)
    .join(', ')
  return `${row.name} [${row.unit || 'no unit'}]${where}${
    stated ? `\n    the source also states: ${stated}` : ''
  }`
}

/**
 * One line per activity, region dropped.
 *
 * `key` is what "the same activity in another region" collapses on. The first candidate of a group
 * survives, and the backend has already put the best-justified region there — so the choice the
 * model makes maps back onto a concrete dataset without it ever having to weigh a country.
 */
function forTheModel(candidates: MatchRow['candidates'], kind?: string): MatchRow['candidates'] {
  const seen = new Set<string>()
  const out: MatchRow['candidates'] = []
  for (const c of candidates) {
    // For a flow the compartment is part of what it IS, and the backend hands over several
    // subcompartments of one substance exactly when its rules could not decide between them —
    // folding them by name and unit removed the very choice the model was asked to make.
    const compartment = kind === 'biosphere' ? `|${(c.categories ?? []).join('/')}` : ''
    const key = `${c.name || c.label}|${c.unit}${compartment}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

/**
 * One candidate line.
 *
 * The **compartment** is on it and the **region** is not, and the asymmetry is the whole point. A
 * compartment is part of what a flow IS — "Carbon dioxide, air" and "Carbon dioxide, water" are two
 * substances as far as a characterisation factor is concerned, and the imported line states its own
 * compartment, so the model can compare like with like. A region is not part of what a process is;
 * the source usually names none, so offering it would be inviting a guess (see `forTheModel`).
 *
 * It went missing for a day: collapsing the regions meant switching from `label` (name · categories
 * · location) to `name`, which dropped the compartment along with the region.
 */
function flowLine(c: MatchRow['candidates'][number]): string {
  const where = c.categories?.length ? ` · ${c.categories.join(' / ')}` : ''
  return `${c.name || c.label} [${c.unit || 'no unit'}]${where}`
}

function candidateLine(c: MatchRow['candidates'][number], i: number): string {
  return `    ${i + 1}. ${flowLine(c)}`
}

/**
 * The line that says the shortlist came from a spelled-out abbreviation — "PET resin" was also searched
 * as "polyethylene terephthalate resin". The model judges candidates against the imported line, and a
 * wrong reading ("pet food" as polyethylene terephthalate) is only visible to it when it is told
 * so. Wording tested on a model: the right reading kept, the wrong one refused.
 */
function searchedAsLine(candidates: MatchRow['candidates']): string {
  for (const c of candidates) {
    const m = /also searched as “([^”]+)”/.exec(c.why ?? '')
    if (m)
      return (
        `    (also searched as “${m[1]}”: an abbreviation in the name was spelled out — check that this ` +
        'reading is what the item means)\n'
      )
  }
  return ''
}

function itemBlock(candidates: MatchRow['candidates'], row: MatchRow, n: number): string {
  // Two unit strings whose quantities differ are easy to read past — "[kg]" against "[standard
  // cubic meter]" cost a run its natural gas because nobody said MASS against VOLUME out loud.
  const options = candidates
    .map((c, i) => {
      const line = candidateLine(c, i)
      const clash = c.quantity && row.quantity && c.quantity !== row.quantity
      return clash ? `${line} — measures ${c.quantity}, the imported line measures ${row.quantity}` : line
    })
    .join('\n')
  return `Item ${n}: ${describe(row)}\n${searchedAsLine(candidates)}    0. none of these\n${options}`
}

/**
 * The items, under the dataset they came out of.
 *
 * Without it the model was asked things it could not possibly answer: our vocabulary splits methane
 * and carbon monoxide by origin (fossil, non-fossil, from soil or biomass) where the source writes
 * neither, and which one it is follows from what the process IS. It refused, and refusing was the
 * only honest answer to the question we were actually asking.
 */
function withDatasets(rows: MatchRow[], block: (row: MatchRow, i: number) => string): string {
  const out: string[] = []
  let current = ''
  rows.forEach((row, i) => {
    if (row.dataset && row.dataset !== current) {
      current = row.dataset
      out.push(`From the dataset “${current}”:`)
    }
    out.push(block(row, i))
  })
  return out.join('\n\n')
}

/**
 * The substance property the model offered to bridge two quantities, if it offered a usable one.
 *
 * Dropped silently when it is not a positive number with a name: a bridge whose origin cannot be
 * printed beside the factor is indistinguishable from an invented one, and the backend refuses it
 * anyway. The match then stands unconverted at the lowest band, which is the honest outcome.
 */
function bridgeOf(answer: Answer): { assumption?: { quantity: number; what: string } } {
  const quantity = Number(answer.bridge?.quantity)
  const what = String(answer.bridge?.what || '').trim()
  return quantity > 0 && what ? { assumption: { quantity, what } } : {}
}

/** Pull the first JSON object out of a reply that may carry prose or a fence around it. */
function parseJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced ? fenced[1] : text).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

interface Answer {
  item: number
  choice: number
  evidence?: string
  bridge?: { quantity?: number; what?: string }
}
interface Check {
  item: number
  verdict: string
  /** Why it is not a yes. Reaches the reviewer verbatim — see the note at the rejection. */
  why?: string
}

/**
 * Match one batch: propose, then verify, then band.
 *
 * A row whose model answer cannot be parsed, or whose choice is out of range, comes back as `open`.
 * That is on purpose — a malformed answer is not a reason to fall back to "probably the first
 * candidate", which is how a parser bug turns into wrong data.
 */
export async function matchBatch(
  rows: MatchRow[],
  opts: {
    model: string
    signal?: AbortSignal
    onCost?: (model: string, sample: CostSample) => void
    /** The user's "Max tokens per reply" — a hard ceiling it says it is, here too. Both
     *  calls of a batch get it: the proposal and the verification. */
    maxTokens?: number
  }
): Promise<MatchDecision[]> {
  const usable = rows.filter((r) => r.candidates.length > 0)
  if (!usable.length) return []
  // One batch, one task. The caller keeps flows and processes apart (see ipc/import.ts) because the
  // two need different instructions — and a mixed batch would have to get one of them wrong.
  const kind = usable[0].kind === 'biosphere' ? 'biosphere' : 'technosphere'
  // The list the model sees, per row. Everything below indexes into THIS, not into row.candidates
  // — the two differ as soon as an activity exists in several regions.
  const offered = new Map(usable.map((r) => [r, forTheModel(r.candidates, kind)]))

  let proposalDone = false
  const proposal = await collectText({
    model: opts.model,
    signal: opts.signal,
    onCost: opts.onCost,
    maxTokens: opts.maxTokens,
    onFinish: () => {
      proposalDone = true
    },
    messages: [
      { role: 'system', content: kind === 'biosphere' ? SYSTEM_FLOW : SYSTEM_PROCESS },
      {
        role: 'user',
        content: withDatasets(usable, (r, i) => itemBlock(offered.get(r) ?? r.candidates, r, i + 1))
      }
    ]
  })
  if (opts.signal?.aborted && !proposalDone) throw new MatchStopped()
  const answers = parseJson<{ answers: Answer[] }>(proposal)?.answers ?? []
  const byItem = new Map(answers.map((a) => [Number(a.item), a]))

  const proposed: Array<{ row: MatchRow; answer: Answer; item: number }> = []
  const decisions: MatchDecision[] = []
  usable.forEach((row, i) => {
    const answer = byItem.get(i + 1)
    const choice = Number(answer?.choice ?? 0)
    const evidence = String(answer?.evidence ?? '').trim()
    const list = offered.get(row) ?? row.candidates
    // A whole number inside the list, or no choice: 1.5 passed the range check and indexed
    // `undefined`, and the crash took the whole run and its sister workers down.
    if (!answer || !Number.isInteger(choice) || choice <= 0 || choice > list.length) {
      decisions.push({
        dataset: row.dataset,
        ...keyOf(row),
        index: row.index,
        code: null,
        confidence: 'open',
        // The model's own words, not ours. A refusal carries the diagnosis — "the vocabulary has
        // no unspeciated chromium", "none of these is 1,2-dichloroethane" — and replacing it with
        // a house sentence threw away the one thing that says whether the shortlist or the
        // vocabulary is at fault.
        evidence: answer
          ? String(answer.evidence || '').trim() ||
            'the model found none of the candidates to be the same flow'
          : 'no usable answer from the model'
      })
      return
    }
    if (!evidence) {
      // Evidence is the price of a match. Without it there is nothing for a reviewer to check,
      // and "no evidence" is exactly the state the abstention rule is meant to catch.
      decisions.push({
        dataset: row.dataset,
        ...keyOf(row),
        index: row.index,
        code: null,
        confidence: 'open',
        evidence: 'the model chose a candidate but gave no evidence for it'
      })
      return
    }
    proposed.push({ row, answer: { ...answer, choice, evidence }, item: proposed.length + 1 })
  })

  if (!proposed.length) return decisions

  let verificationDone = false
  const verification = await collectText({
    model: opts.model,
    signal: opts.signal,
    onCost: opts.onCost,
    maxTokens: opts.maxTokens,
    onFinish: () => {
      verificationDone = true
    },
    messages: [
      { role: 'system', content: kind === 'biosphere' ? VERIFY_FLOW : VERIFY_PROCESS },
      {
        role: 'user',
        content: proposed
          .map(({ row, answer, item }) => {
            const c = (offered.get(row) ?? row.candidates)[answer.choice - 1]
            // The compartment belongs on BOTH sides. It was shown on the imported line only, and
            // the check was still asked whether the compartments agree — so it read the missing
            // half as a mismatch and overturned matches that were word-for-word identical
            // ("Gas, natural, in ground" against "Gas, natural · in ground"). Its own reasoning
            // comes along too: a check that cannot see the argument can only re-guess it.
            return [
              `Item ${item}:`,
              `    dataset: ${row.dataset || '—'}`,
              `    imported: ${describe(row)}`,
              `    matched to: ${flowLine(c)}`,
              ...(searchedAsLine([c]) ? [searchedAsLine([c]).replace(/\n$/, '')] : []),
              `    reason given: ${answer.evidence || '—'}${
                answer.bridge?.quantity
                  ? ` — bridged with ${answer.bridge.quantity} ${c.unit || '?'} per ${
                      row.unit || '?'
                    } (${answer.bridge.what || 'unnamed'})`
                  : ''
              }`
            ].join('\n')
          })
          .join('\n\n')
      }
    ]
  })
  if (opts.signal?.aborted && !verificationDone) throw new MatchStopped()
  const verdicts = new Map(
    (parseJson<{ checks: Check[] }>(verification)?.checks ?? []).map((c) => [
      Number(c.item),
      { verdict: String(c.verdict || '').toLowerCase(), why: String(c.why || '').trim() }
    ])
  )

  for (const { row, answer, item } of proposed) {
    const candidate = (offered.get(row) ?? row.candidates)[answer.choice - 1]
    const verdict = verdicts.get(item)?.verdict ?? 'unsure'
    if (verdict === 'no') {
      // A doubt, not a veto. The check earns its keep on units and on dataset kind — mass against
      // becquerels, a burden carrier against a treatment — but one wording away from that it threw
      // out fourteen good matches in a single run, and a thrown-out match leaves nothing behind to
      // review. So the match stands at the lowest band with the objection attached, and the person
      // reading the import decides. These are proposals.
      decisions.push({
        dataset: row.dataset,
        ...keyOf(row),
        index: row.index,
        code: candidate.code,
        confidence: 'low',
        evidence:
          `${answer.evidence || 'matched by the model'} — but the check doubts it: ` +
          (verdicts.get(item)?.why || 'it said they are not the same flow'),
        ...bridgeOf(answer)
      })
      continue
    }
    decisions.push({
      dataset: row.dataset,
      ...keyOf(row),
      index: row.index,
      code: candidate.code,
      // `yes` earns "medium", never "good": the good band is reserved for what a rule established
      // — an identifier that hit, or an exact name in an exact compartment. A model agreeing with
      // itself twice is not the same kind of evidence, and the band has to keep meaning that.
      confidence: verdict === 'yes' ? 'medium' : 'low',
      evidence: `${answer.evidence}${verdict === 'unsure' ? ' (the check could not confirm it)' : ''}`,
      ...bridgeOf(answer)
    })
  }
  return decisions
}
