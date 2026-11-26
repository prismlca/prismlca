/**
 * What a session's backend did not expect: every "Unhandled error" in its log (`app.log` in the session's logs),
 * with the traceback that follows it. The window shows such an error only as a red banner and its console stays
 * clean, so `explore` reads the log after each run as a source of findings of its own.
 */

export interface UnhandledError {
  /** The line of the "Unhandled error" record in the log, from 1. */
  line: number
  /** The traceback's last line: the exception and its message. */
  exception: string
  /** The innermost frame in PrismLCA's own backend code (`engine/lca.py:143 in get_lca`), if any. */
  where: string | null
  /** The traceback with the frames outside PrismLCA's code left out, and the exception. */
  traceback: string[]
}

// The main process writes the backend's stderr to the log chunk by chunk, "[backend] " before each chunk (trimmed),
// not before each record: a record can start mid-chunk without the prefix, and a traceback that spans two chunks has
// the prefix — and has lost its indentation — at the start of its second part. So the prefix is taken off every line,
// and records are told by their level, as the backend's logging writes them ("ERROR: [module] message").
const bare = (l: string): string => l.replace(/^\[backend\] ?/, '')
const RECORD = /^ERROR:.*\bUnhandled error\s*$/
const FRAME = /^\s*File "(.+)", line (\d+), in (.+)$/
const OWN = /[/\\]prism_lca[/\\](.+)$/

/** A line that starts the next record (any level), a message of another part of the app (`[sealed] …`) or of the
 *  main process ends a traceback. */
const nextRecord = (l: string): boolean =>
  /^(DEBUG|INFO|WARNING|ERROR|CRITICAL):/.test(l) ||
  /^\[[\w-]+\]/.test(l) ||
  /^Error occurred in handler/.test(l)

export function unhandledErrors(log: string): UnhandledError[] {
  const lines = log.split(/\r?\n/).map(bare)
  const found: UnhandledError[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!RECORD.test(lines[i])) continue
    const block: string[] = []
    for (let j = i + 1; j < lines.length && !nextRecord(lines[j]) && block.length < 400; j++)
      block.push(lines[j])
    let exception = ''
    let where: string | null = null
    const traceback: string[] = []
    for (let k = 0; k < block.length; k++) {
      const l = block[k]
      const frame = FRAME.exec(l)
      if (frame) {
        const own = OWN.exec(frame[1])
        if (own) {
          where = `${own[1].replace(/\\/g, '/')}:${frame[2]} in ${frame[3]}`
          const source = block[k + 1]
          const shown = source !== undefined && /^\s/.test(source) && !FRAME.test(source)
          traceback.push(l, ...(shown ? [source] : []))
        }
        continue
      }
      // The exception is the traceback's last line that is neither a frame, its source, nor a heading. A source
      // line that lost its indentation at a chunk's edge may pass for one on the way; the real last line follows.
      if (l.trim() && !/^\s/.test(l) && !/^(Traceback|During handling|The above exception)/.test(l)) {
        exception = l.trim()
      }
    }
    traceback.push(exception)
    found.push({ line: i + 1, exception: exception || '(no traceback)', where, traceback })
  }
  return found
}

export interface ErrorGroup {
  exception: string
  where: string | null
  count: number
  /** The first occurrence's line in the log. */
  firstLine: number
}

/** The same exception from the same place, counted once with how often it came. */
export function groupErrors(errors: UnhandledError[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>()
  for (const e of errors) {
    const key = `${e.exception}\u0000${e.where}`
    const g = groups.get(key)
    if (g) g.count++
    else groups.set(key, { exception: e.exception, where: e.where, count: 1, firstLine: e.line })
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}
