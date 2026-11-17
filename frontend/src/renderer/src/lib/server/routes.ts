/**
 * The GET routes the renderer reads more than once, with their one authoritative response shape.
 *
 * Before this register, every call site declared its own idea of the response as a type argument —
 * and the ideas drifted: `model/tag-groups` was declared three different ways in four files (with
 * `color`+`values`, with `databases`, as a bare list), `calc/methods` two ways. The compiler never
 * saw the disagreement because `api<T>` casts. Here each route appears once, with the superset the
 * backend actually sends; `apiGet` infers from the path, so a call site cannot invent a shape.
 *
 * Hand-written rather than generated from the backend's OpenAPI (decision E4 of the refactor plan
 * stayed open): the types are replaceable later, the call sites are not. Only routes that are read
 * from several places belong here — a one-consumer endpoint gains nothing from the indirection.
 */
import type { ActivityInfo, DatabaseInfo, Graph } from '../api'
import type { MethodEntry } from '../methods'

/** One tag group of a model, as `/api/v1/model/tag-groups?database=` sends it: the values for the
 *  pickers in the model's own order, whether some process or input of the model carries the group
 *  (`used`), and the values none carries (`unused`). A group belongs to one model. */
export interface TagGroup {
  name: string
  color: string
  values: string[]
  used?: boolean
  unused?: string[]
}

/** A tag group some process of the asked-for models carries, as `/api/v1/model/tag-groups/in-use`
 *  sends it — what a "split by" can offer. Groups of different models are one entry when they share
 *  the name; `databases` says which of the models carry it. */
export interface TagFamily {
  name: string
  databases: string[]
}

/** One scenario of a model, as `/api/v1/scenarios` lists it. `dead`/`no_effect` are the server's
 *  own verdicts about overrides that currently change nothing (see the route's docstring). */
export interface ScenarioEntry {
  id: string
  name: string
  description?: string
  overrides: Record<string, number>
  dead?: string[]
  no_effect?: string[]
}

/** Study metadata (ISO 14040/44) for one model — free-text fields keyed by name. The backend sends
 *  strings for the classic fields; `limitations` is the one structured member. */
export type StudyMeta = Record<string, unknown>

/**
 * Route → response. Fixed paths are literal keys; routes with a path or query parameter are
 * template-literal index signatures, so `apiGet('/api/v1/study?database=' + db)` still infers.
 */
export interface GetRoutes {
  '/api/v1/databases': DatabaseInfo[]
  '/api/v1/calc/methods': MethodEntry[]
  '/api/v1/model/unit-vocabulary': { units: string[] }
  '/api/v1/search/geography-names': { names: Record<string, string> }
  [tagGroups: `/api/v1/model/tag-groups?database=${string}`]: { database: string; groups: TagGroup[] }
  [tagFamilies: `/api/v1/model/tag-groups/in-use?${string}`]: { groups: TagFamily[] }
  [study: `/api/v1/study?database=${string}`]: StudyMeta
  [scenarios: `/api/v1/scenarios?database=${string}`]: ScenarioEntry[]
  [activities: `/api/v1/model/activities/${string}`]: ActivityInfo[]
  [graph: `/api/v1/model/graph/${string}`]: Graph
}

export type RouteKey = keyof GetRoutes & string

// Route builders for the parametrised keys. `as const` keeps the template-literal TYPE (a plain
// template expression widens to `string`, which the register's index signatures cannot match).
export const scenariosRoute = (db: string) => `/api/v1/scenarios?database=${encodeURIComponent(db)}` as const
export const studyRoute = (db: string) => `/api/v1/study?database=${encodeURIComponent(db)}` as const
export const activitiesRoute = (db: string) => `/api/v1/model/activities/${encodeURIComponent(db)}` as const
export const graphRoute = (db: string) => `/api/v1/model/graph/${encodeURIComponent(db)}` as const
export const tagGroupsRoute = (db: string) =>
  `/api/v1/model/tag-groups?database=${encodeURIComponent(db)}` as const
/** The tag groups in use in `dbs`. The first model's groups come first, so callers put the open model
 *  there; the rest is sorted, so the same set of models is the same cache key however it was collected. */
export const tagFamiliesRoute = (first: string, others: Iterable<string> = []) => {
  const rest = [...new Set(others)].filter((d) => d && d !== first).sort()
  const query = [first, ...rest].map((d) => `database=${encodeURIComponent(d)}`).join('&')
  return `/api/v1/model/tag-groups/in-use?${query}` as const
}
