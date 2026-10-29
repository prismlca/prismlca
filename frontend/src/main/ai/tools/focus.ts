import type { Tool } from './context'
import { TOOLS } from './registry'
import { TOOL_META } from './catalog'
import { RESEARCH_CAP_PHRASE } from './format'

/** The tools that go to the web on the model's behalf — offered only while web search is on. */
const WEB_TOOLS = new Set(['research_web', 'research_bom'])

/**
 * OpenAI-format tool specs, minus vision-only tools when the model can't see images, minus any
 * tools the user disabled in Settings → AI-Tools, and minus `distances` / `eurostat_eol` / the web
 * research tools when that feature is off for this chat — none of those are ever offered to the model
 * (an absent tool cannot be asked for, and for the external-data tools the model is not even told
 * they exist).
 */
export function toolSpecs(
  canSeeImages: boolean,
  disabled?: ReadonlySet<string>,
  groups?: ReadonlySet<string>,
  maxResearchQuestions?: number,
  distancesAvailable = true,
  eurostatAvailable = true,
  planTool = true,
  webAvailable = true
): Tool['spec'][] {
  return TOOLS.filter((t) => {
    const name = t.spec.function.name
    if (!canSeeImages && name === 'screenshot_canvas') return false
    if (!distancesAvailable && name === 'distances') return false
    if (!eurostatAvailable && name === 'eurostat_eol') return false
    if (!webAvailable && WEB_TOOLS.has(name)) return false
    // Per model (models.ts `planTool`): off = the tool is not offered and the prompt says nothing.
    if (!planTool && name === 'plan') return false
    if (disabled?.has(name)) return false
    if (groups && !groups.has(TOOL_META[name]?.group ?? 'Other')) return false
    return true
  }).map((t) => withEffectiveResearchCap(t.spec, maxResearchQuestions))
}

/**
 * Put the number the run will actually enforce into `research_web`'s ceiling sentence (V113).
 *
 * A copy, never a mutation: `TOOLS` is module-level and shared, and rewriting a spec in place would
 * leak one run's setting into the next and into `npm run tools:manifest`. The manifest keeps the
 * mechanism-only wording, which is the honest thing for an external contract to say.
 */
function withEffectiveResearchCap(spec: Tool['spec'], cap?: number): Tool['spec'] {
  if (spec.function.name !== 'research_web' || !Number.isFinite(Number(cap))) return spec
  const props = spec.function.parameters?.properties as Record<string, { description?: string }>
  const before = props?.questions?.description
  if (!before?.includes(RESEARCH_CAP_PHRASE)) return spec
  const after = before.replace(
    RESEARCH_CAP_PHRASE,
    `(${Number(cap)} in this chat — the user sets it in Settings → AI → Limits)`
  )
  return {
    ...spec,
    function: {
      ...spec.function,
      parameters: {
        ...spec.function.parameters,
        properties: { ...props, questions: { ...props.questions, description: after } }
      }
    }
  } as Tool['spec']
}

/**
 * Groups that are always offered — reading, calculating, asking and undoing are useful in every
 * conversation, and leaving them out is how focusing cripples an agent.
 */
// 'Plan' is core so focusing never hides the checklist on exactly the long runs it is for; whether a
// MODEL gets it is decided after this, by `planTool` (toolSpecs).
const CORE_GROUPS = ['Read & search', 'Calculate', 'History', 'Canvas & UI', 'Plan']

/** Topic → the extra group it unlocks. Deliberately generous: a false positive costs a few tokens,
 * a false negative costs the agent a capability it needs. */
const GROUP_HINTS: Array<[string, RegExp]> = [
  [
    'Edit model',
    /\b(model|process|activity|exchange|input|flow|amount|build|create|add|delete|remove|classif|proxy|dataset|bom|material|bill of materials|stückliste)/i
  ],
  ['Parameters', /\b(parameter|formula|variable|fx|assumption|annahme|driver|rate|share|anteil)/i],
  [
    'Scenarios',
    /\b(scenario|szenario|what[- ]?if|variant|sensitiv|compare.*(case|option)|end[- ]of[- ]life|eol|recycl)/i
  ],
  [
    'LCIA methods',
    /\b(lcia|method|indicator|characteri[sz]ation|factor|cf|gwp|impact categor|family|familie)/i
  ],
  ['Tags', /\b(tag|phase|lebenszyklus|life[- ]cycle phase|group by|aggregat)/i],
  [
    'Research',
    /\b(research|recherche|web|source|quelle|look ?up online|bom|bill of materials|stückliste|composition|zusammensetzung)/i
  ]
]

/**
 * Pick the tool groups a conversation needs — used only when the user turns focusing on.
 *
 * Two deliberate properties: it is computed from the WHOLE conversation (so a topic raised later still
 * unlocks its tools) and it only ever ADDS groups. That keeps the offered set stable across the turns
 * of a chat, which matters because the tool list is part of the cached prompt prefix — re-picking per
 * turn would invalidate the cache on every single request and cost more than it saves.
 */
export function groupsForConversation(texts: string[]): Set<string> {
  const joined = texts.join('\n')
  const groups = new Set(CORE_GROUPS)
  for (const [group, re] of GROUP_HINTS) if (re.test(joined)) groups.add(group)
  return groups
}
