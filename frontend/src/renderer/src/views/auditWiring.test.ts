import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Two joins that only a source scan can hold, in the manner of the backend's `lca.`-call scan and
 * the tool-count cap in `tools.test.ts`.
 *
 * **The filter has to be a query parameter.** `GET /model/audit` reads `database` from the query
 * string. Passed in a request body instead, the route falls back to its default and answers with the
 * whole project's history — a response that is indistinguishable from a filter that does not work,
 * and it cost 72 seconds of proving a working backend fix was broken. A type-check cannot see it:
 * both spellings compile.
 *
 * **The undo buttons have to read the history.** `GET /model/history` existed for months and nothing
 * called it, so Undo and Redo were permanently enabled and never said what they would take back.
 * That is also what made the project-switch fault invisible — the stacks were cleared or not
 * and the toolbar looked the same either way. A button that stops being bound to `can_undo` compiles
 * and renders perfectly.
 */
const read = (...parts: string[]): string => readFileSync(join(__dirname, '..', ...parts), 'utf-8')

describe('the model-scoped audit list', () => {
  const views = ['views/Parameters.tsx', 'views/Scenarios.tsx'] as const

  it.each(views)('%s asks for the active model, in the query string', (file) => {
    const src = read(file)
    const calls = src.match(/api<AuditEntry\[\]>\([^)]*\)/g) ?? []
    expect(calls, `${file} no longer fetches the audit log at all`).toHaveLength(1)
    // The URL is a template literal carrying `q`, which both views build as `?database=…`.
    expect(calls[0]).toMatch(/`\/api\/v1\/model\/audit\$\{q\}`/)
    expect(src).toMatch(/const q = `\?database=\$\{encodeURIComponent\(activeDb\)\}`/)
  })

  it.each(views)('%s does not pass the filter in a request body', (file) => {
    // `api(method, path, body)` — a third argument on this call is the mistake described above.
    expect(read(file)).not.toMatch(/'\/api\/v1\/model\/audit'\s*,\s*\{/)
    expect(read(file)).not.toMatch(/model\/audit`\s*,\s*\{/)
  })

  it('the canvas panel asks for the open model too, in the query string', () => {
    // It used to be unfiltered: on "Mould remover R7" it showed 137 lines of another model and none
    // of its own, read as R7's history. Workspace-wide actions now come back marked in every
    // model's list, so no view is needed for them alone.
    const src = read('Workbench.tsx')
    expect(src).toMatch(/`\/api\/v1\/model\/audit\?database=\$\{encodeURIComponent\(db\)\}`/)
  })
})

describe('what a model mutation makes stale', () => {
  it('drops the tag-group list, whose per-group model list drives the result pickers', () => {
    // A first tag assignment changes which models use a group, not the groups: before this, Group by
    // offered only "— off —" until an unrelated group was created. Every
    // mutation — tag menu, bulk tagging, undo, the assistant — passes through reloadAudit.
    const src = read('Workbench.tsx')
    const body = src.slice(src.indexOf('const reloadAudit = useCallback'))
    expect(body.slice(0, body.indexOf('}, [fetchAudit'))).toContain('invalidateModelCaches()')
    expect(read('lib/server/modelCaches.ts')).toContain("'/api/v1/model/tag-groups'")
  })

  it('reaches the caches from an assistant edit on every view, not only where the chat panel is', () => {
    // The panel exists on the Model view only; goal and scope written while the Overview showed opened
    // empty from the cache. The Workbench hears the edits and reloads through the chat's own refresh,
    // which reloads the audit — the step that marks the caches stale (behaviour: Workbench.dom.test.tsx).
    expect(read('Workbench.tsx')).toMatch(/useAiEditRefresh\(activeDb, chatUi\.refresh\)/)
    expect(read('lib/server/modelCaches.ts')).toContain("'/api/v1/study'")
  })
})

describe('the undo and redo buttons', () => {
  const src = read('Workbench.tsx')

  it('read GET /model/history, for the open model', () => {
    expect(src).toMatch(/api<UndoState>\(/)
    expect(src).toMatch(/`\/api\/v1\/model\/history\?database=\$\{encodeURIComponent\(db\)\}`/)
  })

  it('send the open model with every step, so another model’s change is refused, not taken back', () => {
    // Sent from workbench/useHistorySteps.ts, which also weighs them against the canvas's own history.
    expect(read('workbench/useHistorySteps.ts')).toMatch(/activeDb \? \{ database: activeDb \} : \{\}/)
  })

  // The buttons themselves live in workbench/ModelToolbar.tsx — written ONCE as an
  // `undoRedo` fragment and rendered in both toolbars (Overview and the canvas), so the pin is "one
  // definition, two render sites".
  const toolbar = read('workbench/ModelToolbar.tsx')

  it('are disabled when there is nothing to undo or redo', () => {
    expect(toolbar.match(/disabled=\{!p\.undoState\.can_undo\}/g) ?? []).toHaveLength(1)
    expect(toolbar.match(/disabled=\{!p\.undoState\.can_redo\}/g) ?? []).toHaveLength(1)
    expect(toolbar.match(/\{undoRedo\}/g) ?? []).toHaveLength(2)
  })

  it('say what they would take back', () => {
    expect(toolbar.match(/Undo: \$\{p\.undoState\.next_undo\}/g) ?? []).toHaveLength(1)
    expect(toolbar.match(/Redo: \$\{p\.undoState\.next_redo\}/g) ?? []).toHaveLength(1)
    // …and say so when there is nothing, rather than showing a bare verb.
    expect(toolbar.match(/'Nothing to undo'/g) ?? []).toHaveLength(1)
  })

  it('re-read the history when the view or the model changes', () => {
    // The pair sits on two pages, but a parameter set on Parameters or a scenario created on
    // Scenarios is an undoable command issued from a page that has no toolbar. Without this effect
    // the state was whatever it was when you left: Undo greyed out although something was undoable,
    // or a tooltip naming a step other than the one it would take back. A rendered assertion would
    // mean mounting the whole Workbench, so this is a source join like the two above.
    const effect = src.slice(src.indexOf('void reloadHistory()'))
    expect(effect.slice(0, 120)).toMatch(/\}, \[view, activeDb, reloadHistory\]\)/)
    expect(src).toMatch(/const reloadHistory = useCallback/)
    // …and it must be the cheap call, not the whole audit log on every navigation.
    const cheap = src.slice(src.indexOf('const reloadHistory'))
    expect(cheap.slice(0, 200)).not.toMatch(/model\/audit/)
  })

  it('are told about writes made on the two pages that carry no toolbar of their own', () => {
    // Measured on the running app: setting a parameter left Undo greyed out as “Nothing to
    // undo” while its line was already in the audit list beside it, and Redo stayed enabled on a stack
    // that write had just cleared — clicking it produced the “Nothing to redo.” banner. The effect
    // above only fires on a navigation, and these two pages write through their own `api()` call. So
    // both must report upward, and the report must re-read the history rather than only the graph.
    const params = src.slice(src.indexOf('<Parameters'), src.indexOf('<Lcia'))
    expect(params).toMatch(/onChanged=\{\(\) => \{[^}]*reloadHistory\(\)/s)
    expect(params).toMatch(/<Scenarios[^>]*onChanged=\{\(\) => void reloadHistory\(\)\}/s)
    // …and the other direction: an Undo from the toolbar has to reach the page under it, or the row
    // keeps showing the value the undo took back (measured: 4.25 shown, 3.95 held).
    expect(params).toMatch(/<Parameters[\s\S]*?rev=\{modelRev\}/)
    expect(params).toMatch(/<Scenarios[^>]*rev=\{modelRev\}/)
  })

  it('leave no panel showing what an Undo took back', () => {
    // The per-node tag menu keeps its own copy of that node's tags, written optimistically when it
    // sets one, so an Undo from the toolbar left it offering a value the model no longer carried.
    // The menu lives in workbench/useTagging.ts.
    const tagging = read('workbench/useTagging.ts')
    const effect = tagging.slice(tagging.indexOf('const id = tagMenu?.id'))
    expect(effect.slice(0, 600)).toContain('fetchNodeTags(id)')
    expect(effect.slice(0, 600)).toMatch(/\}, \[modelRev\]\)/)
  })

  it('re-read the history after a project switch, where the backend clears the stacks', () => {
    // `activateProject` lives in workbench/useProjectModels.ts; the pinned behaviour —
    // the switch endpoint AND a history re-read in the same body.
    const pm = read('workbench/useProjectModels.ts')
    const activate = pm.slice(pm.indexOf('const activateProject'))
    const body = activate.slice(0, activate.indexOf('const deleteProject'))
    expect(body).toContain('/projects/${encodeURIComponent(name)}/activate')
    expect(body).toContain('reloadAudit()')
  })
})
