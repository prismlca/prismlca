/**
 * The processes of one test installation: the app's main process and everything it started, taken as a
 * snapshot while the app runs, and what of that snapshot is still running after a quit.
 *
 * Only processes descended from the app the test launched count (and anything naming the test's own
 * install folder), never a process found by its program name — the person running the tests may have
 * PrismLCA open, and its backend is not ours to end.
 *
 * Nor is a process ever taken by its pid alone. Windows hands the pid of an exited process to the next one
 * that starts, and a process keeps the pid of its parent after that parent has exited: csrss.exe and
 * winlogon.exe name as their parent a process that ended at logon, so once one of the app's processes got
 * that pid, they looked like its children, and so did everything they started. A process here is its pid,
 * its start time and its command line together, and a child counts only if it started no earlier than the
 * parent it names — a process older than the holder of a pid cannot have been started by it.
 *
 * Playwright resolves `close()` only once every holder of the app's output pipes has let go, and on
 * Windows a child inherits those pipes from its parent, so one leftover grandchild makes a quit look
 * hung. On Linux the opposite: a leftover backend holds nothing of the test's and would go unnoticed.
 * Checking the snapshot after the quit catches both.
 */
import { execFileSync, type ChildProcess } from 'node:child_process'

export interface ProcessInfo {
  pid: number
  ppid: number
  command: string
  /** When the process started, in microseconds since 1970 (whole seconds on Linux and macOS), or null where
   *  the system does not say. Meant for comparing with other start times from the same listing code. */
  started: number | null
}

/**
 * A Win32_Process's start time (`$_`) as whole microseconds since 1970: an integer crosses JSON unchanged,
 * so the value the kill script computes again can be compared for equality.
 */
const WIN_STARTED =
  'if ($_.CreationDate) { [long][math]::Floor((([DateTimeOffset]$_.CreationDate).UtcTicks - 621355968000000000) / 10) }'

/** Runs a Windows PowerShell script; encoded, so no quote in it meets the command line's quoting rules. */
function powershell(script: string): string {
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  )
}

/** Every running process except this one. */
export function listProcesses(): ProcessInfo[] {
  return allProcesses().filter((p) => p.pid !== process.pid)
}

function allProcesses(): ProcessInfo[] {
  if (process.platform === 'win32') {
    const json = powershell(
      `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='Started';e={${WIN_STARTED}}} | ConvertTo-Json -Compress`
    )
    const rows = [JSON.parse(json)].flat() as {
      ProcessId: number
      ParentProcessId: number
      Name: string
      CommandLine: string | null
      Started: number | null
    }[]
    return rows.map((r) => ({
      pid: r.ProcessId,
      ppid: r.ParentProcessId,
      command: r.CommandLine ?? r.Name,
      started: typeof r.Started === 'number' ? r.Started : null
    }))
  }
  // `lstart` in the C locale ("Tue Nov 17 18:04:05 2026") is the same text on Linux and macOS, whatever
  // language the person running the tests has set; it is computed from the boot time, so it does not drift
  // between two listings.
  return execFileSync('ps', ['-eo', 'pid=,ppid=,lstart=,args='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' }
  })
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => {
      const started = Date.parse(m[3])
      return {
        pid: Number(m[1]),
        ppid: Number(m[2]),
        command: m[4],
        started: Number.isNaN(started) ? null : started * 1000
      }
    })
}

/** Whether `a` and `b` are one process: the same pid, start time and command line. */
export function sameProcess(a: ProcessInfo, b: ProcessInfo): boolean {
  return a.pid === b.pid && a.started !== null && a.started === b.started && a.command === b.command
}

/** Whether `parent` started `child`: the child names its pid and started no earlier. */
function startedBy(child: ProcessInfo, parent: ProcessInfo): boolean {
  return (
    child.ppid === parent.pid &&
    child.pid !== parent.pid &&
    child.started !== null &&
    parent.started !== null &&
    child.started >= parent.started
  )
}

/**
 * The processes of `running` that are the test's: those of `known` still running (the same process, not
 * merely the same pid), what one of them started, and anything naming `installRoot`.
 *
 * A child is found only through a parent that is still running. One whose parent has exited names a pid that
 * may belong to anything by now, and there is no telling whether it was started before or after the pid
 * passed on; such a child counts only if it was in `known` already or names `installRoot`.
 */
export function ours(running: ProcessInfo[], known: ProcessInfo[], installRoot: string): ProcessInfo[] {
  const found = new Set(
    running.filter((p) => p.command.includes(installRoot) || known.some((k) => sameProcess(k, p)))
  )
  for (let grew = true; grew; ) {
    grew = false
    for (const p of running) {
      if (found.has(p)) continue
      for (const parent of found) {
        if (startedBy(p, parent)) {
          found.add(p)
          grew = true
          break
        }
      }
    }
  }
  return running.filter((p) => found.has(p))
}

/**
 * The test's processes now: `child` (the process the test started), what descends from it, and anything
 * naming `installRoot`. `child` counts only while Node has not yet reported its exit: until then it is not
 * reaped either, so the pid in the listing is still its own and cannot have passed to another process.
 */
export function processTree(child: ChildProcess, installRoot: string): ProcessInfo[] {
  const running = listProcesses()
  const alive = child.exitCode === null && child.signalCode === null && child.pid !== undefined
  const root = alive ? running.find((p) => p.pid === child.pid) : undefined
  if (root !== undefined && root.started === null) {
    throw new Error(
      `The process listing gives no start time for pid ${root.pid}; without one, no process can be told ` +
        `apart from a stranger that got a pid back.`
    )
  }
  return ours(running, root === undefined ? [] : [root], installRoot)
}

/**
 * Watches what of `snapshot` is still running, for as many looks as the caller takes. Each look returns the
 * test's processes running now — those of the snapshot, what they started, anything naming `installRoot` —
 * and remembers every process it found, so a worker found through its parent keeps counting after that
 * parent has exited and left it naming a pid that may by now be anybody's.
 */
export function leftovers(
  snapshot: ProcessInfo[],
  installRoot: string,
  list: () => ProcessInfo[] = listProcesses
): () => ProcessInfo[] {
  let known = snapshot
  return () => {
    const left = ours(list(), known, installRoot)
    known = [...known, ...left.filter((p) => !known.some((k) => sameProcess(k, p)))]
    return left
  }
}

export function listed(processes: ProcessInfo[]): string {
  if (processes.length === 0) return ' none'
  return processes.map((p) => `\n  pid ${p.pid} (parent ${p.ppid}): ${p.command.slice(0, 300)}`).join('')
}

/**
 * Ends every process in the list that is still the one listed: same pid, start time and command line. One
 * that is gone, or whose pid has passed to another process meanwhile, is left alone.
 */
export function endAll(processes: ProcessInfo[]): void {
  const targets = processes.filter((p) => p.started !== null)
  if (targets.length === 0) return
  if (process.platform === 'win32') {
    endOnWindows(targets)
    return
  }
  // Linux and macOS hand out pids in turn and come back to a freed one only after running through all the
  // others, so a check a moment before the signal is as good as one at the moment.
  const running = listProcesses()
  for (const p of targets) {
    if (!running.some((r) => sameProcess(r, p))) continue
    try {
      process.kill(p.pid, 'SIGKILL')
    } catch {
      /* gone already */
    }
  }
}

/**
 * Windows reuses a freed pid soon, so the check and the kill go through one handle: while the script holds
 * it, the process cannot be gone for good and its pid cannot pass on. A process the script cannot open
 * is left alone, and so is one whose start time is no longer the listed one.
 */
function endOnWindows(targets: ProcessInfo[]): void {
  // In batches, because the script travels on the command line, which Windows caps at 32,767 characters.
  for (let i = 0; i < targets.length; i += 40) {
    const list = targets
      .slice(i, i + 40)
      .map((p) => `  [pscustomobject]@{ Id = ${p.pid}; Started = ${p.started} }`)
    const script = [
      '$targets = @(',
      ...list,
      ')',
      'foreach ($t in $targets) {',
      '  try {',
      '    $p = [System.Diagnostics.Process]::GetProcessById($t.Id)',
      '    $null = $p.Handle',
      `    $now = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $t.Id) | ForEach-Object { ${WIN_STARTED} }`,
      '    if ($null -ne $now -and $now -eq $t.Started) { $p.Kill() }',
      '  } catch {}',
      '}',
      // A process that was gone already is no failure of the script.
      'exit 0'
    ].join('\n')
    try {
      powershell(script)
    } catch (e) {
      console.warn(`could not end the leftover processes: ${String(e)}`)
    }
  }
}
