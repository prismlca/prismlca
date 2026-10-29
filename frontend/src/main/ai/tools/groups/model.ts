/** Everything that writes the model itself: processes, exchanges, metadata. */
// Split out of the monolithic tools.ts. Spec and run stay together on purpose:
// the prose description and the handler are edited as a pair, and the description guard in
// tools.test.ts scans spec text against implementation names.

import type { Tool } from '../context'
import { num, obj, objArr, str } from '../schema'
import { AI, NO_MODEL, S, batchResult, fgDb, runItem } from '../format'
import { resolveCode } from '../resolve'
import { trimUnitNotes } from '../advice/warnings'
import { IMPL, delegate } from '../impl'
import { type LinkedInput, UNOPENED_LINKS_SHOWN, unopenedLinks } from '../advice/hotspots'
import { expandBatch, explainNotFound, ignoredNote } from './exchangeBatch'

/**
 * What edit_exchange says beside a link to a background dataset nobody has opened. Without it, models
 * moved on after linking — searching for the next input or asking the user about masses — and opened
 * nothing; with it, they open the carrying datasets (say PP, steel and moulding of a hose cart) in one
 * call. It must not override the plan: small auxiliaries after the main materials were checked are left
 * alone, and the last sentence keeps a user's "don't spend calls on checking" above the nudge — without
 * it the nudge won; with it the model calculates and flags the unopened inputs as provisional.
 */
export const openBeforeRelying = (n: number): string =>
  `You linked ${n} background dataset(s) this chat has not opened yet (not_yet_opened). Open the ones ` +
  'that will carry the result — the main material, the energy, anything you expect at a tenth of the ' +
  'total or more — with get_process_details before you build further on them (one call takes a ' +
  '"codes" list; summary=true shows the biggest inputs): a name does not say what a dataset contains or ' +
  'what it was built for. Small auxiliaries can wait; after calculating, explain_result names the ' +
  'unopened ones that turned out to matter. If the user has told you not to check datasets, follow ' +
  'that, and name the unopened ones in your answer.'

/**
 * The batch list — plus the top-level entry when the model filled BOTH. Both shapes are in the schema
 * (one process in the top-level fields, or several in `processes`); their combination used to mean
 * "the list wins", and the top-level process vanished without a word. Three of four GLM 5.3 Flash
 * runs did exactly that — main process on top, phases in the list — and each spent two
 * to four rounds finding and recreating it (V363). Now the combination means all of them. The
 * top-level entry counts when it carries the identifying field: `name` for create, `code` or
 * `current_name` for edit — a bare `database` or `location` beside the list is not a process.
 */
function processItems(a: any, idKey: 'name' | 'code'): any[] {
  const list: any[] = Array.isArray(a?.processes) && a.processes.length ? a.processes : []
  if (!list.length) return [a]
  const { processes: _list, ...top } = a
  const identified = idKey === 'name' ? Boolean(top.name) : Boolean(top.code || top.current_name)
  return identified ? [top, ...list] : list
}

export const modelTools: Tool[] = [
  {
    spec: {
      type: 'function',
      function: {
        name: 'delete_model',
        description:
          'Delete a whole foreground model and all its processes. Destructive and NOT undoable — say what you are about to delete and why before you call it.',
        parameters: obj({ database: str('Model name.') }, ['database'])
      }
    },
    // A floor under every approval mode: deleting a model is not undoable, and a
    // client can approve calls on its own, so a person confirms it in the window unless an approval
    // card already did (ctx.preApproved) — the same rule as the custom-method deletes in impl.ts. It
    // was the one irreversible delete without a question of its own, so under "Never ask" (MCP) or
    // with the chat card off it ran unasked while deleting one method asked.
    run: async (a, ctx) => {
      if (!ctx.preApproved) {
        const r = await ctx.ui('ask_user', {
          question: `Delete the model "${String(a.database ?? '')}" and all its processes? This cannot be undone.`,
          options: [{ label: 'Delete' }, { label: 'Cancel' }]
        })
        const answers: string[] = Array.isArray(r?.answers) ? r.answers.map(String) : []
        if (!answers.includes('Delete')) return S({ cancelled: true })
      }
      return S(await ctx.api('POST', '/api/v1/databases/foreground/delete', { ...a, ...AI }))
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'create_process',
        description:
          'Create one or several foreground processes in a model. Pass "processes" to create a batch in a single call (a process given in the top-level fields beside the list is created too). The answer carries each new process\'s "code" — batch included — so never go looking for it with another call. ALWAYS write the "comment" here, in the creating call: it is the material the report\'s inventory chapter is WRITTEN from — not printed verbatim, so it need not be polished, but nothing missing from it can appear in the report — and describing processes "later" reliably means never — say what the process represents and where each figure comes from (own data / your own estimate, said plainly / a source with publisher, year and URL).',
        parameters: obj(
          {
            database: str('Foreground model name; omit for the model open on the canvas.'),
            name: str('Process name.'),
            product: str('Reference product (optional).'),
            unit: str('Unit (default "unit").'),
            location: str('Location (default GLO).'),
            comment: str('Description: what it represents and where its data comes from, with sources.'),
            processes: objArr('Several processes at once; each item takes the same fields as above.', {
              name: str('Process name.'),
              product: str('Reference product.'),
              unit: str('Unit.'),
              location: str('Location.'),
              comment: str('Description with sources.')
            })
          },
          []
        )
      }
    },
    run: async (a, ctx) => {
      const db = fgDb(a, ctx)
      if (!db) return NO_MODEL
      const items = processItems(a, 'name')
      if (!items.some((i) => i?.name)) return S({ error: 'Each process needs a "name".' })
      const create = async (it: any): Promise<unknown> => {
        const { comment, ...fields } = it ?? {}
        const made = await ctx.api('POST', '/api/v1/model/activities', {
          ...fields,
          processes: undefined,
          database: db,
          ...AI
        })
        // The description is a second call only because creation and field-setting are separate
        // endpoints; from the model's side it is one step, which is the point.
        const code = made?.activity?.code ?? made?.code
        if (comment && code) {
          await ctx.api('POST', '/api/v1/model/activities/fields', { database: db, code, comment, ...AI })
        }
        return { code, name: it?.name, described: Boolean(comment) }
      }
      if (items.length === 1) {
        const r = await create(items[0])
        return S({
          ...(r as object),
          hint: items[0]?.comment ? undefined : 'No comment given — add the description now, not later.'
        })
      }
      const results = await Promise.all(items.map((it) => runItem(it, () => create(it))))
      return batchResult(results)
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'edit_process',
        description:
          "Edit fields of a foreground process (name, product, unit, location, comment). The comment is the process DESCRIPTION and report chapters are handed it verbatim: say what the process represents and where its data comes from — the user's data, your own estimate (say so), or web research with title, publisher, year and URL. Write one for every foreground process you create.",
        parameters: obj(
          {
            database: str('Model name; omit for the model open on the canvas.'),
            code: str('Activity code — or identify the process by "current_name".'),
            current_name: str('Existing process name instead of the code; must match exactly one.'),
            location: str('Location, to disambiguate a name used in several regions.'),
            name: str('New name (optional).'),
            product: str('New reference product (optional).'),
            unit: str('New unit (optional).'),
            comment: str(
              'Description of the process: what it represents and where its data comes from, with sources for anything researched. Replaces the existing text.'
            ),
            processes: objArr(
              'Edit several processes in one call; each item takes the same fields (a process identified in the top-level fields beside the list is edited too).',
              {
                code: str('Activity code.'),
                current_name: str('Existing name instead of the code.'),
                name: str('New name.'),
                product: str('New reference product.'),
                unit: str('New unit.'),
                comment: str('New description with sources.')
              }
            )
          },
          []
        )
      }
    },
    run: async (a, ctx) => {
      const db = fgDb(a, ctx)
      if (!db) return NO_MODEL
      const items = processItems(a, 'code')
      const edit = async (it: any): Promise<unknown> => {
        // `name` here is the *new* name, so the default wording would have pointed at the one field
        // that must not be used to find the process.
        const r = await resolveCode(
          ctx,
          db,
          { code: it?.code, name: it?.current_name, location: it?.location },
          { code: 'code', name: 'current_name' }
        )
        if ('error' in r) throw new Error(r.error)
        const { processes, current_name, database, code, ...fields } = it ?? {}
        void processes
        void current_name
        void database
        void code
        // Patch semantics, honestly: an ABSENT field means "leave it", and so does an EMPTY one —
        // GPT-5.6 pads every optional field with "", and `name: ""` used to travel all the way into
        // Brightway, which refused the save as `ValidityError: Missing field name` dressed up as an
        // "Unexpected server error" (V287). Nothing here can be meaningfully set to empty.
        for (const k of Object.keys(fields)) {
          if (typeof fields[k] === 'string' && !fields[k].trim()) delete fields[k]
        }
        return ctx.api('POST', '/api/v1/model/activities/fields', {
          database: db,
          code: r.code,
          ...fields,
          ...AI
        })
      }
      if (items.length === 1) {
        // Resolved by the item's OWN identifiers: with `processes: [{code, …}]` they sit in items[0],
        // and a pre-check on the outer arguments refused a correct call.
        try {
          return S(await edit(items[0]))
        } catch (e) {
          return e instanceof Error ? e.message : String(e)
        }
      }
      const results = await Promise.all(items.map((it) => runItem(it, () => edit(it))))
      return batchResult(results)
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'delete_process',
        description:
          'Delete a foreground process. Destructive — confirm intent with the user first. If the process is consumed by others, the call is rejected (delete_blocked) unless force=true; forcing removes the consumer inputs too (undo restores them).',
        parameters: obj(
          {
            database: str('Model name.'),
            code: str('Activity code.'),
            force: {
              type: 'boolean',
              description:
                'Delete even if other processes consume it (their inputs are removed; undo restores them). Confirm with the user before forcing.'
            }
          },
          ['database', 'code']
        )
      }
    },
    run: async (a, ctx) => S(await ctx.api('POST', '/api/v1/model/activities/delete', { ...a, ...AI }))
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'set_classification',
        description:
          'Set the ISIC section and/or CPC class of a foreground process (for stacked-bar breakdowns).',
        parameters: obj(
          {
            database: str('Model name.'),
            code: str('Activity code.'),
            isic: str('ISIC section letter A–U.'),
            cpc: str('CPC code.'),
            cpc_name: str('CPC name.')
          },
          ['database', 'code']
        )
      }
    },
    run: async (a, ctx) =>
      S(await ctx.api('POST', '/api/v1/model/activities/classification', { ...a, ...AI }))
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'set_flow_properties',
        description:
          "Set flow properties (carbon content, dry mass, price, …) on a foreground process's reference product. Property names/units must match the ecoinvent vocabulary — check the current ones with get_flow_properties first.",
        parameters: obj(
          {
            database: str('Foreground model name.'),
            code: str('Activity code.'),
            properties: {
              type: 'object',
              description:
                'Map of property name → {amount, unit}, e.g. {"carbon content, fossil": {"amount": 0.5, "unit": "kg"}}.',
              additionalProperties: obj({ amount: num('Value.'), unit: str('Unit.') }, ['amount', 'unit'])
            }
          },
          ['database', 'code', 'properties']
        )
      }
    },
    run: async (a, ctx) => S(await ctx.api('POST', '/api/v1/model/properties', { ...a, ...AI }))
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'manage_model',
        description:
          'Create, copy or rename a foreground model. action="create" takes name (+ optional goal/scope); "duplicate" takes source + name; "rename" takes database + name. NOT undoable. Deleting a model is the separate delete_model tool.',
        parameters: obj(
          {
            action: str('One of: create | duplicate | rename.'),
            name: str('New model name (all actions).'),
            goal: str('Optional goal text (action=create).'),
            scope: str('Optional scope text (action=create).'),
            source: str('Model to copy (action=duplicate).'),
            database: str('Model to rename (action=rename).')
          },
          ['action', 'name']
        )
      }
    },
    run: async (a, ctx) =>
      delegate({ create: 'create_model', duplicate: 'duplicate_model', rename: 'rename_model' }, a, ctx, {
        duplicate: ['source'],
        rename: ['database']
      })
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'model_info',
        description:
          'Read or update a model\'s study metadata (goal & scope, functional unit, geography and reference year, system boundaries, cut-off criteria, process and system allocation, notes, the people involved — author, organisation, commissioner, critical review, which appear on the report cover — and "limitations", what you could not resolve). action="get" reads it — do this before substantive modelling; "set" merges only the fields you pass (undoable). This is the study\'s contract and your brief, and it is the ONLY channel from you to whoever writes the report: they never see this conversation.',
        parameters: obj(
          {
            action: str('One of: get | set.'),
            database: str('Model name; defaults to the open model.'),
            language: str(
              'The language the study is DOCUMENTED in (en | de | fr | es | pt; default en). Set it ' +
                'once at the start — from what the user asked for, or the language of the conversation — ' +
                'and then write ALL study documentation in it consistently: these fields, process ' +
                'comments, scenario names and descriptions, parameter comments. A report in another ' +
                'language translates from it mechanically, so mixed-language documentation ends up as a ' +
                'mixed-language document.'
            ),
            goal: str('Goal of the study.'),
            scope: str('Scope description.'),
            functional_unit: str('The functional unit.'),
            geography: str(
              'Where the product is made and where it is sold or used, e.g. "made in Poland, sold in ' +
                'Germany" — the market every dataset choice has to match. The brief or the user names it; ' +
                'the language of the conversation does not, so ask when neither does.'
            ),
            reference_year: str('The year or period the data should represent, e.g. "2025".'),
            system_boundaries: str('What is in and out of the system.'),
            cutoff_criteria: str('Cut-off rules applied.'),
            allocation: str(
              'Process allocation: how a multi-output process is split between its products (mass, economic, energy).'
            ),
            system_allocation: str(
              'System allocation: how end-of-life burdens and credits are handled (cut-off, avoided burden, 50/50, circular footprint formula).'
            ),
            author: str('Who wrote the study.'),
            organisation: str('The organisation carrying out the study.'),
            commissioner: str('Who the study was carried out for.'),
            date: str('Study date, ISO format.'),
            limitations: {
              type: 'array',
              description:
                'What YOU could not resolve while building this model — the judgements that belong to the study rather than to any one process, and that no process comment has room for: an allocation you had to choose, an assumption the result turns out to rest on, something deliberately left out, data the user could not supply. The report prints them in its Limitations chapter beside the ones it can check for itself. A proxy\'s reasoning does NOT go here — that belongs in the process comment, which the inventory chapter prints. REPLACES the whole list, so pass the ones that still apply — or use "add_limitations" to append one without resending the rest, which is what you want the second time.',
              items: obj(
                {
                  text: str('One statement, in full sentences, as a reader will read it in the report.'),
                  kind: str('limitation | assumption | exclusion | data_gap. Defaults to limitation.'),
                  subject: str(
                    'Optional: what it is about — a process name, a parameter, a life-cycle phase.'
                  )
                },
                ['text']
              )
            },
            add_limitations: {
              type: 'array',
              description:
                'With action=set. APPENDS to the recorded limitations instead of replacing them — use this for one that occurs to you later, so you do not have to resend the existing ones correctly from memory. Duplicates (same text) are dropped. Same entry shape as "limitations"; pass one or the other, never both.',
              items: obj(
                {
                  text: str('One statement, in full sentences, as a reader will read it in the report.'),
                  kind: str('limitation | assumption | exclusion | data_gap. Defaults to limitation.'),
                  subject: str(
                    'Optional: what it is about — a process name, a parameter, a life-cycle phase.'
                  )
                },
                ['text']
              )
            },
            critical_review: str(
              'Who reviewed the study and when. Leaving it empty is meaningful: a public comparative ' +
                'assertion without a recorded review has to say so (ISO 14044 §7.3.3).'
            ),
            notes: str('Any other study notes.')
          },
          ['action']
        )
      }
    },
    run: async (a, ctx) => delegate({ get: 'get_model_info', set: 'set_model_info' }, a, ctx)
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'edit_exchange',
        description:
          'Add, change, annotate or remove inputs/exchanges on a foreground process. action="add" links an input (input_database/code plus amount OR formula, and you may pass comment in the SAME call — no follow-up needed); "set_amount" (amount); "set_formula" (formula — empty detaches it and keeps the number); "set_comment" (comment). "set_amount" and "set_formula" also take a comment in the same call and answer `commented: true`, so changing a number and saying why is ONE call; "remove"; "replace_input" swaps the dataset behind an existing exchange for another one (new_input_code, optional new_input_database) and CARRIES OVER its amount, formula and comment unless you pass new ones — that is the one call to reach for when a review says a dataset was the wrong choice. ADD RETURNS THE NEW EXCHANGE\'S uid, so never re-read the process just to find it. Say WHICH process with activity_code (or activity_name), and which exchange inside it with "uid" or input_database/input_code — except that a "uid" ALONE is enough, because it identifies the exchange on its own and the process is looked up for you. input_database is required for action="add" even when the input is another process of the same model: pass the active model\'s database name. Pass "exchanges" to do a whole batch in one call \u2014 and then the top-level "activity_code"/"activity_name"/"activity_database", "action", "type" and "input_database" act as DEFAULTS for every item, so name the process once instead of on all nine rows; an item that says something else wins. What names a single exchange (uid, input_code, amount, formula, comment) belongs on the item and is ignored at the top level. The comment is where the REASON for an amount belongs — why a waste flow has the sign it has, why a proxy dataset stands in, what a formula expresses. Undoable.',
        parameters: obj(
          {
            action: str('add | set_amount | set_formula | set_comment | remove | replace_input.'),
            new_input_code: str('Replacement dataset code (action=replace_input).'),
            new_input_database: str(
              "Replacement dataset database (action=replace_input; defaults to the old one's)."
            ),
            activity_database: str('Foreground model holding the exchange; omit for the open model.'),
            activity_code: str('Activity code holding the exchange — or use "activity_name".'),
            activity_name: str('Name of the activity holding the exchange, instead of its code.'),
            input_database: str(
              "Input's database (required for action=add — the active model's own name for a link to another process of this model; or to identify an existing exchange)."
            ),
            input_code: str("Input's code (action=add, or to identify an existing exchange)."),
            amount: num(
              'Amount (action=add/set_amount). Optional on "add" when you pass a formula — the formula is evaluated and its result becomes the amount.'
            ),
            type: str(
              '"technosphere" (default) or "biosphere" (action=add). Biosphere flows take formulas exactly like technosphere ones — parameterise field emissions instead of typing constants.'
            ),
            uid: str(
              'Exchange uid, instead of input_database/input_code. Enough on its own: the process holding it is looked up, so activity_code/activity_name is optional when you have a uid.'
            ),
            formula: str(
              'Formula expression; empty clears it. May be passed with action=add, where it also supplies the amount. Works for biosphere flows too.'
            ),
            comment: str('Why this amount/sign/proxy — may be passed with action=add.'),
            tags: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description:
                'action=add: tags of the new input itself, { "<tag group>": "<value>" } — e.g. { "Life-cycle phase": "Raw materials" } for steel that a manufacturing process consumes. Only for an input from OUTSIDE the model (background, library, another model); a process of this model is tagged on the process (edit_tags).'
            },
            exchanges: objArr('Several exchange edits in one call; each item takes the same fields.', {
              action: str('add | set_amount | set_formula | set_comment | remove | replace_input.'),
              new_input_code: str('Replacement dataset code (action=replace_input).'),
              new_input_database: str('Replacement dataset database (action=replace_input).'),
              activity_code: str('Activity code holding the exchange.'),
              activity_name: str('Activity name instead of the code.'),
              input_database: str("Input's database."),
              input_code: str("Input's code."),
              amount: num('Amount. Optional on "add" when a formula is given.'),
              type: str('technosphere (default) or biosphere. Biosphere flows take formulas too.'),
              uid: str('Exchange uid.'),
              formula: str('Formula expression; on "add" it also supplies the amount.'),
              comment: str('Reason for this amount/sign/proxy.'),
              tags: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description:
                  'action=add: tags of the new input, { "<tag group>": "<value>" } (inputs from outside the model only).'
              }
            })
          },
          []
        )
      }
    },
    run: async (a, ctx) => {
      const db = fgDb(a, ctx)
      if (!db) return NO_MODEL
      const routes = {
        add: 'add_exchange',
        set_amount: 'set_exchange_amount',
        set_formula: 'set_exchange_formula',
        set_comment: 'set_exchange_comment',
        remove: 'remove_exchange',
        replace_input: 'add_exchange'
      } as const

      /** Background datasets this call linked (add / replace_input), for the reminder in withLinks. */
      const linked: LinkedInput[] = []
      const noteLink = (ex: any, database: unknown, code: unknown, type: unknown): void => {
        const kind = String(ex?.type ?? type ?? 'technosphere')
        if (kind === 'biosphere' || kind === 'production') return
        const d = String(ex?.input?.database ?? database ?? '')
        const c = String(ex?.input?.code ?? code ?? '')
        if (d && c) linked.push({ name: ex?.input?.name ?? undefined, database: d, code: c })
      }

      /** Find an existing exchange's uid from its input, so the caller never has to hold one. */
      const uidOf = async (activityCode: string, it: any): Promise<string> => {
        if (typeof it.uid === 'string' && it.uid.trim()) return it.uid.trim()
        const code = typeof it.input_code === 'string' ? it.input_code.trim() : ''
        if (!code) throw new Error('Identify the exchange by "uid" or by "input_database"/"input_code".')
        const detail = await ctx.api(
          'GET',
          `/api/v1/model/activities/${encodeURIComponent(db)}/${encodeURIComponent(activityCode)}`
        )
        const hits = (detail?.exchanges ?? []).filter(
          (e: any) =>
            e?.type !== 'production' &&
            e?.input?.code === code &&
            (!it.input_database || e?.input?.database === it.input_database)
        )
        if (hits.length === 1) return hits[0].uid
        if (!hits.length) throw new Error(`No exchange on this process has input ${code}.`)
        throw new Error(
          `${hits.length} exchanges on this process have input ${code} — pass "uid" to say which ` +
            `(${hits.map((h: any) => `${h.uid}=${h.amount}`).join(', ')}).`
        )
      }

      /**
       * Which process holds an exchange, from its uid alone.
       *
       * One read of the whole foreground, memoised for the call, so a batch of ten orphaned uids
       * costs one lookup rather than ten. A miss returns undefined and the ordinary "which process?"
       * error follows — the uid may simply be stale.
       */
      let foreground: Promise<any> | null = null
      const activityOfUid = async (c: typeof ctx, database: string, uid: string) => {
        foreground ??= c.api(
          'GET',
          `/api/v1/model/activities/${encodeURIComponent(database)}?with_exchanges=true`
        )
        const acts = (await foreground) ?? []
        for (const a of Array.isArray(acts) ? acts : (acts.activities ?? []))
          if ((a?.exchanges ?? []).some((e: any) => e?.uid === uid)) return a?.code as string
        return undefined
      }

      const one = async (it: any): Promise<unknown> => {
        // A batch is ONE level deep. An item that nests its own `exchanges` array used to have that
        // array quietly dropped and was then refused for the fields it carried: a
        // solar-lamp run sent `{activity_code, action:"add", exchanges:[6 × {input_database,
        // input_code, formula, comment}]}` and got back `action="add" also requires: input_database.`
        // — true of the item and useless, because every one of the six nested entries had one. It
        // cost a round and six retyped items. Name the field that does not belong (V96's rule, one
        // level down) instead of describing a symptom of having dropped it.
        //
        // An EMPTY `exchanges: []` is a different animal and is ignored: GPT-5.6 pads every optional
        // schema field with "" / 0 / [] on every call, and rejecting the pad told it to "lift those
        // 0 entries out" — advice that, followed, changes nothing. 14 rejected calls and one
        // repeat-block in a single run (V286) until the model guessed the accepted shape.
        if (Array.isArray(it?.exchanges) && it.exchanges.length)
          throw new Error(
            'An item may not carry its own "exchanges" array — the batch array is top-level only. ' +
              `Lift those ${it.exchanges.length} entries out so each one is its own item in the ` +
              'top-level "exchanges" list; the top level then supplies activity_code and action as ' +
              'defaults for all of them.'
          )
        // An item that names an input and says what it is worth can only be an "add", and this
        // guesses so rather than refusing. It used to demand an `amount` — which refused exactly the
        // shape this tool asks for two paragraphs up, because a FORMULA *is* the amount. Measured in
        // a real run: 21 exchanges in one call, the 3 carrying a number went through and the
        // 18 carrying a formula came back as `Missing "action"`, costing a round and 9,336 characters
        // of error to say one thing.
        const action =
          String(it?.action ?? '').trim() ||
          (it?.input_code && (it?.amount !== undefined || it?.formula) ? 'add' : '')
        if (!(action in routes)) {
          throw new Error(
            action
              ? `Unknown action "${action}". Expected one of: ${Object.keys(routes).join(', ')}.`
              : `Missing "action". Expected one of: ${Object.keys(routes).join(', ')}. ` +
                `It may be passed ONCE at call level, where it applies to every item of "exchanges".`
          )
        }
        // A uid identifies an exchange on its own — `new_uid()` is a uuid4 — so being told which
        // process it sits on is a lookup, not information. Demanding it anyway cost a whole call in
        // a real run: coming out of a review that named two exchanges in two
        // different processes by uid, the model batched both without an activity and got "2 of the
        // batch failed" (V243). It split them and retried; the fix is that it never had to.
        let activityCode = it?.activity_code
        const activityName = it?.activity_name
        if (!activityCode && !activityName && typeof it?.uid === 'string' && it.uid.trim()) {
          const found = await activityOfUid(ctx, db, it.uid.trim())
          if (!found)
            throw new Error(
              `No exchange with uid "${it.uid.trim()}" in "${db}" — it may have been removed, or replaced: ` +
                'replace_input gives the exchange a NEW uid (in its answer). Read the process (get_process_details) for the current one.'
            )
          activityCode = found
        }
        const resolved = await resolveCode(
          ctx,
          db,
          { code: activityCode, name: activityName, location: it?.location },
          { code: 'activity_code', name: 'activity_name' }
        )
        if ('error' in resolved) throw new Error(resolved.error)
        const base = { activity_database: db, activity_code: resolved.code }

        if (action === 'add') {
          for (const k of ['input_database', 'input_code'] as const) {
            if (!it?.[k]) throw new Error(`action="add" also requires: ${k}.`)
          }
          // A formula IS the amount: the engine evaluates it and stores the result (params
          // .set_exchange_formula → recalculate_exchanges). Demanding a number alongside it made the
          // MODEL do that arithmetic by hand on every parameterised exchange — two truths for one
          // quantity, free to drift apart the moment either is edited.
          const hasAmount = it.amount !== undefined && it.amount !== null
          if (!hasAmount && !it.formula)
            throw new Error(
              'action="add" also requires: amount — or a formula, which is evaluated to give one.'
            )
          const made: any = await IMPL.add_exchange(
            {
              ...base,
              input_database: it.input_database,
              input_code: it.input_code,
              amount: hasAmount ? it.amount : 0,
              type: it.type,
              ...(it.tags && typeof it.tags === 'object' ? { tags: it.tags } : {})
            },
            ctx
          )
          const parsed = typeof made === 'string' ? JSON.parse(made) : made
          const uid = parsed?.exchange?.uid
          // Formula and comment in the same logical step as the link. Splitting these across calls is
          // what turned a 45-exchange model into 150 tool calls.
          let amount = hasAmount ? it.amount : 0
          // The unit the amount has to be in, plus the unit of every parameter the formula uses.
          // Computed by the backend on every formula write since V73 — and thrown away here: in one
          // run eleven formulas went through this path and the model saw it zero times.
          // `set_formula` is the only branch that ever returned it, and a caller who (as instructed)
          // links and parameterises in one call never takes that branch.
          let dimensionCheck: unknown
          if (uid && it.formula) {
            try {
              const set: any = await IMPL.set_exchange_formula({ ...base, uid, formula: it.formula }, ctx)
              const parsedSet = typeof set === 'string' ? JSON.parse(set) : set
              const ex = parsedSet?.exchange
              if (typeof ex?.amount === 'number') amount = ex.amount
              dimensionCheck = parsedSet?.exchange?.dimension_check ?? parsedSet?.dimension_check
            } catch (e) {
              // The placeholder existed only to carry the formula. A bad formula must not leave a
              // silent zero behind pretending to be a real quantity.
              if (!hasAmount && uid) await IMPL.remove_exchange({ ...base, uid }, ctx).catch(() => {})
              throw e
            }
          }
          if (uid && it.comment) await IMPL.set_exchange_comment({ ...base, uid, comment: it.comment }, ctx)
          noteLink(parsed?.exchange, it.input_database, it.input_code, it.type)
          return {
            uid,
            amount,
            formula: it.formula ?? null,
            commented: Boolean(it.comment),
            ...(dimensionCheck ? { dimension_check: dimensionCheck } : {})
          }
        }

        // Doing it twice is the same as doing it once. When nothing carries the old input any more
        // but something already carries the NEW one, this replacement has already happened, and
        // "No exchange on this process has input X" sends the caller hunting for a wrong code
        // instead of telling it the job is done. Measured in a real run: a repeated batch
        // cost two refused items and a round, on a model that was already correct.
        if (action === 'replace_input') {
          const wanted = String(it?.new_input_code ?? '').trim()
          if (!wanted) throw new Error('action="replace_input" also requires: new_input_code.')
          const before = await ctx.api(
            'GET',
            `/api/v1/model/activities/${encodeURIComponent(db)}/${encodeURIComponent(resolved.code)}`
          )
          const rows = (before?.exchanges ?? []).filter((e: any) => e?.type !== 'production')
          const oldCode = typeof it?.input_code === 'string' ? it.input_code.trim() : ''
          const stillThere = it?.uid
            ? rows.some((e: any) => e.uid === it.uid)
            : rows.some((e: any) => e?.input?.code === oldCode)
          const already = rows.find((e: any) => e?.input?.code === wanted)
          if (!stillThere && already)
            return {
              uid: already.uid,
              input_code: wanted,
              amount: already.amount,
              formula: already.formula ?? null,
              already_replaced: true,
              note: 'Already points at the new input — an earlier call did this. Nothing was changed. Use action="set_comment" if only the comment is missing.'
            }
        }

        const uid = await uidOf(resolved.code, it)

        // Swapping one background dataset for another — the commonest repair after a review — was
        // five calls: search, find the exchange, remove it, add the replacement, restore the amount.
        // Four of those carried no decision, and dropping the old link before the new one is what
        // made it risky. Add first, then remove: a failure leaves the model as it was.
        if (action === 'replace_input') {
          const newCode = String(it?.new_input_code ?? '').trim()
          if (!newCode) throw new Error('action="replace_input" also requires: new_input_code.')
          const detail = await ctx.api(
            'GET',
            `/api/v1/model/activities/${encodeURIComponent(db)}/${encodeURIComponent(resolved.code)}`
          )
          const cur = (detail?.exchanges ?? []).find((e: any) => e?.uid === uid)
          // What the exchange MEANT carries over unless the caller says otherwise; only the dataset
          // behind it changes. A replacement that silently reset the amount to 1 would be worse than
          // the five calls it replaces.
          const amount = it.amount ?? cur?.amount
          const formula = it.formula ?? cur?.formula ?? undefined
          const comment = it.comment ?? cur?.comment ?? undefined
          // The input's own tags (its life-cycle phase) belong to the input, not to the dataset behind it.
          const tags: Record<string, string> | undefined =
            Array.isArray(cur?.tags) && cur.tags.length
              ? Object.fromEntries(cur.tags.map((t: any) => [t.dimension, t.value]))
              : undefined
          if (amount === undefined || amount === null)
            throw new Error('Could not read the old amount — pass "amount" explicitly.')
          const made: any = await IMPL.add_exchange(
            {
              ...base,
              input_database: it.new_input_database ?? it.input_database ?? cur?.input?.database,
              input_code: newCode,
              amount,
              type: it.type ?? cur?.type,
              ...(tags ? { tags } : {})
            },
            ctx
          )
          const parsed = typeof made === 'string' ? JSON.parse(made) : made
          const newUid = parsed?.exchange?.uid
          let finalAmount = amount
          try {
            if (newUid && formula) {
              const set = await IMPL.set_exchange_formula({ ...base, uid: newUid, formula }, ctx)
              // The formula's own value, not the amount read before it was set.
              const parsedSet = typeof set === 'string' ? JSON.parse(set) : set
              if (typeof parsedSet?.exchange?.amount === 'number') finalAmount = parsedSet.exchange.amount
            }
            if (newUid && comment) await IMPL.set_exchange_comment({ ...base, uid: newUid, comment }, ctx)
          } catch (e) {
            // A formula the backend refuses must not leave the old AND the new input in the model:
            // the replacement is taken back out, the old one stays as it was.
            if (newUid) await IMPL.remove_exchange({ ...base, uid: newUid }, ctx).catch(() => {})
            throw e
          }
          await IMPL.remove_exchange({ ...base, uid }, ctx)
          noteLink(
            parsed?.exchange,
            it.new_input_database ?? it.input_database ?? cur?.input?.database,
            newCode,
            it.type ?? cur?.type
          )
          return {
            replaced: uid,
            uid: newUid,
            input_code: newCode,
            amount: finalAmount,
            formula: formula ?? null,
            // Same field, same meaning, same spelling as the "add" path: your comment was written.
            // The only field mentioning the comment was `carried_over.comment`,
            // which is `false` EXACTLY WHEN one was written — the opposite of how it reads next to
            // `commented: true` on the sibling action. In that run the model replaced two inputs
            // successfully, read `comment: false`, replayed the whole batch (two refused items and a
            // round, because the old inputs were gone) and then set the comments a third time.
            commented: Boolean(it.comment),
            kept_old: {
              amount: it.amount === undefined,
              formula: it.formula === undefined,
              comment: it.comment === undefined
            }
          }
        }

        if (action === 'remove') return JSON.parse(String(await IMPL.remove_exchange({ ...base, uid }, ctx)))
        /**
         * A comment handed over beside an amount or a formula used to be dropped without a word —
         * `add` accepted it in the same call and `replace_input` carried it over, but these two
         * branches passed only their own field on. A real solar-lamp run built a
         * dataset-switch scenario exactly as the skill added the day before tells you to, commented
         * the dormant exchange in the same item as `set_formula`, and the comment vanished: the
         * resting exchange still described itself as the active proxy, so the study document said
         * something untrue. Write it, and say `commented` in the same spelling as the sibling
         * actions — the answer must not leave the caller guessing which of its two instructions
         * landed.
         */
        const alsoComment = async (out: unknown): Promise<any> => {
          const parsed = JSON.parse(String(out))
          if (it.comment === undefined) return parsed
          const after = JSON.parse(
            String(await IMPL.set_exchange_comment({ ...base, uid, comment: it.comment }, ctx))
          )
          // The exchange in `out` was serialised BEFORE the comment was written, so echoing it back
          // beside `commented: true` says two contradictory things: a real apple-sauce run
          // got its four new comments stored correctly and its four OLD comments read back, in the
          // same answer that reported success. A model checking whether its text landed sees the
          // text it replaced. Take the exchange from the write that happened last.
          const exchange = after?.exchange ? { exchange: { ...parsed.exchange, ...after.exchange } } : {}
          return { ...parsed, ...exchange, commented: true }
        }
        if (action === 'set_amount') {
          if (it.amount === undefined || it.amount === null)
            throw new Error('action="set_amount" also requires: amount.')
          return alsoComment(await IMPL.set_exchange_amount({ ...base, uid, amount: it.amount }, ctx))
        }
        if (action === 'set_formula') {
          // A missing formula is not an empty one: `undefined` travelled as null and removed the
          // existing formula together with its parameter registration. Pass "" to
          // remove a formula on purpose.
          if (typeof it.formula !== 'string')
            throw new Error('action="set_formula" also requires: formula (pass "" to remove the formula).')
          return alsoComment(await IMPL.set_exchange_formula({ ...base, uid, formula: it.formula }, ctx))
        }
        return JSON.parse(String(await IMPL.set_exchange_comment({ ...base, uid, comment: it.comment }, ctx)))
      }

      const { items, ignored, inheritedDb } = expandBatch(a)
      /** What was handed over and could not be honoured — never silently. */
      const withNote = (out: string): string => {
        const note = ignoredNote(ignored)
        return trimUnitNotes(note ? S({ ...JSON.parse(out), ...note }) : out, ctx)
      }
      /** The link-time reminder (see unopenedLinks): background datasets linked here, never opened. */
      const withLinks = (out: string): string => {
        const unread = unopenedLinks(linked, db, ctx.inspected)
        if (!unread.length) return out
        try {
          return S({
            ...JSON.parse(out),
            not_yet_opened: unread.slice(0, UNOPENED_LINKS_SHOWN),
            ...(unread.length > UNOPENED_LINKS_SHOWN
              ? { not_yet_opened_more: unread.length - UNOPENED_LINKS_SHOWN }
              : {}),
            open_before_relying: openBeforeRelying(unread.length)
          })
        } catch {
          return out
        }
      }
      if (items.length === 1) {
        try {
          return withNote(withLinks(S(await one(items[0]))))
        } catch (e) {
          return withNote(S({ error: e instanceof Error ? e.message : String(e) }))
        }
      }
      const results = await Promise.all(
        items.map((it) =>
          runItem(it, () =>
            one(it).catch((e: unknown) => {
              throw explainNotFound(it, inheritedDb, e)
            })
          )
        )
      )
      return withNote(withLinks(batchResult(results)))
    }
  }
]
