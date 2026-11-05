import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { endpointPath, pidAlive, readEndpoint, writeEndpoint } from './endpoint'

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'prism-endpoint-'))
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('the endpoint file', () => {
  it('is read only when it names a loopback MCP URL and a process id', () => {
    const good = { url: 'http://127.0.0.1:4242/mcp', token: 't', pid: 42, version: '1', startedAt: 'x' }
    writeEndpoint(userData, good)
    expect(readEndpoint(userData)).toEqual(good)
    for (const bad of [
      { ...good, url: 'http://example.com:4242/mcp' },
      { ...good, url: 'http://127.0.0.1:4242/other' },
      { ...good, pid: 0 },
      { ...good, pid: '42' },
      { ...good, version: 1 },
      { ...good, token: undefined }
    ]) {
      writeFileSync(endpointPath(userData), JSON.stringify(bad))
      expect(readEndpoint(userData)).toBeNull()
    }
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    "counts another account's process as not the app",
    () => {
      expect(pidAlive(process.pid)).toBe(true)
      expect(pidAlive(1)).toBe(false) // init: alive, but not this user's
      expect(pidAlive(-1)).toBe(false)
    }
  )
})
