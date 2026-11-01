/**
 * Localize: a dataset from outside the model becomes an editable process of it — the canvas's
 * right-click "Localize (edit)" as a tool. The copy takes the dataset's place for the inputs that drew
 * on it, so the result stays the same until the copy is changed. One or two levels deep: at two, the
 * dataset's direct suppliers are copied too and the copy draws on them.
 */

import type { Tool, ToolCtx } from '../context'
import { obj, str } from '../schema'
import { AI, NO_MODEL, S, cap, fgDb } from '../format'

/** How many of the copy's inputs the answer lists — enough for nine datasets in ten, and each one
 *  carries the uid that localizes it in turn. */
export const LOCALIZE_INPUTS_SHOWN = 40

const WHICH =
  'Say which dataset: input_database + input_code (from search_background, or the input of an exchange), ' +
  'or the "uid" of one input of the model.'

interface Target {
  database: string
  code: string
  uid?: string
}

/** The dataset behind one exchange of the model, found by its uid. */
async function targetOfUid(ctx: ToolCtx, db: string, uid: string): Promise<Target | { error: string }> {
  const acts = await ctx.api('GET', `/api/v1/model/activities/${encodeURIComponent(db)}?with_exchanges=true`)
  for (const act of Array.isArray(acts) ? acts : (acts?.activities ?? [])) {
    const ex = (act?.exchanges ?? []).find((e: any) => e?.uid === uid)
    if (!ex) continue
    if (ex.type !== 'technosphere')
      return {
        error: `The exchange "${uid}" is a ${ex.type} flow — only a dataset an input draws on can be localized.`
      }
    return { database: String(ex.input?.database ?? ''), code: String(ex.input?.code ?? ''), uid }
  }
  return {
    error:
      `No exchange with uid "${uid}" in "${db}" — it may have been removed or replaced. Read the process ` +
      '(get_process_details) for the current one.'
  }
}

/** What to do next, in the order a caller needs it. */
function nextSteps(relinked: number, depth: number): string {
  const steps = [
    'The copy computes exactly like the original until you change it. Change it with edit_exchange ' +
      '(activity_code = "code") and write in edit_process\'s comment which dataset it copies and what you ' +
      'changed: the report describes the process from that comment.'
  ]
  if (!relinked)
    steps.push(
      'No input of this model drew on the dataset, so nothing uses the copy yet: link it with edit_exchange ' +
        'action="add" (input_database = this model, input_code = "code").'
    )
  steps.push(
    depth === 2
      ? 'Its direct suppliers are copies in this model now ("suppliers"); they still draw on the background.'
      : 'To change one of its suppliers too, call localize_dataset again with that input\'s uid from "inputs" — ' +
          "the copy then draws on the supplier's copy."
  )
  return steps.join(' ')
}

export const localizeTools: Tool[] = [
  {
    spec: {
      type: 'function',
      function: {
        name: 'localize_dataset',
        description:
          "Make a dataset from outside the model — a background dataset or one from the library — an EDITABLE process of the model. It is copied into the model, and the inputs that drew on it draw on the copy instead, in the calculation and on the canvas; the result stays the same until you change the copy. Use it when a dataset fits except for something you must adapt (another electricity mix, a different energy demand, a missing input) — never rebuild one by hand. A dataset that fits as it is stays a plain input. Name it by input_database + input_code (every input of the model that uses it moves to the copy) or by the uid of one exchange (only that input moves). depth=2 also copies its direct suppliers and points the copy at those copies; take it only when you will change several of them — for one supplier, localize the copy's input to it by uid. Undoable.",
        parameters: obj(
          {
            database: str('Model to copy into; omit for the model open on the canvas.'),
            input_database: str("Database of the dataset (from search_background, or an exchange's input)."),
            input_code: str('Code of the dataset.'),
            uid: str(
              'The uid of ONE input of the model (get_process_details): only that input moves to the copy, and the dataset is the one it draws on. Also how you localize an input of an earlier copy.'
            ),
            depth: {
              type: 'integer',
              enum: [1, 2],
              description:
                '1 (default): the dataset alone. 2: its direct suppliers are copied as well and the copy draws on them — at most 30.'
            }
          },
          []
        )
      }
    },
    run: async (a, ctx) => {
      const db = fgDb(a, ctx)
      if (!db) return NO_MODEL
      const depth = a?.depth === undefined || a?.depth === null || a?.depth === '' ? 1 : Number(a.depth)
      if (depth !== 1 && depth !== 2) return S({ error: '"depth" is 1 or 2.' })
      const uid = typeof a?.uid === 'string' ? a.uid.trim() : ''
      const givenDb = typeof a?.input_database === 'string' ? a.input_database.trim() : ''
      const givenCode = typeof a?.input_code === 'string' ? a.input_code.trim() : ''

      let target: Target
      if (uid) {
        const found = await targetOfUid(ctx, db, uid)
        if ('error' in found) return S(found)
        if ((givenCode && givenCode !== found.code) || (givenDb && givenDb !== found.database))
          return S({
            error:
              `The exchange "${uid}" draws on ${found.database}/${found.code}, not on ` +
              `${givenDb || found.database}/${givenCode || found.code}. Pass the uid alone, or the dataset alone.`
          })
        target = found
      } else {
        if (!givenDb || !givenCode) return S({ error: WHICH })
        target = { database: givenDb, code: givenCode }
      }
      if (target.database === db)
        return S({
          error:
            `${target.code} is already a process of "${db}" and editable as it is — change it with edit_process ` +
            'and edit_exchange.'
        })

      let made: any
      try {
        made = await ctx.api('POST', '/api/v1/model/activities/copy', {
          source_database: target.database,
          source_code: target.code,
          target_database: db,
          relink_consumers: true,
          ...(target.uid ? { uids: [target.uid] } : {}),
          depth,
          ...AI
        })
      } catch (e) {
        if ((e as { code?: string })?.code === 'too_many_suppliers')
          return S({
            error: e instanceof Error ? e.message : String(e),
            next:
              'Call localize_dataset with depth=1, then localize only the inputs of the copy you mean to ' +
              'change, each by its uid.'
          })
        throw e
      }

      const exchanges: any[] = Array.isArray(made?.exchanges) ? made.exchanges : []
      const inputs = cap(
        exchanges
          .filter((e) => e?.type === 'technosphere')
          .map((e) => ({
            uid: e.uid,
            name: e.input?.name,
            location: e.input?.location,
            amount: e.amount,
            unit: e.input?.unit,
            database: e.input?.database,
            code: e.input?.code
          })),
        LOCALIZE_INPUTS_SHOWN
      )
      const relinked = Number(made?.relinked ?? 0)
      return S({
        database: db,
        code: made?.activity?.code,
        name: made?.activity?.name,
        location: made?.activity?.location,
        copied_from: { database: target.database, code: target.code },
        relinked,
        inputs: inputs.items,
        inputs_note: inputs.note,
        biosphere_flows: exchanges.filter((e) => e?.type === 'biosphere').length,
        ...(depth === 2
          ? {
              suppliers: (made?.suppliers ?? []).map((s: any) => ({
                code: s.code,
                name: s.name,
                location: s.location,
                copied_from: { database: s.from?.[0], code: s.from?.[1] }
              }))
            }
          : {}),
        next: nextSteps(relinked, depth)
      })
    }
  }
]
