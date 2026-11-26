/**
 * Command lines written down for people, read back as control-prism commands: the recipes in the feature map's
 * pages and the preparation steps of the positive controls. `explore` prepares each session with the model recipe
 * of features/model.md this way, so a session is set up exactly as the page tells a person to set one up, and a
 * change to the page changes it too.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from './args'

/** How a command line in a page starts. */
export const COMMAND = 'node scripts/control-prism.mjs '

/** Splits a command line the way a POSIX shell does for "…" and '…' quoting (no expansions). */
export function shellWords(line: string): string[] {
  const words: string[] = []
  let word: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'") {
      const end = line.indexOf("'", i + 1)
      word = (word ?? '') + line.slice(i + 1, end)
      i = end
    } else if (c === '"') {
      let j = i + 1
      let s = ''
      for (; line[j] !== '"'; j++) s += line[j] === '\\' && /["\\$`]/.test(line[j + 1]) ? line[++j] : line[j]
      word = (word ?? '') + s
      i = j
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word)
      word = null
    } else word = (word ?? '') + c
  }
  if (word !== null) words.push(word)
  return words
}

/** The commands that drive a running session; a recipe that `explore` runs may hold only these (and the launch
 *  and doctor it does itself). */
const DRIVING = new Set(['click', 'hover', 'type', 'press', 'select', 'drag', 'wait'])

/** The control-prism commands of the first `sh` block in the section `## <heading>` of a page, prefix taken off. */
export function firstBlock(markdown: string, heading: string): string[] {
  const start = markdown.indexOf(`\n## ${heading}\n`)
  if (start < 0) throw new Error(`no section "## ${heading}"`)
  const rest = markdown.slice(start + heading.length + 5)
  const end = rest.search(/\n## /)
  const block = /```sh\n([\s\S]*?)```/.exec(end < 0 ? rest : rest.slice(0, end))
  if (!block) throw new Error(`no sh block in "## ${heading}"`)
  return block[1]
    .split('\n')
    .filter((l) => l.startsWith(COMMAND))
    .map((l) => l.slice(COMMAND.length))
}

/** Command lines as the words of commands to run on a session. `launch` and `doctor` are left out: whoever runs
 *  the recipe launches and checks the session itself. Any command but driving ones is refused, and every line
 *  must parse. */
export function drivingCommands(lines: string[]): string[][] {
  return lines
    .map((l) => shellWords(l))
    .filter((words) => {
      const { cmd } = parseArgs(words)
      if (cmd === 'launch' || cmd === 'doctor') return false
      if (!DRIVING.has(cmd)) throw new Error(`"${cmd}" is not a command that drives the app`)
      return true
    })
}

/** The model of features/model.md: one process emitting 2 kg of fossil CO2, calculated with GWP100. */
export function modelRecipe(frontend: string): string[][] {
  const page = join(frontend, 'features', 'model.md')
  try {
    return drivingCommands(firstBlock(readFileSync(page, 'utf8'), 'Driving it with control-prism'))
  } catch (e) {
    throw new Error(`the model recipe of ${page} cannot be run: ${(e as Error).message}`)
  }
}
