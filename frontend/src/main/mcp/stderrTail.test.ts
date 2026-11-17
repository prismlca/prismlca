import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { stderrTail } from './stderrTail'

describe('stderrTail', () => {
  it('returns the last lines of what was written, across chunk borders', () => {
    const s = new PassThrough()
    const tail = stderrTail(s, 2)
    s.write('[prism-mcp-bridge] one\n[prism-mcp-br')
    s.write('idge] ready (PrismLCA 1.2.3)\r\n\n[prism-mcp-bridge] The client closed standard input\n')
    expect(tail()).toBe(
      '[prism-mcp-bridge] ready (PrismLCA 1.2.3) | [prism-mcp-bridge] The client closed standard input'
    )
  })

  it('keeps only the end of a long log', () => {
    const s = new PassThrough()
    const tail = stderrTail(s, 3, 20)
    s.write(`${'x'.repeat(500)}\nlast line\n`)
    expect(tail()).toBe('xxxxxxxxx | last line')
  })

  it('is empty for a bridge that said nothing, or without a stream', () => {
    expect(stderrTail(new PassThrough())()).toBe('')
    expect(stderrTail(null)()).toBe('')
  })
})
