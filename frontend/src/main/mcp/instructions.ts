/**
 * What an external model is told about PrismLCA — in two layers, because the clients cap what they
 * carry: Claude Code truncates server `instructions` at 2,048 characters, so the instructions only
 * say what PrismLCA is and that `orientation` comes first; `orientation` then delivers the modelling
 * rules the in-app system prompt holds, built from the SAME builder (systemPrompt.ts) so the two can
 * never drift apart. It is a tool and not a resource because a resource being
 * available does not mean it was read.
 */
import { buildSystemPrompt, type Skill } from '../ai/systemPrompt'
import { MCP_EXCLUDED_TOOLS } from './catalog'

/** Claude Code's documented cut-off for server instructions; the text below stays under it. */
export const INSTRUCTIONS_MAX_CHARS = 2048

export const INSTRUCTIONS = `PrismLCA is a desktop life-cycle-assessment (LCA) app on the Brightway 2.5 engine, running on this computer. You are an external agent driving it through its tools. The user sees the PrismLCA window: every change you make lands in its audit log under your client's name and can be undone there.

FIRST call \`orientation\`. It returns the model this session works on, its study scope, the released background databases, the skills you can load with \`get_skill\`, and the modelling rules (sign conventions, method choice, units, what is undoable). Do not model before reading it; call it again after switching models.

One model = one foreground database on a canvas. Tools act on the session's model unless you pass \`database\`; \`get_current_model\` says which it is, and \`canvas_view\` action="open_model" switches the session to another. Models live in a workspace (one background database and the models built on it); only the user switches workspaces, in the app window.

Reads are free. Writes are audited and undoable by the user, and you may take back your own change with \`history\` (undo/redo) without asking. Tools marked destructive (deleting a model, a custom method or a method family) ask the user for confirmation inside the PrismLCA window — so call \`canvas_view\` action="show" first to bring the window to the front. The same holds for \`ask_user\`: the question card appears in the app, not in your client, and waits up to 15 minutes for an answer; while it waits you receive progress notifications.

A calculation answers synchronously. For a whole method family or many methods on one process, call \`calculate\` with job="start" and poll job="status" — a long synchronous call can exceed your client's tool timeout, and a retry would compute it twice.

Search hits are never verified choices: for the inputs that carry the result, read the dataset with \`get_process_details\` before linking it, and run \`check_model_health\` after building.`

const EXCLUDED_NAMES = [...MCP_EXCLUDED_TOOLS]

/** What a bullet of the system prompt must not mention to survive into the orientation text. */
const DROP_BULLET = new RegExp(
  [
    ...EXCLUDED_NAMES.map((n) => `\\b${n}\\b`),
    // The clickable process chip is rendered by the in-app chat only.
    'prism:process/',
    // "Web search is enabled for this chat" — the client's own web access is its own affair.
    '\\*\\*Web search\\*\\* is enabled',
    // The chat's "+" menu of switches; a session's sources are set in the app's settings instead.
    'left of the chat input'
  ].join('|')
)

export interface OrientationOpts {
  activeDb: string | null
  skills: Skill[]
  /** The session's approval mode shows a card before irreversible actions (anything but 'never'). */
  approvalGate?: boolean
  backgroundDbs?: string[]
  libraryDbs?: string[]
  preferredBackground?: string
  studyLanguage?: string
  distances?: boolean
  eurostat?: boolean
  /** The study metadata of the session's model (backend `/study`), already fetched; null = none. */
  study?: Record<string, unknown> | null
  clientName?: string
  /** Full descriptions of tools whose MCP description was shortened (catalog.ts). */
  toolNotes?: Record<string, string>
}

/**
 * Drop whole bullets — a bullet is its "- " line plus any indented continuation lines — that name
 * a tool this catalogue does not carry, or a feature only the in-app chat has.
 */
export function stripBullets(text: string, drop: RegExp = DROP_BULLET): string {
  const out: string[] = []
  let bullet: string[] | null = null
  const flush = (): void => {
    if (bullet && !drop.test(bullet.join('\n'))) out.push(...bullet)
    bullet = null
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('- ')) {
      flush()
      bullet = [line]
    } else if (bullet && line.length && (line.startsWith(' ') || line.startsWith('\t'))) {
      bullet.push(line)
    } else {
      flush()
      out.push(line)
    }
  }
  flush()
  return out.join('\n')
}

/** The heading that separates the chat's self-introduction from the part worth keeping. */
const FIRST_HEADING = '\n\n# What PrismLCA is'

/**
 * The orientation text: the system prompt's substance under an MCP preamble. The prompt's own first
 * paragraph ("You are the assistant built into PrismLCA … you live inside the app") is replaced,
 * because it is not true for the reader; everything after the first heading is kept, minus the
 * bullets that name tools this catalogue does not have.
 */
export function buildOrientation(o: OrientationOpts): string {
  const prompt = buildSystemPrompt({
    activeDb: o.activeDb,
    skills: o.skills,
    isNewChat: false,
    webSearch: false,
    distances: o.distances,
    eurostat: o.eurostat,
    // The client keeps its own task list; `plan` is not in this catalogue (catalog.ts), so the rule
    // is not in this text either — by parameter, not by stripping.
    planTool: false,
    approvalGate: o.approvalGate,
    backgroundDbs: o.backgroundDbs,
    libraryDbs: o.libraryDbs,
    preferredBackground: o.preferredBackground,
    studyLanguage: o.studyLanguage
  })
  const at = prompt.indexOf(FIRST_HEADING)
  const body = stripBullets(at >= 0 ? prompt.slice(at + 2) : prompt)
  const who = o.clientName ? ` (${o.clientName})` : ''
  const head =
    `# You are an external agent${who} connected to PrismLCA over MCP\n` +
    `PrismLCA is a desktop LCA app (Brightway 2.5) on this computer. Its own assistant is not running; ` +
    `you take its place through the same tools. The user watches the PrismLCA window: your changes ` +
    `appear there, are logged under your client's name, and can be undone by the user. Confirmations ` +
    `and \`ask_user\` questions are shown in that window — bring it to the front with \`canvas_view\` ` +
    `action="show" before you ask. The rules below are the ones the in-app assistant follows; they ` +
    `are written to it, so read "you" as yourself and "this chat" as this session.\n\n`
  const session =
    `\n\n# This session\n` +
    `- Model: ${o.activeDb ? `\`${o.activeDb}\`` : 'none open — create one with `manage_model` action="create" or open one with `canvas_view` action="open_model"'}\n` +
    // The chat's database switches are the chat's; an external session gets every installed database
    // and chooses per call (V383).
    `- Databases: this session searches every installed background database${o.libraryDbs?.length ? ' and the library' : ''} by default — the switches of the in-app chat do not apply to you. Narrow a search yourself with \`database\` (one) or \`databases\` (several) on \`search_background\`; names from \`list_models\`.\n` +
    (o.study && Object.keys(o.study).length
      ? `- Study metadata (\`model_info\`):\n\`\`\`json\n${JSON.stringify(o.study, null, 1)}\n\`\`\``
      : `- No study metadata recorded yet: set goal & scope with \`model_info\` action="set" before substantive work.`)
  const notes = Object.entries(o.toolNotes ?? {})
  const toolNotes = notes.length
    ? `\n\n# Tool notes\nYour client shows a shortened description for these tools; this is the full one.\n` +
      notes.map(([name, text]) => `\n## ${name}\n${text}`).join('\n')
    : ''
  return head + body + session + toolNotes
}
