/**
 * Doctor's verdict on a sealed session, the log as `refused` lists it, and a log with a torn last line.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppFacts, BackendFacts } from './facts'
import { judgeSeal, PROBE_HOST, readSealLog, refusedLines, type SealEntry, type SealFacts } from './sealed'
import type { SessionRecord } from './session'

const LOG = '/w/frontend/.cache/control-prism/logs/default/sealed.jsonl'
const TRAP = 'http://127.0.0.1:41000'

const entry = (over: Partial<SealEntry>): SealEntry => ({
  at: '2026-11-21T18:00:01.000Z',
  proc: 'main',
  pid: 100,
  kind: 'network',
  target: 'prismlca.com:443',
  via: 'node',
  outcome: 'refused',
  ...over
})

const MAIN_IN_PLACE = entry({ kind: 'sealed', target: 'links, …', via: 'main', outcome: 'in place' })
const BACKEND_IN_PLACE = entry({
  proc: 'backend',
  pid: 7,
  kind: 'sealed',
  via: 'audit hook',
  outcome: 'in place'
})
const WINDOW_IN_PLACE = entry({
  kind: 'sealed',
  target: 'choosers of window 2',
  via: 'debugger',
  outcome: 'in place'
})
const PROBES = [
  entry({ target: `${PROBE_HOST}:443` }),
  entry({ target: `https://${PROBE_HOST}/`, via: 'chromium' })
]

function seal(over: Partial<SealFacts> = {}): SealFacts {
  return {
    pid: 100,
    log: LOG,
    trap: TRAP,
    node: 'refused',
    chromium: 'refused',
    windows: [{ id: 2, url: 'file:///w/frontend/out/renderer/index.html', attached: true }],
    ...over
  }
}

const backend = (over: Partial<BackendFacts> = {}): BackendFacts =>
  ({ pid: 7, seal: LOG, proxy: TRAP, ...over }) as BackendFacts
const app = (over: Partial<AppFacts> = {}): AppFacts =>
  ({ seal: seal(), backends: [backend()], ...over }) as AppFacts
// An older record has no `seal` at all.
const record = (sealLog: string | null | 'absent' = LOG): SessionRecord =>
  (sealLog === 'absent' ? {} : { seal: sealLog }) as SessionRecord

const fails = (checks: { status: string; text: string }[]): string[] =>
  checks.filter((c) => c.status === 'FAIL').map((c) => c.text)

describe('judgeSeal', () => {
  const log = [MAIN_IN_PLACE, WINDOW_IN_PLACE, BACKEND_IN_PLACE, ...PROBES]

  it('passes a session sealed in every part, and counts what it refused apart from the probes', () => {
    const checks = judgeSeal(record(), app(), [...log, entry({ kind: 'link', target: 'https://x.invalid/' })])
    expect(fails(checks)).toEqual([])
    expect(checks.map((c) => c.text)).toEqual([
      `the app is sealed: what it refuses is written to ${LOG}`,
      'no part of the seal failed',
      "a request through the main process's Node is refused",
      "a request through the main process's Chromium is refused",
      "file and colour choosers are cancelled in each of the app's web contents (1)",
      'the backend (pid 7) refuses its own lookups and connections',
      `the backend's proxy variables lead to the trap (${TRAP})`,
      '1 attempt(s) refused so far — refused lists them'
    ])
  })

  it('only notes an unsealed session, and older records count as unsealed', () => {
    for (const r of [record(null), record('absent')]) {
      const checks = judgeSeal(r, app({ seal: null }), null)
      expect(checks).toEqual([
        { status: 'note', text: expect.stringMatching(/^not sealed: .* launch --sealed/) }
      ])
    }
  })

  it('fails when the app is not sealed though launch asked, or writes elsewhere', () => {
    expect(fails(judgeSeal(record(), app({ seal: null }), log))).toEqual([
      expect.stringMatching(/asked for a sealed instance, but the app is not sealed/)
    ])
    expect(fails(judgeSeal(record(), app({ seal: seal({ log: '/elsewhere.jsonl' }) }), log))).toEqual([
      expect.stringMatching(/writes its seal log to \/elsewhere\.jsonl/)
    ])
    expect(fails(judgeSeal(record(null), app(), log))).toEqual([
      expect.stringMatching(/sealed .* though launch was not asked/)
    ])
  })

  it('fails each part that is not in place', () => {
    const broken = app({
      seal: seal({
        node: 'ENOTFOUND',
        chromium: 'net::ERR_NAME_NOT_RESOLVED',
        windows: [
          { id: 2, url: 'file:///w/frontend/out/renderer/index.html', attached: true },
          { id: 3, url: 'data:text/html,splash', attached: true }
        ]
      }),
      backends: [backend({ pid: 8, proxy: null })]
    })
    const failed = entry({
      kind: 'sealed',
      target: 'child processes unsealed: EADDRINUSE',
      via: 'proxy',
      outcome: 'failed'
    })
    expect(fails(judgeSeal(record(), broken, [WINDOW_IN_PLACE, BACKEND_IN_PLACE, failed]))).toEqual([
      expect.stringMatching(/main process wrote no "sealed in place" line/),
      expect.stringMatching(/part of the seal failed: child processes unsealed: EADDRINUSE \(proxy\)/),
      expect.stringMatching(/Node was not refused by the seal \(ENOTFOUND\)/),
      expect.stringMatching(/Chromium was not refused by the seal \(net::ERR_NAME_NOT_RESOLVED\)/),
      expect.stringMatching(/not cancelled in data:text\/html,splash/),
      expect.stringMatching(/backend \(pid 8\) wrote no "sealed in place" line/),
      expect.stringMatching(/HTTPS_PROXY is null, not the trap/)
    ])
  })

  it("holds only the running app's failures against it: a restart appends to the same log", () => {
    const earlier = entry({
      pid: 99,
      kind: 'dialog',
      target: 'choosers of window 2: detached',
      via: 'debugger',
      outcome: 'failed'
    })
    expect(fails(judgeSeal(record(), app(), [earlier, ...log]))).toEqual([])
    const now = { ...earlier, pid: 100 }
    expect(fails(judgeSeal(record(), app(), [now, ...log]))).toEqual([
      expect.stringMatching(/part of the seal failed: choosers of window 2: detached/)
    ])
  })

  it('notes that the backend goes unchecked where /proc cannot be read', () => {
    const checks = judgeSeal(record(), app({ backends: null }), log)
    expect(fails(checks)).toEqual([])
    expect(checks.some((c) => c.status === 'note' && /only checked on Linux/.test(c.text))).toBe(true)
  })
})

describe('the log', () => {
  it('lists every attempt by its line, leaves out the seals, marks the probes, and starts after --since', () => {
    const entries = [
      MAIN_IN_PLACE,
      entry({ kind: 'link', target: 'https://www.prismlca.com/handbook/', via: 'shell.openExternal' }),
      PROBES[0],
      entry({
        kind: 'dialog',
        target: 'file chooser (selectSingle)',
        via: '<input type=file>',
        outcome: 'cancelled'
      })
    ]
    expect(refusedLines(entries, 0)).toEqual([
      '#2 18:00:01 main link refused: https://www.prismlca.com/handbook/ — shell.openExternal',
      `#3 18:00:01 main network refused: ${PROBE_HOST}:443 — node (doctor's probe)`,
      '#4 18:00:01 main dialog cancelled: file chooser (selectSingle) — <input type=file>'
    ])
    expect(refusedLines(entries, 3)).toEqual([expect.stringMatching(/^#4 /)])
  })

  it('reads what is whole and skips a line torn off mid-write; no file is null', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'prism-sealed-')), 'sealed.jsonl')
    expect(readSealLog(path)).toBeNull()
    writeFileSync(path, `${JSON.stringify(MAIN_IN_PLACE)}\n\n{"at":"2026-11-21T18:0`)
    expect(readSealLog(path)).toEqual([MAIN_IN_PLACE])
  })
})
