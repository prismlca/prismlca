/**
 * What a model-wide lookup by exchange uid adds when it finds nothing — the tools' half of the backend's
 * `engine/uid_hint.py`, for the lookups that run here over a model read with its exchanges.
 *
 * A uid is 32 hex digits a model copies by hand, and a copy one character off came back only as "not found"
 * (V487). So the refusal says when a uid is malformed, and names the uid of the model that differs by one
 * character or starts with the same eight — with what it is. Named only: two exchanges can differ in one
 * digit, and a lookup that took the nearest one would edit the wrong exchange and report success.
 */

const UID_SHAPE = /^[0-9a-f]{32}$/
/** Leading characters two uids must share to count as near (32 bits). */
const PREFIX = 8
const SHOWN = 3

function oneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) {
    let diff = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++
    return diff === 1
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a]
  let i = 0
  while (i < short.length && short[i] === long[i]) i++
  return short.slice(i) === long.slice(i + 1)
}

/** Whether `uid` is one edit away from `wanted`, or starts with the same eight characters. */
export function isNearUid(wanted: string, uid: unknown): boolean {
  if (typeof uid !== 'string' || !uid || !wanted || uid === wanted) return false
  const a = wanted.toLowerCase()
  const b = uid.toLowerCase()
  if (a.length >= PREFIX && a.slice(0, PREFIX) === b.slice(0, PREFIX)) return true
  return oneEdit(a, b)
}

/** A stretch of differing characters longer than this is no slip of the hand: the two uids only start alike. */
const SLIP = 6

/**
 * Where `sent` departs from the uid `real`, in words the caller can hold against its own text. Two uids of
 * 32 hex digits that differ in two swapped characters look identical, and a caller told only "did you mean
 * <the right one>" read it as the uid it had sent and sent the wrong one again.
 */
export function uidDifference(sent: string, real: string): string {
  const a = sent.toLowerCase()
  const b = real.toLowerCase()
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++
  const yours = a.slice(head, a.length - tail)
  const its = b.slice(head, b.length - tail)
  if (yours.length > SLIP || its.length > SLIP)
    return `it shares only its first ${head} characters with yours`
  if (!yours) return `yours lacks "${its}" after character ${head}`
  if (!its) return `yours has "${yours}" too many at character ${head + 1}`
  return `at character ${head + 1} yours has "${yours}" where it has "${its}"`
}

/**
 * The refusal of a model-wide lookup by exchange uid that found nothing, from the model's activities read
 * with their exchanges (`GET /model/activities/<db>?with_exchanges=true`, a list or `{activities}`).
 *
 * A near uid comes first, with where it differs: when one exists it is almost always the answer, and
 * "it may have been removed or replaced" in front of it sent the caller looking elsewhere.
 */
export function uidNotFound(uid: string, db: string, acts: unknown): string {
  const list = Array.isArray(acts) ? acts : ((acts as { activities?: unknown })?.activities ?? [])
  const near: string[] = []
  for (const act of Array.isArray(list) ? list : [])
    for (const ex of (act as { exchanges?: any[] })?.exchanges ?? [])
      if (isNearUid(uid, ex?.uid)) {
        const role = ex.type === 'production' ? 'output' : ex.type === 'biosphere' ? 'flow' : 'input'
        near.push(`${ex.uid} (${role}: ${ex.input?.name ?? '?'} — ${uidDifference(uid, String(ex.uid))})`)
      }
  const malformed = UID_SHAPE.test(uid)
    ? ''
    : ` Malformed uid (${uid.length} characters) — a uid is 32 hex digits.`
  const elsewhere =
    'the exchange may have been removed, or replaced: replace_input gives the exchange a NEW uid (in its ' +
    'answer). Read the process (get_process_details) for the current one.'
  if (!near.length) return `No exchange with uid "${uid}" in "${db}" — ${elsewhere}${malformed}`
  return (
    `No exchange with uid "${uid}" in "${db}".${malformed} Did you mean ${near.slice(0, SHOWN).join(' or ')}? ` +
    `It was not used in its place — send it if it is the one you meant. If it is not, ${elsewhere}`
  )
}
