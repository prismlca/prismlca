/**
 * The skill list of the system prompt (and so of the MCP orientation built from it): one line per skill,
 * name and description. Only these two are always in context; the body is loaded with `get_skill`.
 *
 * A skill's name and description come from the skill store as stored: each is put on one line and capped,
 * so a skill is always one bullet of bounded length. An ordinary skill reads exactly as it was written —
 * the caps sit far above the longest built-in, and a backend test (`test_ai_skills.py`) keeps them there.
 */
import type { Skill } from './systemPrompt'

export const SKILL_NAME_MAX = 120
export const SKILL_DESCRIPTION_MAX = 1000

/** Every character that starts a new line, in Markdown or for a reader of the text. One class, so a split
 *  reads the text once whatever it holds. */
const LINE_BREAKS = /[\n\r\v\f\u0085\u2028\u2029]+/

/**
 * `text` on one line, at most `max` characters. A cut ends at a word boundary, so every word of a cut name
 * is still a word of the full one — `get_skill` finds a skill by the words of its name.
 */
export function oneLine(text: unknown, max: number): string {
  const flat = String(text ?? '')
    .split(LINE_BREAKS)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
  const kept: string[] = []
  for (const char of flat) {
    if (kept.length === max) {
      const cut = kept.slice(0, max - 1).join('')
      const space = cut.lastIndexOf(' ')
      return `${(space > cut.length / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
    }
    kept.push(char)
  }
  return flat
}

/** An id that is one plain token, as the store's own and the shipped ones are; any other stays out of the line. */
const PLAIN_ID = /^[\w.-]{1,64}$/

/**
 * One bullet per skill. A name the listing had to change carries the skill's id as the name to load it by
 * (`get_skill` takes an id too): two long names can be cut to the same text, and a cut name's words can all
 * be in another skill's name.
 */
export function skillListing(skills: readonly Skill[]): string {
  return skills
    .map((s) => {
      const name = oneLine(s.name, SKILL_NAME_MAX)
      const key = name !== s.name && typeof s.id === 'string' && PLAIN_ID.test(s.id) ? s.id : null
      const description = oneLine(s.description, SKILL_DESCRIPTION_MAX) || '(no description)'
      return `- **${name}**${key ? ` (\`get_skill\` name: \`${key}\`)` : ''} — ${description}`
    })
    .join('\n')
}
