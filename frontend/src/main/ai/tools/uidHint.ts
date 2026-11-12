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

/**
 * The sentences to add to a "no exchange with uid …" refusal, from the model's activities read with their
 * exchanges (`GET /model/activities/<db>?with_exchanges=true`, a list or `{activities}`); '' when there is
 * nothing to add.
 */
export function uidMiss(uid: string, acts: unknown): string {
  const list = Array.isArray(acts) ? acts : ((acts as { activities?: unknown })?.activities ?? [])
  const near: string[] = []
  for (const act of Array.isArray(list) ? list : [])
    for (const ex of (act as { exchanges?: any[] })?.exchanges ?? [])
      if (isNearUid(uid, ex?.uid)) {
        const role = ex.type === 'production' ? 'output' : ex.type === 'biosphere' ? 'flow' : 'input'
        near.push(`${ex.uid} (${role}: ${ex.input?.name ?? '?'})`)
      }
  const parts = UID_SHAPE.test(uid)
    ? []
    : [`Malformed uid (${uid.length} characters) — a uid is 32 hex digits.`]
  if (near.length)
    parts.push(
      `Did you mean ${near.slice(0, SHOWN).join(' or ')}? It was not used in its place — send it if it is ` +
        'the one you meant.'
    )
  return parts.length ? ` ${parts.join(' ')}` : ''
}
