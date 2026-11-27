/**
 * The parts whose mass the chat already has when it asks for a bill of materials — read off a document it opened,
 * found by its own search, stated by the user, or worked out from dimensions — given to research_bom as
 * `known_parts`. They are weighed with the researched parts by the same rules, and they reach the research log with
 * their origin, where the health check, the reviewer and the report read the study's part masses.
 *
 * Two gaps this closes. A chat that read a datasheet and had only the missing parts researched got a balance of the
 * missing parts alone — "do not add up" with nothing missing, or "not judged" — and could not weigh the completed
 * list again without researching all of it. And figures the chat found itself never reached the log at all: a model
 * built from them looked unresearched to everything that reads it.
 *
 * Each known part is one outcome of its own, named like a requested component, so the weighing treats it as one:
 * sums, overlaps, versions and the whole-product checks are unchanged. Only two things differ, and both are about
 * where a figure comes from. A known part's page is held against the chat's own record (bomChatRecord.ts) instead of
 * against the researchers' citations. And a part the user stated needs no page: the user is its source.
 */
import { parseBomAnswer, type BomItem } from './bomAnswer'
import type { LegOutcome } from './bomBalance'

/** What to do with a known part that came without a figure. */
const OPEN_KNOWN =
  'pass its figure (a bound such as "< 0.1 kg" goes in as that bound, named so in "note"), or name it under ' +
  '"components" to have it researched.'

/** Known parts one call takes: a bill of materials of a few dozen lines, the small parts grouped. */
export const MAX_KNOWN_PARTS = 24

const EXAMPLE =
  '[{"component": "tub (150 l, sheet steel)", "material": "steel", "mass_kg": 11.0, "source_url": "https://…"}, ' +
  '{"component": "frame", "material": "steel tube", "mass_kg": 6.25, "note": "2 × 1.9 m tube 32 × 1.5 mm, 7850 kg/m³"}]'

/**
 * The `known_parts` argument read into one outcome per part, or the refusal that says what to send instead. A part
 * named without a mass stays as an open one — it is part of the product, and the balance cannot be judged without
 * it — but it is never researched: what is to be researched goes under `components`.
 */
export function knownPartsArg(raw: unknown): LegOutcome[] | string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string')
    return `"known_parts" arrived as ONE string, not an array — the array was JSON-encoded into a string. Resend it as a real JSON array of objects, e.g. ${EXAMPLE}.`
  if (!Array.isArray(raw)) return `"known_parts" must be an array of objects, e.g. ${EXAMPLE}.`
  if (raw.length > MAX_KNOWN_PARTS)
    return `"known_parts" holds ${raw.length} entries; at most ${MAX_KNOWN_PARTS} — group the small parts (e.g. "screws, nuts and washers") into one entry with their summed mass.`
  const outcomes: LegOutcome[] = []
  const seen = new Map<string, number>()
  for (const [i, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return `"known_parts[${i}]" must be an object with at least "component" and "mass_kg", e.g. ${EXAMPLE}.`
    const r = entry as Record<string, unknown>
    const name = typeof r.component === 'string' ? r.component.trim() : ''
    if (!name) return `"known_parts[${i}]" has no "component" — name the part, e.g. ${EXAMPLE}.`
    // Each known part is weighed as an outcome of its own, so a name given twice would count its mass twice.
    const key = name.toLowerCase().replace(/\s+/g, ' ')
    const first = seen.get(key)
    if (first !== undefined)
      return `"known_parts" names "${name}" twice (entries ${first} and ${i}) — one entry per part: put the pieces of one part into one entry with "count", or name two different parts apart.`
    seen.set(key, i)
    const leg = parseBomAnswer({ items: [r] })
    const origin: BomItem['origin'] = r.stated_by_user === true ? 'user' : 'assistant'
    outcomes.push({
      request: name,
      known: true,
      leg: {
        ...leg,
        items: leg.items.map((it) => ({ ...it, origin })),
        // Said on the part itself, since "no mass found" would claim a search that never ran.
        unresolved: leg.unresolved.map((u) => ({
          ...u,
          note: [`Given under known_parts without a readable mass — ${OPEN_KNOWN}`, u.note]
            .filter(Boolean)
            .join(' ')
        }))
      }
    })
  }
  return outcomes.length ? outcomes : undefined
}
