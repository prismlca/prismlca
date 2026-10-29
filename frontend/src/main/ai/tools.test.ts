import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withUnknownFields } from './agent'
import { UNOPENED_LINKS_SHOWN } from './tools/advice/hotspots'
import {
  MUTATING_TOOLS,
  TOOL_BY_NAME,
  TOOLS,
  groupsForConversation,
  toolCatalog,
  toolSpecs,
  NON_TOOL_IMPL_NAMES,
  RESEARCH_CAP_PHRASE,
  inspectedKey,
  unopenedLinkedHotspots,
  trimUnitNotes,
  type ToolCtx
} from './tools'

/**
 * Structural guard rails for the tool catalog. These are cheap, offline and deterministic — they
 * catch the class of mistakes that silently degrades the assistant: a schema the provider rejects,
 * a `required` field that does not exist, a tool missing from the Settings catalog (it then shows up
 * as a raw technical name under "Other"), or a stale entry in MUTATING_TOOLS so the canvas no longer
 * reloads after an edit.
 */
describe('tool specs', () => {
  it('are non-empty, uniquely named, and stay a manageable surface', () => {
    // Tool-selection accuracy degrades well before 70 tools (OpenAI recommends far under 20, Cursor
    // caps at 40, RAG-MCP measures 13.6% → 43.1% when the visible set shrinks). This ceiling is a
    // tripwire: adding capability should mean extending a consolidated tool, not adding a new one.
    // 51 once: raised by exactly one for `distances` — the first tool reaching
    // an external non-LLM service, ONE tool for all four transport modes, and hidden entirely
    // (spec and system prompt) whenever the feature is off, so most chats still see 50.
    // 52 for `eurostat_eol`, on the same terms: ONE tool for four Eurostat tables, and
    // gone (spec and prompt) when the chat or the app switches it off.
    // 53 for `plan`: a tool without a backend that the chat loop itself needs —
    // not foldable into an existing one, because no other tool carries run state — hidden (spec and
    // prompt) for every model whose catalogue row says `planTool: false`, and never offered over MCP.
    expect(TOOLS.length).toBeGreaterThan(25)
    expect(TOOLS.length).toBeLessThanOrEqual(53)
    const names = TOOLS.map((t) => t.spec.function.name)
    expect(new Set(names).size).toBe(names.length)
    expect(Object.keys(TOOL_BY_NAME).length).toBe(TOOLS.length)
  })

  it('use the OpenAI function shape with snake_case names and a described purpose', () => {
    for (const t of TOOLS) {
      const f = t.spec.function
      expect(t.spec.type, f.name).toBe('function')
      expect(f.name, f.name).toMatch(/^[a-z][a-z0-9_]*$/)
      // Long enough to actually steer the model towards/away from the tool.
      expect(f.description.length, f.name).toBeGreaterThan(30)
      expect(typeof t.run, f.name).toBe('function')
    }
  })

  it('declare object parameter schemas whose required keys exist', () => {
    for (const t of TOOLS) {
      const f = t.spec.function
      const p = f.parameters as { type?: string; properties?: Record<string, unknown>; required?: string[] }
      expect(p.type, f.name).toBe('object')
      expect(typeof p.properties, f.name).toBe('object')
      for (const key of p.required ?? []) {
        expect(Object.keys(p.properties ?? {}), `${f.name}.${key}`).toContain(key)
      }
    }
  })

  it('keep MUTATING_TOOLS in sync with real tool names', () => {
    const names = new Set(TOOLS.map((t) => t.spec.function.name))
    for (const n of MUTATING_TOOLS) expect(names, n).toContain(n)
  })

  it('give every tool a catalog entry (label + group) for Settings → AI-Tools', () => {
    const ungrouped = toolCatalog().filter((e) => e.group === 'Other' || e.label === e.name)
    expect(ungrouped.map((e) => e.name)).toEqual([])
    for (const e of toolCatalog()) expect(e.hint.length, e.name).toBeGreaterThan(10)
  })
})

describe('consolidated tools', () => {
  /** Record which endpoint a tool hits, so we can assert the action actually routes. */
  function spy(): { calls: Array<{ method: string; path: string; body?: unknown }>; ctx: ToolCtx } {
    const calls: Array<{ method: string; path: string; body?: unknown }> = []
    return {
      calls,
      ctx: {
        api: async (method, path, body) => {
          calls.push({ method, path, body })
          return { ok: true }
        },
        ui: async () => ({ ok: true }),
        activeDb: 'demo-model'
      }
    }
  }

  const run = async (
    tool: string,
    args: Record<string, unknown>
  ): Promise<{ calls: Array<{ path: string; body?: unknown }>; out: unknown }> => {
    const s = spy()
    const out = await TOOL_BY_NAME[tool].run(args, s.ctx)
    return { calls: s.calls, out }
  }

  it('scores several indicators with ONE compare request (V331)', async () => {
    // The per-indicator fan-out applied every scenario once per indicator — 64 factorisations for 16
    // indicators × 4 subjects, 187 s and 226 s in a real run. The endpoint takes `methods` now.
    const s = spy()
    s.ctx.api = async (method, path, body) => {
      s.calls.push({ method, path, body })
      return {
        results: [
          { method: ['a'], results: [] },
          { method: ['b'], results: [] }
        ]
      }
    }
    const out = JSON.parse(
      String(
        await TOOL_BY_NAME.compare_scenarios.run(
          { code: 'x', scenario_ids: ['s1'], methods: [['a'], ['b']] },
          s.ctx
        )
      )
    )
    expect(s.calls).toHaveLength(1)
    expect((s.calls[0].body as any).methods).toEqual([['a'], ['b']])
    expect(out.total).toBe(2)
    expect(out.results[1].result.method).toEqual(['b'])
  })

  it('answers a parameter write with the parameter it wrote', async () => {
    // The endpoint replies with the model's WHOLE parameter list, which the Parameters page discards
    // and reloads for itself. Only the assistant is charged for it — and a batch fans out to one call
    // per parameter, so setting sixteen returned 1+2+...+16 = 136 records in a single 35k tool result,
    // then paid for all of it again on every later round.
    const whole = {
      parameters: [
        { name: 'volume_ml', amount: 250, unit: 'ml', description: 'a' },
        { name: 'mass_kg', amount: 0.26, formula: 'volume_ml / 1000', unit: 'kg', description: 'b' },
        { name: 'dose_kg', amount: 0.01, unit: 'kg', description: 'c' }
      ]
    }
    const ctx = {
      api: async () => whole,
      ui: async () => ({ ok: true }),
      activeDb: 'demo-model'
    } as unknown as ToolCtx
    const out = JSON.parse(
      String(
        await TOOL_BY_NAME['edit_parameter'].run(
          { action: 'set', name: 'mass_kg', formula: 'volume_ml / 1000' },
          ctx
        )
      )
    )
    expect(out).toEqual({ parameter: whole.parameters[1] })
  })

  it('hands back whatever it got when the write did not name a parameter', async () => {
    // A refusal or an unexpected shape must reach the model intact — swallowing it would leave the
    // assistant believing a write succeeded.
    const refusal = { error: 'The formula computes 1.4 for "share", which is above 1.' }
    const ctx = {
      api: async () => refusal,
      ui: async () => ({ ok: true }),
      activeDb: 'demo-model'
    } as unknown as ToolCtx
    const out = JSON.parse(
      String(await TOOL_BY_NAME['edit_parameter'].run({ action: 'set', name: 'share', value: 1.4 }, ctx))
    )
    expect(out).toEqual(refusal)
  })

  it('lets a batch name its process once, at the top', async () => {
    // The failure this fixes, from a real run: nine exchanges for one process, `activity_code` written
    // once at the top — and a batch took *only* the items, so every one of them failed for want of a
    // process. Two rounds and 18 refused items before the model gave up and repeated the code per row.
    const calls: Array<{ path: string; body: any }> = []
    const ctx = {
      api: async (_m: string, path: string, body: any) => {
        calls.push({ path, body })
        return { exchange: { uid: 'u-' + calls.length } }
      },
      ui: async () => ({ ok: true }),
      activeDb: 'demo-model'
    } as unknown as ToolCtx

    const out = JSON.parse(
      String(
        await TOOL_BY_NAME['edit_exchange'].run(
          {
            activity_code: 'proc-1',
            action: 'add',
            input_database: 'ecoinvent-3.12-cutoff',
            exchanges: [
              { input_code: 'water', amount: 0.73 },
              { input_code: 'sles', amount: 0.13 }
            ]
          },
          ctx
        )
      )
    )
    expect(out.failed).toBe(0)
    expect(out.succeeded).toBe(2)
    // Both landed on the process named once, with the database named once.
    const adds = calls.filter((c) => c.path === '/api/v1/model/exchanges')
    expect(adds.map((c) => c.body.activity_code)).toEqual(['proc-1', 'proc-1'])
    expect(adds.map((c) => c.body.input_database)).toEqual(['ecoinvent-3.12-cutoff', 'ecoinvent-3.12-cutoff'])
    expect(adds.map((c) => c.body.input_code)).toEqual(['water', 'sles'])
  })

  it('lets an item override what the batch said', async () => {
    const calls: Array<{ path: string; body: any }> = []
    const ctx = {
      api: async (_m: string, path: string, body: any) => {
        calls.push({ path, body })
        return { exchange: { uid: 'u' } }
      },
      ui: async () => ({ ok: true }),
      activeDb: 'demo-model'
    } as unknown as ToolCtx

    await TOOL_BY_NAME['edit_exchange'].run(
      {
        activity_code: 'proc-1',
        action: 'add',
        input_database: 'ecoinvent-3.12-cutoff',
        exchanges: [
          { input_code: 'water', amount: 1 },
          // Its own process and its own database: a batch-wide default must not overrule what an
          // item says about itself.
          { activity_code: 'proc-2', input_database: 'demo-model', input_code: 'sub', amount: 2 }
        ]
      },
      ctx
    )
    const adds = calls.filter((c) => c.path === '/api/v1/model/exchanges')
    expect(adds.map((c) => c.body.activity_code)).toEqual(['proc-1', 'proc-2'])
    expect(adds.map((c) => c.body.input_database)).toEqual(['ecoinvent-3.12-cutoff', 'demo-model'])
  })

  it('says what a batch-wide value could not be applied to, rather than swallowing it', async () => {
    // A run in practice wrote a batch-level comment beside per-item ones, and those calls worked —
    // because the field was ignored. Refusing them now would break a working pattern to fix a broken
    // one, so the batch goes through and the answer names what did not apply. Spreading it would be
    // worse still: one "why this amount" sentence attached to every amount.
    const ctx = {
      api: async () => ({ exchange: { uid: 'u' } }),
      ui: async () => ({ ok: true }),
      activeDb: 'demo-model'
    } as unknown as ToolCtx

    const out = JSON.parse(
      String(
        await TOOL_BY_NAME['edit_exchange'].run(
          {
            activity_code: 'proc-1',
            action: 'add',
            comment: 'PET body replaced with bottle-grade granulate',
            exchanges: [
              { input_database: 'ecoinvent-3.12-cutoff', input_code: 'a', amount: 1 },
              { input_database: 'ecoinvent-3.12-cutoff', input_code: 'b', amount: 2 }
            ]
          },
          ctx
        )
      )
    )
    expect(out.succeeded).toBe(2)
    expect(out.not_applied).toEqual(['comment'])
    expect(out.hint).toContain('"comment"')
    expect(out.hint).toContain('activity_code') // it names what may sit at the top
  })

  it('names the arguments this tool actually has when the process is unidentified', async () => {
    // It used to answer "Pass either \"code\" or \"name\"" — two parameters `edit_exchange` does not
    // have. The model retried with the words it was given and failed again.
    const ctx = {
      api: async () => [],
      ui: async () => ({ ok: true }),
      activeDb: 'demo-model'
    } as unknown as ToolCtx
    const out = JSON.parse(
      String(
        await TOOL_BY_NAME['edit_exchange'].run(
          { action: 'add', input_database: 'x', input_code: 'y', amount: 1 },
          ctx
        )
      )
    )
    expect(out.error).toContain('activity_code')
    expect(out.error).toContain('activity_name')
    expect(out.error).not.toContain('"code"')
  })

  it('routes each action to its own endpoint', async () => {
    expect((await run('edit_scenario', { action: 'create', name: 'high' })).calls[0].path).toBe(
      '/api/v1/scenarios'
    )
    expect((await run('edit_scenario', { action: 'delete', id: 'x' })).calls[0].path).toBe(
      '/api/v1/scenarios/delete'
    )
    expect((await run('edit_parameter', { action: 'set', name: 'mass', value: 1 })).calls[0].path).toBe(
      '/api/v1/params'
    )
    expect((await run('edit_parameter', { action: 'delete', name: 'mass' })).calls[0].path).toBe(
      '/api/v1/params/delete'
    )
    expect(
      (await run('edit_exchange', { action: 'remove', activity_database: 'd', activity_code: 'c', uid: 'u' }))
        .calls[0].path
    ).toBe('/api/v1/model/exchanges/remove')
    expect((await run('history', { action: 'undo' })).calls[0].path).toBe('/api/v1/model/undo')
    expect((await run('manage_model', { action: 'rename', database: 'a', name: 'b' })).calls[0].path).toBe(
      '/api/v1/databases/foreground/rename'
    )
    expect(
      (await run('edit_lcia_method', { action: 'set_factor', method: ['m'], ref: 1, cf: 2 })).calls[0].path
    ).toBe('/api/v1/lcia/factor')
    expect((await run('manage_method_family', { action: 'upsert', family: 'Mine' })).calls[0].path).toBe(
      '/api/v1/lcia/family'
    )
  })

  it('finds the process a uid sits on, so a review-driven batch needs no activity_code', async () => {
    // V243: coming out of a review that named two exchanges in two different processes BY UID, the
    // model batched both without an activity and got "2 of the batch failed". A uid is a uuid4 and
    // identifies the exchange on its own, so the process is a lookup — one read of the foreground,
    // shared by the whole batch.
    const calls: Array<{ method: string; path: string; body?: any }> = []
    const ctx = {
      api: async (method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body })
        if (path.includes('with_exchanges'))
          return [
            { code: 'A', name: 'first', exchanges: [{ uid: 'u1' }] },
            { code: 'B', name: 'second', exchanges: [{ uid: 'u2' }] }
          ]
        return { ok: true }
      },
      ui: async () => ({ ok: true }),
      activeDb: 'demo-model'
    } as any

    await TOOL_BY_NAME.edit_exchange.run(
      {
        exchanges: [
          { action: 'set_comment', uid: 'u1', comment: 'first' },
          { action: 'remove', uid: 'u2' }
        ]
      },
      ctx
    )
    const writes = calls.filter((c) => c.method === 'POST')
    expect(writes.map((c) => c.body.activity_code)).toEqual(['A', 'B'])
    // …and the foreground is read once for the whole batch, not once per orphaned item.
    expect(calls.filter((c) => c.path.includes('with_exchanges'))).toHaveLength(1)
  })

  it('names the uid that matches nothing, and the way it goes stale', async () => {
    // It used to ask for activity_code/activity_name — true of the call, useless for a uid that
    // replace_input had just renewed (seen with an external MCP agent).
    const ctx = {
      api: async (_m: string, path: string) => (path.includes('with_exchanges') ? [] : { ok: true }),
      ui: async () => ({ ok: true }),
      activeDb: 'demo-model'
    } as any
    const out = (await TOOL_BY_NAME.edit_exchange.run({ action: 'remove', uid: 'gone' }, ctx)) as string
    expect(out).toMatch(/No exchange with uid \\"gone\\" in \\"demo-model\\"/)
    expect(out).toMatch(/replace_input gives the exchange a NEW uid/)
  })

  it('accepts the mode/kind aliases used instead of action', async () => {
    expect((await run('explain_result', { mode: 'flows', database: 'd', code: 'c' })).calls[0].path).toBe(
      '/api/v1/calc/elementary-flows'
    )
    expect((await run('lookup', { kind: 'geographies', database: 'd' })).calls[0].path).toContain(
      '/api/v1/search/geographies/'
    )
  })

  it('still tags mutations as AI so they stay undoable and audited', async () => {
    const { calls } = await run('edit_exchange', {
      action: 'add',
      activity_database: 'd',
      activity_code: 'c',
      input_database: 'i',
      input_code: 'k',
      amount: 1
    })
    expect((calls[0].body as { source?: string }).source).toBe('ai')
  })

  it('reports an unknown action instead of throwing', async () => {
    const { out, calls } = await run('edit_scenario', { action: 'frobnicate' })
    expect(calls).toEqual([])
    expect(String(out)).toContain('Unknown action')
    expect(String(out)).toContain('create')
  })

  // A live eval caught a model calling manage_method_family with the wrong field name twelve times
  // in a row: the API answered "HTTP 422", which told it nothing, so it kept retrying. Per-action
  // required arguments have to be named back to the model BEFORE the request goes out.
  it('names the missing per-action argument instead of letting the API answer 422', async () => {
    const { out, calls } = await run('manage_method_family', { action: 'rename', family: 'Mine' })
    expect(calls).toEqual([]) // never reached the backend
    expect(String(out)).toContain('name')
    expect(String(out)).toContain('rename')

    const dup = await run('manage_model', { action: 'duplicate', name: 'copy' })
    expect(dup.calls).toEqual([])
    expect(String(dup.out)).toContain('source')

    const ex = await run('edit_exchange', {
      action: 'set_amount',
      activity_database: 'd',
      activity_code: 'c',
      amount: 1
    })
    expect(ex.calls).toEqual([])
    expect(String(ex.out)).toContain('uid')
  })

  it('accepts an empty formula (detach) and a zero amount as present', async () => {
    const detach = await run('edit_exchange', {
      action: 'set_formula',
      activity_database: 'd',
      activity_code: 'c',
      uid: 'u',
      formula: ''
    })
    expect(detach.calls.length).toBe(1)
    const zero = await run('edit_exchange', {
      action: 'set_amount',
      activity_database: 'd',
      activity_code: 'c',
      uid: 'u',
      amount: 0
    })
    expect(zero.calls.length).toBe(1)
  })

  it('renames a family from `family` as well as the endpoint-shaped `old`', async () => {
    const viaFamily = await run('manage_method_family', { action: 'rename', family: 'Old', name: 'New' })
    expect((viaFamily.calls[0].body as { old?: string }).old).toBe('Old')
    const viaOld = await run('manage_method_family', {
      action: 'rename',
      family: 'ignored',
      old: 'Old',
      name: 'New'
    })
    expect((viaOld.calls[0].body as { old?: string }).old).toBe('Old')
  })
})

describe('groupsForConversation', () => {
  it('always includes the core groups, even for an empty conversation', () => {
    const g = groupsForConversation([])
    for (const core of ['Read & search', 'Calculate', 'History', 'Canvas & UI']) expect(g).toContain(core)
    expect(g.has('LCIA methods')).toBe(false)
  })

  it('unlocks a group from either language', () => {
    expect(groupsForConversation(['build a scenario for high recycling'])).toContain('Scenarios')
    expect(groupsForConversation(['ein Szenario mit hoher Recyclingquote'])).toContain('Scenarios')
    expect(groupsForConversation(['what characterization factor does EF give methane?'])).toContain(
      'LCIA methods'
    )
    expect(groupsForConversation(['tag the processes by life-cycle phase'])).toContain('Tags')
    expect(groupsForConversation(['research the bill of materials'])).toContain('Research')
  })

  it('grows with the conversation instead of being re-picked per turn', () => {
    // Stability matters: the tool list is part of the cached prompt prefix, so it must only ever add.
    const first = groupsForConversation(['add a process'])
    const later = groupsForConversation(['add a process', 'now compare two scenarios'])
    for (const g of first) expect(later).toContain(g)
    expect(later.size).toBeGreaterThan(first.size)
  })
})

describe('toolSpecs filtering', () => {
  it('hides the screenshot tool from models that cannot see images', () => {
    const withVision = toolSpecs(true).map((s) => s.function.name)
    const without = toolSpecs(false).map((s) => s.function.name)
    expect(withVision).toContain('screenshot_canvas')
    expect(without).not.toContain('screenshot_canvas')
    expect(without.length).toBe(withVision.length - 1)
  })

  it('never offers tools the user switched off', () => {
    const off = new Set(['calculate', 'delete_process'])
    const names = toolSpecs(true, off).map((s) => s.function.name)
    expect(names).not.toContain('calculate')
    expect(names).not.toContain('delete_process')
    expect(names).toContain('list_models')
  })

  it('can focus on a subset of groups without ever dropping the core ones', () => {
    const groups = groupsForConversation(['Add a parameter mass = 2 kg to this model'])
    const focused = toolSpecs(true, undefined, groups).map((s) => s.function.name)

    expect(focused.length).toBeLessThan(toolSpecs(true).length) // the point of focusing
    expect(focused).toContain('edit_parameter') // the topic's own group
    expect(focused).toContain('list_models') // core: reading is always available
    expect(focused).toContain('calculate') // core
    expect(focused).toContain('history') // core: undo must never be unavailable
    expect(focused).toContain('ask_user')
    expect(focused).not.toContain('edit_lcia_method') // nothing hinted at LCIA methods
  })

  it('ignores unknown names in the disabled set (stale localStorage entries)', () => {
    const names = toolSpecs(true, new Set(['no_such_tool_v1'])).map((s) => s.function.name)
    expect(names.length).toBe(toolSpecs(true).length)
  })
})

/**
 * The critic is deliberately NOT an agent with its own tools: the dossier is gathered here, so a
 * review costs one predictable model pass and every finding is anchored to a figure we handed over.
 * What must hold is that the evidence is actually collected — and that a missing part is declared
 * instead of quietly making an incomplete picture look complete.
 */
describe('review_model', () => {
  const dossierFor = async (
    args: Record<string, unknown>,
    failing: string[] = []
  ): Promise<{ dossier: string; paths: string[]; out: any }> => {
    const paths: string[] = []
    let dossier = ''
    const ctx: ToolCtx = {
      api: async (_m, path) => {
        paths.push(path)
        if (failing.some((f) => path.includes(f))) throw new Error('backend exploded')
        if (path.startsWith('/api/v1/study')) return { goal: 'compare bottles', functional_unit: '1 l' }
        return { ok: true }
      },
      ui: async () => ({ ok: true }),
      activeDb: 'demo-model',
      review: async (o) => {
        dossier = o.dossier
        return {
          text: 'Blocking: nothing quotable.',
          outcome: 'ok' as const,
          reasoning_chars: 0,
          attempts: 1,
          ms: 1
        }
      }
    }
    const out = JSON.parse((await TOOL_BY_NAME.review_model.run(args, ctx)) as string)
    return { dossier, paths, out }
  }

  it('collects health, processes, goal & scope and hotspots into one dossier', async () => {
    const { dossier, paths, out } = await dossierFor({ code: 'c1', method: ['IPCC', 'GWP100'] })
    expect(paths.some((p) => p.includes('/model/health/'))).toBe(true)
    expect(paths.some((p) => p.includes('/model/activities/'))).toBe(true)
    expect(paths.some((p) => p.startsWith('/api/v1/study'))).toBe(true)
    expect(paths).toContain('/api/v1/calc/contribution')
    expect(dossier).toContain('GOAL & SCOPE')
    expect(dossier).toContain('compare bottles')
    expect(out.review).toContain('Blocking')
    expect(out.gaps).toEqual([])
  })

  it('names the missing hotspot analysis when no code/method is given', async () => {
    const { dossier, paths, out } = await dossierFor({})
    expect(paths).not.toContain('/api/v1/calc/contribution')
    expect(dossier).toContain('not analysed')
    expect(out.gaps.join(' ')).toContain('hotspots')
  })

  it('survives a failing part and declares it as a gap', async () => {
    const { dossier, out } = await dossierFor({ code: 'c1', method: ['m'] }, ['/model/health/'])
    expect(out.gaps.join(' ')).toContain('health check')
    expect(dossier).toContain('GAPS IN THIS DOSSIER')
    expect(out.review).toContain('Blocking') // the review still happened
  })

  it('quotes what the biggest datasets say about themselves — read or not', async () => {
    // The reviewer cannot look anything up. "Never opened" (below) tells it that nobody read a
    // dataset; this hands it the text itself — the sentence that names the laptop inside the garden
    // lamp. It must appear even when the dataset WAS opened, because reading a comment and drawing
    // the conclusion are different acts (one real run read the binder market and still missed
    // the pigment).
    const tree = {
      db: 'demo-model',
      c: 'fu',
      n: 'FU',
      shr: 1,
      ch: [{ db: 'ei', c: 'batt', n: 'market for battery, NiMH, rechargeable', shr: 0.41, ch: [] }]
    }
    let dossier = ''
    const ctx: ToolCtx = {
      api: async (_m, path) => {
        if (path === '/api/v1/calc/contribution') return { tree }
        if (path.includes('/model/activities/ei/batt'))
          return {
            activity: {
              name: 'market for battery, NiMH, rechargeable',
              comment: 'Each market represents the consumption mix of a product.',
              main_supplier_comment: {
                name: 'battery production, NiMH, rechargeable',
                location: 'GLO',
                share: 1,
                comment:
                  'This dataset represents the production of 1 kg of a NiMH battery for laptop ' +
                  'applications … as used in a Fujitsu-Siemens laptop, model: C4135.'
              }
            }
          }
        if (path.startsWith('/api/v1/study')) return {}
        return { ok: true }
      },
      ui: async () => ({}),
      activeDb: 'demo-model',
      inspected: new Set([inspectedKey('ei', 'batt')]),
      review: async (o) => {
        dossier = o.dossier
        return { text: 'ok', outcome: 'ok' as const, reasoning_chars: 0, attempts: 1, ms: 1 }
      }
    }
    await TOOL_BY_NAME.review_model.run({ code: 'fu', method: ['m'] }, ctx)
    expect(dossier).toContain('WHAT THE BIGGEST DATASETS SAY ABOUT THEMSELVES')
    expect(dossier).toContain('for laptop')
    expect(dossier).toContain('supplies 100 %')
    expect(dossier).toContain('41 % of the result')
    // It was opened, so the "nobody looked" fact must NOT be claimed — the quote stands on its own.
    expect(dossier).not.toContain('DATASETS NOBODY LOOKED AT')
  })

  it('says so when no model is open and never calls the reviewer', async () => {
    let called = false
    const out = await TOOL_BY_NAME.review_model.run(
      {},
      {
        api: async () => ({}),
        ui: async () => ({}),
        activeDb: null,
        review: async () => (
          (called = true),
          { text: 'x', outcome: 'ok' as const, reasoning_chars: 0, attempts: 1, ms: 1 }
        )
      }
    )
    expect(String(out)).toContain('No model open')
    expect(called).toBe(false)
  })
})

/**
 * Behaviour of the argument-shape affordances added after an early practice test, where a real
 * cradle-to-grave build spent roughly a third of its ~500 tool calls on bookkeeping: re-reading a
 * process to find a uid it had just been handed, one call per exchange, and ten consecutive parameter
 * calls rejected for a missing `action` that could only have meant one thing.
 */
describe('tool argument affordances', () => {
  const ctxWith = (
    api: (method: string, path: string, body?: unknown) => Promise<unknown>,
    activeDb: string | null = 'M'
  ): ToolCtx => ({ api: api as ToolCtx['api'], ui: async () => ({}), activeDb })

  it('treats a parameter call without an action as a set', async () => {
    const seen: Array<{ path: string; body: unknown }> = []
    const out = await TOOL_BY_NAME.edit_parameter.run(
      { name: 'mass_glass', value: 0.37, comment: 'VdF standard' },
      ctxWith(async (_m, path, body) => (seen.push({ path, body }), { ok: true }))
    )
    expect(seen[0].path).toBe('/api/v1/params')
    expect((seen[0].body as { name: string }).name).toBe('mass_glass')
    expect(String(out)).not.toContain('Unknown action')
  })

  it('still rejects an action it does not know, and names the alternatives', async () => {
    const out = await TOOL_BY_NAME.edit_parameter.run(
      { action: 'destroy', name: 'x' },
      ctxWith(async () => ({}))
    )
    const r = JSON.parse(String(out))
    expect(r.error).toContain('Unknown action "destroy"')
    expect(r.error).toContain('set')
  })

  it('sets a batch of parameters in ONE request, not one per parameter', async () => {
    // The fan-out this replaced looked like parallelism and was the opposite: every write
    // recalculates the whole model and they queue on the same lock, so 22 parameters took 183.9 s
    // where one takes ~10 (V228). One request is also what lets a formula name a parameter created
    // beside it (V232).
    const calls: Array<{ path: string; body: unknown }> = []
    const out = await TOOL_BY_NAME.edit_parameter.run(
      {
        parameters: [
          { name: 'a', value: 1 },
          { name: 'b', value: 2 },
          { name: 'c', formula: 'a + b' }
        ]
      },
      ctxWith(async (_m, path, body) => {
        calls.push({ path, body })
        return { parameters: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'unrelated' }] }
      })
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe('/api/v1/params/bulk')
    const sent = (calls[0].body as { parameters: Array<Record<string, unknown>> }).parameters
    expect(sent).toHaveLength(3)
    expect(sent[2]).toMatchObject({ name: 'c', formula: 'a + b' })
    const r = JSON.parse(String(out))
    expect(r.total).toBe(3)
    expect(r.succeeded).toBe(3)
    // The endpoint answers with the model's WHOLE parameter list; only the ones this call wrote are
    // kept, or the batch would re-pay for every unrelated parameter on every later round.
    expect(JSON.stringify(r.results)).not.toContain('unrelated')
  })

  it('says nothing was written when a batch of parameters is refused', async () => {
    const out = await TOOL_BY_NAME.edit_parameter.run(
      {
        parameters: [
          { name: 'a', value: 1 },
          { name: 'b', formula: 'nope +' }
        ]
      },
      ctxWith(async () => {
        throw new Error('Parameter update failed: bad formula')
      })
    )
    const r = JSON.parse(String(out))
    expect(r.succeeded).toBe(0)
    expect(r.failed).toBe(2)
    expect(r.error).toContain('bad formula')
    // One transaction means one outcome; the model must not go hunting for which items landed.
    expect(r.hint).toContain('nothing was written')
  })

  it('falls back to the open model when no database is given', async () => {
    const paths: string[] = []
    await TOOL_BY_NAME.list_activities.run(
      {},
      ctxWith(async (_m, path) => (paths.push(path), []))
    )
    expect(paths[0]).toContain(encodeURIComponent('M'))
  })

  it('says which model it needs when nothing is open', async () => {
    const out = await TOOL_BY_NAME.list_activities.run(
      {},
      ctxWith(async () => [], null)
    )
    expect(String(out)).toContain('No model open')
  })

  it('resolves a process by name instead of a 32-character code', async () => {
    const paths: string[] = []
    await TOOL_BY_NAME.get_process_details.run(
      { name: 'Glass bottle, 1 L' },
      ctxWith(async (_m, path) => {
        paths.push(path)
        if (path.endsWith(encodeURIComponent('M'))) {
          return [
            { code: 'aaa', name: 'Glass bottle, 1 L', location: 'DE' },
            { code: 'bbb', name: 'Paper label', location: 'DE' }
          ]
        }
        return { activity: {}, exchanges: [] }
      })
    )
    expect(paths[1]).toContain('aaa')
  })

  it('refuses an ambiguous name and lists the candidates rather than guessing', async () => {
    const out = await TOOL_BY_NAME.get_process_details.run(
      { name: 'Apple supply' },
      ctxWith(async () => [
        { code: 'aaa', name: 'Apple supply', location: 'DE' },
        { code: 'bbb', name: 'Apple supply', location: 'FR' }
      ])
    )
    const r = JSON.parse(String(out))
    expect(r.error).toContain('not unique')
    expect(r.candidates).toHaveLength(2)
    expect(JSON.stringify(r.candidates)).toContain('FR')
  })

  it('returns the new uid when adding an exchange, and applies formula + comment in the same call', async () => {
    const calls: Array<{ path: string; body: any }> = []
    const out = await TOOL_BY_NAME.edit_exchange.run(
      {
        action: 'add',
        activity_code: 'act1',
        input_database: 'ecoinvent',
        input_code: 'in1',
        amount: 0.37,
        formula: 'mass_glass',
        comment: 'positive: ordinary product input'
      },
      ctxWith(async (_m, path, body) => {
        calls.push({ path, body })
        if (path === '/api/v1/model/exchanges') return { exchange: { uid: 'u-new' } }
        return { ok: true }
      })
    )
    const r = JSON.parse(String(out))
    expect(r.uid).toBe('u-new')
    expect(r.commented).toBe(true)
    expect(calls.map((c) => c.path)).toContain('/api/v1/params/exchange-formula')
    expect(calls.map((c) => c.path)).toContain('/api/v1/model/exchanges/comment')
  })

  it('finds an exchange by its input when no uid is passed', async () => {
    const bodies: any[] = []
    await TOOL_BY_NAME.edit_exchange.run(
      { action: 'set_amount', activity_code: 'act1', input_code: 'in1', amount: 2 },
      ctxWith(async (method, path, body) => {
        if (method === 'GET') {
          return {
            exchanges: [
              { uid: 'p', type: 'production', input: { code: 'act1', database: 'M' } },
              { uid: 'u1', type: 'technosphere', input: { code: 'in1', database: 'ecoinvent' } }
            ]
          }
        }
        bodies.push(body)
        return { ok: true }
      })
    )
    expect(bodies[0].uid).toBe('u1')
  })

  it('will not guess which of two exchanges from the same input was meant', async () => {
    const out = await TOOL_BY_NAME.edit_exchange.run(
      { action: 'remove', activity_code: 'act1', input_code: 'in1' },
      ctxWith(async () => ({
        exchanges: [
          { uid: 'u1', type: 'technosphere', amount: 1, input: { code: 'in1', database: 'ecoinvent' } },
          { uid: 'u2', type: 'technosphere', amount: 2, input: { code: 'in1', database: 'ecoinvent' } }
        ]
      }))
    )
    expect(JSON.parse(String(out)).error).toContain('pass "uid"')
  })

  it('searches several datasets in one call', async () => {
    const queries: string[] = []
    const out = await TOOL_BY_NAME.search_background.run(
      { queries: ['packaging glass white', 'aluminium wrought alloy', 'kraft paper'] },
      ctxWith(async (_m, _p, body) => (queries.push((body as { query: string }).query), { hits: [] }))
    )
    expect(queries).toHaveLength(3)
    expect(JSON.parse(String(out)).total).toBe(3)
  })

  it('searches the databases the caller names, over the released default (V383)', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const ctx = {
      ...ctxWith(async (_m, _p, body) => (bodies.push(body as Record<string, unknown>), { hits: [] })),
      backgroundDbs: ['ecoinvent-3.12-cutoff', 'bafu-2026-v1'],
      libraryDbs: []
    }
    await TOOL_BY_NAME.search_background.run({ query: 'steel' }, ctx as never)
    expect(bodies[0].databases).toEqual(['ecoinvent-3.12-cutoff', 'bafu-2026-v1'])
    await TOOL_BY_NAME.search_background.run({ query: 'steel', databases: ['bafu-2026-v1'] }, ctx as never)
    expect(bodies[1].databases).toEqual(['bafu-2026-v1'])
    expect(bodies[1].database).toBeUndefined()
  })

  it('names an {"item": …}-wrapped "queries" object — the XML-style array MiniMax sends (V327)', async () => {
    // Seven identical rejections in a real run, each answered "pass a non-empty
    // array" — which the model believed it had done.
    const out = await TOOL_BY_NAME.search_background.run(
      { queries: { item: [{ query: 'treatment of waste polyethylene', geographies: { item: 'DE' } }] } },
      ctxWith(async () => ({ hits: [] }))
    )
    const err = JSON.parse(String(out)).error
    expect(err).toContain('OBJECT {"item": …}')
    expect(err).toContain('No "item" wrapper')
  })

  it('names a JSON-encoded "queries" string instead of claiming the array was empty', async () => {
    // Measured: told only "pass a non-empty array", the model retried the identical
    // stringified shape three times before falling back to single-query calls.
    const out = await TOOL_BY_NAME.search_background.run(
      { queries: '["steel tube low-alloyed", "powder coating epoxy"]' },
      ctxWith(async () => ({ hits: [] }))
    )
    const err = JSON.parse(String(out)).error
    expect(err).toContain('ONE string, not an array')
    expect(err).toContain('do not wrap the array in quotes')
  })

  it('keeps the dimension_check boilerplate once per run and the data fields always', () => {
    const note =
      '"note":"The amount is in kilogram, per 1 unit of this process\'s reference product. ' +
      'Units are labels, not checked — confirm the expression above actually yields kilogram ' +
      '(a stray kWh/MJ or g/kg factor is a factor of 3.6 or 1000), and record the conversion ' +
      'in the exchange comment."'
    const block = `{"dimension_check":{"amount_must_be_in":"kilogram","parameter_units":{"m":"kg"},${note}}}`
    const ctx = {} as ToolCtx
    // First answer of the run: one note survives, even in a batch carrying two.
    const first = trimUnitNotes(`[${block},${block}]`, ctx)
    expect((first.match(/Units are labels/g) ?? []).length).toBe(1)
    expect(JSON.parse(first)[1].dimension_check.amount_must_be_in).toBe('kilogram')
    // Every later answer: data fields stay, the sentence is gone, the JSON stays valid.
    const later = trimUnitNotes(block, ctx)
    expect(later).not.toContain('Units are labels')
    expect(JSON.parse(later).dimension_check.parameter_units.m).toBe('kg')
  })

  it('names a JSON-encoded "questions" string on research_web', async () => {
    const out = await TOOL_BY_NAME.research_web.run(
      { questions: '["typical lifetime of a folding gazebo", "steel recycling rate DE"]' },
      { ...ctxWith(async () => ({})), researchWeb: async () => ({ findings: [] }) } as never
    )
    expect(JSON.parse(String(out)).error).toContain('ONE string, not an array')
  })

  it('refuses a JSON-encoded "queries" string instead of answering with the family catalogue', async () => {
    const out = await TOOL_BY_NAME.list_methods.run(
      { queries: '["EF v3.1 climate change", "EF v3.1 water use"]' },
      ctxWith(async () => [{ method: ['EF v3.1', 'climate change', 'GWP100'], recommended: true }])
    )
    const r = JSON.parse(String(out))
    expect(r.families).toBeUndefined()
    expect(r.error).toContain('ONE string, not an array')
  })

  it('offers the method catalogue when asked without a query', async () => {
    const out = await TOOL_BY_NAME.list_methods.run(
      {},
      ctxWith(async () => [
        { method: ['EF v3.1', 'climate change', 'GWP100'], recommended: true },
        { method: ['EF v3.1', 'water use', 'UDP'], recommended: true },
        { method: ['IPCC 2021', 'climate change', 'GWP100'], recommended: true }
      ])
    )
    const r = JSON.parse(String(out))
    expect(r.families).toEqual([
      { family: 'EF v3.1', indicators: 2 },
      { family: 'IPCC 2021', indicators: 1 }
    ])
  })

  it('ranks the family a query names by whole words, and the newer family when no year is named (V386)', async () => {
    const methods = [
      {
        method: ['ReCiPe 2016 v1.03, midpoint (E)', 'climate change', 'global warming potential (GWP1000)'],
        recommended: true
      },
      {
        method: ['ReCiPe 2016 v1.03, midpoint (H)', 'climate change', 'global warming potential (GWP100)'],
        recommended: true
      },
      { method: ['IPCC 2013', 'climate change', 'global warming potential (GWP100)'], recommended: true },
      { method: ['IPCC 2021', 'climate change', 'global warming potential (GWP100)'], recommended: true }
    ]
    let r = JSON.parse(
      String(
        await TOOL_BY_NAME.list_methods.run(
          { query: 'ReCiPe 2016 midpoint H climate' },
          ctxWith(async () => methods)
        )
      )
    )
    expect(r.methods[0].method[0]).toBe('ReCiPe 2016 v1.03, midpoint (H)')
    r = JSON.parse(
      String(
        await TOOL_BY_NAME.list_methods.run(
          { query: 'IPCC GWP100' },
          ctxWith(async () => methods)
        )
      )
    )
    expect(r.methods[0].method[0]).toBe('IPCC 2021')
    r = JSON.parse(
      String(
        await TOOL_BY_NAME.list_methods.run(
          { query: 'IPCC 2013 GWP100' },
          ctxWith(async () => methods)
        )
      )
    )
    expect(r.methods[0].method[0]).toBe('IPCC 2013')
  })

  it('matches a method name the way a person would write it', async () => {
    const methods = [
      { method: ['EF v3.1', 'climate change', 'global warming potential (GWP100)'], recommended: true },
      { method: ['CML v4.8 2016', 'climate change', 'GWP100'], recommended: true }
    ]
    for (const query of ['EF 3.1 climate change', 'ef v3.1 climate', 'EF3.1  CLIMATE CHANGE']) {
      const out = await TOOL_BY_NAME.list_methods.run(
        { query },
        ctxWith(async () => methods)
      )
      const r = JSON.parse(String(out))
      expect(r.methods, query).toHaveLength(1)
      expect(r.methods[0].method[0], query).toBe('EF v3.1')
    }
  })
})

describe('what the model is told to call', () => {
  /**
   * Every tool name a description or hint mentions must be a tool the model can actually call.
   *
   * The consolidated surface makes this easy to get wrong: `IMPL` holds forty single-purpose
   * implementations (`set_model_info`, `set_method_factor`, `add_exchange`, …) that are NOT tools, and
   * their names read exactly like tools. Three had leaked into model-visible text — the goal & scope
   * hint said "saving it via set_model_info", and both flow searches pointed at `set_method_factor` —
   * so a model following the instruction would call something that does not exist. The same defect was
   * found in the built-in skills (V65); this is the other half of the surface.
   *
   * Checked against the IMPL names only, on purpose. A guard that flagged every snake_case word also
   * flagged 26 perfectly good parameter names, and a test that has to be edited whenever a parameter
   * is added is a test that gets deleted.
   */
  it('never tells the model to call an implementation that is not a tool', () => {
    const dead = NON_TOOL_IMPL_NAMES.filter(
      // These are also action values or ordinary words; naming them in prose is correct.
      (n) => !['undo', 'redo', 'contribution'].includes(n)
    )
    const offenders: string[] = []
    for (const t of TOOLS) {
      // Descriptions and parameter docs — everything the model reads about this tool.
      const text = JSON.stringify(t.spec.function)
      for (const name of dead) {
        if (new RegExp(`\\b${name}\\b`).test(text)) offenders.push(`${t.spec.function.name}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('has implementations that are not tools, or the guard above proves nothing', () => {
    expect(NON_TOOL_IMPL_NAMES.length).toBeGreaterThan(10)
    expect(NON_TOOL_IMPL_NAMES).toContain('set_model_info')
  })
})

/**
 * Regressions from a real picture-frame run: three tools whose answer carried something other
 * than what its name promised.
 */
describe('answers that must say what they mean', () => {
  it('applies recommended_only when the query does NOT match exactly (V79)', async () => {
    // Measured: "EF 3.1 resource use fossils" — "fossils" is in no indicator name — came back with 12
    // entries under recommended_only:true, 7 of them recommended:false, including the "no LT" family
    // the parameter promises to remove.
    const methods = [
      { method: ['EF v3.1', 'energy resources: non-renewable', 'ADP: fossil fuels'], recommended: true },
      { method: ['EF v3.1 no LT', 'energy resources: non-renewable no LT', 'ADP no LT'], recommended: false },
      { method: ['EF v3.1 no LT', 'land use no LT', 'soil quality no LT'], recommended: false }
    ]
    const out = JSON.parse(
      (await TOOL_BY_NAME.list_methods.run(
        { query: 'EF 3.1 resource use fossils', recommended_only: true },
        { api: async () => methods, ui: async () => ({}), activeDb: 'm' }
      )) as string
    )
    expect(out.exact_match).toBe(false)
    expect(out.methods.length).toBeGreaterThan(0)
    for (const m of out.methods) expect(m.recommended).toBe(true)
  })

  it('never turns a recommended_only fallback into "nothing found" (V79)', async () => {
    const methods = [{ method: ['CML', 'climate change', 'GWP100 no LT'], recommended: false }]
    const out = JSON.parse(
      (await TOOL_BY_NAME.list_methods.run(
        { query: 'CML climate nonsense', recommended_only: true },
        { api: async () => methods, ui: async () => ({}), activeDb: 'm' }
      )) as string
    )
    expect(out.methods.length).toBe(1) // the safety valve: better a specialist variant than silence
  })

  it('reports a failed review as failed, not as a clean one (V77)', async () => {
    const out = JSON.parse(
      (await TOOL_BY_NAME.review_model.run(
        {},
        {
          api: async () => ({}),
          ui: async () => ({}),
          activeDb: 'demo',
          review: async () => ({
            text: '',
            outcome: 'empty' as const,
            reasoning_chars: 41_000,
            attempts: 2,
            ms: 113_976,
            finish_reason: 'stop'
          })
        }
      )) as string
    )
    expect(out.review).toBeNull()
    expect(out.review_failed).toBe('empty')
    expect(out.detail).toMatch(/no text in 2 attempts/)
    expect(out.note).toMatch(/FAILED review/)
  })

  it('separates the direct impact from the cumulative share (V85)', async () => {
    // The tree node carries both; pairing one with the other overstated a contributor by a third.
    const tree = {
      n: 'root',
      db: 'm',
      c: 'r',
      g: 'DE',
      dir: 0,
      imp: 10,
      shr: 1,
      ch: [{ n: 'flat glass production', db: 'ei', c: 'g', g: 'RER', dir: 2.7, imp: 3.53, shr: 0.353 }]
    }
    const out = JSON.parse(
      (await TOOL_BY_NAME.explain_result.run(
        { mode: 'tree', code: 'r', method: ['m'] },
        { api: async () => ({ meta: { total: 10 }, tree }), ui: async () => ({}), activeDb: 'm' }
      )) as string
    )
    const glass = out.top_contributors_by_direct_impact.find((c: any) => c.name === 'flat glass production')
    expect(glass.direct).toBe(2.7)
    expect(glass.direct_share).toBeCloseTo(0.27, 5) // its OWN share, not the chain's
    expect(glass.cumulative).toBe(3.53)
    expect(glass.cumulative_share).toBe(0.353)
    expect(out.how_to_read).toMatch(/never be summed/)
  })
})

describe('the wall-paint run findings', () => {
  it('infers action="add" for an item that carries a formula instead of an amount (V86)', async () => {
    // The tool tells the model a formula IS the amount, then refused every item that took it at its
    // word: 21 exchanges in one call, the 3 with a number went through, the 18 with a formula did not.
    const calls: any[] = []
    const out = JSON.parse(
      (await TOOL_BY_NAME.edit_exchange.run(
        {
          exchanges: [
            { activity_code: 'p', input_database: 'ei', input_code: 'x', formula: 'share_binder' },
            { activity_code: 'p', input_database: 'ei', input_code: 'y', amount: 0.5 }
          ]
        },
        {
          api: async (m: string, path: string, body: any) => {
            calls.push([m, path, body])
            if (path.includes('/api/v1/model/activities/') && m === 'GET') return { exchanges: [] }
            return { exchange: { uid: 'u1', amount: body?.amount ?? 1 } }
          },
          ui: async () => ({}),
          activeDb: 'm'
        }
      )) as string
    )
    expect(out.failed).toBe(0)
    expect(out.succeeded).toBe(2)
  })

  it('names the argument a tool does NOT have when a call fails (V96)', () => {
    const tool = { spec: { function: { parameters: { properties: { database: {}, code: {} } } } } }
    const msg = withUnknownFields(
      'Invalid arguments — code: Field required',
      JSON.stringify({ database: 'ei', codes: ['a', 'b'] }),
      tool
    )
    expect(msg).toMatch(/no "codes"/)
    expect(msg).toMatch(/"database", "code"/)
    // Silent when every argument is one the tool declares — this must not chatter on real failures.
    expect(withUnknownFields('boom', JSON.stringify({ database: 'ei' }), tool)).toBe('boom')
  })

  it('scores several activities in one call (V96)', async () => {
    const out = JSON.parse(
      (await TOOL_BY_NAME.calculate.run(
        { database: 'ei', codes: ['a', 'b', 'c'], method: ['IPCC'] },
        {
          api: async (_m: string, _p: string, body: any) => ({ score: body.code.length }),
          ui: async () => ({}),
          activeDb: 'm'
        }
      )) as string
    )
    expect(out.total).toBe(3)
    expect(out.failed).toBe(0)
  })

  it('says the comment was written when replacing an input (V97)', async () => {
    // `carried_over.comment` was false EXACTLY when a comment had been written — the opposite of how
    // it reads beside `commented: true` on the sibling action. The model replayed the whole batch.
    const out = JSON.parse(
      (await TOOL_BY_NAME.edit_exchange.run(
        {
          action: 'replace_input',
          activity_code: 'p',
          input_database: 'ei',
          input_code: 'old',
          new_input_code: 'new',
          comment: 'why this dataset'
        },
        {
          api: async (m: string, path: string, body: any) => {
            if (m === 'GET' && path.includes('/api/v1/model/activities/'))
              return {
                exchanges: [
                  { uid: 'u-old', type: 'technosphere', amount: 2, input: { database: 'ei', code: 'old' } }
                ]
              }
            return { exchange: { uid: 'u-new', amount: body?.amount ?? 1 } }
          },
          ui: async () => ({}),
          activeDb: 'm'
        }
      )) as string
    )
    expect(out.commented).toBe(true)
    expect(out.kept_old.comment).toBe(false) // the old one was NOT kept, because a new one was given
  })

  it('reports a replacement that has already happened instead of "no exchange has input X" (V97)', async () => {
    const out = JSON.parse(
      (await TOOL_BY_NAME.edit_exchange.run(
        {
          action: 'replace_input',
          activity_code: 'p',
          input_database: 'ei',
          input_code: 'old',
          new_input_code: 'new'
        },
        {
          api: async () => ({
            exchanges: [
              { uid: 'u-new', type: 'technosphere', amount: 2, input: { database: 'ei', code: 'new' } }
            ]
          }),
          ui: async () => ({}),
          activeDb: 'm'
        }
      )) as string
    )
    expect(out.already_replaced).toBe(true)
    expect(out.uid).toBe('u-new')
  })

  it('lists an activity reached by two supply chains once (V92)', async () => {
    // Two rows, same code, different numbers, nothing saying why: the model quoted one of them and
    // reported 18 % for a substance carrying 41 %.
    const tio2 = (dir: number, imp: number, shr: number) => ({
      n: 'titanium dioxide production, sulfate process',
      db: 'ei',
      c: 'tio2',
      g: 'RER',
      dir,
      imp,
      shr
    })
    const tree = {
      n: 'root',
      db: 'm',
      c: 'r',
      g: 'DE',
      dir: 0,
      imp: 10,
      shr: 1,
      ch: [
        { n: 'paint', db: 'm', c: 'p', g: 'DE', dir: 0, imp: 8, shr: 0.8, ch: [tio2(1.5, 3.24, 0.324)] },
        tio2(1.3, 4.9, 0.49)
      ]
    }
    const out = JSON.parse(
      (await TOOL_BY_NAME.explain_result.run(
        { mode: 'tree', code: 'r', method: ['m'] },
        { api: async () => ({ meta: { total: 10 }, tree }), ui: async () => ({}), activeDb: 'm' }
      )) as string
    )
    const rows = out.top_contributors_by_direct_impact.filter((c: any) => c.code === 'tio2')
    expect(rows.length).toBe(1)
    expect(rows[0].paths).toBe(2)
    expect(rows[0].direct).toBeCloseTo(2.8, 6)
    expect(rows[0].cumulative).toBeCloseTo(8.14, 6)
    expect(out.how_to_read).toMatch(/paths/)
    // A single-path row must stay clean: no stray field.
    expect(out.top_contributors_by_direct_impact.find((c: any) => c.code === 'p').paths).toBeUndefined()
  })

  it('shows what a dataset is made of in the summary (V87)', async () => {
    // summary=true kept 1,900 characters of market boilerplate and dropped the five lines that say
    // whether this is a binder or a paint. It was a paint, and it cost 4.56 kg CO2e of hidden TiO2.
    const out = JSON.parse(
      (await TOOL_BY_NAME.get_process_details.run(
        { database: 'ei', code: 'disp', summary: true },
        {
          api: async () => ({
            activity: { name: 'acrylic dispersion production', unit: 'kilogram' },
            exchanges: [
              { type: 'production', amount: 1, input: { name: 'acrylic dispersion' } },
              { type: 'technosphere', amount: 0.5041, input: { name: 'market for acrylic binder' } },
              { type: 'technosphere', amount: 0.2516, input: { name: 'market for titanium dioxide' } },
              { type: 'technosphere', amount: 0.04, input: { name: 'market for ethylene glycol' } }
            ]
          }),
          ui: async () => ({}),
          activeDb: 'm'
        }
      )) as string
    )
    expect(out.biggest_inputs[0].name).toBe('market for acrylic binder')
    expect(out.biggest_inputs[1].name).toBe('market for titanium dioxide')
    expect(out.exchange_count).toBe(4)
  })
})

describe('the solar-lamp run findings', () => {
  it('writes a comment handed over beside a formula, and says so (V99)', async () => {
    // The dataset-switch pattern the scenario skill teaches sets a formula and comments the exchange
    // that now rests at zero, in the same item. The comment used to be dropped in silence, so the
    // resting exchange kept describing itself as the active proxy.
    const wrote: any[] = []
    const out = JSON.parse(
      (await TOOL_BY_NAME.edit_exchange.run(
        {
          activity_code: 'p',
          exchanges: [
            { uid: 'u1', action: 'set_formula', formula: 'm*use_full', comment: 'dormant in baseline' },
            { uid: 'u2', action: 'set_amount', amount: 2, comment: 'why it is two' }
          ]
        },
        {
          api: async (_m: string, path: string, body: any) => {
            wrote.push([path, body])
            return { exchange: { uid: body?.uid } }
          },
          ui: async () => ({}),
          activeDb: 'm'
        }
      )) as string
    )
    expect(out.failed).toBe(0)
    expect(out.results.every((r: any) => r.result.commented === true)).toBe(true)
    const comments = wrote.filter(([path]) => String(path).includes('/exchanges/comment'))
    expect(comments.map(([, b]) => b.comment)).toEqual(['dormant in baseline', 'why it is two'])
  })

  it('answers every write with the state it left behind (answer == re-read sweep)', async () => {
    // Five findings were one defect wearing five names: V41 (formula write answered amount 0), V97
    // (`carried_over.comment` false exactly when a comment was written), V111 (`commented: true`
    // beside the comment from BEFORE the write) and the read-side V85/V92. Each was found in a paid
    // run and fixed alone. This closes the class for the tool layer's combining logic: a stateful
    // fake backend holds the truth, and whatever an edit_exchange answer names must equal it. The
    // backend half of the same sweep lives in tests/test_write_readback.py, with the real engine.
    const store = new Map<string, any>()
    let n = 0
    const snap = (uid: string): any => JSON.parse(JSON.stringify(store.get(uid)))
    const api = async (_m: string, path: string, body: any): Promise<any> => {
      if (path === '/api/v1/model/exchanges') {
        const uid = `u${++n}`
        store.set(uid, {
          uid,
          amount: body.amount,
          formula: null,
          comment: null,
          type: body.type ?? 'technosphere',
          input: { database: body.input_database, code: body.input_code }
        })
        return { exchange: snap(uid) }
      }
      if (path === '/api/v1/model/exchanges/amount') {
        Object.assign(store.get(body.uid), { amount: body.amount, formula: null })
        return { exchange: snap(body.uid) }
      }
      if (path === '/api/v1/params/exchange-formula') {
        // The fake "evaluates" every formula to 42 — what matters is that the ANSWER carries the
        // evaluated state, not which number it is.
        Object.assign(store.get(body.uid), { formula: body.formula, amount: 42 })
        return { exchange: snap(body.uid) }
      }
      if (path === '/api/v1/model/exchanges/comment') {
        Object.assign(store.get(body.uid), { comment: body.comment })
        return { exchange: snap(body.uid) }
      }
      if (path === '/api/v1/model/exchanges/remove') {
        store.delete(body.uid)
        return { ok: true }
      }
      if (path.startsWith('/api/v1/model/activities/')) {
        return { activity: {}, exchanges: [...store.values()].map((e) => JSON.parse(JSON.stringify(e))) }
      }
      throw new Error(`unexpected ${path}`)
    }
    const ctx: any = { api, ui: async () => ({}), activeDb: 'M' }
    const run = async (item: Record<string, unknown>): Promise<any> => {
      // A one-item batch answers with the bare result, not the batch envelope.
      const out = JSON.parse(
        (await TOOL_BY_NAME.edit_exchange.run({ activity_code: 'A', exchanges: [item] }, ctx)) as string
      )
      expect(out.error, JSON.stringify(out)).toBeUndefined()
      return out
    }

    // add with formula + comment: the answer's amount is the evaluated one, and the comment landed.
    const added = await run({
      action: 'add',
      input_database: 'ei',
      input_code: 'x',
      formula: 'mass * 2',
      comment: 'first words'
    })
    const uid = added.uid
    expect(added.amount).toBe(store.get(uid).amount) // 42, not the 0 placeholder (V41)
    expect(added.commented).toBe(true)
    expect(store.get(uid).comment).toBe('first words')

    // set_formula + comment: the echoed exchange must be the state AFTER the comment write (V111).
    const setF = await run({ action: 'set_formula', uid, formula: 'mass * 3', comment: 'second words' })
    expect(setF.commented).toBe(true)
    expect(setF.exchange.formula).toBe(store.get(uid).formula)
    expect(setF.exchange.comment).toBe(store.get(uid).comment)
    expect(store.get(uid).comment).toBe('second words')

    // set_amount + comment: same contract on the sibling branch (V99).
    const setA = await run({ action: 'set_amount', uid, amount: 7, comment: 'third words' })
    expect(setA.commented).toBe(true)
    expect(setA.exchange.amount).toBe(store.get(uid).amount)
    expect(setA.exchange.comment).toBe('third words')

    // replace_input: everything the answer claims was carried over must really be on the NEW row,
    // and the old row must be gone (V97).
    const replaced = await run({ action: 'replace_input', uid, new_input_code: 'y' })
    expect(store.has(uid)).toBe(false)
    const fresh = store.get(replaced.uid)
    expect(fresh.input.code).toBe('y')
    expect(replaced.amount).toBe(fresh.amount)
    expect(fresh.comment).toBe('third words') // carried, as kept_old claims
    expect(replaced.kept_old).toEqual({ amount: true, formula: true, comment: true })
  })

  it('says when this chat already asked the same search (V112)', async () => {
    // The queries and signatures are the ones a real apple-sauce run actually sent; the
    // backend reduces "tinplate production" and "tinplate" to the same content word.
    const searched = new Map<string, { query: string; hits: number }>()
    const ctx: any = {
      api: async (_m: string, _p: string, body: any) => ({
        query: body.query,
        count: 8,
        content_terms: body.query.includes('tinplate') ? ['tinplate'] : ['apple', 'juice'],
        hits: []
      }),
      ui: async () => ({}),
      activeDb: 'm',
      searched
    }
    const first = JSON.parse(
      (await TOOL_BY_NAME.search_background.run({ query: 'tinplate production' }, ctx)) as string
    )
    expect(first.already_searched).toBeUndefined()
    const second = JSON.parse(
      (await TOOL_BY_NAME.search_background.run({ query: 'tinplate' }, ctx)) as string
    )
    expect(second.already_searched.earlier_query).toBe('tinplate production')
    expect(second.already_searched.earlier_results).toBe(8)
    // A different material is not the same search.
    const other = JSON.parse(
      (await TOOL_BY_NAME.search_background.run({ query: 'apple juice' }, ctx)) as string
    )
    expect(other.already_searched).toBeUndefined()
  })

  it('does not call a literal retry a repeat, and passes literal through (abbreviation expansion)', async () => {
    // After "pet food" came back read as polyethylene terephthalate, the way out is the same words
    // searched as typed — telling the model it is repeating itself would send it to a proxy instead.
    const bodies: any[] = []
    const ctx: any = {
      api: async (_m: string, _p: string, body: any) => {
        bodies.push(body)
        return { query: body.query, count: 3, content_terms: ['food', 'pet'], hits: [] }
      },
      ui: async () => ({}),
      activeDb: 'm',
      searched: new Map()
    }
    await TOOL_BY_NAME.search_background.run({ query: 'pet food' }, ctx)
    const literal = JSON.parse(
      (await TOOL_BY_NAME.search_background.run({ query: 'pet food', literal: true }, ctx)) as string
    )
    expect(bodies[0].literal).toBeUndefined()
    expect(bodies[1].literal).toBe(true)
    expect(literal.already_searched).toBeUndefined()
    const again = JSON.parse(
      (await TOOL_BY_NAME.search_background.run({ query: 'pet food', literal: true }, ctx)) as string
    )
    expect(again.already_searched.earlier_query).toBe('pet food') // a literal repeat IS a repeat
  })

  it('does not treat two generic queries as the same search (V112)', async () => {
    // "market for tap water" has no content words at all — an empty signature must never match.
    const ctx: any = {
      api: async (_m: string, _p: string, body: any) => ({ query: body.query, count: 4, content_terms: [] }),
      ui: async () => ({}),
      activeDb: 'm',
      searched: new Map()
    }
    await TOOL_BY_NAME.search_background.run({ query: 'market for tap water' }, ctx)
    const second = JSON.parse(
      (await TOOL_BY_NAME.search_background.run({ query: 'market for the box' }, ctx)) as string
    )
    expect(second.already_searched).toBeUndefined()
  })

  it('treats the same words in a different geography as a different search (V112)', async () => {
    const ctx: any = {
      api: async (_m: string, _p: string, body: any) => ({
        query: body.query,
        count: 5,
        content_terms: ['tinplate']
      }),
      ui: async () => ({}),
      activeDb: 'm',
      searched: new Map()
    }
    await TOOL_BY_NAME.search_background.run({ query: 'tinplate', geographies: ['DE'] }, ctx)
    const other = JSON.parse(
      (await TOOL_BY_NAME.search_background.run({ query: 'tinplate', geographies: ['RER'] }, ctx)) as string
    )
    expect(other.already_searched).toBeUndefined()
    const same = JSON.parse(
      (await TOOL_BY_NAME.search_background.run({ query: 'tinplate', geographies: ['DE'] }, ctx)) as string
    )
    expect(same.already_searched).toBeDefined()
  })

  it('bundles every honesty signal into ONE warnings list, first key in the answer', async () => {
    // The consolidation, not a new signal: in a real run `split_match_warning` fired three
    // times in its own small field and was read past three times. The fields stay; the block is the
    // salience fix, so it must come FIRST and must repeat each signal that fired.
    const ctx: any = {
      api: async (_m: string, _p: string, body: any) => ({
        query: body.query,
        count: 5,
        weak_match: true,
        unmatched_terms: ['6'],
        terms_not_in_results: ['tinplate'],
        proxy_warning: "No result's name or reference product contains: 'tinplate'.",
        split_match_warning: 'No single result carries more than 1 of the 2 things your query named.',
        hint: 'This reads as a question about a FIGURE, not a dataset name.',
        content_terms: ['tinplate'],
        hits: []
      }),
      ui: async () => ({}),
      activeDb: 'm',
      searched: new Map()
    }
    await TOOL_BY_NAME.search_background.run({ query: 'tinplate' }, ctx) // prime already_searched
    const raw = (await TOOL_BY_NAME.search_background.run({ query: 'tinplate' }, ctx)) as string
    const out = JSON.parse(raw)
    expect(Object.keys(out)[0]).toBe('warnings')
    expect(out.warnings.length).toBe(6)
    const all = out.warnings.join('\n')
    for (const piece of [
      'Nothing in this list truly resembles the query',
      "specifier(s) '6'",
      "No result's name or reference product contains: 'tinplate'.",
      'No single result carries more than 1 of the 2',
      'You already searched these words in this chat',
      'question about a FIGURE'
    ]) {
      expect(all).toContain(piece)
    }
    // The source fields survive untouched — the block repeats them, it does not replace them.
    expect(out.weak_match).toBe(true)
    expect(out.split_match_warning).toBeDefined()
  })

  it('adds no warnings block to a clean search answer', async () => {
    const ctx: any = {
      api: async (_m: string, _p: string, body: any) => ({
        query: body.query,
        count: 5,
        weak_match: false,
        unmatched_terms: [],
        terms_not_in_results: [],
        content_terms: ['steel'],
        hits: [{ code: 'x' }]
      }),
      ui: async () => ({}),
      activeDb: 'm',
      searched: new Map()
    }
    const out = JSON.parse((await TOOL_BY_NAME.search_background.run({ query: 'steel' }, ctx)) as string)
    expect(out.warnings).toBeUndefined()
  })

  it('tells the model the research cap this chat will enforce (V113)', async () => {
    const generic = (specs: any[]): string =>
      specs.find((s) => s.function.name === 'research_web').function.parameters.properties.questions
        .description
    // Unset: the mechanism, no number — this is also what the manifest ships.
    expect(generic(toolSpecs(true))).toContain(RESEARCH_CAP_PHRASE)
    expect(generic(toolSpecs(true))).not.toMatch(/\b6 by default\b/)
    // Set: the figure that will actually be enforced. A real run ran at 4 while the text
    // said 6, and the model wrote "under the limit of 6" about a call that was exactly at it.
    expect(generic(toolSpecs(true, undefined, undefined, 4))).toContain('(4 in this chat')
    expect(generic(toolSpecs(true, undefined, undefined, 4))).not.toContain(RESEARCH_CAP_PHRASE)
    // The shared spec is never rewritten in place — a second call with no cap is generic again.
    expect(generic(toolSpecs(true))).toContain(RESEARCH_CAP_PHRASE)
    // …and no other tool is touched.
    const other = toolSpecs(true, undefined, undefined, 4).find(
      (s) => s.function.name === 'search_background'
    )
    expect(other).toBe(toolSpecs(true).find((s) => s.function.name === 'search_background'))
  })

  it('echoes the comment it just wrote, not the one it replaced (V111)', async () => {
    // A real apple-sauce run got all four of its new comments STORED and all four OLD ones
    // read back, in the same answer that said `commented: true` — because the exchange came from the
    // formula write, which happened before the comment write. A model checking whether its text
    // landed sees the text it replaced, and may write it a second time.
    const out = JSON.parse(
      (await TOOL_BY_NAME.edit_exchange.run(
        {
          activity_code: 'p',
          uid: 'u1',
          action: 'set_formula',
          formula: 'm_glass * (1/n_cycles + break_loss)',
          comment: 'the new text'
        },
        {
          api: async (_m: string, path: string, body: any) =>
            String(path).includes('/exchanges/comment')
              ? { exchange: { uid: body.uid, formula: body.formula, comment: body.comment } }
              : {
                  exchange: {
                    uid: body.uid,
                    formula: body.formula,
                    comment: 'the OLD text',
                    input: { name: 'packaging glass production, white' },
                    dimension_check: { amount_must_be_in: 'kilogram' }
                  }
                },
          ui: async () => ({}),
          activeDb: 'm'
        }
      )) as string
    )
    expect(out.commented).toBe(true)
    expect(out.exchange.comment).toBe('the new text')
    // …and nothing the formula write knew is lost in the swap.
    expect(out.exchange.input.name).toBe('packaging glass production, white')
    expect(out.exchange.dimension_check.amount_must_be_in).toBe('kilogram')
    expect(out.exchange.formula).toBe('m_glass * (1/n_cycles + break_loss)')
  })

  it('leaves the comment alone when none was passed (V99)', async () => {
    const wrote: string[] = []
    await TOOL_BY_NAME.edit_exchange.run(
      { activity_code: 'p', uid: 'u1', action: 'set_formula', formula: 'x' },
      {
        api: async (_m: string, path: string) => {
          wrote.push(path)
          return { exchange: { uid: 'u1' } }
        },
        ui: async () => ({}),
        activeDb: 'm'
      }
    )
    expect(wrote.some((p) => p.includes('/exchanges/comment'))).toBe(false)
  })

  it('names the forbidden field when an item nests its own exchanges array (V101)', async () => {
    const out = JSON.parse(
      (await TOOL_BY_NAME.edit_exchange.run(
        {
          exchanges: [
            { activity_code: 'p', input_database: 'ei', input_code: 'ok', amount: 1 },
            {
              activity_code: 'p',
              action: 'add',
              exchanges: [{ input_database: 'ei', input_code: 'a', formula: 'm' }]
            }
          ]
        },
        {
          api: async (_m: string, _p: string, body: any) => ({ exchange: { uid: 'u', ...body } }),
          ui: async () => ({}),
          activeDb: 'm'
        }
      )) as string
    )
    expect(out.succeeded).toBe(1)
    expect(out.failed).toBe(1)
    const err = out.results.find((r: any) => !r.ok).error
    expect(err).toMatch(/may not carry its own "exchanges"/)
    // The old message pointed at input_database, which every nested entry already had.
    expect(err).not.toMatch(/requires: input_database/)
  })

  it('ignores the empty exchanges array a padding model sends on every call (V286)', async () => {
    // GPT-5.6 fills every optional schema field ("" / 0 / []). A padded `exchanges: []` beside a
    // complete single edit is a no-op, not the nested-batch mistake — rejecting it cost one run
    // 14 refused calls of "lift those 0 entries out".
    const out = JSON.parse(
      (await TOOL_BY_NAME.edit_exchange.run(
        {
          activity_code: 'p',
          action: 'add',
          input_database: 'ei',
          input_code: 'ok',
          amount: 1,
          exchanges: []
        },
        {
          api: async (_m: string, _p: string, body: any) => ({ exchange: { uid: 'u', ...body } }),
          ui: async () => ({}),
          activeDb: 'm'
        }
      )) as string
    )
    expect(JSON.stringify(out)).not.toMatch(/may not carry its own/)
    expect(out.uid).toBe('u')
  })

  it('treats padded empty strings on edit_process as "leave unchanged" (V287)', async () => {
    // `name: ""` used to travel into Brightway and come back as ValidityError dressed up as an
    // unexpected server error. Nothing on this tool can be meaningfully set to empty.
    const posts: any[] = []
    await TOOL_BY_NAME.edit_process.run(
      { code: 'c', name: '', location: '', unit: '', comment: 'what this process represents' },
      {
        api: async (_m: string, path: string, body: any) => {
          if (body) posts.push({ path, body })
          return { activity: { code: 'c', name: 'kept' } }
        },
        ui: async () => ({}),
        activeDb: 'm'
      }
    )
    const post = posts.find((c) => c.path.includes('/activities/fields'))
    expect(post).toBeDefined()
    expect(post.body.comment).toBe('what this process represents')
    expect(post.body.name).toBeUndefined()
    expect(post.body.unit).toBeUndefined()
    expect(post.body.location).toBeUndefined()
  })

  it('drops padded empty study fields instead of wiping the record (V288/V292)', async () => {
    // A padded set with goal:"" wiped a study's recorded goal & scope mid-run — and the padded
    // `limitations: []` beside a real add_limitations used to be refused as "not both".
    const posts: any[] = []
    const out = JSON.parse(
      (await TOOL_BY_NAME.model_info.run(
        {
          action: 'set',
          goal: '',
          scope: 'the scope that is actually being set',
          limitations: [],
          add_limitations: [{ text: 'The product mass is a researched screening value.' }]
        },
        {
          api: async (m: string, path: string, body: any) => {
            if (m === 'GET') return { limitations: [{ text: 'already recorded' }] }
            posts.push({ path, body })
            return { ok: true }
          },
          ui: async () => ({}),
          activeDb: 'm',
          model: 'test-model'
        }
      )) as string
    )
    expect(JSON.stringify(out)).not.toMatch(/not both/)
    const post = posts.find((c) => c.path === '/api/v1/study')
    expect(post).toBeDefined()
    expect(post.body.goal).toBeUndefined()
    expect(post.body.scope).toBe('the scope that is actually being set')
    // The padded empty replace-list appended instead of clearing: old entry kept, new one added.
    expect(post.body.limitations.map((l: any) => l.text)).toEqual([
      'already recorded',
      'The product mass is a researched screening value.'
    ])
  })

  it('finds a skill whose name carries one word more than the request (V106)', async () => {
    const asked: string[] = []
    const out = JSON.parse(
      (await TOOL_BY_NAME.get_skill.run(
        { names: ['Bill of materials from product description', 'no such thing at all'] },
        {
          api: async (_m: string, path: string) => ({
            ...(asked.push(path) && {}),
            skills: [
              {
                id: 'a',
                name: 'Bill of materials from a product description',
                description: 'd',
                content: 'c'
              },
              { id: 'b', name: 'Interpreting results', description: 'd', content: 'c' }
            ]
          }),
          ui: async () => ({}),
          activeDb: 'm'
        }
      )) as string
    )
    expect(out.skills[0].name).toBe('Bill of materials from a product description')
    expect(out.skills[0].content).toBe('c')
    // A genuine miss still fails, and the answer still carries the list to pick from.
    expect(out.skills[1].error).toMatch(/No skill named/)
    expect(out.available).toContain('Interpreting results')
    // Only skills that are switched on: the same list the system prompt offers, so a skill disabled
    // in Settings is withheld here too, not just hidden.
    expect(asked).toEqual(['/api/v1/ai/skills?enabled=true'])
  })

  it('records every dataset it opens, so the hotspot check can tell (V100)', async () => {
    const inspected = new Set<string>()
    await TOOL_BY_NAME.get_process_details.run(
      { database: 'ei', codes: ['batt', 'steel'] },
      { api: async () => ({ name: 'x' }), ui: async () => ({}), activeDb: 'm', inspected }
    )
    expect([...inspected]).toEqual([inspectedKey('ei', 'batt'), inspectedKey('ei', 'steel')])
  })
})

describe('unopenedLinkedHotspots (V100, union rule)', () => {
  const tree = {
    db: 'model',
    c: 'fu',
    n: 'FU',
    shr: 1,
    ch: [
      {
        db: 'model',
        c: 'phase',
        n: 'Production',
        shr: 0.9,
        ch: [
          // Linked by the foreground and big: somebody chose this one.
          {
            db: 'ei',
            c: 'batt',
            n: 'market for battery, NiMH',
            shr: 0.41,
            ch: [
              // Deep inside the battery's own recipe — 17 %, and nobody chose it.
              { db: 'ei', c: 'lani5', n: 'electrode production, positive, LaNi5', shr: 0.17, ch: [] }
            ]
          },
          { db: 'ei', c: 'steel', n: 'market for steel', shr: 0.18, ch: [] },
          // Under a tenth but in the top few: the apple-sauce lid — 3.4 %, shipped as raw converter
          // steel because the first cut of this rule was a flat 10 % bar.
          { db: 'ei', c: 'lid', n: 'steel production, converter, unalloyed', shr: 0.034, ch: [] },
          // Linked, but under the floor: too small to move a screening conclusion, top-8 or not.
          { db: 'ei', c: 'box', n: 'market for corrugated board box', shr: 0.017, ch: [] }
        ]
      }
    ]
  }

  it('lists what the foreground links: everything above a tenth PLUS the top ranks down to the floor', () => {
    const out = unopenedLinkedHotspots(tree, 'model', new Set<string>())
    expect(out.map((x) => x.code)).toEqual(['batt', 'steel', 'lid'])
  })

  it('drops the ones already opened without promoting anything from under the floor', () => {
    expect(
      unopenedLinkedHotspots(tree, 'model', new Set([inspectedKey('ei', 'batt')])).map((x) => x.code)
    ).toEqual(['steel', 'lid'])
    expect(
      unopenedLinkedHotspots(
        tree,
        'model',
        new Set([inspectedKey('ei', 'batt'), inspectedKey('ei', 'steel'), inspectedKey('ei', 'lid')])
      )
    ).toEqual([])
  })

  it('says nothing at all when the run keeps no record', () => {
    // No set means no claim: better silent than accusing a model of not reading what it read.
    expect(unopenedLinkedHotspots(tree, 'model', undefined)).toEqual([])
  })
})

describe('source hygiene (V102)', () => {
  it('has no raw NUL bytes in the AI sources', () => {
    // A literal 0x00 in a source file makes grep and ripgrep classify it as binary and return
    // NOTHING for a matching pattern, silently. tools.ts carried two for a day, in the file that
    // holds every tool description — three code searches came back empty before anyone noticed.
    // Every .ts under this directory (recursively), not a hand-kept list: a file added by a split
    // must not silently fall out of coverage.
    const files = readdirSync(__dirname, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => join(e.parentPath, e.name))
    expect(files.length).toBeGreaterThan(5)
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      expect(text.includes('\u0000'), f).toBe(false)
    }
  })
})

describe('provenance logging (research + review)', () => {
  const webResult = (question: string) => ({
    question,
    findings: [
      { text: 'The jar weighs 220 g (https://example.org/jar).', sources: ['https://example.org/jar'] }
    ],
    sources: ['https://example.org/jar'],
    unsourced_dropped: 0
  })

  it('research_web records the sourced findings against the open model', async () => {
    const posts: Array<{ path: string; body: any }> = []
    const out = JSON.parse(
      (await TOOL_BY_NAME.research_web.run({ question: 'jar weight?' }, {
        api: async (_m: string, path: string, body: any) => (posts.push({ path, body }), { added: 1 }),
        ui: async () => ({}),
        activeDb: 'demo-model',
        researchWeb: async (o: any) => webResult(o.question)
      } as unknown as ToolCtx)) as string
    )
    expect(out.findings).toHaveLength(1)
    const post = posts.find((p) => p.path === '/api/v1/provenance/research')
    expect(post?.body.database).toBe('demo-model')
    expect(post?.body.entries[0].question).toBe('jar weight?')
    expect(post?.body.entries[0].findings[0].sources).toEqual(['https://example.org/jar'])
  })

  it('research_web asks both question lists when a model fills both, each question once', async () => {
    const asked: Array<{ question: string; context?: string }> = []
    const ctx = {
      api: async () => ({}),
      ui: async () => ({}),
      maxResearchQuestions: 4,
      researchWeb: async (o: any) => (asked.push(o), webResult(o.question))
    } as unknown as ToolCtx
    const out = (await TOOL_BY_NAME.research_web.run(
      {
        questions: ['market?', 'regulation?'],
        detailed_questions: [{ question: 'regulation?', context: 'EU' }]
      },
      ctx
    )) as string
    expect(out).not.toMatch(/not both/)
    // The detailed one keeps its own context; the plain duplicate is not asked a second time.
    expect(asked.map((o) => o.question)).toEqual(['regulation?', 'market?'])
    expect(asked[0].context).toBe('EU')
    // The same question with two contexts is two questions.
    asked.length = 0
    await TOOL_BY_NAME.research_web.run(
      {
        detailed_questions: [
          { question: 'recycling rate?', context: 'Germany' },
          { question: 'recycling rate?', context: 'France' }
        ]
      },
      ctx
    )
    expect(asked.map((o) => o.context)).toEqual(['Germany', 'France'])
  })

  it('research_web survives a failing log write and records every answered leg of a batch', async () => {
    const posts: any[] = []
    let failLog = true
    const ctx = {
      api: async (_m: string, path: string, body: any) => {
        if (path === '/api/v1/provenance/research') {
          if (failLog) throw new Error('backend gone')
          posts.push(body)
        }
        return {}
      },
      ui: async () => ({}),
      activeDb: 'demo-model',
      maxResearchQuestions: 4,
      researchWeb: async (o: any) => webResult(o.question)
    } as unknown as ToolCtx
    // The log write throws — the research result must come back regardless.
    const out = JSON.parse((await TOOL_BY_NAME.research_web.run({ question: 'q1' }, ctx)) as string)
    expect(out.findings).toHaveLength(1)
    failLog = false
    await TOOL_BY_NAME.research_web.run({ questions: ['q1', 'q2'] }, ctx)
    expect(posts[0].entries.map((e: any) => e.question)).toEqual(['q1', 'q2'])
  })

  it('review_model logs the review, hands back its id and the re-read note', async () => {
    const posts: Array<{ path: string; body: any }> = []
    const out = JSON.parse(
      (await TOOL_BY_NAME.review_model.run({}, {
        api: async (_m: string, path: string, body: any) => {
          posts.push({ path, body })
          if (path === '/api/v1/provenance/review') return { id: 'rev123' }
          return { ok: true }
        },
        ui: async () => ({}),
        activeDb: 'demo-model',
        review: async () => ({
          text: 'Should fix: the lid.',
          outcome: 'ok' as const,
          reasoning_chars: 0,
          attempts: 1,
          ms: 1
        })
      } as unknown as ToolCtx)) as string
    )
    expect(out.review_id).toBe('rev123')
    expect(out.note).toMatch(/re-read the/i)
    expect(out.note).toMatch(/resolutions/)
    const logged = posts.find((p) => p.path === '/api/v1/provenance/review')
    expect(logged?.body.review).toBe('Should fix: the lid.')
  })

  it('review_model with resolutions only records — the reviewer is never called', async () => {
    let reviewed = false
    const posts: Array<{ path: string; body: any }> = []
    const out = JSON.parse(
      (await TOOL_BY_NAME.review_model.run(
        { resolutions: [{ finding: 'lid lacks forming', resolution: 'open', reason: 'below 10 %' }] },
        {
          api: async (_m: string, path: string, body: any) => (
            posts.push({ path, body }),
            { recorded: 1, open: 1 }
          ),
          ui: async () => ({}),
          activeDb: 'demo-model',
          review: async () => (
            (reviewed = true),
            { text: 'x', outcome: 'ok' as const, reasoning_chars: 0, attempts: 1, ms: 1 }
          )
        } as unknown as ToolCtx
      )) as string
    )
    expect(reviewed).toBe(false)
    expect(out.open).toBe(1)
    expect(posts[0].path).toBe('/api/v1/provenance/review/resolutions')
    expect(posts[0].body.resolutions[0].resolution).toBe('open')
  })
})

describe('tool argument edge cases', () => {
  const spyCtx = (
    answer: (method: string, path: string, body?: any) => unknown
  ): { calls: Array<{ method: string; path: string; body?: any }>; ctx: any } => {
    const calls: Array<{ method: string; path: string; body?: any }> = []
    const ctx = {
      api: async (m: string, p: string, b?: unknown) => {
        calls.push({ method: m, path: p, body: b })
        return answer(m, p, b)
      },
      ui: async () => ({ ok: true }),
      activeDb: 'demo-model'
    }
    return { calls, ctx }
  }

  it('explain_result forwards a single scenario instead of dropping it', async () => {
    const s = spyCtx(() => ({ meta: {}, tree: null }))
    await TOOL_BY_NAME.explain_result.run({ mode: 'tree', database: 'd', code: 'c', scenario: 'sc1' }, s.ctx)
    const post = s.calls.find((c) => c.method === 'POST')
    expect(post?.body?.scenario).toBe('sc1')
  })

  it('set_formula without a formula is refused rather than treated as "remove"', async () => {
    const s = spyCtx(() => ({ ok: true, exchange: { uid: 'u', amount: 1 } }))
    const out = String(
      await TOOL_BY_NAME.edit_exchange.run(
        { action: 'set_formula', activity_database: 'd', activity_code: 'c', uid: 'u' },
        s.ctx
      )
    )
    expect(out).toMatch(/requires: formula/)
    expect(s.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('a batch of exactly one process resolves by its own code', async () => {
    const s = spyCtx((m, p) =>
      m === 'GET' && p.includes('/model/activities/')
        ? [{ code: 'X', name: 'x', location: 'GLO' }]
        : { ok: true }
    )
    await TOOL_BY_NAME.edit_process.run({ processes: [{ code: 'X', comment: 'new words' }] }, s.ctx)
    const post = s.calls.find((c) => c.method === 'POST')
    expect(post?.body?.code).toBe('X')
  })

  it('a stated location that no process carries is refused, not ignored', async () => {
    const s = spyCtx((m, p) =>
      m === 'GET' && p.includes('/model/activities/')
        ? [{ code: 'fr', name: 'Strom', location: 'FR' }]
        : { ok: true }
    )
    const out = String(
      await TOOL_BY_NAME.edit_process.run({ current_name: 'Strom', location: 'DE', comment: 'c' }, s.ctx)
    )
    expect(out).toContain('not with location')
    expect(s.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('an invalid activity type inside a batch item is refused for that item', async () => {
    const s = spyCtx(() => ({ results: [], content_terms: ['steel'], count: 0 }))
    const out = String(
      await TOOL_BY_NAME.search_background.run(
        { database: 'eco', queries: [{ query: 'steel', activity_types: ['markets'] }] },
        s.ctx
      )
    )
    expect(out).toContain('Unknown activity type')
    expect(s.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })
})

describe('the link-time reminder', () => {
  const linkCtx = (inspected: Set<string> | undefined): ToolCtx => ({
    api: (async (_m: string, path: string, body: any) => {
      if (path === '/api/v1/model/exchanges')
        return {
          exchange: {
            uid: `u-${body.input_code}`,
            type: body.type ?? 'technosphere',
            input: {
              database: body.input_database,
              code: body.input_code,
              name: `name of ${body.input_code}`
            }
          }
        }
      return { ok: true }
    }) as ToolCtx['api'],
    ui: async () => ({}),
    activeDb: 'M',
    inspected
  })

  it('names the background datasets a link call used that nobody has opened', async () => {
    const out = JSON.parse(
      (await TOOL_BY_NAME.edit_exchange.run(
        {
          activity_code: 'p',
          action: 'add',
          exchanges: [
            { input_database: 'ei', input_code: 'pp', amount: 3.2 },
            { input_database: 'ei', input_code: 'steel', amount: 1.1 },
            // read before — no reminder
            { input_database: 'ei', input_code: 'water', amount: 0.4 },
            // the model's own process — not background
            { input_database: 'M', input_code: 'sub', amount: 1 },
            // an elementary flow — not a dataset
            { input_database: 'biosphere3', input_code: 'co2', amount: 0.1, type: 'biosphere' }
          ]
        },
        linkCtx(new Set([inspectedKey('ei', 'water')]))
      )) as string
    )
    expect(out.succeeded).toBe(5)
    expect(out.not_yet_opened.map((l: any) => l.code)).toEqual(['pp', 'steel'])
    expect(out.not_yet_opened[0].name).toBe('name of pp')
    expect(out.open_before_relying).toMatch(/^You linked 2 background dataset/)
  })

  it('stays silent once everything linked has been opened, and without run memory', async () => {
    const add = { action: 'add', activity_code: 'p', input_database: 'ei', input_code: 'pp', amount: 1 }
    const opened = JSON.parse(
      (await TOOL_BY_NAME.edit_exchange.run(add, linkCtx(new Set([inspectedKey('ei', 'pp')])))) as string
    )
    expect(opened.uid).toBe('u-pp')
    expect(opened.not_yet_opened).toBeUndefined()
    const noMemory = JSON.parse((await TOOL_BY_NAME.edit_exchange.run(add, linkCtx(undefined))) as string)
    expect(noMemory.open_before_relying).toBeUndefined()
  })

  it('counts the new dataset of a replace_input', async () => {
    const ctx = linkCtx(new Set())
    const api = ctx.api
    ctx.api = (async (m: string, path: string, body?: any) =>
      m === 'GET' && path.includes('/api/v1/model/activities/')
        ? {
            exchanges: [
              { uid: 'u-old', type: 'technosphere', amount: 2, input: { database: 'ei', code: 'old' } }
            ]
          }
        : api(m as any, path, body)) as ToolCtx['api']
    const out = JSON.parse(
      (await TOOL_BY_NAME.edit_exchange.run(
        {
          action: 'replace_input',
          activity_code: 'p',
          input_database: 'ei',
          input_code: 'old',
          new_input_code: 'new'
        },
        ctx
      )) as string
    )
    expect(out.not_yet_opened.map((l: any) => l.code)).toEqual(['new'])
  })

  it('caps the list, says how many more there are, and names a dataset once', async () => {
    const exchanges = Array.from({ length: UNOPENED_LINKS_SHOWN + 3 }, (_, i) => ({
      input_database: 'ei',
      input_code: `c${i}`,
      amount: 1
    }))
    const out = JSON.parse(
      (await TOOL_BY_NAME.edit_exchange.run(
        { activity_code: 'p', action: 'add', exchanges: [...exchanges, exchanges[0]] },
        linkCtx(new Set())
      )) as string
    )
    expect(out.not_yet_opened).toHaveLength(UNOPENED_LINKS_SHOWN)
    expect(out.not_yet_opened_more).toBe(3)
    expect(out.open_before_relying).toMatch(/^You linked 15 background dataset/)
  })
})
