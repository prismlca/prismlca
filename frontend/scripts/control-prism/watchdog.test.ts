import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callerDeadline, described, hostDeadline, Overdue, Watchdog } from './watchdog'

const never = (): Promise<string> => new Promise<string>(() => undefined)

/** A command whose end the test decides. */
function controlled(): {
  work: () => Promise<string>
  finish: (t: string) => void
  fail: (e: Error) => void
} {
  let finish!: (t: string) => void
  let fail!: (e: Error) => void
  const p = new Promise<string>((ok, no) => {
    finish = ok
    fail = no
  })
  return { work: () => p, finish, fail }
}

const req = (cmd: string, args: string[] = [], flags: Record<string, string | true> = {}) => ({
  cmd,
  args,
  flags
})

describe('deadlines', () => {
  it('gives the host its own bound plus a margin, and the caller a little longer still', () => {
    expect(hostDeadline('snapshot', {})).toBe(30_000)
    expect(callerDeadline('snapshot', {})).toBe(40_000)
    expect(hostDeadline('wait', {})).toBe(50_000)
    expect(callerDeadline('wait', {})).toBe(60_000)
    expect(hostDeadline('wait', { timeout: '600000' })).toBe(620_000)
    expect(hostDeadline('click', { timeout: '2000' })).toBe(22_000)
    // A whole-window shot has Playwright's own 30 s; a targeted one takes --timeout when it is longer.
    expect(callerDeadline('shot', {})).toBe(60_000)
    expect(hostDeadline('shot', { target: 'Run', timeout: '120000' })).toBe(140_000)
    expect(callerDeadline('read', {})).toBe(60_000)
    expect(callerDeadline('facts', {})).toBe(40_000)
    // --timeout is capped as wait caps it; nonsense falls back to the default.
    expect(hostDeadline('wait', { timeout: '99999999' })).toBe(15 * 60_000 + 20_000)
    expect(hostDeadline('wait', { timeout: 'soon' })).toBe(50_000)
  })

  it('never gives up on stop or restart, whose callers still wait a bounded time', () => {
    expect(hostDeadline('stop', {})).toBeNull()
    expect(hostDeadline('restart', {})).toBeNull()
    expect(callerDeadline('stop', {})).toBe(3 * 60_000)
    expect(callerDeadline('restart', {})).toBe(6 * 60_000)
    // A name that is a property of every object is no command of its own.
    expect(hostDeadline('toString', {})).toBe(50_000)
  })

  it('names a command without the text it types or the script it reads', () => {
    expect(described(req('click', ['role=button:Delete']))).toBe('click "role=button:Delete"')
    expect(described(req('type', ['label=Name', 'secret text']))).toBe('type "label=Name"')
    expect(described(req('read', ['document.title']))).toBe('read')
    expect(described(req('wait', ['visible', 'Run']))).toBe('wait visible "Run"')
    expect(described(req('wait', ['app-ready']))).toBe('wait app-ready')
    expect(described(req('drag', ['A', 'B']))).toBe('drag "A" onto "B"')
    expect(described(req('press', ['Control+z'], { target: 'Canvas' }))).toBe('press Control+z "Canvas"')
    expect(described(req('shot', ['/tmp/x.png']))).toBe('shot')
    expect(described(req('snapshot', [], { target: 'css=.modal' }))).toBe('snapshot "css=.modal"')
  })
})

describe('Watchdog', () => {
  let log: string[]
  let dog: Watchdog
  beforeEach(() => {
    vi.useFakeTimers()
    log = []
    dog = new Watchdog((l) => log.push(l))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes answers and failures through unchanged, and gives up on nothing that settled', async () => {
    await expect(dog.run(req('snapshot'), async () => 'tree')).resolves.toBe('tree')
    await expect(
      dog.run(req('click', ['Run']), async () => {
        throw new Error('Timeout 10000ms exceeded')
      })
    ).rejects.toThrow('Timeout 10000ms exceeded')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(log).toEqual([])
    expect(dog.state()).toEqual({ busy: [], outstanding: null, overdue: [] })
  })

  it('answers for a look that never settles at its deadline, and lets the next command run', async () => {
    const stuck = dog.run(req('shot', ['/tmp/a.png']), never)
    const seen = expect(stuck).rejects.toThrow(Overdue)
    await vi.advanceTimersByTimeAsync(49_999)
    expect(log).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await seen
    await expect(stuck).rejects.toThrow(
      /^shot did not finish within 50 s \(its own bound is 30 s\): the driver is stuck, not necessarily the window\. The session takes the next command\./
    )
    expect(log).toEqual(['gave up on shot after 50 s'])
    // A look cannot act late: driving goes on. doctor still sees the call Playwright never answered.
    await expect(dog.run(req('click', ['Run']), async () => 'clicked Run')).resolves.toBe('clicked Run')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(dog.state()).toEqual({ busy: [], outstanding: null, overdue: [{ what: 'shot', ms: 4_000 }] })
    // Until a restart retires the old window.
    dog.reset()
    expect(dog.state().overdue).toEqual([])
  })

  it('forgets a look given up on once it settles, without news', async () => {
    const c = controlled()
    const stuck = dog.run(req('snapshot'), c.work)
    const seen = expect(stuck).rejects.toThrow(Overdue)
    await vi.advanceTimersByTimeAsync(30_000)
    await seen
    expect(dog.state().overdue).toEqual([{ what: 'snapshot', ms: 0 }])
    c.fail(new Error('Timeout 10000ms exceeded'))
    await vi.advanceTimersByTimeAsync(0)
    expect(dog.state().overdue).toEqual([])
    expect(dog.takeNews()).toBeUndefined()
    expect(log.at(-1)).toBe('snapshot, given up on earlier, failed after all (Timeout 10000ms exceeded)')
  })

  it('drives nothing while a click given up on may still land, and says when it did', async () => {
    const c = controlled()
    const stuck = dog.run(req('click', ['role=button:Delete']), c.work)
    const seen = expect(stuck).rejects.toThrow(/may still land, so this session drives nothing/)
    await vi.advanceTimersByTimeAsync(30_000)
    await seen
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(dog.run(req('type', ['label=Name', 'x']), async () => 'typed')).rejects.toThrow(
      /^the earlier click "role=button:Delete", given up on 5 s ago, has not finished and may still land/
    )
    // Looking goes on.
    await expect(dog.run(req('snapshot'), async () => 'tree')).resolves.toBe('tree')
    expect(dog.state().outstanding).toEqual({ what: 'click "role=button:Delete"', ms: 5_000 })

    await vi.advanceTimersByTimeAsync(7_000)
    c.finish('clicked')
    await vi.advanceTimersByTimeAsync(0)
    expect(dog.state().outstanding).toBeNull()
    expect(dog.takeNews()).toBe(
      'the earlier click "role=button:Delete", given up on at its deadline, finished after all, 12 s later'
    )
    expect(dog.takeNews()).toBeUndefined()
    expect(log.at(-1)).toBe('click "role=button:Delete", given up on earlier, finished after all, 12 s later')
    await expect(dog.run(req('type', ['label=Name', 'x']), async () => 'typed')).resolves.toBe('typed')
  })

  it('says so too when a command given up on fails after all', async () => {
    const c = controlled()
    const stuck = dog.run(req('press', ['Enter']), c.work)
    const seen = expect(stuck).rejects.toThrow(Overdue)
    await vi.advanceTimersByTimeAsync(30_000)
    await seen
    c.fail(new Error('Target page, context or browser has been closed\nCall log: …'))
    await vi.advanceTimersByTimeAsync(0)
    expect(dog.takeNews()).toBe(
      'the earlier press Enter, given up on at its deadline, failed after all (Target page, context or browser has been closed)'
    )
    expect(dog.state().outstanding).toBeNull()
  })

  it('forgets what the old window had outstanding at a restart', async () => {
    const old = controlled()
    const stuck = dog.run(req('click', ['Run']), old.work)
    const seen = expect(stuck).rejects.toThrow(Overdue)
    await vi.advanceTimersByTimeAsync(30_000)
    await seen
    dog.reset()
    expect(dog.state().outstanding).toBeNull()
    // A click on the new window is given up on too; the old one settling must not free it.
    const next = controlled()
    const stuckAgain = dog.run(req('click', ['Calculate']), next.work)
    const seenAgain = expect(stuckAgain).rejects.toThrow(Overdue)
    await vi.advanceTimersByTimeAsync(30_000)
    await seenAgain
    old.fail(new Error('Target closed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(dog.takeNews()).toBeUndefined()
    expect(dog.state().outstanding?.what).toBe('click "Calculate"')
  })

  it("names what holds the line and when it is given up on, leaving out doctor's own question", async () => {
    const wait = controlled()
    const waiting = dog.run(req('wait', ['visible', 'Run'], { timeout: '60000' }), wait.work)
    const restart = controlled()
    const restarting = dog.run(req('restart'), restart.work)
    const facts = controlled()
    const asking = dog.run(req('facts'), facts.work)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(dog.state()).toEqual({
      busy: [
        { what: 'wait visible "Run"', ms: 12_000, leftMs: 68_000 },
        { what: 'restart', ms: 12_000, leftMs: null }
      ],
      outstanding: null,
      overdue: []
    })
    wait.finish('Run is visible')
    restart.finish('started again')
    facts.finish('{}')
    await expect(waiting).resolves.toBe('Run is visible')
    await expect(restarting).resolves.toBe('started again')
    await expect(asking).resolves.toBe('{}')
    expect(dog.state().busy).toEqual([])
  })

  it('does not give up on a restart however long it takes', async () => {
    const restart = controlled()
    const restarting = dog.run(req('restart'), restart.work)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(log).toEqual([])
    restart.finish('started again')
    await expect(restarting).resolves.toBe('started again')
  })
})
