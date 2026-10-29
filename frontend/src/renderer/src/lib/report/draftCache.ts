/**
 * The per-viewer cache of refused chapters (V424a).
 *
 * A chapter the gate refused is held OUTSIDE the report as a draft (see `useChapterWriter`) — and it lived
 * only in React state. A renderer reload, or a hot reload that remounted the panel, threw away text that
 * had been paid for together with the reasons it was refused: one run read "2
 * chapters empty" after a reload instead of "2 kept as drafts", and the writer report said "Nothing to
 * report" over a chapter the gate had refused three times.
 *
 * So each report's drafts are mirrored into localStorage, together with the gate's findings for those
 * chapters — the reasons belong to the draft, not to the run that produced it. This is a cache, as all
 * localStorage is in this app: losing it costs the draft, never the report, and every access is guarded.
 * Only chapters holding a draft are kept; the remarks on stored chapters stay per session as before.
 */

export type Draft = { text: string; model?: string; lookups?: unknown[]; figure?: unknown }
export type Finding = { kind: string; detail: string }

type Entry = Draft & { findings?: Finding[] }

const PREFIX = 'prism.reportDrafts:'

export const draftKey = (base: string): string => `${PREFIX}${base}`

/** This report's drafts and the findings that belong to them; empty maps when nothing (readable) is stored. */
export function loadDrafts(base: string): {
  drafts: Record<string, Draft>
  findings: Record<string, Finding[]>
} {
  const drafts: Record<string, Draft> = {}
  const findings: Record<string, Finding[]> = {}
  try {
    const raw = localStorage.getItem(draftKey(base))
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') return { drafts, findings }
    for (const [id, value] of Object.entries(parsed as Record<string, Entry>)) {
      if (!value || typeof value.text !== 'string' || !value.text.trim()) continue
      const { findings: f, ...draft } = value
      drafts[id] = draft
      if (Array.isArray(f) && f.length) findings[id] = f
    }
  } catch {
    /* unreadable or unavailable — a cache miss, nothing more */
  }
  return { drafts, findings }
}

/**
 * Mirror the drafts (and their findings) of one report. An empty set removes the key. When the quota is
 * hit, the text is what matters: a second attempt drops the lookups and the figure request, which only
 * make the gate's job easier — the author can still read, edit and re-check the text.
 */
export function saveDrafts(
  base: string,
  drafts: Record<string, Draft>,
  findings: Record<string, Finding[]>
): void {
  const entries = (lean: boolean): Record<string, Entry> =>
    Object.fromEntries(
      Object.entries(drafts)
        .filter(([, d]) => d && typeof d.text === 'string' && d.text.trim())
        .map(([id, d]) => [
          id,
          lean
            ? { text: d.text, model: d.model, findings: findings[id] ?? [] }
            : { ...d, findings: findings[id] ?? [] }
        ])
    )
  try {
    const full = entries(false)
    if (!Object.keys(full).length) {
      localStorage.removeItem(draftKey(base))
      return
    }
    try {
      localStorage.setItem(draftKey(base), JSON.stringify(full))
    } catch {
      localStorage.setItem(draftKey(base), JSON.stringify(entries(true)))
    }
  } catch {
    /* quota / unavailable — the in-memory drafts still stand for this session */
  }
}
