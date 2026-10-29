/**
 * Skills that read differently depending on what a chat has: which background databases it released,
 * and which external-data switches are on.
 *
 * The two providers PrismLCA supports disagree on things a skill must state as a rule: in ecoinvent 3 a
 * treatment activity has a negative reference product (waste goes in with a negative amount), in
 * BAFU:20XY a disposal dataset is a service with a positive one; ecoinvent has markets, BAFU has
 * none. One skill text that hedges both ways is longer and easier to misread than the one that fits
 * the chat, so a skill may fence a passage:
 *
 *     <!-- if ecoinvent -->
 *     …ecoinvent-only guidance…
 *     <!-- endif -->
 *     <!-- if bafu -->
 *     …BAFU-only guidance…
 *     <!-- endif -->
 *
 * `<!-- if ecoinvent bafu -->` keeps the block when either is released. A chat that released neither
 * (or a caller that does not say) gets every provider block: complete beats tailored when the facts are
 * unknown.
 *
 * The same fence names a switch: `<!-- if web -->` (web search), `<!-- if eurostat -->` (the Eurostat
 * tool) and `<!-- if distances -->` (the transport-distance tool). Such a block goes only when the caller says the switch is off — a guide to a source the
 * model cannot reach invites it to try, or to tell the user it did. Unknown keeps it, as above.
 *
 * Markers are HTML comments, so the raw skill still renders as plain Markdown in Settings.
 */

export type Provider = 'ecoinvent' | 'bafu'

/** The external-data switches a skill may fence on. `undefined` means the caller does not know. */
export interface SkillSwitches {
  web?: boolean
  eurostat?: boolean
  distances?: boolean
}

const IF_RE = /^[ \t]*<!--\s*if\s+([a-z ]+?)\s*-->[ \t]*\r?\n?/i
const ENDIF_RE = /^[ \t]*<!--\s*endif\s*-->[ \t]*\r?\n?/i

/** Which providers the released background database names stand for (`ecoinvent-3.12-cutoff` →
 *  ecoinvent, `bafu-2026-v1` → bafu). Unknown names count for nothing. */
export function providersOf(dbNames: readonly string[] | undefined): Set<Provider> {
  const out = new Set<Provider>()
  for (const name of dbNames ?? []) {
    const n = name.toLowerCase()
    if (n.startsWith('ecoinvent')) out.add('ecoinvent')
    else if (n.startsWith('bafu')) out.add('bafu')
  }
  return out
}

/** Resolve the conditional blocks of a skill. An empty provider set keeps every provider block; a
 *  switch block goes only when its switch is `false`. */
export function renderSkill(
  content: string,
  providers: ReadonlySet<Provider>,
  switches: SkillSwitches = {}
): string {
  const wanted = (word: string): boolean => {
    if (word === 'web' || word === 'eurostat' || word === 'distances') return switches[word] !== false
    return providers.size === 0 || providers.has(word as Provider)
  }
  const lines = content.split('\n')
  const out: string[] = []
  let skipping = false
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const open = IF_RE.exec(`${line}\n`)
    if (open) {
      skipping = !open[1].trim().toLowerCase().split(/\s+/).some(wanted)
      continue
    }
    if (ENDIF_RE.test(`${line}\n`)) {
      skipping = false
      continue
    }
    if (!skipping) out.push(raw)
  }
  return out.join('\n')
}

/**
 * Skills whose whole method is a switched tool: with the switch off the chat does not list them. Only
 * the list — `get_skill` still serves one asked for by name, because an MCP client (web always "off"
 * here, its own web in hand) can follow the method with its own means.
 */
const SKILL_NEEDS: Record<string, keyof SkillSwitches> = { 'builtin-bom': 'web' }

/** The skills a chat is offered: every one, minus those whose switch the caller says is off. */
export function offeredSkills<T extends { id?: string }>(skills: readonly T[], switches: SkillSwitches): T[] {
  return skills.filter((s) => {
    const needs = s.id ? SKILL_NEEDS[s.id] : undefined
    return !needs || switches[needs] !== false
  })
}
