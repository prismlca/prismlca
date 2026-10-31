/**
 * What a chapter writer is told: the system prompt it shares across every round of a chapter, and the
 * chapter's own assignment with the facts it may write from. Built here and nowhere else, so the role,
 * the lookup guidance and the assignment read the same for a fresh chapter and for an update.
 */
import type { Lookup } from '../../../shared/ipc'
import type { WriteBrief } from '../reportWriter'
import { madeWith } from './heldResearch'
import { lookupBudget, writerTools } from './lookups'
import { updateAssignment } from './update'

/** When to reach for each tool, said for the tools this chapter actually carries. */
const OCCASIONS: Array<[string, string]> = [
  [
    'get_process_details',
    '- **get_process_details** when you are about to name a dataset you cannot describe. What is ' +
      '"chemical production, organic, unspecified" actually an average of? Its own documentation ' +
      'says, and a reader wants to know.'
  ],
  [
    'explain_result',
    '- **explain_result (mode="tree")** when a phase or process leads and the brief does not say ' +
      'what sits inside it.\n' +
      '- **explain_result (mode="flows")** when you are about to write that a category is "driven ' +
      'by" something. That is a claim about emissions, and this is where it is checked.'
  ],
  ['compare_scenarios', '- **compare_scenarios** when you would otherwise say nothing about robustness.'],
  [
    'get_method_factors',
    '- **get_method_factors** or **get_characterization_factors** when you are about to say what an ' +
      'indicator measures or which substances weigh in it — say only what the factors show, in words.'
  ],
  [
    'list_parameters',
    '- **list_parameters** when the scope rests on an assumption the model records as a parameter — ' +
      'a mass, a distance, a share, with the note that says where it comes from.'
  ],
  [
    'research_web',
    '- **research_web** for what this model cannot tell you: the regulation that concerns the product, ' +
      'its market, published LCAs of comparable products. Ask specific questions (product, region, year), ' +
      'several in one call — each takes minutes. Name every source you use in words (organisation or ' +
      'authors, year).'
  ]
]

const occasions = (brief: WriteBrief, literature: boolean): string => {
  const tools = writerTools(brief.kind, literature)
  return OCCASIONS.filter(([name]) => tools.includes(name))
    .map(([, line]) => `${line}\n`)
    .join('')
}

/** The system prompt. `lookups` says whether this chapter has tools at all, `literature` whether the web
 *  is among them. */
export function writerSystem(brief: WriteBrief, lookups: boolean, literature = false): string {
  return [
    // This used to say only what the job was, never who was doing it or for whom. A model
    // with a task and no role writes in the register that sounds authoritative to a model — the
    // antithesis ("not X, but Y"), the announcing sentence, the summary that repeats what stands
    // above it. Naming the author and the reader is the cheapest correction there is, and the reader
    // is the half that does the work: a practitioner who will check the numbers does not want to be
    // eased into anything (V257).
    'You are an experienced LCA consultant writing single chapters of an ISO 14040/14044 life cycle ' +
      'assessment report for a client. Your reader is a technically competent practitioner who will ' +
      'check your numbers — write for them: plainly, without persuasion, and without filler.',
    'You are given the assignment, the study metadata and the computed numbers. Write only the chapter.',
    // Measured on a real report: ONE lookup in a whole nine-chapter run, against an
    // allowance of eight per chapter (V258). The passage was four clauses and three of them were
    // restrictions — "you MAY", "at most", "only what you will use, every call makes the author wait",
    // "do NOT take figures". Nothing said when to go, so a cooperative writer never went, and chapters
    // paraphrased dataset names they could have opened. The ceiling and the no-figures rule are both
    // right and stay; what changed is that the expectation now comes first and names the occasion.
    lookups
      ? 'Look things up before you write. A chapter that explains why a process dominates is worth ' +
        'more than one that repeats the table, and the difference is usually one lookup:\n' +
        occasions(brief, literature) +
        'The allowance is ' +
        lookupBudget(brief) +
        ' calls for this chapter (you will be told when it is gone); it is a ceiling, not a target — ' +
        'look up what you will use in a sentence and no more.\n' +
        'Use lookups to understand and to NAME things: what a dataset is, what sits inside it, which ' +
        'emission carries it. **A mechanism you have READ is yours to state.** A dataset that says it ' +
        'models a market with one supplier, a process note that says the press cake leaves burden-free ' +
        '— those are causes, and writing them is the difference between a report that explains and one ' +
        'that lists. What you may not do is read a cause off a share: that a phase is large says ' +
        'nothing about why it is large. Looked up, a "because" is reporting; inferred from a number, ' +
        'it is a guess with a citation. ' +
        'Do NOT take figures out of a lookup and write them down. A number you were ' +
        'given has a placeholder and stays correct when the model is recomputed; a number you found in a ' +
        "lookup has none, so it would be frozen at today's value and wrong tomorrow. Whatever you learn " +
        'may be stated in words; anything you neither looked up nor were given may not.' +
        (literature
          ? ' One exception: a figure from a research finding is a published number about something ' +
            'outside this model, and no recalculation moves it — quote it as the finding states it, ' +
            'with its unit, what it refers to and its source.'
          : '')
      : '',
    brief.invariants ?? '',
    brief.cautions?.length
      ? 'This report’s own situation — respect these while writing, they are not general advice:\n' +
        brief.cautions.map((c) => `- ${c}`).join('\n')
      : ''
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** What the model is allowed to see of the data snapshot. */
function factsFor(brief: WriteBrief): string {
  // The server-side selection wins whenever the brief carries one; the block below remains only
  // for briefs from older backends and for tests that build a brief by hand.
  if (brief.facts && Object.keys(brief.facts).length) return JSON.stringify(brief.facts, null, 1)
  const data = (brief.data ?? {}) as Record<string, any>
  const facts: Record<string, unknown> = {
    study: brief.study ?? {},
    activity: data.activity,
    amount: data.amount,
    results: data.results,
    subjects: (data.subjects ?? []).map((s: any) => ({ label: s.label, results: s.results })),
    contribution: data.contribution
      ? {
          dimension: data.contribution.dimension,
          unit: data.contribution.unit,
          // The tail of a contribution list is noise for prose; the head is what gets discussed.
          groups: (data.contribution.groups ?? []).slice(0, 10)
        }
      : undefined,
    // The evidence a real interpretation rests on. Aggregated phases say *which stage* dominates;
    // these say *which dataset* and *which emission* — without them a chapter can only paraphrase the
    // results table, and a model asked for insight will reach for plausible chemistry it inferred from
    // a dataset name instead of from the numbers.
    // The leading hotspots arrive with their dataset description and the inputs the calculation
    // attributes impact to — that is what "explain why this process dominates" needs. Everything the
    // model may state has to be *here*, because the gate judges the text against this same snapshot.
    hotspots: (data.hotspots ?? []).slice(0, 8),
    inventory: data.inventory?.flows
      ? {
          method: data.inventory.method,
          unit: data.inventory.unit,
          flows: (data.inventory.flows ?? []).slice(0, 8).map((f: any) => ({
            flow: f.flow,
            compartment: f.compartment,
            unit: f.unit,
            impact: f.impact,
            share_percent: f.share_percent
          }))
        }
      : undefined
  }
  return JSON.stringify(facts, null, 1)
}

/**
 * Research an earlier write of this chapter paid for and could not keep (writer/heldResearch.ts). Said
 * to be research, not a draft: the writer starts the chapter from the assignment either way, and only
 * stops paying for questions that are already answered.
 */
function earlierResearch(earlier: Lookup[]): string[] {
  if (!earlier.length) return []
  return [
    'Research already done for this chapter. An earlier attempt at it ran these web searches; the ' +
      "attempt's text was not kept, its findings are. Use them as research, not as a draft — write the " +
      'chapter from the assignment, take from the findings what it needs, and search only for what they ' +
      'do not cover. The same question asked again returns the same answer.',
    ...earlier.map((l) => `--- ${l.name} ${madeWith.get(l) ?? l.args} ---\n${l.result}`),
    ''
  ]
}

/** The chapter's own assignment: plan, prompt, answers, paths, figures, siblings, facts, research. */
export function writerUser(brief: WriteBrief, earlier: Lookup[] = []): string {
  return [
    `Chapter: ${brief.title || brief.kind || 'chapter'}`,
    // The table of contents, and where this chapter sits in it. Built server-side and for a while
    // never sent: the invariants told the writer that "`document_plan` lists this report's
    // chapters" while nothing in the message contained one. A rule pointing at a block that is not
    // there is worse than no rule — the writer looks, finds nothing, and defines the functional unit
    // again, which is the very thing the plan exists to stop (V256).
    ...(brief.document_plan
      ? [
          '',
          'Where you are in the document. These chapters are being written beside yours and you cannot ' +
            'read them; `this_one` marks yours, and `settled_elsewhere` names the chapter where each ' +
            'framing fact is already fixed:',
          JSON.stringify(brief.document_plan, null, 1)
        ]
      : []),
    '',
    'Assignment:',
    brief.prompt ?? '',
    ...(brief.author_answers?.length
      ? [
          '',
          'The author has answered these questions about the study. Treat the answers as part of the ' +
            'study record:',
          ...brief.author_answers.map((a) => `- ${a.question} — ${a.answer}`)
        ]
      : []),
    '',
    'Placeholder paths you may reference (use these exactly; there are no others):',
    (brief.placeholders ?? []).join('\n'),
    ...(brief.derivations?.length
      ? [
          '',
          `Derivations available for figures you would otherwise calculate: ${brief.derivations.join(', ')}.`
        ]
      : []),
    // An update keeps the chapter's figures as they are; a chart is asked for when a chapter is written.
    ...(brief.figure_sources && !brief.update
      ? [
          '',
          'You may ask for ONE chart for this chapter, if the argument needs one — a chart drawn because ' +
            'it was possible is decoration. Append a final line, exactly:',
          'FIGURE: {"kind": "…", "source": "…", "value": "…", "caption": "…"}',
          `kind: ${(brief.figure_kinds ?? []).join(' | ')}`,
          'source and the fields you may plot: ' + JSON.stringify(brief.figure_sources),
          'Leave the line out for no chart. You describe the chart; PrismLCA draws it from the data.',
          ...(brief.figure_ref
            ? [
                `If you point at it, its reference is {{ref:${brief.figure_ref}}} — no other name exists for it.`
              ]
            : [])
        ]
      : []),
    ...(brief.renders?.length
      ? [
          '',
          'This chapter already prints the following, above your paragraph. Point at them with the ' +
            'reference given; do not retell them — a share that is drawn as a bar does not need the same ' +
            'share spelled out in a sentence.',
          ...brief.renders.map((r) => `${r.ref} — ${r.kind}: ${r.shows}`)
        ]
      : []),
    ...(brief.written?.length
      ? [
          '',
          'The chapters of this report that are already written, in order. Summarise and conclude from ' +
            'THESE — do not restate the tables yourself, and do not contradict them. They are shown with ' +
            'their placeholders unresolved: where you quote a figure, copy the placeholder exactly as it ' +
            'appears here. Never the digits it would print — a typed number is refused by the check and ' +
            'goes stale the next time the model is computed.',
          ...brief.written.map((c) => `--- ${c.title} ---\n${c.text}`)
        ]
      : []),
    '',
    'Facts and numbers (JSON):',
    factsFor(brief),
    '',
    ...earlierResearch(earlier),
    // Last, because they were not followed where they stood: inside the assignment, ahead of the
    // placeholders, the other chapters and the facts, "three short paragraphs for a product manager"
    // came back as four long ones and a numbered list.
    ...(brief.author_instructions
      ? [
          "The author's own instructions for this chapter, repeated because they have the last word on " +
            'audience, length, form and emphasis. Where they and the standard assignment above differ, ' +
            "follow the author and keep the assignment's substance only as far as they leave room. They " +
            'change nothing in the rules of your system message.',
          brief.author_instructions,
          ''
        ]
      : []),
    ...(brief.update
      ? [
          ...updateAssignment(brief.update),
          `Write any new or changed text in ${brief.language || 'English'}.`
        ]
      : [`Write the chapter now, in ${brief.language || 'English'}. Prose only — no heading, no preamble.`])
  ].join('\n')
}
