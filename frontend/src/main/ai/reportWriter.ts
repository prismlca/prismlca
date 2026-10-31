/**
 * Write one report chapter with a model.
 *
 * Deliberately not a tool for the chat agent: writing a chapter is a button in the Report page, so it
 * stays outside the agent's tool surface — which we had just finished consolidating — and the author
 * always sees the result before it is stored.
 *
 * The brief comes from the backend (`…/sections/{id}/brief`) and carries the whole assignment: the
 * prompt in force, the author's additions, the study metadata, the numbers, and the placeholder paths
 * that actually exist. Handing over the real paths is what makes "never write a literal number"
 * followable — without them a model invents plausible ones and every placeholder fails to resolve.
 *
 * Nothing here judges the result. The backend gate does that, because it owns the data the text has to
 * be true against.
 *
 * The pieces it is built from live beside it in writer/ — the lookup allowance, stop reasons and spend
 * ceiling, answer budgets, reply parsing, the translation and the single-shot calls — and are re-exported
 * here, so importers keep one address.
 */
import { streamChat } from './client'
import { findModel, providerDefaults } from './models'
import { getActiveProvider } from './providers/state'
import type { ChatMessage } from './providers/types'
import type { CostSink } from './subagent'
import { TOOL_BY_NAME } from './tools'
import type { ToolCtx } from './tools'
import type { Finding, Lookup, WriteAllOutcome, WritePhase } from '../../shared/ipc'
import type { ChapterReview } from '../../shared/ipc'
import { capToolResult } from './resultBudget'
import { costOf } from './stream'
import { makeRepeatGuard } from './toolGuards'
import { asPrinted, lookupBudget, RESEARCH_CALLS, writerTools } from './writer/lookups'
import {
  answered,
  chapterOf,
  earlierResearch,
  holdResearch,
  madeWith,
  settleResearch
} from './writer/heldResearch'
import { stopNote } from './writer/costGuard'
import { incompleteReason, joinContinuation, MAX_CONTINUATIONS, MAX_SECTION_ANSWERS } from './writer/answers'
import { converse } from './writer/dialogue'
import { clean } from './writer/text'
import { writerSystem, writerUser } from './writer/messages'
import { settleUpdate, type UpdateBrief } from './writer/update'

export { lookupBudget } from './writer/lookups'
export {
  accountGuard,
  ANSWER_BUDGET_MS,
  costAccount,
  costGuard,
  costNote,
  costReason,
  DEADLINE_NOTE,
  DEADLINE_REASON,
  reportDeadlineMs,
  resetCostAccounts,
  stopNote
} from './writer/costGuard'
export type { CostAccount, CostReason } from './writer/costGuard'
export {
  applyPatch,
  FORCED_ANSWERS,
  incompleteReason,
  joinContinuation,
  MAX_CONTINUATIONS,
  MAX_SECTION_ANSWERS,
  sectionAnswers
} from './writer/answers'
export { clean, parseMap, parseRevision } from './writer/text'
export { translateStudyTexts, translationAnswers, translationBatches } from './writer/translate'
export { expandAbbreviations } from './writer/singleCalls'

// Finding and Lookup travel inside WriteAllOutcome across the bridge, so they live beside it in
// shared/ipc.ts; re-exported for this module's long-standing importers.
export type { Finding, Lookup } from '../../shared/ipc'

/**
 * Last-resort fallback only. The caller passes the model the user has chosen, because a report chapter
 * goes to a client: this is the opposite of the summariser or the research legs, where a cheap model is
 * the right call. Hunyuan Hy3 held this slot because the placeholder discipline was measured against it;
 * it left the catalogue as too weak, and DeepSeek V4.1 Flash — the cheapest row — took
 * the slot WITHOUT that measurement being repeated. Treat it as a stand-in until a live run has
 * shown it keeps the placeholder rules; it is not a default for real work either way.
 */
export const FALLBACK_MODEL = providerDefaults('openrouter').writerFallback

// WritePhase lives in shared/ipc.ts (one definition for main, preload and renderer); re-exported
// here because this module is where the phases are produced and long-standing imports point at it.
export type { WritePhase } from '../../shared/ipc'

/**
 * How often a phase may be re-announced. A stream ticks per token; a line that changes forty times a
 * second is a flicker, not information. Phase *changes* ignore this and are sent at once.
 */
const PHASE_TICK_MS = 400

const CONTINUE_PROMPT =
  'Your answer was cut off at the output limit. Continue exactly where you stopped — do not repeat ' +
  'anything already written, do not restart the chapter, and output only the remaining text.'

/**
 * How much of a lookup the model sees AND how much travels back for the gate to check the text
 * against. One constant on purpose: recording less than was sent (it used to be 4 000 vs 30 000) made
 * the gate judge a fact the model legitimately read from the tail of a lookup as unsupported.
 */
const LOOKUP_CHARS = 30_000

export interface WriteBrief {
  kind?: string
  /** This chapter's writer may search the literature (engine/report_prompts.build_brief): the report
   *  allows it and the chapter is the introduction or the interpretation. */
  literature?: boolean
  /** The snapshot this brief's numbers come from, and the wording the chapter had. Both go back with
   *  every proposal: the gate refuses a write whose snapshot moved, the store one whose text did. */
  snapshot_id?: string
  text_version?: string
  /**
   * Stored study text → the text this document prints, for every string a translation moved. Used to
   * rewrite a LOOKUP answer before the model reads it: the snapshot is translated, the model is not,
   * and `get_process_details` answers out of the model — see `asPrinted` (V260).
   */
  printed_names?: Record<string, string>
  /**
   * Facts about THIS report's situation the writer must respect before writing — the ISO 14044 §7.3.3
   * comparative-assertion guard, the weak-difference threshold, "one subject compares nothing". The
   * backend has always sent them; not forwarding them meant the writer produced exactly the sentences
   * the gate then flagged, and the flags are advisory — nothing but the author's eye caught them.
   */
  cautions?: string[]
  /** Named derivations the report can compute at typesetting time (sum, diff, percent, change, factor). */
  derivations?: string[]
  /** Chart sources a chapter may ask to have drawn, and the numeric fields allowed for each. */
  figure_sources?: Record<string, string[]>
  figure_kinds?: string[]
  /**
   * The label a chart asked for in this write will carry, so the paragraph can point at it. It depends on
   * what the chapter already draws, so it could not be guessed — and a guess that missed bought an
   * `unknown_reference` for the very chart the write had commissioned.
   */
  figure_ref?: string
  /**
   * What this chapter *already* shows — the tables and figures printed with it, each with the reference to
   * use. A comment chapter's assignment says "comment on the analysis below the table"; without this the
   * writer never learned what that table is, so it either ignored the figure beside it or described it.
   */
  renders?: { ref: string; kind: string; shows: string }[]
  title?: string
  language?: string
  prompt?: string
  /** The author's additional instructions for this chapter, also inside `prompt`; repeated last. */
  author_instructions?: string
  invariants?: string
  study?: Record<string, unknown>
  placeholders?: string[]
  /**
   * The other chapters, for the two whose job is to sum the document up. As STORED — placeholders
   * unresolved — so a summary copies `{{results.0.score}}` rather than the number it prints, which is
   * both what keeps it correct after a recompute and what gets it past the gate.
   */
  written?: Array<{ title: string; text: string }>
  /**
   * This report's chapters with one clause each, `this_one` on the writer's own, and where each
   * framing fact is settled. Seven of nine chapters are written blind and in parallel, so a writer
   * that does not know a Goal & Scope chapter exists has no choice but to define the functional unit
   * again — which it did, five times over (V256).
   */
  document_plan?: {
    chapters?: Array<Record<string, string>>
    settled_elsewhere?: Record<string, string>
  }
  /**
   * The server's own selection of snapshot values for the writer (`report_prompts.brief_facts`).
   * Preferred over the local selection below: it lives beside the prompts and the gate, so the
   * three cannot drift — the local one had, and the writer was being told to read fields
   * (`checks`, `trade_offs`, the process notes) it was never handed.
   */
  facts?: Record<string, unknown>
  data?: Record<string, unknown>
  /** What the author answered when a writer asked — part of the study record from then on. */
  author_answers?: Array<{ question: string; answer: string }>
  /**
   * Present on an update brief (`…/update-brief`): the chapter as it stands and what changed under
   * it. The writer then answers with replacements, not with a new chapter (writer/update.ts).
   */
  update?: UpdateBrief
}

export interface WriteSectionOpts {
  brief: WriteBrief
  model?: string
  signal?: AbortSignal
  onCost?: CostSink
  /** Settings → AI → Limits "Max tokens per writer reply"; absent = the provider default ceiling. */
  maxTokens?: number
  /** Backend client. Absent = write from the brief alone (what the tests and a dry run do). */
  api?: ToolCtx['api']
  activeDb?: string | null
  /**
   * The section's proposal endpoint. Given it, the writer asks the gate *before* handing the text over
   * and revises what the gate objected to — the findings are precise ("the number 90 is written out"),
   * so feeding them back is strictly better than making the author press Write again and hope.
   */
  checkPath?: string
  /**
   * The second reader (Settings → AI → Models, Review model) and the route of its brief. Given both, a
   * chapter that passes the contract is read before it is stored, and writer and reader settle the
   * reader's points between them (writer/dialogue.ts). Absent, the gate decides alone.
   */
  reviewModel?: string
  reviewPath?: string
  /**
   * The web research sub-agent, for a chapter whose brief allows the literature (`brief.literature`).
   * Bound by the caller to the research model, the run's signal and its cost account; absent = no web.
   */
  researchWeb?: ToolCtx['researchWeb']
  /** Questions per research call (Settings → AI → Limits), as the chat has them. */
  maxResearchQuestions?: number
  /** Which run this chapter belongs to. Diagnostics only: it goes to the gate with every judgement so
   *  the journal can tell one run's eleven lanes apart afterwards (engine/gate_journal). */
  runId?: string
  /** Where the wait is reported. One mechanism; `writeAll` passes its own through and adds the id. */
  onPhase?: (p: WritePhase) => void
}

export interface WriteSectionResult {
  text: string
  model: string
  lookups: Lookup[]
  findings: Finding[]
  attempts: number
  figure: Record<string, unknown> | null
  /**
   * True when the model's answer did not end properly — no completion signal, cut off at the output
   * limit twice over, stopped for a filter, or empty — or when the run was stopped with text in hand.
   * The text is a DRAFT then: not checked, not to be stored; `findings` says why.
   */
  incomplete?: boolean
  /** What writer and second reader settled, when a reader read the chapter. Sent with the store. */
  review?: ChapterReview | null
  /** An update's outcome: the chapter was edited, or found still right as it stood. */
  update?: 'edited' | 'unchanged'
}

/**
 * Write one chapter. The guard around `writeSectionInner`: a run stopped after the text had arrived
 * — the cost ceiling trips on the final usage event, the author presses Stop during the check — used
 * to throw the paid-for, complete text away, because the caller only ever saw the exception.
 * What has arrived comes back as an unchecked draft instead.
 */
export async function writeSection(opts: WriteSectionOpts): Promise<WriteSectionResult> {
  const draft: Draft = { text: '', lookups: [] }
  // The research of a write is held until a store of the chapter is seen: the caller stores after this
  // returns (writeAll settles on its verdict), so a passed check is no proof yet (writer/heldResearch.ts).
  const chapter = chapterOf(opts.checkPath)
  try {
    const out = await writeSectionInner(opts, draft)
    holdResearch(chapter, out.lookups)
    return out
  } catch (e) {
    holdResearch(chapter, draft.lookups)
    if (opts.signal?.aborted && draft.text.trim()) {
      return {
        text: draft.text,
        model: opts.model || providerDefaults(getActiveProvider()).writerFallback,
        lookups: draft.lookups,
        findings: [
          {
            kind: 'run_stopped',
            detail:
              (e instanceof Error ? e.message : String(e)) +
              ' The text that had arrived is kept as a draft — it was not checked and not stored.'
          }
        ],
        attempts: 1,
        figure: null,
        incomplete: true
      }
    }
    throw e
  }
}

/** What has arrived so far, for the guard. */
type Draft = { text: string; lookups: Lookup[] }

async function writeSectionInner(opts: WriteSectionOpts, draft: Draft): Promise<WriteSectionResult> {
  const { brief } = opts
  const model = opts.model || providerDefaults(getActiveProvider()).writerFallback

  // The web only where the brief allows it AND the caller bound a researcher to the run.
  const literature = Boolean(brief.literature && opts.researchWeb)
  const system = writerSystem(brief, Boolean(opts.api) && lookupBudget(brief) > 0, literature)

  // What an earlier write of this chapter researched and could not keep (writer/heldResearch.ts).
  const earlier = literature ? earlierResearch(chapterOf(opts.checkPath), brief.update?.lookups) : []
  const user = writerUser(brief, earlier)

  // The system prompt is the one block every chapter, lookup round and revision shares byte for byte.
  // Anthropic caches a prefix only where a breakpoint marks it (the chat places the same marker, see
  // agent.ts markCacheBreakpoints); without one the writer paid the whole prompt every round — measured
  // on Sonnet 5.5: 1 021 072 prompt tokens for nine chapters, 0 from the cache, while the chat
  // on the same model read 94 % of its 4.7 M tokens from it (V399). The user turn carries the chapter's
  // own brief and is not marked: it differs per chapter, and a marker there would only cost the write.
  const explicit = findModel(model, getActiveProvider()).explicitCache === true
  // The user turn carries the chapter's brief — the bulk of the prompt — and it is marked as well
  // (V421): measured on a nine-chapter silicone report, the system-prompt marker alone left the writer
  // at 4–5 % cache over 1.73 M prompt tokens, because five of nine chapters needed two or three
  // attempts and every revision round resent the same brief uncached. With the marker here, the
  // revision rounds (and a second Write of the same chapter) read it from the cache; a chapter
  // written once pays the cache write (1.25×) for nothing, which the revision rate more than repays.
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: explicit ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system
    },
    {
      role: 'user',
      content: explicit ? [{ type: 'text', text: user, cache_control: { type: 'ephemeral' } }] : user
    }
  ]

  // No budget, no tools: a schema the chapter may not use costs prompt, and an unused capability in
  // front of a model is a temptation, not a safeguard.
  // The read-only tools this chapter may use (writer/lookups.ts), from the agent's own registry.
  const allowedTools = writerTools(brief.kind, literature)
  const tools =
    opts.api && lookupBudget(brief) > 0 ? allowedTools.map((n) => TOOL_BY_NAME[n]).filter(Boolean) : []
  const ctx: ToolCtx | null = opts.api
    ? {
        api: opts.api,
        // The writer's tools are read-only and never touch the interface; a call would be a bug, so it
        // fails loudly rather than silently doing nothing.
        ui: async () => {
          throw new Error('A chapter writer cannot drive the interface.')
        },
        activeDb: opts.activeDb ?? null,
        webSearchAllowed: literature,
        researchWeb: literature ? opts.researchWeb : undefined,
        maxResearchQuestions: opts.maxResearchQuestions
      }
    : null
  let researched = 0

  // An update starts from the evidence the chapter was accepted with: the sentences it leaves standing
  // still rest on it, and the store keeps what it is sent. A lookup made again replaces its old answer.
  // Research held from a write that was not stored is evidence the same way: the writer is shown it.
  const lookups: Lookup[] = [...(brief.update?.lookups ?? []), ...earlier]
  draft.lookups = lookups
  let text = ''
  /** The provider's finish reason for the round that produced `text` — null until one is stated. */
  let finishReason: string | null = null
  const allowance = lookupBudget(brief)
  let budget = allowance
  // Shared with the chat agent (toolGuards.ts). The budget bounded the damage of a model re-sending
  // the same lookup byte-for-byte — it still burned one of the chapter's few paid lookups per repeat.
  // A blocked repeat costs no budget, like the allowlist refusal: refusing is not a lookup.
  const repeats = makeRepeatGuard('write the chapter from what you already have.')

  // Throttled, because the two phases that carry a count are fed by per-token stream events. A phase
  // *change* passes `changed` and is never dropped: the label is the information, the count is detail.
  let lastTick = 0
  const tick = (p: WritePhase, changed = false): void => {
    if (!opts.onPhase) return
    const now = Date.now()
    if (!changed && now - lastTick < PHASE_TICK_MS) return
    lastTick = now
    opts.onPhase(p)
  }

  // An aborted or dropped stream ends *silently* — streamChat returns whatever arrived as if the model
  // had finished. Checked after every stream: a Stop click or a network drop must become an error, not
  // a syntactically clean half-chapter that passes the gate and is stored as a whole one.
  const assertLive = (): void => {
    if (opts.signal?.aborted)
      throw new Error(stopNote(opts.signal, 'The write was cancelled — the chapter was not finished.'))
  }

  // One round per batch of lookups. The loop ends when the model answers with prose instead of calls —
  // or when the budget runs out, in which case it is told so and writes from what it has.
  for (let round = 0; round < allowance + 1; round++) {
    let roundText = ''
    let calls: Array<{ id: string; name: string; arguments: string }> | null = null
    // Once the budget is gone the tools are withdrawn, so the next round has to be prose. Leaving them
    // on and merely refusing each call let a persistent model burn every round and return nothing.
    const offer = tools.length && budget > 0 ? tools.map((t) => t.spec) : undefined
    // Nothing has arrived yet, and on a reasoning model nothing will for minutes.
    let thought = 0
    let finish: string | null = null
    tick({ phase: 'sent' }, true)
    for await (const ev of streamChat({
      model,
      messages,
      tools: offer,
      temperature: null,
      signal: opts.signal,
      maxTokens: opts.maxTokens
    })) {
      if (ev.type === 'delta') {
        // An empty content delta is not a character of chapter, and announcing "0 characters so far"
        // would replace a truthful "waiting for the model" with a count of nothing.
        const first = roundText.length === 0 && ev.text.length > 0
        roundText += ev.text
        if (roundText.length) tick({ phase: 'writing', chars: roundText.length }, first)
      } else if (ev.type === 'reasoning') {
        const first = thought === 0
        thought += ev.chars
        tick({ phase: 'thinking', chars: thought }, first)
      } else if (ev.type === 'provider') {
        // The chat logs this line per turn; the writer did not, so a chapter that hung for ten minutes
        // could not be told apart from a slow provider after the fact (V354).
        console.log(`[prism-ai] writer served by ${ev.name} — ${model}`)
      } else if (ev.type === 'usage') {
        opts.onCost?.(model, costOf(ev.usage))
        // The chat logs its cache share per round; the writer did not, so V399/V421 could only be
        // judged from the monthly usage file after the fact. One line per writer call, same shape.
        const cached = ev.usage?.prompt_tokens_details?.cached_tokens
        const prompt = ev.usage?.prompt_tokens ?? 0
        if (typeof cached === 'number' && prompt) {
          const cost = typeof ev.usage?.cost === 'number' ? `, $${ev.usage.cost.toFixed(4)}` : ''
          console.log(
            `[prism-ai] writer cache: ${cached}/${prompt} prompt tokens (${Math.round((cached / prompt) * 100)}%)${cost} — ${model}`
          )
        }
      } else if (ev.type === 'finish') {
        finish = ev.reason
      } else if (ev.type === 'tool_calls') {
        calls = ev.calls
      }
    }
    assertLive()

    if (!calls || !calls.length || !ctx) {
      text = roundText
      finishReason = finish
      draft.text = text
      break
    }

    messages.push({
      role: 'assistant',
      content: roundText || null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments }
      }))
    })

    for (const call of calls) {
      const allowed = allowedTools.includes(call.name)
      const tool = allowed ? TOOL_BY_NAME[call.name] : undefined
      let result: string
      const blocked = tool ? repeats.block(call.name, call.arguments) : null
      const inHand = tool && !blocked ? answered(lookups, call.name, call.arguments) : null
      if (!tool) {
        // A name outside the list costs no budget: refusing it is not a lookup, and charging for it
        // would let one wrong guess eat the allowance for the processes that matter.
        result = `${call.name} is not available while writing a chapter. Available: ${allowedTools.join(', ')}.`
      } else if (blocked) {
        result = blocked
      } else if (inHand) {
        // Asked before — in this write, in one that was not stored, or by the chapter an update starts
        // from: the same answer, and nothing spent.
        console.log(
          `[writer] ${brief.title}: ${call.name} answered from research in hand, not searched again`
        )
        result = inHand.result
      } else if (call.name === 'research_web' && researched >= RESEARCH_CALLS) {
        // Like the allowlist refusal, free: the research already in hand is what the chapter is written from.
        result = `No more web research for this chapter (${RESEARCH_CALLS} calls). Write from the findings you have.`
      } else if (budget <= 0) {
        result = `No lookups left (${allowance} is the limit for this chapter). Write the chapter from what you have.`
      } else {
        budget--
        if (call.name === 'research_web') researched++
        tick({ phase: 'lookup', name: call.name, spent: allowance - budget, allowance }, true)
        try {
          const out = await tool.run(JSON.parse(call.arguments || '{}'), ctx)
          result = asPrinted(typeof out === 'string' ? out : JSON.stringify(out), brief)
        } catch (e) {
          result = `Error: ${e instanceof Error ? e.message : String(e)}`
        }
        // A lookup another lane superseded mid-traversal is nobody's evidence and nobody's spend.
        // The backend keys its cancellation per request now, so this is a belt over the
        // braces, but a 409 that does slip through must not eat one of the chapter's few lookups.
        if (/calc_superseded|Superseded by a newer request/i.test(result)) budget++
        // Structural cut, not a flat slice: `.slice(0, LOOKUP_CHARS)` cut mid-object, and a truncated
        // JSON reads as complete but is not (the resultBudget lesson, applied here).
        // Model and gate keep seeing the SAME text — that one-constant invariant is documented above.
        result = capToolResult(result, LOOKUP_CHARS).text
        const whole = call.arguments ?? ''
        const again = lookups.findIndex((l) => l.name === call.name && (madeWith.get(l) ?? l.args) === whole)
        if (again >= 0) lookups.splice(again, 1)
        const made = { name: call.name, args: whole.slice(0, 500), result }
        madeWith.set(made, whole)
        lookups.push(made)
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
    }
  }

  // A model that only ever answers with tool calls would otherwise leave the author with an empty
  // chapter. One final round with no tools offered and the instruction to write: whatever it produces is
  // still checked by the gate, so a forced answer is not a lowered bar.
  if (!text.trim() && ctx) {
    messages.push({
      role: 'user',
      content: 'Write the chapter now from what you have. No further lookups are available.'
    })
    let thought = 0
    finishReason = null
    tick({ phase: 'sent' }, true)
    for await (const ev of streamChat({
      model,
      messages,
      temperature: null,
      signal: opts.signal,
      maxTokens: opts.maxTokens
    })) {
      if (ev.type === 'delta') {
        const first = text.length === 0 && ev.text.length > 0
        text += ev.text
        if (text.length) tick({ phase: 'writing', chars: text.length }, first)
      } else if (ev.type === 'reasoning') {
        const first = thought === 0
        thought += ev.chars
        tick({ phase: 'thinking', chars: thought }, first)
      } else if (ev.type === 'usage') opts.onCost?.(model, costOf(ev.usage))
      else if (ev.type === 'finish') finishReason = ev.reason
    }
    assertLive()
    draft.text = text
  }

  // ---- completion -----------------------------------------------------------------------
  // Success means the model said it was done. The loop above once took whatever had
  // arrived as the chapter: a connection that closed without a finish event read as a finished
  // answer, an answer cut off at the output limit was never noticed, and an empty one went to the
  // gate and was stored over the chapter it replaced. Three cases, kept apart
  // because they need different answers: the output limit gets a continuation, a missing or foreign
  // finish keeps the text as an unchecked draft, and nothing at all is an error rather than a chapter.
  for (let more = 0; finishReason === 'length' && more < MAX_CONTINUATIONS; more++) {
    console.log(`[writer] ${brief.title}: output limit hit, continuation ${more + 1} of ${MAX_CONTINUATIONS}`)
    messages.push({ role: 'assistant', content: text })
    messages.push({ role: 'user', content: CONTINUE_PROMPT })
    let tail = ''
    let finish: string | null = null
    tick({ phase: 'sent' }, true)
    for await (const ev of streamChat({
      model,
      messages,
      temperature: null,
      signal: opts.signal,
      maxTokens: opts.maxTokens
    })) {
      if (ev.type === 'delta') {
        tail += ev.text
        tick({ phase: 'writing', chars: text.length + tail.length })
      } else if (ev.type === 'usage') opts.onCost?.(model, costOf(ev.usage))
      else if (ev.type === 'finish') finish = ev.reason
    }
    assertLive()
    text = joinContinuation(text, tail)
    finishReason = finish
    draft.text = text
  }
  console.log(`[writer] ${brief.title}: finish=${finishReason ?? 'none'} chars=${text.length}`)
  const unfinished = incompleteReason(finishReason, clean(text))
  if (unfinished) {
    return {
      text: clean(text),
      model,
      lookups,
      findings: [unfinished],
      attempts: 1,
      figure: null,
      incomplete: true
    }
  }

  // An update answers with replacements to the chapter as it stands, not with a chapter: turn the answer
  // into the updated text before anything else reads it. A reply that cannot be applied, twice over,
  // leaves the chapter as it was — kept, with the reason, never overwritten by a failed answer.
  let updated: WriteSectionResult['update']
  if (brief.update) {
    const answer = await settleUpdate({
      raw: text,
      original: brief.update.text,
      model,
      messages,
      signal: opts.signal,
      onCost: opts.onCost,
      maxTokens: opts.maxTokens
    })
    assertLive()
    if (answer.kind === 'refused') {
      return {
        text: brief.update.text,
        model,
        lookups,
        findings: [{ kind: 'update_failed', detail: `The update could not be applied: ${answer.error}` }],
        attempts: 2,
        figure: null,
        incomplete: true
      }
    }
    text = answer.text
    updated = answer.kind
  }

  // The chapter may end with a figure request. Split it off before anything else looks at the prose:
  // the gate would otherwise read the JSON as a sentence full of literal numbers. EVERY such line is
  // removed — a second one (or one whose caption contains `}`) used to survive as raw JSON in the
  // chapter; greedy-to-line-end, so braces inside a caption stay part of the spec.
  let figure: Record<string, unknown> | null = null
  text = text
    .replace(/^[ \t]*FIGURE:[ \t]*(\{.*\})[ \t]*$/gm, (_line, json: string) => {
      if (!figure) {
        try {
          figure = JSON.parse(json) as Record<string, unknown>
        } catch {
          figure = null // a malformed request is no request; the backend would refuse it anyway
        }
      }
      return ''
    })
    .trimEnd()
  if (!figure) {
    // A spec pretty-printed across several lines — rare, but the old single-line pass missed it, and
    // its lazy regex stopped at the first `}` ending a line, so a spec with nested braces was mangled
    // AND its matched prefix removed, leaving an orphan brace as prose. Balance-scan instead, and only
    // remove text when the parse actually succeeded.
    const at = text.search(/^[ \t]*FIGURE:/m)
    const open = at >= 0 ? text.indexOf('{', at) : -1
    if (open >= 0) {
      let depth = 0
      let end = -1
      let inString = false
      for (let i = open; i < text.length; i++) {
        const ch = text[i]
        if (inString) {
          if (ch === '\\') i++
          else if (ch === '"') inString = false
        } else if (ch === '"') inString = true
        else if (ch === '{') depth++
        else if (ch === '}' && --depth === 0) {
          end = i
          break
        }
      }
      if (end > open) {
        try {
          figure = JSON.parse(text.slice(open, end + 1)) as Record<string, unknown>
          text = (text.slice(0, at) + text.slice(end + 1)).trimEnd()
        } catch {
          figure = null // a malformed request is no request; the text stays untouched
        }
      }
    }
  }

  text = clean(text)
  draft.text = text
  if (!opts.api || !opts.checkPath) return { text, model, lookups, findings: [], attempts: 1, figure }

  // ---- the conversation before the store ----------------------------------------------
  // The contract check, the second reader and the writer's answers to it: writer/dialogue.ts. A gate
  // or reader that cannot run leaves the paid-for text standing, with a finding saying why.
  const settled = await converse({
    text,
    figure,
    lookups,
    brief,
    model,
    messages,
    reviewModel: opts.reviewModel,
    reviewPath: opts.reviewPath,
    api: opts.api,
    checkPath: opts.checkPath,
    runId: opts.runId,
    signal: opts.signal,
    onCost: opts.onCost,
    maxTokens: opts.maxTokens,
    tick,
    assertLive,
    onDraft: (t) => {
      draft.text = t
    }
  })
  return {
    text: settled.text,
    model,
    lookups,
    findings: settled.findings,
    attempts: settled.attempts,
    figure: settled.figure,
    review: settled.review,
    // Judged by the text that is stored, not by the first answer: an "unchanged" the gate or the reader
    // then revised is an edited chapter.
    update: updated && (settled.text === clean(brief.update?.text ?? '') ? 'unchanged' : 'edited')
  }
}

export type { WriteAllOutcome } from '../../shared/ipc'

/** How many chapters are in flight at once. Four saturates the useful parallelism of one backend. */
const WRITE_LANES = 4

/**
 * How many model answers a whole "Write all" run waits for, one after another.
 *
 * Per wave, the lanes run `lanes` chapters at once, so a wave is `ceil(size / lanes)` chapters deep,
 * not `size` — parallel answers are one wait, not many. The waves themselves are barriers and do add
 * up. The clock this feeds used to count one answer per chapter, which is not what a chapter is: it
 * is a lookup loop, a prose round and up to two revisions (V185).
 */
export function writeAllAnswers(waves: ReadonlyArray<ReadonlyArray<unknown>>, lanes = WRITE_LANES): number {
  const width = Math.max(1, lanes)
  return waves.reduce((n, wave) => n + Math.ceil(wave.length / width) * MAX_SECTION_ANSWERS, 0)
}

/**
 * The whole "Write all" run, owned here — one process, one abort signal, one progress stream.
 *
 * It used to be orchestrated in the renderer: the renderer ran the wave loops, main held one abort
 * key, the backend gated — and cancellation, progress and error semantics each crossed two process
 * boundaries. The three most expensive findings of an early review (lanes aborting each other,
 * a silent half-chapter, a paid-for text destroyed by a transient gate error) all lived on exactly
 * those seams. Now the renderer sends the plan and paints the outcomes.
 *
 * `waves` are ordered barriers: the summarising chapters (executive summary, conclusions) read the
 * stored siblings, so they must not start until the ordinary chapters have landed.
 */
export async function writeAll(opts: {
  /** The report's API base, e.g. `/api/v1/report/one/<db>/<id>`. */
  base: string
  /** `update`: bring a written chapter up to date (writer/update.ts) instead of writing it anew. */
  waves: { id: string; mode?: 'write' | 'update' }[][]
  model?: string
  signal?: AbortSignal
  api: NonNullable<ToolCtx['api']>
  activeDb?: string | null
  onCost?: CostSink
  /** Settings → AI → Limits "Max tokens per writer reply"; absent = the provider default ceiling. */
  maxTokens?: number
  /** The second reader for every chapter of the run; absent = the gate decides alone. */
  reviewModel?: string
  /** The web research for the literature chapters (`WriteSectionOpts.researchWeb`). */
  researchWeb?: ToolCtx['researchWeb']
  maxResearchQuestions?: number
  onProgress?: (p: { done: number; total: number; outcome: WriteAllOutcome }) => void
  /**
   * The per-chapter phase, stamped with the chapter it came from — the same mechanism the single
   * Write uses, not a second one. The run's own progress is `onProgress` (a chapter at a time); this
   * is the inside of one chapter, and with four lanes running it is four voices on one line. So the
   * panel keys it by id and draws it only for a chapter being written on its own.
   */
  onPhase?: (p: WritePhase & { id: string }) => void
  lanes?: number
}): Promise<WriteAllOutcome[]> {
  const lanes = opts.lanes ?? WRITE_LANES
  const total = opts.waves.reduce((n, wave) => n + wave.length, 0)
  const outcomes: WriteAllOutcome[] = []
  let done = 0
  // One id for the whole run, sent with every judgement. Without it the gate journal is a flat list
  // in which eleven lanes interleave and nothing says which chapter belonged to which run.
  const runId = `wr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  console.log(`[write-all] run ${runId}, ${total} step(s)`)

  const one = async (id: string, mode: 'write' | 'update' = 'write'): Promise<WriteAllOutcome> => {
    // Kept outside the try: if the storing call throws, the generated — and paid-for — text is
    // returned as a draft instead of vanishing into the catch. Same rescue the renderer used to do.
    let written: Awaited<ReturnType<typeof writeSection>> | null = null
    const checkPath = `${opts.base}/sections/${id}/proposal`
    // Stamped, not guessed at: whether the lanes actually overlap and where a chapter's minutes go
    // (brief vs model vs store) is only answerable from these lines — a 48-minute live run
    // could not say whether it had been parallel at all.
    const t0 = Date.now()
    let briefMs = 0
    let writeMs = 0
    console.log(`[write-all] start ${id} at ${new Date(t0).toISOString()}`)
    try {
      if (opts.signal?.aborted) throw new Error(stopNote(opts.signal, 'The run was cancelled.'))
      // Said while it runs: the first wave of a silicone report waited 125 s here (the snapshot
      // computes every indicator for every variant) with "(thinking)" as the only signal (V422).
      opts.onPhase?.({ id, phase: 'brief' })
      const brief = (await opts.api(
        'POST',
        `${opts.base}/sections/${id}/${mode === 'update' ? 'update-brief' : 'brief'}`,
        {}
      )) as WriteBrief
      briefMs = Date.now() - t0
      written = await writeSection({
        brief,
        model: opts.model,
        signal: opts.signal,
        api: opts.api,
        activeDb: opts.activeDb ?? null,
        onCost: opts.onCost,
        maxTokens: opts.maxTokens,
        checkPath,
        reviewModel: opts.reviewModel,
        reviewPath: `${opts.base}/sections/${id}/review-brief`,
        researchWeb: opts.researchWeb,
        maxResearchQuestions: opts.maxResearchQuestions,
        runId,
        onPhase: opts.onPhase ? (p) => opts.onPhase!({ ...p, id }) : undefined
      })
      writeMs = Date.now() - t0 - briefMs
      if (written.incomplete) {
        // Not a chapter: no gate, no store. The panel keeps the text as a draft with the reason.
        console.log(
          `[write-all] incomplete ${id} total=${Date.now() - t0}ms: ${written.findings[0]?.kind ?? 'incomplete'}`
        )
        return {
          id,
          stored: false,
          text: written.text,
          model: written.model,
          lookups: written.lookups,
          figure: null,
          findings: written.findings,
          attempts: written.attempts,
          incomplete: true
        }
      }
      const verdict = (await opts.api('POST', checkPath, {
        text: written.text,
        store: true,
        model: written.model,
        lookups: written.lookups,
        figure: written.figure,
        run: runId,
        attempt: written.attempts ?? 1,
        // Bound to the brief's moment: a recalculation or another write since then makes the backend
        // refuse (409), and the catch below keeps the text as a draft with that reason.
        snapshot_id: brief.snapshot_id,
        expected_text_version: brief.text_version,
        // Read by a second model: the gate decides on the contract alone and keeps the reading.
        ...(written.review ? { reviewed_by: written.review.reviewer, review: written.review } : {})
      })) as { stored?: boolean; findings?: Finding[]; text?: string }
      // The store has the last word on the research too: a refusal here holds it after all.
      settleResearch(chapterOf(checkPath), written.lookups, verdict?.stored === true)
      // The gate repairs what it can before it judges (a literal that is one parameter's current
      // value becomes that parameter's placeholder), so the stored text is not always the text sent.
      // Take its word for what was written, or the panel paints a chapter the file does not hold.
      if (typeof verdict?.text === 'string' && verdict.text) written.text = verdict.text
      console.log(
        `[write-all] done ${id} total=${Date.now() - t0}ms brief=${briefMs}ms write=${writeMs}ms ` +
          `store=${Date.now() - t0 - briefMs - writeMs}ms attempts=${written.attempts ?? 1} stored=${verdict?.stored === true}`
      )
      return {
        id,
        stored: verdict?.stored === true,
        text: written.text,
        model: written.model,
        lookups: written.lookups,
        figure: written.figure,
        findings: (verdict?.findings ?? written.findings) as Finding[],
        attempts: written.attempts,
        review: written.review ?? null,
        update: written.update
      }
    } catch (e) {
      console.log(
        `[write-all] failed ${id} total=${Date.now() - t0}ms brief=${briefMs}ms write=${writeMs}ms: ` +
          (e instanceof Error ? e.message : String(e))
      )
      holdResearch(chapterOf(checkPath), written?.lookups)
      return {
        id,
        stored: false,
        text: written?.text,
        model: written?.model,
        lookups: written?.lookups,
        figure: written?.figure ?? null,
        findings: written?.findings ?? [],
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }

  for (const wave of opts.waves) {
    const queue = [...wave]
    const lane = async (): Promise<void> => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const outcome = await one(next.id, next.mode)
        outcomes.push(outcome)
        opts.onProgress?.({ done: ++done, total, outcome })
      }
    }
    await Promise.all(Array.from({ length: Math.min(lanes, queue.length) }, lane))
    // A cancelled run stops between waves too — the per-chapter guard only covers lane starts.
    if (opts.signal?.aborted) break
  }
  return outcomes
}
