import type { SubjectRef } from '../../lib/subjectKey'
import type { PickedActivity } from '../SearchDialog'

/** The shapes the Results page shares with its charts and dialogs (moved out of Results.tsx verbatim). */
export interface Picked {
  key: string // method joined by ' · '
  method: string[]
  family: string
  label: string // impact category (method[1])
  detail: string // specific indicator (method[2])
  unit: string
}
/** An elementary flow of the life cycle inventory, as `/calc/compare` names it under `inventory_flows`. */
export interface LciFlow {
  name: string
  categories: string[]
  unit: string
}
export interface CompareResponse {
  methods: { key: string; unit: string; method: string[] }[]
  subjects: {
    label: string
    code: string
    scores: Record<string, number>
    /** The subject's life cycle inventory, when the request asked for it (`inventory`): amount per flow id. */
    inventory?: Record<string, number>
  }[]
  /** The stacked split, when the request asked for it in the same pass (`stacked_dimensions`). */
  stacked?: StackedResp
  /** The flows the rows' inventories name, by flow id. */
  inventory_flows?: Record<string, LciFlow>
}
/** A matrix row as the page keeps it: the backend's row plus WHO it is — the subject it was computed
 *  for (database, code, scenario), since code alone repeats across models (see lib/subjectKey). */
export type MatrixRow = CompareResponse['subjects'][number] & SubjectRef
export interface Matrix {
  methods: CompareResponse['methods']
  subjects: MatrixRow[]
  /** Every flow any row's inventory names, by flow id; absent when the run computed no inventory. */
  flows?: Record<string, LciFlow>
}
/** Subject from ANOTHER foreground model (the active model's activities are picked via the
 * checkbox list; another model is added by its reference process through ModelPickDialog).
 * `enabled` defaults to true (absent = enabled) so persisted entries keep working. */
export interface ModelSubject {
  database: string
  code: string
  name: string
  enabled?: boolean
}
/** One subject as the page computes it: who, plus what it is called and how much of it. */
export interface CompareSubject extends SubjectRef {
  label: string
  amount?: number
}
export interface StackedGroup {
  key: string
  impact: number
  share: number
}
export interface StackedResp<Row = StackedRow> {
  dimensions: string[]
  keys: Record<string, string[]> // per dimension: union of classification keys (stack order/colours)
  labels?: Record<string, Record<string, string>> // per dimension: key → display label (ISIC/CPC name)
  subjects: Row[]
}
export interface StackedRow {
  label: string | null
  code: string
  // per method key → { total, unit, dims: { dimension → groups } }
  methods: Record<string, { total: number; unit: string; dims: Record<string, StackedGroup[]> }>
}
/** The merged stacked result: every row carries the subject it was computed for, like `MatrixRow`. */
export type StackedData = StackedResp<StackedRow & SubjectRef>
export interface MethodInfo {
  method: string[]
  name: string
  unit: string
  recommended?: boolean // standard reporting indicator (vs specialist variant)
}
/** Background-database subject with an on/off checkbox (absent = enabled). */
export type BgSubject = PickedActivity & { enabled?: boolean }
