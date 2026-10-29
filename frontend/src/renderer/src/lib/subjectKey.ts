/**
 * Who a compare subject on the Results page is: database + code + scenario.
 *
 * The page used to key subjects by code (+ scenario) alone. Two models in one project carry the same
 * codes as a matter of course — a bundle imported under another name keeps them — and then the radar
 * found the first model's row for both, and in difference mode both counted as the reference.
 *
 * The key is RELATIVE to the model whose view stores it: a process of that model is its code
 * (`code`, `code#scenario`), anything from another database carries it (`database/code`). Relative on
 * purpose, not `activeDb/code` throughout: the view travels with its model — a rename moves it whole
 * and a bundle import hands it to a model of a different name — and an absolute own-model key would
 * then point at the old name, which after an import is another model that may well still exist.
 *
 * Every part is escaped (`%`, `/`, `#` percent-encoded), because codes and model names are free text —
 * an import can bring a code `B/root` or `root#s1`, and unescaped those would read as another model's
 * process or as a scenario. For the usual hex/UUID codes and plain model names the escaping changes
 * nothing, so the keys look exactly like the ones stored before. The backend mirrors this encoding in
 * `engine/view_store.py` (rename, bundle import) — change both or neither.
 */
import { renameCanvasKeys } from './canvasKeys'

export interface SubjectRef {
  database: string
  code: string
  scenario?: string
}

/** The `results.keys` value of a view whose keys are in this form. Absent = older build, migrate. */
export const SUBJECT_KEYS_VERSION = 2

/** Escape one part of a key: `%`, `/` and `#` would otherwise be read as structure. */
export function encPart(s: string): string {
  return s.replace(/[%/#]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/** The subject's key as seen from `ownDb` — pass `null` for an absolute key (in-memory identity only). */
export function subjectKey(s: SubjectRef, ownDb: string | null): string {
  const base = s.database === ownDb ? encPart(s.code) : `${encPart(s.database)}/${encPart(s.code)}`
  return s.scenario ? `${base}#${encPart(s.scenario)}` : base
}

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v)

interface Entry extends SubjectRef {
  enabled?: boolean
}
const entries = (v: unknown): Entry[] =>
  Array.isArray(v)
    ? v.filter((x): x is Entry => isRec(x) && typeof x.database === 'string' && typeof x.code === 'string')
    : []

/** What the model the view belongs to has, in the page's own order — the migration needs all three. */
export interface OwnModel {
  /** Codes of the model's processes, in the order the page lists them. */
  codes: string[]
  /** Scenario ids, in the order the page lists them. */
  scenarios: string[]
  /** The databases that exist, or `null` when not known (then no subject is dropped for it). */
  databases: Set<string> | null
}

/**
 * Bring a stored `results` section from an older build to the current keys. Once: the result carries
 * `keys: SUBJECT_KEYS_VERSION`, and a section that has it is returned as `null` (nothing to do), so a
 * key already in the new form is never read as an old one again.
 *
 * Two older forms exist. Before 2c9884c5 every colour and the reference were keyed by bare code
 * (`code`, `code#scenario`), foreign subjects included; 2c9884c5 itself wrote foreign ones as
 * `database/code`, unescaped. Everything is read from the section as it came (a snapshot), the moves
 * are computed first and applied after, so a key written by one move is never taken for an old key
 * by the next.
 *
 * - colours: a foreign subject takes its colour from `database/code` (2c9884c5), else from its bare
 *   code; an own process from its bare code. A bare key goes unless an own process or a scenario still
 *   answers to it — then everyone who shared the colour keeps it.
 * - reference: resolved the way the old page resolved it — against the subjects it actually compared
 *   (ticked processes, baseline, ticked scenarios, enabled entries of existing databases), in its
 *   order, first match. Not found there, it is looked up among all entries; not found at all, it is
 *   cleared rather than left to mean something else under the new keys.
 * - the process selection (`subjSel`) and scenario ticks are keyed by plain code / id and unchanged.
 *
 * Known residual cases, deliberately not handled:
 * - Old keys are unescaped, so a code or model name that itself contains `/` or `%2F` can make the
 *   2c9884c5 form (`database/code`) and a bare code read alike: an own code "B/x" vs B's "x", or a
 *   foreign code "C/x" vs a model "B/C". The migration then takes the first reading (2c9884c5 form
 *   before bare code, compared subjects before all entries). Codes are UUIDs/hex in practice.
 * - A section written with the marker by this build and afterwards by an OLDER build keeps the marker,
 *   while the older build writes old-form keys — they are then read as new. Accepted: one writer per
 *   window, and a downgrade is not a supported path.
 * - A rename rewrites keys only in marked sections (see `renameDatabaseInView`); in an unmarked one a
 *   2c9884c5-form key of the renamed model no longer matches its renamed entry and its colour or
 *   reference is dropped by the later migration.
 */
export function migrateSubjectKeys(results: Rec, ownDb: string, own: OwnModel): Rec | null {
  if (typeof results.keys === 'number' && results.keys >= SUBJECT_KEYS_VERSION) return null
  const snap: Rec = results // read only below
  const next: Rec = { ...snap, keys: SUBJECT_KEYS_VERSION }

  const fg = entries(snap.fgSubjects).filter((s) => s.database !== ownDb)
  const bg = entries(snap.bgSubjects)
  const foreign = [...fg, ...bg]
  const scenIds = new Set(own.scenarios)
  const oldForeign = (s: SubjectRef): string => `${s.database}/${s.code}` // 2c9884c5, unescaped

  if (isRec(snap.colors)) {
    const old = snap.colors as Record<string, string>
    const moves: [string, string][] = []
    const consumed = new Set<string>()
    for (const code of own.codes) {
      const key = subjectKey({ database: ownDb, code }, ownDb)
      if (key !== code && code in old && !(key in old)) {
        moves.push([key, old[code]])
        consumed.add(code)
      }
    }
    for (const s of foreign) {
      const key = subjectKey(s, ownDb)
      if (key in old) continue
      const from = oldForeign(s) in old ? oldForeign(s) : s.code in old ? s.code : null
      if (from === null) continue
      moves.push([key, old[from]])
      consumed.add(from)
    }
    const stillOwn = new Set(own.codes.map((code) => subjectKey({ database: ownDb, code }, ownDb)))
    const c: Record<string, string> = {}
    for (const [k, v] of Object.entries(old)) {
      if (!consumed.has(k) || stillOwn.has(k) || scenIds.has(k)) c[k] = v
    }
    for (const [k, v] of moves) if (!(k in c)) c[k] = v
    next.colors = c
  }

  const ref = snap.refCode
  if (typeof ref === 'string' && ref) next.refCode = resolveOldRef(ref, snap, ownDb, own, fg, bg)
  return next
}

function resolveOldRef(
  ref: string,
  snap: Rec,
  ownDb: string,
  own: OwnModel,
  fg: Entry[],
  bg: Entry[]
): string {
  // The old page's subject list, in its order (Results.tsx `subjects`).
  const sel = isRec(snap.subjSel) ? snap.subjSel : {}
  const scenSel = isRec(snap.scenSel) ? snap.scenSel : {}
  const chosen = own.codes.filter((c) => sel[c])
  const mine = (code: string, scenario?: string): SubjectRef => ({ database: ownDb, code, scenario })
  const compared: SubjectRef[] = [
    ...(snap.baseline === false ? [] : chosen.map((c) => mine(c))),
    ...own.scenarios.filter((id) => scenSel[id]).flatMap((id) => chosen.map((c) => mine(c, id))),
    ...fg.filter((f) => f.enabled !== false && (!own.databases || own.databases.has(f.database))),
    ...bg.filter((b) => b.enabled !== false)
  ]
  const everyone: SubjectRef[] = [
    ...own.codes.map((c) => mine(c)),
    ...own.scenarios.flatMap((id) => own.codes.map((c) => mine(c, id))),
    ...fg,
    ...bg
  ]
  // The id the old page gave a subject: bare code (+ scenario) before 2c9884c5; 2c9884c5 kept that
  // for the own model and wrote `database/code` for everything else.
  const bare = (s: SubjectRef): string => (s.scenario ? `${s.code}#${s.scenario}` : s.code)
  const interim = (s: SubjectRef): string => (s.database === ownDb ? bare(s) : `${s.database}/${s.code}`)
  for (const list of [compared, everyone]) {
    const hit = list.find((s) => interim(s) === ref) ?? list.find((s) => bare(s) === ref)
    if (hit) return subjectKey(hit, ownDb)
  }
  return ''
}

/**
 * Point one model's view at a model that was renamed from `from` to `to`: its subjects from that model
 * (other-model and database entries, the detailed-results subject), the colour and reference keys
 * that name it, and the canvas keys (`renameCanvasKeys`). The backend does the same to the stored views (`ViewStore.rename_database`); this is the
 * renderer's cached copy, so a write still pending cannot send the old name back. `null` = unchanged.
 */
export function renameDatabaseInView(view: Rec, from: string, to: string): Rec | null {
  let changed = false
  const moveEntry = (x: unknown): unknown => {
    if (isRec(x) && x.database === from) {
      changed = true
      return { ...x, database: to }
    }
    return x
  }
  const prefixFrom = `${encPart(from)}/`
  const prefixTo = `${encPart(to)}/`
  const moveKey = (k: string): string => {
    if (!k.startsWith(prefixFrom)) return k
    changed = true
    return prefixTo + k.slice(prefixFrom.length)
  }
  const next: Rec = { ...view }
  if (isRec(view.results)) {
    const r: Rec = { ...view.results }
    // Keys are rewritten only in a migrated section: in an older one a colour key `B/x` may be the
    // model's OWN code "B/x", and only the migration on its next open can tell — against the entries,
    // which are renamed either way (their `database` field is unambiguous).
    const qualified = typeof r.keys === 'number' && r.keys >= SUBJECT_KEYS_VERSION
    for (const f of ['fgSubjects', 'bgSubjects'])
      if (Array.isArray(r[f])) r[f] = (r[f] as unknown[]).map(moveEntry)
    if (qualified && isRec(r.colors))
      r.colors = Object.fromEntries(Object.entries(r.colors).map(([k, v]) => [moveKey(k), v]))
    if (qualified && typeof r.refCode === 'string') r.refCode = moveKey(r.refCode)
    next.results = r
  }
  if (isRec(view.detailed) && isRec(view.detailed.subject)) {
    next.detailed = { ...view.detailed, subject: moveEntry(view.detailed.subject) }
  }
  // …and the canvas, whose node ids carry the model's name unescaped.
  const canvas = renameCanvasKeys(next, from, to)
  return canvas ?? (changed ? next : null)
}
