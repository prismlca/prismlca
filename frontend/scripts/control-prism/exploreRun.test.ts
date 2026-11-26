import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { analyse, markOpen, type RunRecord } from './exploreRun'

function record(dir: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    session: 'xp-test-1',
    label: 'explore',
    dir,
    seconds: 60,
    outcome: 'complete',
    bombadil: { exit: 0, seconds: 60 },
    digest: null,
    namedFunctions: [],
    hitBlocks: [],
    totalBlocks: 0,
    backend: { unhandled: 0, groups: [] },
    consoleErrors: 0,
    refused: { count: 0, byKind: {}, targets: [] },
    load: [],
    screenshots: {},
    stopped: true,
    ...over
  }
}

describe('the evidence of a run', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const quiet = (): void => undefined

  it('is open, never green, when Bombadil ran but left no trace and no backend log', async () => {
    dir = mkdtempSync(join(tmpdir(), 'explore-run-'))
    const r = record(dir)
    await analyse(r, '/no/bombadil', quiet)
    expect(r.outcome).toBe('open')
    expect(r.why).toBe('the session left no backend log to read (logs/app.log); Bombadil left no trace')
  })

  it('reads the backend log of a run that never reached Bombadil, and leaves it not started', async () => {
    dir = mkdtempSync(join(tmpdir(), 'explore-run-'))
    mkdirSync(join(dir, 'logs'))
    writeFileSync(
      join(dir, 'logs', 'app.log'),
      '[backend] ERROR: [prism_lca.api.error_handlers] Unhandled error\nTraceback (most recent call last):\nKeyError: 1\n'
    )
    const r = record(dir, { outcome: 'not started', bombadil: null, why: 'the preparation failed' })
    await analyse(r, '/no/bombadil', quiet)
    expect(r.outcome).toBe('not started')
    expect(r.why).toBe('the preparation failed')
    expect(r.backend.unhandled).toBe(1)
  })

  it('keeps every reason a run is open', () => {
    const r = record('/x')
    markOpen(r, 'one')
    markOpen(r, 'two')
    expect(r).toMatchObject({ outcome: 'open', why: 'one; two' })
    const n = record('/x', { outcome: 'not started' })
    markOpen(n, 'stop did not end the session')
    expect(n.outcome).toBe('not started')
  })
})
