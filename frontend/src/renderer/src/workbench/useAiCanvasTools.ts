/**
 * The handlers the in-app assistant uses to drive the canvas and the results UI (invoked from
 * CanvasChat), plus the deferred cross-page jump. Extracted from Workbench.tsx (wave 4.1, stage 6):
 * the ~150-line `chatUi` memo consumed almost nothing but the canvas API, and the Workbench only
 * ever handed it through to the chat dock.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatUiHandlers } from '../CanvasChat'
import { isBox, shownTags, type BoxData, type Tag } from '../lib/occurrences'
import { splitId } from '../lib/canvas'
import { viewLoaded, viewSet, viewSync } from '../lib/modelView'
import { readLs } from '../lib/persist'
import { fetchQuery } from '../lib/server/useQuery'
import { resolveSplit } from '../views/results/splitBy'
import type { MethodEntry } from '../lib/methods'
import type { ViewKey } from './AppSidebar'
import type { useCanvasModel } from './useCanvasModel'

type Canvas = ReturnType<typeof useCanvasModel>

export interface AiCanvasToolsDeps {
  activeDb: string | null
  methods: MethodEntry[]
  chosen: string
  setChosen: (v: string) => void
  calcBusy: 'calc' | 'mc' | null
  /** The canvas calculation (Sankey overlay) — owned by the Workbench, which holds the result bar. */
  calculate: (methodOverride?: string[], codeOverride?: string) => void
  view: ViewKey
  setView: (v: ViewKey) => void
  setResultsTab: (tab: 'overview' | 'detail') => void
  reloadAudit: () => Promise<void>
  refreshDatabases: () => Promise<unknown>
  reloadTagGroups: () => Promise<void>
  canvas: Pick<
    Canvas,
    | 'nodes'
    | 'setNodes'
    | 'setEdges'
    | 'selected'
    | 'setSelected'
    | 'selectOnly'
    | 'nodesRef'
    | 'edgesRef'
    | 'posRef'
    | 'rfRef'
    | 'autoLayout'
    | 'deleteRef'
    | 'reloadGraph'
  >
}

// The return type is the API surface; spelling it out would be a hand-kept copy of the signatures.
export function useAiCanvasTools(deps: AiCanvasToolsDeps) {
  const {
    activeDb,
    methods,
    chosen,
    setChosen,
    calcBusy,
    calculate,
    view,
    setView,
    setResultsTab,
    reloadAudit,
    refreshDatabases,
    reloadTagGroups,
    canvas
  } = deps
  const {
    nodes,
    setNodes,
    setEdges,
    selected,
    setSelected,
    selectOnly,
    nodesRef,
    edgesRef,
    posRef,
    rfRef,
    autoLayout,
    deleteRef,
    reloadGraph
  } = canvas
  // Read inside AI tool handlers, which are created once and would otherwise close over a stale view.
  const viewRef = useRef<ViewKey>(view)
  viewRef.current = view

  /**
   * Jump to a process from a page that is not the canvas.
   *
   * `chatUi.jumpToProcess` needs the ReactFlow instance, and that only exists while the Model view is
   * mounted — so from Parameters the code is parked, the view switches, and the effect below performs the
   * jump once the node is actually there. Parked in state rather than done immediately because the graph
   * of a model that was never opened arrives a request later.
   */
  const [pendingJump, setPendingJump] = useState<string | null>(null)
  const jumpFromAnyPage = useCallback(
    (code: string) => {
      setPendingJump(code)
      setView('model')
    },
    [setView]
  )

  useEffect(() => {
    if (!pendingJump || view !== 'model' || !activeDb) return
    if (!nodesRef.current.some((n) => n.id === `${activeDb}/${pendingJump}`)) return
    chatUiRef.current?.jumpToProcess(pendingJump)
    setPendingJump(null)
  }, [pendingJump, view, activeDb, nodes, nodesRef])

  // Handlers the assistant uses to drive the canvas/results UI (invoked from CanvasChat).
  const chatUi: ChatUiHandlers = useMemo(
    () => ({
      jumpToProcess: (code) => {
        if (!activeDb) return
        const id = `${activeDb}/${code}`
        selectOnly(id)
        const inst = rfRef.current
        const node = inst?.getNode?.(id) ?? nodesRef.current.find((n) => n.id === id)
        if (node && inst?.setCenter)
          inst.setCenter(node.position.x + 110, node.position.y + 40, { zoom: 1, duration: 400 })
        else inst?.fitView?.({ nodes: [{ id }], padding: 0.5, duration: 400 })
      },
      autoLayout: () => autoLayout('Auto-layout (assistant)'),
      screenshotRect: () => {
        const el = document.querySelector('.react-flow') as HTMLElement | null
        if (!el) return null
        const r = el.getBoundingClientRect()
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height)
        }
      },
      calculateInCanvas: async (method, code) => {
        if (!activeDb) return { error: 'No model open.' }
        // An explicit code from the assistant beats the selection; select it too so the user sees it.
        let target = code
        if (!target) {
          if (selected.length !== 1)
            return { error: 'Pass a process code, or ask the user to select exactly one process.' }
          target = splitId(selected[0])[1]
        } else {
          const id = `${activeDb}/${target}`
          if (!nodesRef.current.some((n) => n.id === id))
            return { error: `Process "${target}" is not in the active model.` }
          selectOnly(id)
        }
        const idx = methods.findIndex((m) => m.method.join('') === method.join(''))
        if (idx >= 0) setChosen(String(idx))
        calculate(method.length ? method : undefined, target)
        // Deliberately not a result: the canvas calculation runs on its own and paints when it is
        // done, so this call can only report that it was started. Saying so is the point — a
        // model once turned "Calculating on the canvas…" into "the Sankey shows the split"
        // in its answer to the user, which it had no way of knowing.
        return {
          started: true,
          note:
            'The canvas calculation was STARTED. This call does not wait for it, so it is not ' +
            'evidence that a banner or Sankey appeared, and it returns no score — do not tell the ' +
            'user what the canvas shows. Use `calculate` if you need the number itself.'
        }
      },
      setupResults: async (args) => {
        const tab = args.tab === 'detailed' || args.tab === 'detail' ? 'detail' : 'overview'
        setResultsTab(tab)
        if (typeof args.stacked === 'boolean')
          localStorage.setItem('prism.ov.stacked', JSON.stringify(args.stacked))
        // Every write below merges into the model's stored Results view. Before that view has been read,
        // the merge would start from an empty section and replace the stored one whole — indicators,
        // subjects, colours gone. So nothing is written into a view that could not be read, and the
        // readback below then shows that nothing took.
        const view = activeDb && (await viewLoaded(activeDb)) ? activeDb : null
        // The split is the model's, so it goes where the Results page reads it (views/results/splitBy.ts).
        if (typeof args.split_by === 'string' && view) {
          const results = (viewSync(view).results as Record<string, unknown> | undefined) ?? {}
          viewSet(view, 'results', { ...results, stackBy: args.split_by })
        }
        // Indicators: declared in the schema since the tool exists, written by nobody at first
        // — a call that named three methods left the eleven the view had before. Matched against the
        // methods the app knows, by tuple; unknown ones are reported back, not silently dropped.
        const wanted = Array.isArray(args.methods)
          ? (args.methods as unknown[]).filter(
              (m): m is string[] => Array.isArray(m) && m.every((x) => typeof x === 'string')
            )
          : []
        const unknownMethods: string[] = []
        if (wanted.length && view) {
          const picked = wanted.flatMap((tuple) => {
            const key = tuple.join(' · ')
            const info = methods.find((m) => m.method.join(' · ') === key)
            if (!info) {
              unknownMethods.push(key)
              return []
            }
            return [
              {
                key,
                method: info.method,
                family: info.method[0],
                label: info.method[1] ?? info.method[0],
                detail: info.method[2] ?? '',
                unit: info.unit
              }
            ]
          })
          if (picked.length) {
            const results = (viewSync(view).results as Record<string, unknown> | undefined) ?? {}
            viewSet(view, 'results', { ...results, picked })
          }
        }
        const scen: Record<string, boolean> = {}
        let baseline = false
        if (Array.isArray(args.subjects)) {
          const fg: Record<string, boolean> = {}
          const bg: Array<{ database: string; code: string; name: string }> = []
          for (const s of args.subjects as Array<{ database: string; code: string; scenario?: string }>) {
            // A scenario is not a subject of its own here: the page computes every ticked process
            // under every ticked scenario. So the same process named once per scenario becomes one
            // process plus a set of scenario ticks — which is what draws the grouped bars a user
            // gets in four clicks and the assistant could not ask for at all (V302).
            if (s.scenario) scen[s.scenario] = true
            else baseline = true
            if (s.database === activeDb) fg[s.code] = true
            else bg.push({ database: s.database, code: s.code, name: s.code })
          }
          // Through the model's view store — the same place `useViewField(db, 'results', …)` reads
          // in Results.tsx. It used to write the per-model localStorage keys, which that view stopped
          // reading when the state moved out of the browser: the tool answered `ok`, the model told
          // the user the view was ready, and the page said "Pick a subject first" (which cost
          // the user the chart they had asked for).
          if (view && (Object.keys(fg).length || bg.length)) {
            const results = (viewSync(view).results as Record<string, unknown> | undefined) ?? {}
            viewSet(view, 'results', {
              ...results,
              ...(Object.keys(fg).length ? { subjSel: fg } : {}),
              ...(bg.length ? { bgSubjects: bg } : {}),
              // Only when scenarios were actually named: an ordinary call must not switch the
              // baseline off or clear a selection the user made on the page.
              ...(Object.keys(scen).length ? { scenSel: scen, baseline } : {})
            })
          }
        }
        // Only follow the assistant to the results page if the user is already looking at it. Switching
        // an unrelated view away mid-run took the canvas out from under someone who was watching the
        // model being built, and dropped them on a page that had not been calculated yet — which reads
        // as data loss, not as progress. Prepared silently is enough; the assistant says it in the chat.
        // `run: true` is the exception the user asked for (V384): the agent wants the computed charts
        // in front of the user, so the page opens AND calculates — the Results view picks the request
        // token up (`runRequested`) once its subjects and indicators are loaded.
        // Only the overview consumes the token (Results.tsx); the detailed tree has no automatic run,
        // so a `run` there is refused rather than reported as started.
        const runWanted = args.run === true
        const run = runWanted && tab === 'overview'
        if (run && view) {
          const results = (viewSync(view).results as Record<string, unknown> | undefined) ?? {}
          viewSet(view, 'results', { ...results, runRequested: Date.now() })
        }
        const wasThere = viewRef.current === 'results'
        if (wasThere || run) setView('results')
        // What the view NOW holds, read back from the store rather than echoed from the arguments.
        // `ok: true` was all this used to say, so a setting that never arrived looked exactly like one
        // that did — and the model told the user a chart was ready that the page could not draw
        // (V300/V301, LH-Lasur run). Reading it back is what makes the difference visible.
        const held =
          (activeDb ? (viewSync(activeDb).results as Record<string, unknown> | undefined) : null) ?? {}
        const on = (v: unknown): string[] =>
          Object.entries((v as Record<string, boolean>) ?? {})
            .filter(([, chosen]) => chosen)
            .map(([key]) => key)
        // The split the page shows, which is the model's tag family until one is chosen.
        const tagGroups = (await fetchQuery('/api/v1/model/tag-groups').catch(() => null))?.groups ?? []
        return {
          tab: tab === 'detail' ? 'detailed' : 'overview',
          subjects: on(held.subjSel),
          background_subjects: ((held.bgSubjects as Array<{ code: string }> | undefined) ?? []).map(
            (b) => b.code
          ),
          scenarios: on(held.scenSel),
          methods: ((held.picked as Array<{ method: string[] }> | undefined) ?? []).map((m) => m.method),
          ...(unknownMethods.length ? { methods_not_found: unknownMethods } : {}),
          stacked: readLs('prism.ov.stacked', false),
          split_by: resolveSplit(held.stackBy as string | undefined, tagGroups, activeDb),
          ...(run && view ? { run: 'started' } : {}),
          ...(runWanted && !run
            ? {
                run: 'not_started',
                run_note:
                  'run=true applies to tab="overview" only; the detailed tree is computed when the user selects a subject there.'
              }
            : {}),
          note:
            'This is what the view holds now. Anything you asked for that is missing here did not ' +
            'take — say so rather than reporting it as done. ' +
            (run
              ? 'The Results page is open and calculating; this answer carries no scores.'
              : wasThere
                ? 'The user is on the results page and can see it.'
                : 'The user is on another page: tell them it is ready, do not assume they can see it.')
        }
      },
      getCanvas: () => ({
        nodes: nodesRef.current.map((n) => {
          // Node names live in data.label (see nodeData) — not data.name.
          const d = n.data as { label?: string; readOnly?: boolean } & BoxData & { tags?: Tag[] }
          return {
            id: n.id,
            code: splitId(n.id)[1],
            database: splitId(n.id)[0],
            name: d.label ?? null,
            kind: d.readOnly ? 'reference' : 'foreground',
            selected: !!n.selected,
            // One dataset may stand here several times, one box per tag combination in effect for its
            // inputs; `inherited` marks a value its inputs do not hold themselves (as in get_model_graph).
            ...(isBox(n) ? { inputs: d.uids ?? [], tags: shownTags(n) } : {})
          }
        })
      }),
      clearCanvas: () => {
        // Remove all read-only reference boxes from the view (does not touch the model / ecoinvent).
        const refIds = new Set(
          nodesRef.current.filter((n) => (n.data as { readOnly?: boolean }).readOnly).map((n) => n.id)
        )
        if (!refIds.size) return { removed: 0 }
        refIds.forEach((r) => delete posRef.current[r])
        const keptN = nodesRef.current.filter((n) => !refIds.has(n.id))
        const keptE = edgesRef.current.filter((e) => !refIds.has(e.source) && !refIds.has(e.target))
        nodesRef.current = keptN
        edgesRef.current = keptE
        setNodes(keptN)
        setEdges(keptE)
        setSelected([])
        return { removed: refIds.size }
      },
      removeFromCanvas: async (code) => {
        const refs = nodesRef.current.filter((n) => (n.data as { readOnly?: boolean }).readOnly)
        const exact = refs.find((n) => n.id === code)
        const byCode = refs.filter((n) => splitId(n.id)[1] === code)
        if (!exact && byCode.length > 1)
          return {
            error: `"${code}" stands on the canvas ${byCode.length} times (one box per tag); pass the box id.`,
            ids: byCode.map((n) => n.id)
          }
        const node = exact ?? byCode[0]
        if (!node) return { error: `No reference "${code}" on the canvas.` }
        // The tool promises a VIEW change ("nothing is deleted"). A box that still feeds inputs can
        // only go together with those exchanges — deleteRef asks the user in a dialog, which an
        // external agent neither sees nor can answer: the call timed out after 30 s and the dialog
        // stayed open, one click away from deleting an input the agent believed untouched.
        // Refuse instead, and say what to remove first.
        const feeds = edgesRef.current.filter(
          (e) =>
            e.source === node.id &&
            splitId(e.target)[0] === activeDb &&
            Boolean((e.data as { uid?: string } | undefined)?.uid)
        )
        if (feeds.length)
          return {
            error:
              `"${code}" still supplies ${feeds.length} input(s) of your processes; removing the box would delete them. ` +
              'Remove those exchanges first (edit_exchange action="remove", uid from get_process_details) — the box then disappears with the last one.',
            feeds: feeds.map((e) => ({ process: splitId(e.target)[1], uid: (e.data as { uid: string }).uid }))
          }
        // Waits for the answer: a supplier with real inputs opens a confirm first, and the user may say no.
        const removed = await deleteRef(node.id)
        return removed
          ? { ok: true, removed: node.id }
          : { error: `"${code}" was not removed — the user declined or the removal failed.` }
      },
      refresh: (opts) => {
        // After an AI edit: reload the canvas graph, audit log, database list and tag groups so the
        // UI reflects the change immediately (previously only a manual model reload showed it). The
        // graph is skipped when the edit was to another model (an assistant working there in parallel).
        if (activeDb && opts?.canvas !== false) {
          void reloadGraph(activeDb).then(() => {
            // After the rebuild, so the new boxes are in the frame. Only on the model view: elsewhere
            // the canvas is not mounted, and it fits itself when it is shown again.
            if (opts?.fit && viewRef.current === 'model')
              requestAnimationFrame(() =>
                setTimeout(() => rfRef.current?.fitView({ padding: 0.2, duration: 400 }), 120)
              )
          })
        }
        // Nobody waits on this reload to show its error: a log that cannot be read now is read again on the
        // next edit, and the caches went stale regardless (reloadAudit).
        void reloadAudit().catch(() => {})
        void refreshDatabases()
        void reloadTagGroups()
      }
    }),
    // chosen/calcBusy: calculateInCanvas closes over calculate(), which reads them — without
    // these deps the assistant path could run with a stale busy-guard or default method.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activeDb,
      methods,
      selected,
      chosen,
      calcBusy,
      reloadGraph,
      reloadAudit,
      refreshDatabases,
      reloadTagGroups,
      deleteRef
    ]
  )

  // The handlers behind a ref, so the deferred jump above can call the latest one without listing the
  // whole object as a dependency (it is rebuilt on every selection change).
  const chatUiRef = useRef<ChatUiHandlers | null>(null)
  chatUiRef.current = chatUi

  return { chatUi, jumpFromAnyPage }
}
