/**
 * What an assistant run calculated, in the terms of the Model page's toolbar: the process (a box on the
 * canvas, which the functional-unit pill reads from the selection) and the LCIA method (an index into the
 * app's method list, which the selector holds). With both set, the canvas "Calculate" computes what the
 * chat reported. Read from the run's tool calls when it ends (useRunCalculationOnCanvas.ts).
 *
 * Only successful calls count — a refused or failed call computed nothing — and only those after the run's
 * last `calculate_in_canvas`: that call selected its process and set its method itself, so what came before
 * it is superseded, and with nothing after it there is nothing to add. Each half is then resolved on its
 * own, because the Results view merges every `setup_results` into what it holds (useAiCanvasTools'
 * setupResults) — one call may name the subjects and a later one only the methods:
 * - The process: the first subject that is a box of this model, from the latest `setup_results` naming
 *   such a subject. A later call whose subjects are no box of this canvas does not hide it.
 * - The method: the first method the app lists, from the latest `setup_results` naming such a method —
 *   the first indicator the Results page then shows. Tuples only, as the view takes them.
 * - A half that no `setup_results` supplies comes from the run's last `calculate` that computed exactly one
 *   process of this model (no failed item): its process when that is a box, and its method — the first the
 *   app lists when it carried several, none for a whole family or no method at all.
 *
 * A process or a method that does not resolve is left out, and the other half still holds. When the run
 * named a process of this model that is not a box (yet) — created in its last moments, before the canvas
 * reloaded — `awaitedProcessId` says which: the latest set-up's first subject of this model, else the
 * calculation's process. A run that calculated nothing gives nothing.
 */
import type { ToolTrace } from '../lib/ai'

/** The part of a tool trace row read here. */
export type CallTrace = Pick<ToolTrace, 'name' | 'args' | 'status' | 'itemsFailed'>

export interface RunCalculationInput {
  /** The run's tool calls, in order. */
  traces: CallTrace[]
  /** The model on screen, which the run worked on (the caller checks that). */
  activeDb: string
  /** The ids of the boxes on its canvas, `<database>/<code>`. */
  processIds: ReadonlySet<string>
  /** The methods the app lists; the toolbar's selector holds an index into this list. */
  methods: ReadonlyArray<{ method: string[] }>
}

export interface RunCalculation {
  /** The box to select. */
  processId?: string
  /** Only without `processId`: the process of this model the run named, in the canvas's id form, which is
   *  not a box there yet — to be selected once the canvas shows it. */
  awaitedProcessId?: string
  /** The method to choose, as its index in `methods`. */
  methodIndex?: number
}

/** Whether any call of the run could have calculated something the toolbar can show — a cheap test before
 *  anything is asked about the run. */
export function mayHaveCalculated(traces: CallTrace[]): boolean {
  return traces.some((t) => t.status === 'ok' && (t.name === 'setup_results' || t.name === 'calculate'))
}

/** The call's arguments as an object; null when they are not JSON (a cut-off row) or not an object. */
function argsOf(t: CallTrace): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(t.args ?? '')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const isTuple = (m: unknown): m is string[] =>
  Array.isArray(m) && m.length > 0 && m.every((x) => typeof x === 'string')

/** The index of a method as a tool names it: its tuple, or (where the tool takes it) the whole name in one
 *  string, the parts joined by " · ". -1 when the app does not list it. */
function methodIndexOf(m: unknown, methods: RunCalculationInput['methods']): number {
  if (isTuple(m))
    return methods.findIndex((e) => e.method.length === m.length && e.method.every((x, i) => x === m[i]))
  if (typeof m === 'string' && m.trim()) return methods.findIndex((e) => e.method.join(' · ') === m.trim())
  return -1
}

/** The first of the named methods that the app lists. */
function firstListed(named: unknown[], methods: RunCalculationInput['methods']): number | undefined {
  for (const m of named) {
    const i = methodIndexOf(m, methods)
    if (i >= 0) return i
  }
  return undefined
}

/** The canvas id a process of this model has (or will have) as a box; undefined for anything else. */
function processOf(database: unknown, code: unknown, input: RunCalculationInput): string | undefined {
  return database === input.activeDb && typeof code === 'string' && code
    ? `${input.activeDb}/${code}`
    : undefined
}

/** The subjects of a `setup_results` that are processes of this model, as canvas ids, in order. */
function setupProcesses(a: Record<string, unknown>, input: RunCalculationInput): string[] {
  const subjects = Array.isArray(a.subjects) ? (a.subjects as unknown[]) : []
  return subjects.flatMap((s) => {
    const subject = (s ?? {}) as { database?: unknown; code?: unknown }
    const id = processOf(subject.database, subject.code, input)
    return id ? [id] : []
  })
}

/** The first method of a `setup_results` that the app lists. The Results view takes its indicators as
 *  tuples only (useAiCanvasTools' setupResults), so a name given as one string set nothing there either. */
function setupMethod(a: Record<string, unknown>, input: RunCalculationInput): number | undefined {
  const named = Array.isArray(a.methods) ? (a.methods as unknown[]) : []
  return firstListed(named.filter(isTuple), input.methods)
}

/** A `calculate` that computed exactly one process of this model: that process (box or not), its method. */
function fromCalculate(
  a: Record<string, unknown>,
  input: RunCalculationInput
): { process: string; methodIndex?: number } | null {
  // The tool's own reading of its arguments (main/ai/tools/groups/calc.ts): no `database` means the run's
  // model; a job names its one process in `code`, and only its start computes one — status, result and
  // cancel name a job, not a process; otherwise `codes` wins over `code`.
  const database = typeof a.database === 'string' && a.database.trim() ? a.database : input.activeDb
  if (database !== input.activeDb) return null
  if (a.job && String(a.job) !== 'start') return null
  const codes = Array.isArray(a.codes) ? a.codes.map((c) => String(c)).filter(Boolean) : []
  const named = !a.job && codes.length ? codes : [a.code]
  const distinct = new Set(named.filter((c): c is string => typeof c === 'string' && c !== ''))
  if (distinct.size !== 1) return null
  const [code] = distinct
  // The backend's precedence: a family wins (which of its indicators the chat named, the arguments do not
  // say), then `methods`, then `method`. Without any, the backend used its default — not known here.
  let methodIndex: number | undefined
  if (!a.method_family) {
    const many = Array.isArray(a.methods) ? (a.methods as unknown[]) : []
    methodIndex = many.length ? firstListed(many, input.methods) : firstListed([a.method], input.methods)
  }
  return { process: `${input.activeDb}/${code}`, methodIndex }
}

/** The run's last `calculate` that computed exactly one process of this model, or null. */
function lastCalculation(calls: CallTrace[], input: RunCalculationInput): ReturnType<typeof fromCalculate> {
  for (let i = calls.length - 1; i >= 0; i--) {
    // A batch item that failed is a calculation that did not happen; with one process, that is the call.
    if (calls[i].name !== 'calculate' || calls[i].itemsFailed) continue
    const a = argsOf(calls[i])
    const found = a && fromCalculate(a, input)
    if (found) return found
  }
  return null
}

export function runCalculation(input: RunCalculationInput): RunCalculation {
  const { traces } = input
  let from = 0
  for (let i = traces.length - 1; i >= 0; i--) {
    if (traces[i].status === 'ok' && traces[i].name === 'calculate_in_canvas') {
      from = i + 1
      break
    }
  }
  const after = traces.slice(from).filter((t) => t.status === 'ok')
  // Latest first.
  const setups = after
    .filter((t) => t.name === 'setup_results')
    .map(argsOf)
    .filter((a): a is Record<string, unknown> => a !== null)
    .reverse()
  const isBox = (id: string): boolean => input.processIds.has(id)

  let processId: string | undefined
  /** The process of this model the rule would have chosen had it been a box. */
  let named: string | undefined
  for (const a of setups) {
    const processes = setupProcesses(a, input)
    named ??= processes[0]
    processId = processes.find(isBox)
    if (processId) break
  }
  let methodIndex: number | undefined
  for (const a of setups) {
    methodIndex = setupMethod(a, input)
    if (methodIndex !== undefined) break
  }
  if (!processId || methodIndex === undefined) {
    const calculation = lastCalculation(after, input)
    if (calculation) {
      if (!processId && isBox(calculation.process)) processId = calculation.process
      named ??= calculation.process
      methodIndex ??= calculation.methodIndex
    }
  }
  return {
    ...(processId ? { processId } : named ? { awaitedProcessId: named } : {}),
    ...(methodIndex !== undefined ? { methodIndex } : {})
  }
}
