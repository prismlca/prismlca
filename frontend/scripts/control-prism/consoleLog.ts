/**
 * The window's console as the host keeps it on disk (`console.log` in the session's logs): one entry per
 * message, numbered from the session's launch. The host answers `console` from memory; the file is what
 * outlives it, so a session ended from outside still has its console, and a host that starts the app again
 * on a kept copy (restart after an idle stop) goes on from the numbers and messages of the one before.
 */
import { readFileSync } from 'node:fs'

export interface ConsoleEntry {
  n: number
  type: string
  text: string
  at: string
}

/** The entry as a line of the file (a message with line breaks spans several). */
export function consoleLine(entry: ConsoleEntry): string {
  return `#${entry.n} ${entry.at} ${entry.type}: ${entry.text}\n`
}

const HEAD = /^#(\d+) (\S+) (\S+): (.*)$/

/** The entries of a console file; none when there is no file. A line that does not start an entry
 *  continues the one before it. */
export function readConsoleFile(path: string): ConsoleEntry[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const entries: ConsoleEntry[] = []
  for (const line of raw.replace(/\n$/, '').split('\n')) {
    const head = HEAD.exec(line)
    if (head && Number(head[1]) === entries.length + 1) {
      entries.push({ n: Number(head[1]), at: head[2], type: head[3], text: head[4] })
    } else if (entries.length > 0) {
      entries[entries.length - 1].text += `\n${line}`
    }
  }
  return entries
}
