/**
 * The processes of one test installation: the app's main process and everything it started, taken as a
 * snapshot while the app runs, and what of that snapshot is still running after a quit.
 *
 * Only processes descended from the app the test launched count (and anything naming the test's own
 * install folder), never a process found by its program name — the person running the tests may have
 * PrismLCA open, and its backend is not ours to end.
 *
 * Playwright resolves `close()` only once every holder of the app's output pipes has let go, and on
 * Windows a child inherits those pipes from its parent, so one leftover grandchild makes a quit look
 * hung. On Linux the opposite: a leftover backend holds nothing of the test's and would go unnoticed.
 * Checking the snapshot after the quit catches both.
 */
import { execFileSync } from 'node:child_process'

export interface ProcessInfo {
  pid: number
  ppid: number
  command: string
}

function allProcesses(): ProcessInfo[] {
  if (process.platform === 'win32') {
    const json = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }
    )
    const rows = JSON.parse(json) as {
      ProcessId: number
      ParentProcessId: number
      Name: string
      CommandLine: string | null
    }[]
    return rows.map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, command: r.CommandLine ?? r.Name }))
  }
  return execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }))
}

/** The running processes that are `roots`, descend from one, or name `installRoot` on their command line. */
export function processTree(roots: number[], installRoot: string): ProcessInfo[] {
  const all = allProcesses().filter((p) => p.pid !== process.pid)
  const ours = new Set(roots)
  for (const p of all) if (p.command.includes(installRoot)) ours.add(p.pid)
  for (let grew = true; grew; ) {
    grew = false
    for (const p of all) {
      if (!ours.has(p.pid) && ours.has(p.ppid)) {
        ours.add(p.pid)
        grew = true
      }
    }
  }
  return all.filter((p) => ours.has(p.pid))
}

export function listed(processes: ProcessInfo[]): string {
  if (processes.length === 0) return ' none'
  return processes.map((p) => `\n  pid ${p.pid} (parent ${p.ppid}): ${p.command.slice(0, 300)}`).join('')
}

/** Ends every process in the list; one that is already gone is no error. */
export function endAll(processes: ProcessInfo[]): void {
  for (const p of processes) {
    try {
      process.kill(p.pid, 'SIGKILL')
    } catch {
      /* gone already */
    }
  }
}
