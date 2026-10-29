/**
 * What a chat turn knows about its model before the first round: the study language, the comparison
 * models it may read, and their briefs.
 *
 * Fetched per turn, so a change reaches the next turn: a language set during the last one, a model
 * linked or switched on meanwhile, a new parameter in the other model. Electron-free.
 */
import type { ApiRaw } from './execute'
import type { ModelScope } from './modelScope'

export interface TurnContext {
  /** The study language recorded in the model's metadata ('de', 'en', …); undefined = none yet. */
  studyLanguage?: string
  /** The chat's model fence: the comparison models this turn may read. */
  scope: ModelScope
  /** One Markdown brief per readable comparison model (backend `comparison_brief`). */
  comparisonBriefs: string[]
}

/**
 * Load the turn's context. A comparison model is readable when it is linked with the chat's model
 * (`compared_with`, symmetric, written only by the user) AND switched on in this chat — the chat's
 * switch alone grants nothing, so a switch left on for a model that was unlinked since is inert.
 *
 * A backend that is not answering yields no language, no comparison and no brief: the turn runs
 * without them, and the fence stays closed rather than open.
 */
export async function loadTurnContext(
  apiRaw: ApiRaw,
  activeDb: string | null,
  switchedOn: string[] = []
): Promise<TurnContext> {
  let studyLanguage: string | undefined
  let linked: string[] = []
  if (activeDb) {
    try {
      const { status, body } = await apiRaw('GET', `/api/v1/study?database=${encodeURIComponent(activeDb)}`)
      const study = status < 400 ? (body as { language?: unknown; compared_with?: unknown }) : undefined
      if (typeof study?.language === 'string' && study.language.trim()) studyLanguage = study.language.trim()
      if (Array.isArray(study?.compared_with))
        linked = study.compared_with.filter((n): n is string => typeof n === 'string' && !!n.trim())
    } catch {
      // Backend still starting: see above.
    }
  }
  const on = new Set(switchedOn)
  const others = linked.filter((n) => n !== activeDb)
  const readable = others.filter((n) => on.has(n))
  const switchedOff = others.filter((n) => !on.has(n))

  // Deterministic, built by the backend from the other model's own records. A model that is gone
  // yields a one-line "not in this project" brief rather than an error.
  const comparisonBriefs: string[] = []
  for (const other of readable) {
    try {
      const { status, body } = await apiRaw(
        'GET',
        `/api/v1/study/comparison-brief?database=${encodeURIComponent(other)}`
      )
      const md = status < 400 ? (body as { markdown?: string })?.markdown : undefined
      if (typeof md === 'string' && md.trim()) comparisonBriefs.push(md)
    } catch {
      // see above
    }
  }
  return { studyLanguage, scope: { readable, switchedOff }, comparisonBriefs }
}
