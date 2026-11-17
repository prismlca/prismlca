/** Tag dimensions and assignments. */
// Split out of the monolithic tools.ts. Spec and run stay together on purpose:
// the prose description and the handler are edited as a pair, and the description guard in
// tools.test.ts scans spec text against implementation names.

import type { Tool } from '../context'
import { obj, str } from '../schema'
import { AI, S, batchResult, runItem } from '../format'
import { delegate } from '../impl'

/**
 * A model's tag groups as `list_tags` returns them: name, colour, the values in the model's order, and
 * `unused` — the values no process or input of the model carries — where there are any.
 *
 * A group belongs to one model, so this is the model's own vocabulary and nothing of its neighbours':
 * what another study called its parts is no suggestion for this one, and the names of other studies do
 * not reach the chat this way (V492).
 */
export function tagGroupsOf(body: unknown): unknown[] {
  const groups = (body as { groups?: unknown })?.groups
  if (!Array.isArray(groups)) return []
  return groups.map((g) => {
    const {
      used: _used,
      unused,
      ...group
    } = (g ?? {}) as { used?: unknown; unused?: unknown } & Record<string, unknown>
    return { ...group, ...(Array.isArray(unused) && unused.length ? { unused } : {}) }
  })
}

const groupsRoute = (database: string): string =>
  `/api/v1/model/tag-groups?database=${encodeURIComponent(database)}`

export const tagsTools: Tool[] = [
  {
    spec: {
      type: 'function',
      function: {
        name: 'list_tags',
        description:
          "List this model's tag groups (dimensions) with their values, or one activity's assigned tags. Tag groups belong to a model; pass database alone to read another model's groups (a comparison model). \"unused\" names the values no process of the model carries.",
        parameters: obj({
          database: str(
            "Optional. Alone: the model whose tag groups to list (default: this model). With code: that activity's tags."
          ),
          code: str('Optional activity code.')
        })
      }
    },
    run: async (a, ctx) => {
      if (a.database && a.code) {
        const tags = await ctx.api(
          'GET',
          `/api/v1/model/tags/${encodeURIComponent(a.database)}/${encodeURIComponent(a.code)}`
        )
        // The groups beside it are this model's: the activity may be a background dataset, which has none.
        const own = ctx.activeDb ? tagGroupsOf(await ctx.api('GET', groupsRoute(ctx.activeDb))) : []
        return S({ groups: own, activity_tags: tags })
      }
      const database = a.database ? String(a.database) : ctx.activeDb
      if (!database) return S({ error: 'No model is open. Tag groups belong to a model — open one first.' })
      return S({ groups: tagGroupsOf(await ctx.api('GET', groupsRoute(database))) })
    }
  },
  {
    spec: {
      type: 'function',
      function: {
        name: 'edit_tags',
        description:
          'Manage this model\'s tag groups and assign tags. Tag groups belong to the model; other models keep their own. action="create_group" creates a dimension (name); "add_value" adds an allowed value to a group (group, value); "assign" tags processes (keys, group, value — omit value to clear); "merge_value" folds one value of a group into another (group, value, into — every process carrying it is retagged, the old value disappears from the group); "merge_group" folds one dimension into another (name, into — its values and tags move). Merging is how a vocabulary that grew four spellings of one phase ("Use", "Use Phase", "Usage Phase") is cleaned up without untagging anything; there is deliberately no delete — a value no process carries is removed in the Tags window. Tagging a whole model by life-cycle phase is ONE call: pass "assignments", a list of { keys, value } (the values are created if the group allows them), instead of one assign per phase. Tags drive the per-phase result breakdowns. Assigning and merging are undoable; a created group or value stays.',
        parameters: obj(
          {
            action: str('One of: create_group | add_value | assign | merge_value | merge_group.'),
            name: str('Tag-group name (action=create_group; the group to fold away on merge_group).'),
            group: str(
              'Tag group / dimension (action=add_value/assign/merge_value, and the default group for "assignments").'
            ),
            value: str('Tag value (action=add_value/assign/merge_value; omit on assign to clear).'),
            into: str('The value (merge_value) or group (merge_group) that absorbs the other.'),
            database: str(
              'The model whose tag groups to change (action=create_group/add_value/merge_value/merge_group). Default: this model.'
            ),
            keys: {
              type: 'array',
              description:
                'A list of what to tag (action=assign): processes { database, code } and/or INPUTS of a process { uid } — the exchange uid from get_model_graph or get_process_details. Tag an input when it belongs to another phase than the process consuming it: steel consumed by a manufacturing process counts as "Raw materials" while the process counts as "Production". Only inputs from outside the model (background, library, another model) can be tagged; a process of this model and a background dataset itself are refused.',
              items: obj(
                {
                  database: str('Database of the process (or of the model holding the input).'),
                  code: str('Process code.'),
                  uid: str('Exchange uid of an input, instead of database/code.')
                },
                []
              )
            },
            assignments: {
              type: 'array',
              description:
                'Several assignments in one call — each { keys, value, group? }. Use this whenever processes get DIFFERENT values of the same dimension (one per life-cycle phase); "keys" alone only batches processes that share one value. Missing values are added to the group automatically.',
              items: obj(
                {
                  keys: {
                    type: 'array',
                    description: 'Processes { database, code } or inputs { uid } for this value.',
                    items: obj(
                      {
                        database: str('Database of the process.'),
                        code: str('Process code.'),
                        uid: str('Exchange uid of an input, instead of database/code.')
                      },
                      []
                    )
                  },
                  value: str('Tag value for these processes; omit to clear.'),
                  group: str('Tag group, if it differs from the top-level "group".')
                },
                ['keys']
              )
            }
          },
          []
        )
      }
    },
    run: async (a, ctx) => {
      const list: any[] = Array.isArray(a.assignments) ? a.assignments : []
      if (!list.length)
        return delegate(
          {
            create_group: 'create_tag_group',
            add_value: 'add_tag_value',
            assign: 'set_tag',
            merge_value: 'merge_tag_value',
            merge_group: 'merge_tag_group'
          },
          a,
          ctx,
          {
            create_group: ['name'],
            add_value: ['group', 'value'],
            assign: ['keys', 'group'],
            merge_value: ['group', 'value', 'into'],
            merge_group: ['name', 'into']
          }
        )
      // One call per (group, value) was the single biggest source of pure call overhead in the Kimi
      // practice run: six processes, six phases, six identical round-trips carrying no decision.
      const results: Array<{ ok: boolean; item: unknown; result?: unknown; error?: string }> = []
      for (const item of list) {
        const group = String(item?.group ?? a.group ?? '')
        if (!group) {
          results.push({
            ok: false,
            item,
            error: 'No tag group — pass "group" on the item or at the top level.'
          })
          continue
        }
        if (!Array.isArray(item?.keys) || !item.keys.length) {
          results.push({ ok: false, item, error: 'No processes — each assignment needs a non-empty "keys".' })
          continue
        }
        results.push(
          // The assignment registers its group and its value in the model of each key, so a phase list
          // can be written before the vocabulary exists and nothing has to be added first.
          await runItem(item, () =>
            ctx.api('POST', '/api/v1/model/tags/set', {
              keys: item.keys,
              group,
              value: item.value ?? null,
              ...AI
            })
          )
        )
      }
      return batchResult(results)
    }
  }
]
