/** What the sensitivity endpoints answer (backend/src/prism_lca/api/v1/sensitivity.py). */

/** A parameter's rule as stored (engine/param_rules.py); `{}` when it has none. */
export interface ParamRule {
  kind?: 'positive' | 'negative' | 'range' | 'list'
  min?: number
  max?: number
  values?: number[]
}

/** A parameter a run may vary, with its value in the chosen variant. */
export interface SensInput {
  name: string
  value: number
  unit: string
  rule: ParamRule
  /** The rule in words ("between 0 and 1"); absent without a rule. */
  allowed?: string
  /** Only for a formula of numbers alone (`2.5 / 1000`), which counts as an input. */
  formula?: string
}

export interface SensInputs {
  inputs: SensInput[]
  /** Calculated from other parameters — not varied, named so their absence is explained. */
  derived: { name: string; formula: string | null; value: number }[]
}

/** Another parameter a step pushed outside its rule (a share calculated from the varied one). */
export interface RuleBreak {
  param: string
  value: number
  allowed: string
}

export interface TornadoEntry {
  param: string
  base: number
  low_value: number
  high_value: number
  /** One score per indicator, in the order of `TornadoResult.methods`. */
  low: number[]
  high: number[]
  /** A side the parameter's rule cut short, with the rule in words. */
  limited?: { low?: string; high?: string }
  /** Sides whose step took another parameter outside its rule. */
  breaks?: { low?: RuleBreak[]; high?: RuleBreak[] }
  replaces_formula?: string
}

export interface TornadoResult {
  methods: string[][]
  units: string[]
  baseline: number[]
  delta: number
  scenario: { id: string; name: string } | null
  entries: TornadoEntry[]
  skipped?: {
    param: string
    reason: 'has_formula' | 'zero_value' | 'fixed'
    formula?: string
    allowed?: string
  }[]
}

export interface CurveResult {
  param: string
  method: string[]
  unit: string
  values: number[]
  curves: {
    scenario: string | null
    name: string
    origin: { value: number; score: number }
    scores: number[]
    /** Points at which another parameter fell outside its rule. */
    breaks?: (RuleBreak & { at: number })[]
  }[]
  replaces_formula?: string
}

export interface JobSnapshot<R> {
  job_id: string
  kind: 'tornado' | 'curve'
  state: 'running' | 'done' | 'error' | 'cancelled' | 'invalidated'
  activity: { database: string; code: string }
  progress: { done: number; total: number; label: string }
  started_at: string
  finished_at: string | null
  seconds: number | null
  error?: string
  result?: R
}

/** The last finished run of one card, kept with the model's view so it survives a restart. */
export interface StoredRun<R> {
  result: R
  /** When the run started — a model edit after this makes the result outdated. */
  startedAt: string
  seconds: number | null
  /** The settings it was computed with (see `runKey`). */
  key: string
  /** The process it was computed for: the chart keeps its own subject when the selection moves on. */
  subject?: string
  /** That process's name when the run finished — still known after the process is deleted. */
  subjectLabel?: string
}
