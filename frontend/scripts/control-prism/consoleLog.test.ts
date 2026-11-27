import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { consoleLine, readConsoleFile } from './consoleLog'

describe('readConsoleFile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-console-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads back what the host wrote, messages with line breaks included, so a new host counts on', () => {
    // A host that starts the app again on a kept copy goes on from here: a cursor taken before (--since 2)
    // must not hide what comes after, and "since launch" must still hold the earlier errors.
    const file = join(dir, 'console.log')
    const written = [
      { n: 1, at: '2026-11-27T18:00:00.000Z', type: 'log', text: 'ready' },
      {
        n: 2,
        at: '2026-11-27T18:00:01.000Z',
        type: 'error',
        text: 'Error: boom\n    at a (x.js:1)\n#3 is not an entry'
      },
      { n: 3, at: '2026-11-27T18:00:02.000Z', type: 'pageerror', text: 'TypeError: x is undefined' }
    ]
    for (const e of written) appendFileSync(file, consoleLine(e))
    expect(readConsoleFile(file)).toEqual(written)
  })

  it('has no entries when there is no file yet', () => {
    expect(readConsoleFile(join(dir, 'console.log'))).toEqual([])
  })
})
