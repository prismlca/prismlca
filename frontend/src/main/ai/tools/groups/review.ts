/** The model reviewer: assemble the dossier, hand it to the judging pass. */
// Split out of the monolithic tools.ts. Spec and run stay together on purpose:
// the prose description and the handler are edited as a pair, and the description guard in
// tools.test.ts scans spec text against implementation names.

import type { Tool, ToolCtx } from '../context'
import { num, obj, str, strArr } from '../schema'
import { S, capText } from '../format'
import { linkedHotspots, needsALook } from '../advice/hotspots'
import { unopenedHotspots } from '../advice/opened'
import { previousReviewOf, previousReviewSection } from './reviewHistory'
import { modelFingerprint, notRunAgain, reviewFailed, reviewSucceeded } from './reviewFailure'
import { indicatorsSection, pickedMethods } from './reviewIndicators'
import { searchesSection } from './reviewSearches'
import { researchSection } from './reviewResearch'
import { processesSection } from './reviewProcesses'
import { paramsSection } from './reviewParams'
import { numbersFingerprint, rememberJudged, withTextOnlyNote } from './reviewNumbers'
import { afterReviewNote, outcomesAnswer, reviewerIdentity } from './reviewAnswer'
import { scoredFor } from '../advice/scored'

export const reviewTools: Tool[] = [
  {
    spec: {
      type: 'function',
      function: {
        name: 'review_model',
        description:
          'Get a second opinion from a separate AI reviewer on a finished product system — what an LCA reviewer would challenge. Collects the evidence itself (structural health check, biggest contributors, the goal & scope on record, the background datasets used) and has a separate reviewer judge it: system boundaries vs. what is actually modelled, plausibility of the proxy datasets, whether the impact method variant fits the stated goal, signs on treatment processes, and hotspots so dominant that one assumption decides the result. It never changes the model; each review is kept in the model\'s review log, stamped against the model state, so the report can say whether the model changed afterwards. It is not a critical review in the ISO 14044 sense and never goes into model_info critical_review. Pass code and method to include the hotspot analysis; without them the review covers structure and goal & scope only. Every finding cites a figure from the evidence, so treat an unquoted claim as absent rather than as a warning. AFTER acting on the findings, call this tool again with "resolutions" to record each finding\'s outcome by its id (the review tags its findings [F1], [F2], …); the answer lists the findings that still have none — fixed things are visible in the model, but "rejected, because …" and "still open" exist nowhere else, and the report prints the open ones in its Limitations chapter. With "resolutions" present nothing is re-reviewed; the call only records. After a structural change (new phase, swapped dataset that carries the result, changed allocation) run the review again — it sees its previous findings.',
        parameters: obj(
          {
            database: str('Model to review; defaults to the open model.'),
            code: str("Reference process for the hotspot analysis (the product system's final activity)."),
            method: strArr('LCIA method tuple for the hotspot analysis, from list_methods.'),
            amount: num('Functional-unit amount for the hotspot analysis (default 1).'),
            review_id: str(
              'With "resolutions": the review_id the review call returned, so the outcomes land on THAT review — omitted, they attach to the latest review of the model, which may be another chat\'s.'
            ),
            resolutions: {
              type: 'array',
              description:
                'Record-only mode: your outcome per review finding, after you acted on the review. One entry per finding you want the study to be able to show.',
              items: obj(
                {
                  id: str(
                    'The finding\'s id as the review tagged it — "F3". Without it the outcome cannot be matched to its finding.'
                  ),
                  finding: str('The finding, in one sentence (your words, not a quote of the whole point).'),
                  resolution: {
                    type: 'string',
                    enum: ['fixed', 'rejected', 'open'],
                    description:
                      'fixed = changed the model; rejected = will not act, say why; open = cannot be settled here — ' +
                      "data nobody has, a decision that is the user's. Not open: what one more call would settle " +
                      '(open the dataset, recompute the figure) — do it; and a baseline that contradicts your own ' +
                      'comment or limitation — make the two agree.'
                  },
                  reason: str(
                    'Why rejected, or what keeps it open. Required in spirit for anything but "fixed".'
                  )
                },
                ['finding', 'resolution']
              )
            }
          },
          []
        )
      }
    },
    surface: 'subagent',
    run: async (a, ctx) => {
      const db = a.database || ctx.activeDb
      if (!db) return S({ error: 'No model open — pass a database name.' })
      // Record-only mode: the builder's outcome per finding, attached to the latest review in the
      // log. This is the half of a review that is otherwise unrecoverable — the model shows what was
      // fixed, but "rejected, because …" and "still open" existed only in the conversation.
      if (Array.isArray(a.resolutions) && a.resolutions.length) {
        // The answer lists the tagged findings that still have no outcome (reviewAnswer.ts): the log
        // cannot be read back, so counts alone left the ones never answered invisible.
        // "fixed" after a mere rewording gets a note (reviewNumbers.ts).
        try {
          const answer = outcomesAnswer(
            await ctx.api('POST', '/api/v1/provenance/review/resolutions', {
              database: db,
              resolutions: a.resolutions,
              ...(typeof a.review_id === 'string' && a.review_id ? { review_id: a.review_id } : {})
            })
          )
          return S(await withTextOnlyNote(answer, a.resolutions, () => readNumbers(ctx, db)))
        } catch (e) {
          return S({ error: e instanceof Error ? e.message : String(e) })
        }
      }
      if (!ctx.review) return S({ error: 'The reviewer is not available in this context.' })

      // Gathered here via the same endpoints the UI uses (ADR-003: tools stay pass-throughs, no new
      // backend logic). Each part is optional: a part that fails is NAMED as a gap in the dossier, so
      // the reviewer never silently judges an incomplete picture as complete.
      const gaps: string[] = []
      const part = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
        try {
          return await fn()
        } catch (e) {
          gaps.push(`${label}: could not be collected (${e instanceof Error ? e.message : String(e)})`)
          return null
        }
      }
      // WITH the exchanges: without them the dossier is process names, units and locations, and the
      // reviewer cannot see a single quantity, formula or sign. It then reports what it cannot find
      // — "no manufacturing energy node appears above cutoff", "the mass balance is not
      // demonstrated" — about things that were present and correct, and every one of those costs the
      // assistant a round to disprove.
      const activities = await part('process list', () =>
        ctx.api('GET', `/api/v1/model/activities/${encodeURIComponent(db)}?with_exchanges=true`)
      )
      // The values and notes behind the formulas (reviewParams.ts).
      const params = await part('parameters', () =>
        ctx.api('GET', `/api/v1/params?database=${encodeURIComponent(db)}`)
      )
      // First, because it decides whether the reviewer runs at all: this chat's review of the same model
      // came back without a result, and the same reviewer would take the same time again (reviewFailure.ts).
      const subject = {
        chatId: ctx.chatId,
        db,
        model: activities ? modelFingerprint(activities) : null,
        reviewer: ctx.reviewModel ?? ''
      }
      const earlier = notRunAgain(subject)
      if (earlier) return S(earlier)
      const study = await part('goal & scope', () =>
        ctx.api('GET', `/api/v1/study?database=${encodeURIComponent(db)}`)
      )
      const health = await part('health check', () =>
        ctx.api('GET', `/api/v1/model/health/${encodeURIComponent(db)}`)
      )
      const hotspots =
        a.code && a.method
          ? await part('hotspots', () =>
              ctx.api('POST', '/api/v1/calc/contribution', {
                database: db,
                code: a.code,
                method: a.method,
                amount: a.amount ?? 1,
                cutoff: 0.01,
                max_depth: 6
              })
            )
          : null
      if (!a.code || !a.method)
        gaps.push('hotspots: not analysed (no code/method given, so no contribution tree)')

      // The reviewer cannot look anything up, so it cannot know what the assistant did or did not
      // read. PrismLCA does: it has the tree and it has the run's record of every get_process_details.
      // Handing over the intersection as a FACT keeps the split intact — PrismLCA supplies the finding,
      // the reviewer decides how hard to press. Worth the four lines because in one real run
      // the review was the only channel that changed the model's behaviour: its PWB point triggered a
      // −38.9 % correction, while the NiMH battery beside it — same defect, 41 % of the result — was
      // never mentioned by anyone and shipped.
      // A fact only while it can be measured: when the app cannot say which producers stand behind
      // the linked markets, a market whose producer was read would be handed over as never looked
      // at. Then the section is left out and named as a gap, like any other part that failed.
      const unopened =
        (await part('datasets nobody looked at', () => unopenedHotspots(ctx, hotspots?.tree, db, 'throw'))) ??
        []

      // What the biggest datasets say about themselves, quoted INTO the dossier — because the
      // reviewer cannot look anything up. "DATASETS NOBODY LOOKED AT" (below) tells it that nobody
      // read them; this hands it the text itself. The difference is measured: in a
      // solar-lamp run the NiMH battery carried 41 % of the result and its producer comment says
      // "for laptop applications … Fujitsu-Siemens laptop" — a reviewer holding that sentence
      // cannot miss it, a reviewer told only that the dataset was never opened did. Fetched for the
      // same union of datasets the inspection rule flags (opened or not — the assistant may have
      // read a comment and still not drawn the conclusion), capped so six long ecoinvent comments
      // do not crowd out the process list the reviewer is asked to challenge.
      const selfDescriptions: string[] = []
      for (const h of needsALook(linkedHotspots(hotspots?.tree, db)).slice(0, 6)) {
        const d: any = await part(`dataset "${h.name}"`, () =>
          ctx.api(
            'GET',
            `/api/v1/model/activities/${encodeURIComponent(h.database)}/${encodeURIComponent(h.code)}`
          )
        )
        const act = d?.activity
        if (!act) continue
        const sup = act.main_supplier_comment
        const text = sup
          ? `${sup.name} [${sup.location ?? '?'}], which supplies ${Math.round((sup.share ?? 0) * 100)} % ` +
            `of this market, states: ${sup.comment}`
          : String(act.comment ?? '')
        const service = act.service_note ? ` SERVICE NOTE: ${capText(String(act.service_note), 300)}` : ''
        // A market billed per m² or m: the amounts that say what its unit refers to (kg of zinc per m²).
        // The comment alone can argue both readings, and the reviewer cannot open the producer.
        const perUnit = act.main_supplier_inputs
        const inputs = Array.isArray(perUnit?.biggest_inputs)
          ? ` INPUTS OF ${perUnit.name} [${perUnit.location ?? '?'}] PER ${perUnit.per ?? 'unit'}: ` +
            perUnit.biggest_inputs
              .map((i: any) => `${i.amount} ${i.unit ?? ''} ${i.name}${i.product ? ` (${i.product})` : ''}`)
              .join('; ')
          : ''
        if (!text.trim() && !service) continue
        selfDescriptions.push(
          `${act.name} [${h.database}] ${Math.round(Math.abs(h.cumulative_share) * 100)} % of the result: ` +
            `"${capText(text.trim(), 600)}"${service}${capText(inputs, 500)}`
        )
      }

      // Every indicator scored for the model, not only the hotspot method (reviewIndicators.ts).
      const view = await part('results page set-up', () =>
        ctx.api('GET', `/api/v1/views/${encodeURIComponent(db)}`)
      )
      const indicators = indicatorsSection(
        scoredFor(ctx.scored, db),
        pickedMethods(view),
        hotspots && Array.isArray(a.method) ? a.method : null
      )

      // What the research tools found for this model, and what they could not settle (reviewResearch.ts).
      const research = await part('research on record', () =>
        ctx.api('GET', `/api/v1/provenance/research?database=${encodeURIComponent(db)}`)
      )

      // This chat's own previous review of the model, if it ran one (reviewHistory.ts).
      const previous = ctx.chatId
        ? previousReviewOf(
            await part('previous review', () =>
              ctx.api('GET', `/api/v1/provenance/review?database=${encodeURIComponent(db)}`)
            ),
            ctx.chatId
          )
        : null

      // Compact, and shortened comment by comment when long — every cut named under GAPS (reviewProcesses.ts).
      const processes = activities ? processesSection(activities, db) : null
      const parameters = params ? paramsSection(params) : null
      gaps.push(...(processes?.gaps ?? []), ...(parameters?.gaps ?? []))
      const capped = (label: string, value: unknown, max: number): string => {
        const text = JSON.stringify(value)
        if (text.length > max) gaps.push(`${label}: cut at ${max.toLocaleString('en-US')} characters`)
        return capText(text, max)
      }

      const dossier = [
        `MODEL: ${db}`,
        `GOAL & SCOPE: ${study && Object.values(study).some((v) => v) ? JSON.stringify(study) : '(empty — nothing recorded)'}`,
        `HEALTH CHECK: ${health ? capped('health check', health, 8_000) : '(missing)'}`,
        // Larger than the rest on purpose: this is now the only place the reviewer can read a
        // quantity, and it is the part it is asked to challenge.
        processes?.text || `PROCESSES (with exchanges): ${activities ? '(none)' : '(missing)'}`,
        parameters?.text ?? '',
        `HOTSPOTS: ${hotspots ? capped('hotspots', hotspots, 8_000) : '(not analysed)'}`,
        // Absence below a cutoff is not absence. Saying so is the difference between "the packaging
        // is missing" and "the packaging is under 1 % — worth a look at the mass estimate".
        hotspots
          ? 'HOW TO READ THE HOTSPOTS: computed with a 1 % cutoff and a depth limit, and truncated ' +
            'above. Something not listed there is BELOW the cutoff, not absent from the model — check ' +
            'it against the process list before reporting it as missing.'
          : '',
        indicators,
        researchSection(research),
        // What the provider's web search found inside the assistant's replies (reviewSearches.ts).
        searchesSection(ctx.webLookups?.() ?? []),
        selfDescriptions.length
          ? 'WHAT THE BIGGEST DATASETS SAY ABOUT THEMSELVES (their own dataset comment; for a ' +
            'market, the producer it mostly buys from): check each sentence against the product ' +
            'under study. A dataset calibrated on another product class — a laptop battery pack in ' +
            'a garden lamp — is a finding even when its name looks generic, and the assistant may ' +
            'never have read these sentences.\n' +
            selfDescriptions.map((s) => `- ${s}`).join('\n')
          : '',
        unopened.length
          ? 'DATASETS NOBODY LOOKED AT: these background datasets are linked directly by a ' +
            'foreground process, each is among the biggest contributors to the result (above 10 %, ' +
            'or in the top 8 with at least 2 %), and the assistant never ' +
            'opened any of them (no get_process_details call in this chat), so nothing it wrote about ' +
            'them can rest on more than their names — ' +
            unopened
              .map((u) => `${u.name} [${u.database}] ${Math.round(u.cumulative_share * 100)} %`)
              .join('; ') +
            '. This is a measured fact, not an inference: raise it, and say for each one what reading ' +
            'it could still change.'
          : '',
        previous ? previousReviewSection(previous) : '',
        gaps.length ? `GAPS IN THIS DOSSIER: ${gaps.join('; ')}` : ''
      ]
        .filter(Boolean)
        .join('\n\n')

      const review = await ctx.review({ dossier })
      if (review.outcome === 'ok') {
        reviewSucceeded(subject)
        // Into the review log, stamped server-side against the model state. Best-effort: losing the
        // log entry must never cost the review itself.
        let logged: { id?: string } = {}
        try {
          logged = await ctx.api('POST', '/api/v1/provenance/review', {
            database: db,
            review: review.text,
            gaps,
            ...(ctx.chatId ? { chat: ctx.chatId } : {}),
            ...(review.partial ? { partial: true } : {})
          })
        } catch {
          /* the review still reaches the model; only the log entry is lost */
        }
        rememberJudged(logged.id, activities && params ? numbersFingerprint(activities, params) : null)
        const who = reviewerIdentity(ctx.reviewModel, ctx.model)
        return S({
          database: db,
          gaps,
          review: review.text,
          review_id: logged.id,
          ...who,
          ...(review.partial
            ? {
                cut_off:
                  'The reviewer ran out of time and was stopped; this is what it had written by then, so ' +
                  'findings it had not reached are missing.'
              }
            : {}),
          note: afterReviewNote(who)
        })
      }
      return S(reviewFailed(subject, gaps, review))
    }
  }
]

/** The model's exchanges and parameters as they stand, for the comparison a recorded "fixed" gets. */
const readNumbers = async (ctx: ToolCtx, db: string): Promise<[unknown, unknown]> => [
  await ctx.api('GET', `/api/v1/model/activities/${encodeURIComponent(db)}?with_exchanges=true`),
  await ctx.api('GET', `/api/v1/params?database=${encodeURIComponent(db)}`)
]
