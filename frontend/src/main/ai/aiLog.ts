/**
 * The `[prism-ai]` lines of the main process: the assistant's own log, one line per event worth
 * reading afterwards (a round, a compaction, a provider error).
 *
 * Every line carries the local time in front of the tag. Without it a run could be followed in the
 * log only by its order — how long a round took, or what happened at the minute a user remembers,
 * was not in it. The stamp goes before `[prism-ai]` so a reader matching on "[prism-ai] cache:" still
 * finds the line.
 *
 * The console is looked up on every call, never captured: the MCP bridge points `console.log` at
 * stderr once it starts (mcp/proxyMain.ts), and a line written through a stale reference would land
 * in the protocol stream on stdout.
 *
 * Never put a key, a prompt or a tool result into a line — a number, a name or a status is enough.
 */
import { localTimestamp } from './localTime'

const TAG = '[prism-ai]'

/** The line as it is written: stamp, tag, message. */
export function aiLine(message: string, at: Date = new Date()): string {
  return `${localTimestamp(at)} ${TAG} ${message}`
}

export function aiLog(message: string): void {
  console.log(aiLine(message))
}

/** A line that reports something going wrong (a fallback, a cache that stopped working). */
export function aiWarn(message: string): void {
  console.warn(aiLine(message))
}
