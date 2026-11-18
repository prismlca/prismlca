/**
 * The bookkeeping that decides which processes an end-to-end test may end. The first block replays a
 * Windows listing: the logon session's processes name as their parent a process that ended long before the
 * test, and an app process that got its pid must not make them the app's. The second runs on whatever
 * machine runs the suite, so the Windows job checks the PowerShell side for real.
 */
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { endAll, leftovers, ours, processTree, sameProcess, type ProcessInfo } from './processes'

const ROOT = 'C:\\Users\\runner\\AppData\\Local\\Temp\\prism-e2e-Ab12'
const SECOND = 1_000_000
const entry = (pid: number, ppid: number, command: string, second: number): ProcessInfo => ({
  pid,
  ppid,
  command,
  started: 1_790_000_000 * SECOND + second * SECOND
})

// The session's smss.exe, pid 7840, started csrss and winlogon and ended; they still name it as parent.
const csrss = entry(7856, 7840, 'csrss.exe', 0)
const winlogon = entry(7904, 7840, 'winlogon.exe {F481B221-8282-4E9D-A4C4-D41230A30000}', 0)
const session = [
  csrss,
  winlogon,
  entry(7952, 7904, '"fontdrvhost.exe"', 1),
  entry(7976, 7904, '"dwm.exe"', 1)
]

// An hour later the test starts the app; one of its helpers gets the pid smss.exe had.
const main = entry(5000, 4000, 'electron.exe D:\\a\\frontend --user-data-dir=' + ROOT + '\\user-data', 3600)
const helper = entry(7840, 5000, 'electron.exe --type=gpu-process', 3601)
const backend = entry(6000, 5000, 'python.exe -m prism_lca', 3602)

describe('which processes are the test’s', () => {
  it('takes no process that names an app process as parent but is older than it', () => {
    expect(ours([...session, main, helper, backend], [main], ROOT)).toEqual([main, helper, backend])
  })

  it('finds no stranger after the quit, though the session names a pid the app had', () => {
    expect(ours(session, [main, helper, backend], ROOT)).toEqual([])
  })

  it('takes neither a process that got a pid of the app nor what that process started', () => {
    // The main process's pid went to an update service, and a second app — the person's own PrismLCA, say —
    // has the same command line under a pid the helper had.
    const service = entry(5000, 900, 'svchost.exe -k netsvcs', 3700)
    const serviceChild = entry(5004, 5000, 'TiWorker.exe', 3701)
    const sameCommand = { ...helper, started: helper.started! + 120 * SECOND }
    expect(sameProcess(sameCommand, helper)).toBe(false)
    expect(ours([...session, service, serviceChild, sameCommand], [main, helper, backend], ROOT)).toEqual([])
  })

  it('keeps a backend that outlived the app, with what it started since', () => {
    const worker = entry(6100, 6000, 'python.exe -c "from multiprocessing.spawn import spawn_main"', 3700)
    expect(ours([...session, backend, worker], [main, helper, backend], ROOT)).toEqual([backend, worker])
  })

  it('keeps a worker found through its parent after that parent has exited', () => {
    const worker = entry(6100, 6000, 'python.exe worker', 3700)
    const listings = [
      [...session, backend, worker],
      [...session, worker],
      [...session, worker]
    ]
    const look = leftovers([main, helper, backend], ROOT, () => listings.shift() ?? [])
    expect(look()).toEqual([backend, worker])
    expect(look()).toEqual([worker])
    expect(look()).toEqual([worker])
  })

  it('keeps anything naming the install folder, however it was started', () => {
    const orphan = entry(6200, 1, `uv.exe run --directory ${ROOT}\\data`, 3700)
    expect(ours([...session, orphan], [], ROOT)).toEqual([orphan])
  })

  it('takes nothing whose start time is unknown, by pid or as a child', () => {
    const unknown = { ...backend, started: null }
    const child = { ...entry(6300, 5000, 'electron.exe --type=renderer', 3603), started: null }
    expect(ours([main, unknown, child], [main, unknown], ROOT)).toEqual([main])
  })
})

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

describe('on this machine', () => {
  it('lists a child with its start time and ends it only while it is the process listed', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true
    })
    const exited = new Promise<void>((done) => child.once('exit', () => done()))
    const nowhere = `prism-e2e-nowhere-${process.pid}-${Date.now()}`
    try {
      const tree = processTree(child, nowhere)
      expect(tree.map((p) => p.pid)).toEqual([child.pid])
      const listedChild = tree[0]
      expect(listedChild.started).toEqual(expect.any(Number))

      // The same pid with another start time is another process: left alone.
      endAll([{ ...listedChild, started: listedChild.started! - 5 * SECOND }])
      await sleep(500)
      expect(child.exitCode).toBeNull()
      expect(child.signalCode).toBeNull()
      expect(leftovers(tree, nowhere)().map((p) => p.pid)).toEqual([child.pid])

      endAll(tree)
      const ended = await Promise.race([exited.then(() => true), sleep(15_000).then(() => false)])
      expect(ended).toBe(true)
    } finally {
      child.kill()
    }
  }, 60_000)
})
