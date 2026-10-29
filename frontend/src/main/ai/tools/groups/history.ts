/** Health check, audit trail, undo/redo, and the last-result lookup table. */
// Split out of the monolithic tools.ts. Spec and run stay together on purpose:
// the prose description and the handler are edited as a pair, and the description guard in
// tools.test.ts scans spec text against implementation names.

import type { Tool } from '../context'
import { obj, str } from '../schema'
import { S } from '../format'
import { delegate } from '../impl'

export const historyTools: Tool[] = [
  {
    spec: {
      type: 'function',
      function: {
        name: 'check_model_health',
        description:
          'Run the structural model-health linter on a foreground model: missing units, unlinked/orphaned references, circular links, duplicate flows, missing reference products, mass balance and unit dimensions. Use after building/changing a model to verify it is sound. The answer lists "checks_run", so a quiet result can be read as "checked and fine" rather than "not checked".',
        parameters: obj({ database: str('Foreground model name; omit for the model open on the canvas.') })
      }
    },
    run: async (a, ctx) => {
      // Defaults to the open model like almost every other tool. Requiring it here was an odd one
      // out that cost a round whenever the model looked the name up first to be safe.
      const db = a.database || ctx.activeDb
      if (!db) return S({ error: 'No model is open — pass "database" or open a model first.' })
      return S(await ctx.api('GET', `/api/v1/model/health/${encodeURIComponent(db)}`))
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'get_audit',
        description:
          'Recent audit-log entries (who/what changed, incl. AI actions) and undo/redo availability.',
        parameters: obj({})
      }
    },
    run: async (_a, ctx) => {
      // The session's model, like `history`: unscoped, this reported can_undo for a step in another
      // model that the scoped undo then refused.
      const q = ctx.activeDb ? `?database=${encodeURIComponent(ctx.activeDb)}` : ''
      const [audit, history] = await Promise.all([
        ctx.api('GET', `/api/v1/model/audit${q}`),
        ctx.api('GET', `/api/v1/model/history${q}`)
      ])
      const list = Array.isArray(audit) ? audit.slice(-25) : audit
      return S({ audit: list, history })
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'history',
        description:
          'Undo or redo the last model change (processes, exchanges, tags, parameters, scenarios) of the model this session works on — a newest change in another model is refused and named, never taken back. Model-level operations (create/rename/delete a model) and custom LCIA methods are NOT undoable. action="undo" | "redo".',
        parameters: obj({ action: str('One of: undo | redo.') }, ['action'])
      }
    },
    run: async (a, ctx) => {
      const out = await delegate({ undo: 'undo', redo: 'redo' }, a, ctx)
      // The engine's summary describes the change as it was MADE ("name (now 'X')"); after an undo
      // that reads as the current state. Say which way the model moved.
      try {
        const r = JSON.parse(String(out))
        if (r && typeof r === 'object' && ('undone' in r || 'redone' in r))
          return S({
            ...r,
            note:
              'undone' in r
                ? 'The change described is taken back: the model is as it was BEFORE it.'
                : 'The change described is applied again.'
          })
      } catch {
        /* not JSON — hand it on as it is */
      }
      return out
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'lookup',
        description:
          'Look something up that you need in order to work. kind="geographies" lists the regions present in a database (needs database) with their plain names (RER = Europe, GLO = global, RoW = rest of world) and whether each is an aggregate region or a country — use them to filter searches, and pass "query" to find a region by name ("europe" finds RER); kind="classification" looks up valid ISIC sections and CPC classes (optional query) for set_classification; kind="source" reads a file the user attached to this conversation (needs source: the id printed with the file). Read the file whenever you are asked what it says and its content is no longer in front of you — never answer about an attachment from memory.',
        parameters: obj(
          {
            kind: str('One of: geographies | classification | source.'),
            database: str('Database name (kind=geographies).'),
            query: str('Optional filter on code or name (kind=geographies, kind=classification).'),
            source: str(
              'The attachment id printed with the file, e.g. "3f9c1a2b4d5e-spec.pdf" (kind=source).'
            ),
            pages: str(
              'Optional, PDFs only: narrows the read to those pages, e.g. "12" or "12-14" or "1,4,9-11". Omit it to read the whole file — narrowing is cheaper when you already know where to look, never a condition for reading (kind=source).'
            ),
            sheet: str(
              'Optional, spreadsheets only: narrows the read to one sheet by name; omit for all of them (kind=source).'
            )
          },
          ['kind']
        )
      }
    },
    run: async (a, ctx) =>
      delegate(
        { geographies: 'list_geographies', classification: 'lookup_classification', source: 'read_source' },
        { ...a, action: a.kind },
        ctx,
        {
          geographies: ['database'],
          source: ['source']
        }
      )
  }
]
