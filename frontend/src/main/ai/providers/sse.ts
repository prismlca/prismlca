/**
 * Server-sent-events framing, as the WHATWG spec defines it for the parts the providers use: an event is
 * the lines up to a blank line, its `data:` lines joined with "\n"; comment lines (":", OpenRouter's
 * keep-alive) and the other fields (`event:`, `id:`, `retry:`) are skipped — every provider here repeats
 * the event type inside its JSON. Reading single `data:` lines instead worked only as long as no provider
 * split an event over two of them.
 */
export class SseFramer {
  private buffer = ''
  private data: string[] = []

  /** Feed decoded text; returns the data of every event this text completed, in order. */
  push(text: string): string[] {
    this.buffer += text
    const out: string[] = []
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line === '') {
        this.dispatch(out)
        continue
      }
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      let value = colon < 0 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field !== 'data') continue
      // A provider that separates its events by newline only (no blank line) would otherwise have every
      // event of the reply joined into one, delivered at the very end — the stream would stop streaming.
      // Pending data that is already a whole JSON value cannot be the start of a multi-line one, so it is
      // delivered before the next line joins it.
      if (this.data.length && isJson(this.data.join('\n'))) this.dispatch(out)
      this.data.push(value)
    }
    return out
  }

  /** The stream ended: a last event without its closing blank line still counts. */
  end(): string[] {
    const out = this.buffer ? this.push('\n') : []
    this.dispatch(out)
    return out
  }

  private dispatch(out: string[]): void {
    if (this.data.length) out.push(this.data.join('\n'))
    this.data = []
  }
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * One event's data as JSON. Normally one object; a provider that put two objects on two `data:` lines of
 * one event — not valid SSE, but cheap to survive — is read line by line rather than lost. `null` when
 * the data is not JSON at all; the caller says so in the log instead of skipping it silently.
 */
export function parseEventData(data: string): unknown[] | null {
  try {
    return [JSON.parse(data)]
  } catch {
    /* not one JSON value — try line by line below */
  }
  const lines = data.split('\n')
  if (lines.length > 1) {
    try {
      return lines.map((l) => JSON.parse(l))
    } catch {
      /* not that either */
    }
  }
  return null
}
