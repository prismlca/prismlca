/**
 * What one exploring run did, read from its Bombadil trace one state at a time: where it went (pages, dialog
 * types, sections, coverage), what it saw go wrong (violations as episodes, with the state they began in), and
 * for a rest violation which named functions ran while nothing was put in. The snapshot names it reads are the
 * extractors of features/explore/lib.ts (`where`, `rest`, `loading`, `serverErrorBanner`).
 */
import type { TraceState } from './bombadil'

export interface Where {
  doc: number | null
  page: string | null
  dialog: string | null
  section: string | null
}

export interface Episode {
  property: string
  /** The state the episode began in. */
  first: number
  /** Seconds from the run's first state. */
  at: number
  /** How many states in a row it lasted. */
  states: number
  where: Where | null
  /** The action that led into its first state. */
  action: string
  detail: string
}

export interface LoadingCount {
  began: number
  ended: number
  left: number
  open: number
  maxSeconds: number
}

export interface RunDigest {
  states: number
  seconds: number
  /** Documents seen: the first and the one after the startup reload; more means the window reloaded itself. */
  documents: number
  actions: Record<string, number>
  pages: { page: string; share: number }[]
  dialogTypes: string[]
  sections: string[]
  coverage: { hit: number; total: number; named: number } | null
  violations: { property: string; episodes: number; shown: Episode[] }[]
  rest: { observations: number; verdicts: Record<string, number> }
  /** Named functions that ran in at least 80 % of the windows of "busy" observations. */
  restBusyFunctions: string[]
  loading: Record<string, LoadingCount>
}

/** Model names and counters taken out of dialog titles and sections, so they count by kind. */
export function dialogType(title: string): string {
  return title.replace(/^(Export|Duplicate|Delete|Rename) .*/, '$1 <name>')
}
const sectionKind = (s: string): string => s.replace(/\d+(\/\d+)?$/, '').trim()

/** A function name worth listing: a component, a hook, or a method or callback of one (`Workbench.onSelectionChange`).
 *  Minified names of the bundle's libraries (`R$1`) are none. */
export function named(fn: string): boolean {
  const head = fn.split('.')[0]
  return !fn.includes('$') && (/^use[A-Z]/.test(head) || /^[A-Z][A-Za-z0-9_]{2,}$/.test(head))
}

/** The order to read what ran at rest in: a loop is kept going by a callback or effect, so methods and callbacks
 *  (`Workbench.onSelectionChange`) come first, then hooks, then the components that merely render again. */
export function restOrder(fn: string): number {
  return fn.includes('.') ? 0 : fn.startsWith('use') ? 1 : 2
}

function snapshot<T>(s: TraceState, name: string): T | null {
  for (const x of s.metadata.snapshots ?? []) if (x.name === name) return x.value as T
  return null
}

/** One line for an action of the trace. */
export function describeAction(a: unknown): string {
  if (a === null || a === undefined) return '(start)'
  if (typeof a === 'string') return a
  const [kind, v] = Object.entries(a as Record<string, unknown>)[0] ?? ['?', null]
  if (kind === 'Custom') {
    const c = v as { name: string; arguments?: unknown[] }
    return `${c.name}(${(c.arguments ?? []).map((x) => JSON.stringify(x)).join(', ')})`
  }
  if (kind === 'Click' || kind === 'DoubleClick') {
    const c = v as { fingerprint?: Record<string, string>; point?: { x: unknown; y: unknown } }
    const fp = c.fingerprint ?? {}
    const name = fp.accessible_name ?? fp.text_content ?? fp.placeholder ?? fp.structural_path ?? ''
    const at = (n: unknown): string => (typeof n === 'number' ? String(Math.round(n)) : JSON.stringify(n))
    const point = c.point ? ` at ${at(c.point.x)},${at(c.point.y)}` : ''
    return `${kind} <${fp.role ?? fp.tag ?? '?'}>${name ? ` "${name.slice(0, 60)}"` : ''}${point}`
  }
  return `${kind} ${JSON.stringify(v).slice(0, 80)}`
}

const actionKind = (a: unknown): string =>
  a === null || a === undefined
    ? '(start)'
    : typeof a === 'string'
      ? a
      : (([k, v]) => (k === 'Custom' ? `${(v as { name: string }).name}` : k))(
          Object.entries(a as Record<string, unknown>)[0] ?? ['?', null]
        )

interface RestSnapshot {
  id: number
  page: string | null
  verdict: string | null
  windows: number
  last: { commits: number; ms: number }[]
}

/** The loading-ends properties of the spec and the kind each watches. */
const LOADING_KINDS: Record<string, string> = {
  startEnds: 'start',
  calculationEnds: 'calc',
  loadEnds: 'load',
  busyEnds: 'busy'
}

function detailOf(property: string, s: TraceState, violation: unknown): string {
  if (property === 'restAfterInput' || property === 'restWasMeasured') {
    const r = snapshot<RestSnapshot>(s, 'rest')
    if (r) {
      const commits = r.last.map((w) => w.commits).join(', ')
      return `observation of ${r.page ?? '?'}: ${r.verdict} after ${r.windows} window(s)${commits ? `; commits in the last: ${commits}` : ''}`
    }
  }
  if (property === 'noServerErrorBanner') {
    const text = snapshot<string>(s, 'serverErrorBanner')
    if (text) return `the window shows: ${text}`
  }
  if (property === 'noConsoleErrors') {
    const v = snapshot<unknown[]>(s, 'consoleErrors')
    if (v?.length) return JSON.stringify(v).slice(0, 300)
  }
  if (property === 'noUncaughtExceptions' || property === 'noUnhandledPromiseRejections') {
    const v = snapshot<unknown[]>(s, 'uncaughtExceptions')
    if (v?.length) return JSON.stringify(v).slice(0, 300)
  }
  const kind = LOADING_KINDS[property]
  if (kind) {
    const now = snapshot<string[]>(s, 'loading') ?? []
    return `"${kind}" did not end within its deadline in the same document, page and dialog (loading now: ${now.join(', ') || 'nothing'})`
  }
  return JSON.stringify(violation).slice(0, 300)
}

/** At most this many episodes of one property are kept with their details; the count covers all. */
const SHOWN = 10
/** Violations of one property at most this many seconds apart belong to one episode. */
export const EPISODE_GAP = 10

export class TraceDigest {
  private n = 0
  private t0: number | null = null
  private t1 = 0
  private docs = new Set<number>()
  private actions: Record<string, number> = {}
  private pages = new Map<string, number>()
  private dialogs = new Set<string>()
  private sections = new Set<string>()
  readonly hit = new Set<number>()
  private episodes = new Map<string, { count: number; shown: Episode[] }>()
  private open = new Map<string, { episode: Episode; ts: number }>()
  private observations = new Map<number, string>()
  private busyWindows = 0
  private busyFns = new Map<string, number>()
  private loading: Record<string, LoadingCount> = {}
  private active = new Map<string, { ctx: string; at: number }>()

  /** `table`: the coverage table (block id → function) of --coverage-symbols, when the run wrote one. */
  constructor(private readonly table: Map<number, string> | null) {}

  add(s: TraceState): void {
    const m = s.metadata
    const ts = m.timestamp
    if (this.t0 === null) this.t0 = ts
    this.t1 = ts
    this.n++
    const kind = actionKind(m.action)
    this.actions[kind] = (this.actions[kind] ?? 0) + 1

    const w = snapshot<Where>(s, 'where')
    if (w) {
      if (w.doc !== null) this.docs.add(w.doc)
      const page = w.page ?? '(none)'
      this.pages.set(page, (this.pages.get(page) ?? 0) + 1)
      if (w.dialog) {
        const d = dialogType(w.dialog)
        this.dialogs.add(d)
        if (w.section) this.sections.add(`${d} > ${sectionKind(w.section)}`)
      }
    }

    const branches = m.state.branches ?? []
    for (const b of branches) this.hit.add(b)

    // Violations: an episode is a stretch of states in which the same property is violated, gaps of up to
    // EPISODE_GAP seconds included — a condition that stays (an indicator that never goes) is reported by Bombadil
    // in bursts, and it is one finding, not one per burst.
    for (const v of m.violations ?? []) {
      const last = this.open.get(v.name)
      if (last && ts - last.ts <= EPISODE_GAP * 1e6) {
        last.episode.states++
        last.ts = ts
        continue
      }
      const e: Episode = {
        property: v.name,
        first: s.index,
        at: Math.round((ts - this.t0) / 1e6),
        states: 1,
        where: w,
        action: describeAction(m.action),
        detail: detailOf(v.name, s, v.violation)
      }
      this.open.set(v.name, { episode: e, ts })
      const all = this.episodes.get(v.name) ?? { count: 0, shown: [] }
      all.count++
      if (all.shown.length < SHOWN) all.shown.push(e)
      this.episodes.set(v.name, all)
    }

    // Rest observations: the last state of each observation carries its verdict; a window of a busy one (or of
    // one still open after three windows) shows what ran while nothing was put in.
    const r = snapshot<RestSnapshot>(s, 'rest')
    if (r?.verdict) this.observations.set(r.id, r.verdict)
    if (
      this.table &&
      kind === 'observeRestMore' &&
      r &&
      (r.verdict === null || r.verdict === 'busy') &&
      r.windows >= 3
    ) {
      this.busyWindows++
      const fns = new Set<string>()
      for (const b of branches) {
        const fn = this.table.get(b)
        if (fn && named(fn)) fns.add(fn)
      }
      for (const fn of fns) this.busyFns.set(fn, (this.busyFns.get(fn) ?? 0) + 1)
    }

    // Loading episodes per kind: ended in place, ended by leaving the place, or still open at the end.
    const ctx = w ? `${w.doc}|${w.page}|${w.dialog}` : ''
    const kinds = new Set(snapshot<string[]>(s, 'loading') ?? [])
    for (const [k, a] of [...this.active]) {
      if (kinds.has(k) && a.ctx === ctx) continue
      const c = this.count(k)
      if (a.ctx !== ctx) c.left++
      else c.ended++
      c.maxSeconds = Math.max(c.maxSeconds, Math.round((ts - a.at) / 1e6))
      this.active.delete(k)
    }
    for (const k of kinds) {
      if (this.active.has(k)) continue
      this.active.set(k, { ctx, at: ts })
      this.count(k).began++
    }
  }

  private count(k: string): LoadingCount {
    return (this.loading[k] ??= { began: 0, ended: 0, left: 0, open: 0, maxSeconds: 0 })
  }

  /** Named functions the run executed (from the coverage table). */
  namedFunctions(): Set<string> {
    const out = new Set<string>()
    if (!this.table) return out
    for (const b of this.hit) {
      const fn = this.table.get(b)
      if (fn && named(fn)) out.add(fn)
    }
    return out
  }

  result(): RunDigest {
    for (const k of this.active.keys()) this.count(k).open++
    this.active.clear()
    const hitInTable = this.table ? [...this.hit].filter((b) => this.table!.has(b)).length : 0
    return {
      states: this.n,
      seconds: this.t0 === null ? 0 : Math.round((this.t1 - this.t0) / 1e6),
      documents: this.docs.size,
      actions: this.actions,
      pages: [...this.pages]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([page, c]) => ({ page, share: Math.round((c * 1000) / this.n) / 10 })),
      dialogTypes: [...this.dialogs].sort(),
      sections: [...this.sections].sort(),
      coverage: this.table
        ? { hit: hitInTable, total: this.table.size, named: this.namedFunctions().size }
        : null,
      violations: [...this.episodes].map(([property, e]) => ({
        property,
        episodes: e.count,
        shown: e.shown
      })),
      rest: {
        observations: this.observations.size,
        verdicts: [...this.observations.values()].reduce<Record<string, number>>(
          (acc, v) => ((acc[v] = (acc[v] ?? 0) + 1), acc),
          {}
        )
      },
      restBusyFunctions: [...this.busyFns]
        .filter(([, c]) => c >= this.busyWindows * 0.8)
        .map(([fn]) => fn)
        .sort((a, b) => restOrder(a) - restOrder(b) || a.localeCompare(b)),
      loading: this.loading
    }
  }
}

/** The coverage table of --coverage-symbols: one JSON object per line, `id` and `function`. */
export function readCoverageTable(text: string): Map<number, string> {
  const table = new Map<number, string>()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const d = JSON.parse(line) as { id: number; function: string }
      table.set(d.id, d.function)
    } catch {
      /* a line cut off when the run ended */
    }
  }
  return table
}
