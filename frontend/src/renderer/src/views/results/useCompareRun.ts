import { useEffect, useRef, useState } from 'react'
import { api, isSuperseded } from '../../lib/api'
import { errMsg } from '../../lib/errors'
import { useViewField } from '../../lib/modelView'
import type {
  CompareResponse,
  CompareSubject,
  Matrix,
  MatrixRow,
  Picked,
  StackedData,
  StackedResp,
  WhyData
} from './types'
import { gatherWhy } from './whySplits'

/**
 * The Results page's run machinery: one request per subject (scores with the life cycle inventory and what makes
 * the difference, then the stacked split — one for both under a scenario), the generation guard that turns a
 * cancelled or superseded run's answers into no-ops, the stale flag, and the assistant's `setup_results run=true`
 * token. Moved out of Results.tsx verbatim; the effects keep their order because the page calls this hook where
 * the block used to stand.
 */
export function useCompareRun({
  activeDb,
  subjects,
  picked,
  stacked,
  stackDims,
  subjKey,
  methKey,
  dimsKey,
  rev,
  scenarioOverridesKey,
  inputsReady,
  setErr
}: {
  activeDb: string | null
  subjects: CompareSubject[]
  picked: Picked[]
  stacked: boolean
  stackDims: string[]
  subjKey: string
  methKey: string
  dimsKey: string
  rev: number | undefined
  scenarioOverridesKey: string
  /** Everything an assistant-requested run depends on has answered (ticked scenarios, tag families). */
  inputsReady: boolean
  setErr: (e: string | null) => void
}) {
  const [matrix, setMatrix] = useState<Matrix | null>(null)
  const [why, setWhy] = useState<WhyData | null>(null)
  const [busy, setBusy] = useState(false)
  const [stackData, setStackData] = useState<StackedData | null>(null)
  const [stackBusy, setStackBusy] = useState(false)
  const [stale, setStale] = useState(false)
  // Monotonic run id: a cancelled/superseded run's responses must not touch state.
  const runSeq = useRef(0)
  useEffect(() => {
    if (!subjects.length || !picked.length) {
      runSeq.current++
      setMatrix(null)
      setWhy(null)
      setStackData(null)
      setBusy(false)
      setStackBusy(false)
      setStale(false)
      return
    }
    setStale(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjKey, methKey, stacked, dimsKey, rev, scenarioOverridesKey])

  // Progress: the run is split into ONE REQUEST PER SUBJECT (matrix, then stacked), so the bar
  // advances after every completed subject and Cancel takes effect between (and within) steps.
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null)

  const [lastSecs, setLastSecs] = useState<number | null>(null)

  // An assistant's `setup_results run=true` (V384): the token lands in the view store; once subjects
  // and indicators are in and nothing is running, calculate once per token — never twice, and never
  // for a token from before this mount.
  // An assistant's `setup_results run=true` (V384): the request token lands in the view store; the
  // handled token lives there too, so a remount (model switch, restart) does not replay a run.
  const [runRequested] = useViewField<number>(activeDb, 'results', 'runRequested', 0)
  const [runHandled, setRunHandled] = useViewField<number>(activeDb, 'results', 'runHandled', 0)
  // Always the current closure: the timer must compute the selection as it is when it fires, not the
  // one it was armed with — an indicator swapped during the delay kept picked.length and would have
  // computed the old one with the stale flag cleared.
  const calculateRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    if (!runRequested || runRequested <= runHandled) return
    if (!subjects.length || !picked.length || !inputsReady || busy || stackBusy) return
    // Any change to what would be computed re-arms the quiet period (same inputs as the stale flag).
    const timer = setTimeout(() => {
      setRunHandled(runRequested)
      calculateRef.current()
    }, 700)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runRequested, runHandled, subjKey, methKey, stacked, dimsKey, inputsReady, busy, stackBusy])

  const calculate = (): void => {
    if (!subjects.length || !picked.length || busy || stackBusy) return
    const mine = ++runSeq.current
    // Everything the selection asks for, whatever view is showing: the normalized view does not draw the
    // stacked split, but a Calculate pressed there used to skip it, and switching to "Per indicator"
    // afterwards showed empty frames asking for another Calculate.
    const wantStacked = stacked
    const total = subjects.length * (wantStacked ? 2 : 1)
    const t0 = Date.now()
    setErr(null)
    setStale(false)
    setLastSecs(null)
    setBusy(true)
    if (wantStacked) setStackBusy(true)
    // The previous run's split goes at once, not when the new one arrives: the new scores are published before
    // their split, and an old split beside them — for good, if the new one fails or is cancelled — was exported
    // as this run's disaggregated sheet next to this run's inventory.
    setStackData(null)
    void (async () => {
      let done = 0
      try {
        const methodsReq = picked.map((p) => p.method)
        const rows: MatrixRow[] = []
        const flows: NonNullable<Matrix['flows']> = {}
        let methodsOut: CompareResponse['methods'] = []
        // A scenario variant is computed inside an applied parameter window — apply, factorise, restore,
        // seconds each. With the split wanted, its scores and its split come from ONE request, so it pays
        // one window instead of two. Processes keep two passes: their scores show before any traversal.
        const together = (s: CompareSubject): boolean => wantStacked && Boolean(s.scenario)
        const splitOf = new Map<number, StackedResp>()
        // What makes the difference is read off the same solves as the scores: every request names the run and
        // all its subjects, and the backend keeps each side until its pair is in (engine/difference_run.py). A
        // scenario alone is asked about too: it has nothing to differ from, and the plan says its baseline is missing.
        const askWhy = subjects.length > 1 || subjects.some((s) => s.scenario)
        const of = subjects.map(({ database, code, scenario, amount }) => ({
          database,
          code,
          scenario,
          amount
        }))
        const whyRun = `${Date.now().toString(36)}-${mine}-${Math.random().toString(36).slice(2)}`
        const answers: NonNullable<CompareResponse['difference']>[] = []
        for (const [i, s] of subjects.entries()) {
          if (runSeq.current !== mine) return
          const label = `${together(s) ? 'Scores and breakdown' : 'Scores'} — ${s.label}`
          setProgress({ done, total, label })
          // The inventory comes along with the scores: read off the same solve, and for a scenario inside the
          // same parameter window, so the LCI table can never describe another calculation than the scores.
          const r = await api<CompareResponse>('POST', '/api/v1/calc/compare', {
            subjects: [s],
            methods: methodsReq,
            inventory: true,
            ...(together(s) ? { stacked_dimensions: stackDims } : {}),
            ...(askWhy ? { difference: { run: whyRun, of, at: i } } : {})
          })
          if (runSeq.current !== mine) return
          methodsOut = r.methods
          if (r.difference) answers.push(r.difference)
          Object.assign(flows, r.inventory_flows)
          rows.push(
            ...r.subjects.map((row) => ({ ...row, database: s.database, code: s.code, scenario: s.scenario }))
          )
          // A split the backend could not compute is left out of the answer; it is asked for on its own in
          // the stacked pass, where its error shows after the scores, as it always has.
          const split = r.stacked?.subjects.length === r.subjects.length ? r.stacked : undefined
          if (split) splitOf.set(i, split)
          done += split ? 2 : 1
          setProgress({ done, total, label })
        }
        setMatrix({ methods: methodsOut, subjects: rows, flows })
        setWhy(answers.length ? gatherWhy(answers, methodsReq) : null)
        setBusy(false)
        if (wantStacked) {
          const merged: StackedData = { dimensions: [], keys: {}, labels: {}, subjects: [] }
          for (const [i, s] of subjects.entries()) {
            if (runSeq.current !== mine) return
            let r = splitOf.get(i)
            if (!r) {
              setProgress({ done, total, label: `Stacked breakdown — ${s.label}` })
              r = await api<StackedResp>('POST', '/api/v1/calc/compare-stacked', {
                subjects: [s],
                methods: methodsReq,
                dimensions: stackDims
              })
              if (runSeq.current !== mine) return
              setProgress({ done: ++done, total, label: `Stacked breakdown — ${s.label}` })
            }
            merged.dimensions = r.dimensions
            merged.subjects.push(
              ...r.subjects.map((row) => ({
                ...row,
                database: s.database,
                code: s.code,
                scenario: s.scenario
              }))
            )
            for (const d of Object.keys(r.keys)) {
              const seen = (merged.keys[d] = merged.keys[d] ?? [])
              for (const k of r.keys[d]) if (!seen.includes(k)) seen.push(k)
              merged.labels![d] = { ...(merged.labels![d] ?? {}), ...(r.labels?.[d] ?? {}) }
            }
          }
          setStackData(merged)
        }
        if (runSeq.current === mine) setLastSecs((Date.now() - t0) / 1000)
      } catch (e) {
        if (runSeq.current === mine && !isSuperseded(e)) setErr(errMsg(e))
      } finally {
        if (runSeq.current === mine) {
          setBusy(false)
          setStackBusy(false)
          setProgress(null)
        }
      }
    })()
  }
  calculateRef.current = calculate

  const cancelCalc = (): void => {
    runSeq.current++ // in-flight responses become no-ops
    setBusy(false)
    setStackBusy(false)
    setProgress(null)
    setStale(true) // nothing (fully) computed — offer Calculate again
    // Bump the backend generations so the running traversals bail at their next checkpoint.
    void api('POST', '/api/v1/calc/cancel', { channel: 'compare' }).catch(() => {})
    void api('POST', '/api/v1/calc/cancel', { channel: 'stacked' }).catch(() => {})
  }

  return { matrix, why, stackData, busy, stackBusy, stale, progress, lastSecs, calculate, cancelCalc }
}
