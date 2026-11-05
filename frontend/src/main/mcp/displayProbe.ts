/**
 * The machine behind displayEnv.ts's questions, read from the live Linux system: who owns a path, who
 * serves an X display, which displays logind assigns to this user's sessions. Read-only — nothing here
 * connects to a display. The roots are parameters so the test can point them at a temporary directory
 * instead of the real /tmp/.X11-unix.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { DisplayFs } from './displayEnv'

export interface ProbeRoots {
  /** Where X servers put their sockets (/tmp/.X11-unix); the abstract name is the same path with '@'. */
  x11Dir: string
  /** Where X servers put their lock files .X<n>-lock (/tmp). */
  lockDir: string
  proc: string
  /** systemd-logind's runtime state (/run/systemd). */
  logind: string
}

export const LINUX_ROOTS: ProbeRoots = {
  x11Dir: '/tmp/.X11-unix',
  lockDir: '/tmp',
  proc: '/proc',
  logind: '/run/systemd'
}

/** The real machine, as displayEnv.ts asks about it. */
export function linuxDisplayFs(uid: number | undefined = process.getuid?.()): DisplayFs {
  return {
    exists: existsSync,
    list: (d) => {
      try {
        return readdirSync(d)
      } catch {
        return []
      }
    },
    home: homedir(),
    owner: ownerOf,
    xServer: (n) => xServerOf(n),
    sessionDisplays: () => (uid === undefined ? [] : sessionDisplaysOf(uid))
  }
}

export function ownerOf(p: string): { uid: number; mode: number; socket: boolean; dir: boolean } | null {
  try {
    const s = lstatSync(p)
    return { uid: s.uid, mode: s.mode & 0o7777, socket: s.isSocket(), dir: s.isDirectory() }
  } catch {
    return null
  }
}

/** A small regular file, opened without following a link and without blocking; anything else is null. */
function readSmallFile(p: string, max = 4096): { text: string; uid: number } | null {
  let fd: number | null = null
  try {
    fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const s = fstatSync(fd)
    if (!s.isFile() || s.size > max) return null
    const buf = Buffer.alloc(max)
    const n = readSync(fd, buf, 0, max, 0)
    return { text: buf.subarray(0, n).toString('utf8'), uid: s.uid }
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** The effective uid of a live process (from status, which stays readable whatever the process). */
function processUid(proc: string, pid: number): number | null {
  try {
    const m = /^Uid:\s+\d+\s+(\d+)/m.exec(readFileSync(join(proc, String(pid), 'status'), 'utf-8'))
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

/** /proc/net/unix: the inodes of listening sockets by path ('@' marks an abstract name). */
function listeningUnixSockets(proc: string): Array<{ inode: string; path: string }> {
  try {
    const out: Array<{ inode: string; path: string }> = []
    // Num RefCount Protocol Flags Type St Inode Path; the flag __SO_ACCEPTCON (0x10000) marks a listener.
    for (const line of readFileSync(join(proc, 'net', 'unix'), 'utf-8')
      .split('\n')
      .slice(1)) {
      const f = line.trim().split(/\s+/)
      if (f.length < 8 || (Number.parseInt(f[3], 16) & 0x10000) === 0) continue
      out.push({ inode: f[6], path: f.slice(7).join(' ') })
    }
    return out
  } catch {
    return []
  }
}

export function xServerOf(
  n: string,
  roots: ProbeRoots = LINUX_ROOTS
): { uid: number; holds: boolean | null } | null {
  if (!/^\d+$/.test(n)) return null
  const lock = readSmallFile(join(roots.lockDir, `.X${n}-lock`), 64)
  if (!lock) return null
  const pid = Number.parseInt(lock.text.trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) return null
  // The process the lock names must belong to the lock's owner.
  if (processUid(roots.proc, pid) !== lock.uid) return null
  let fds: string[]
  try {
    fds = readdirSync(join(roots.proc, String(pid), 'fd'))
  } catch {
    return { uid: lock.uid, holds: null } // not ours to read, as for a server run as root
  }
  const held = new Set<string>()
  for (const fd of fds) {
    try {
      const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(join(roots.proc, String(pid), 'fd', fd)))
      if (m) held.add(m[1])
    } catch {
      /* closed meanwhile */
    }
  }
  const path = join(roots.x11Dir, `X${n}`)
  const listening = listeningUnixSockets(roots.proc)
  const file = listening.filter((l) => l.path === path)
  const abstract = listening.filter((l) => l.path === `@${path}`)
  // Both listeners of the display must exist and belong to this process.
  const holds =
    file.length > 0 &&
    file.every((l) => held.has(l.inode)) &&
    abstract.length > 0 &&
    abstract.every((l) => held.has(l.inode))
  return { uid: lock.uid, holds }
}

/** The X displays logind assigns to this user's active or online sessions (the files sd-login reads). */
export function sessionDisplaysOf(uid: number, roots: ProbeRoots = LINUX_ROOTS): string[] {
  const field = (text: string, key: string): string | undefined =>
    new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim()
  const user = readSmallFile(join(roots.logind, 'users', String(uid)))
  if (!user) return []
  const ids = (field(user.text, 'SESSIONS') ?? '').split(/\s+/).filter((id) => /^[A-Za-z0-9]+$/.test(id))
  const displays: string[] = []
  for (const id of ids) {
    const s = readSmallFile(join(roots.logind, 'sessions', id))
    if (!s || field(s.text, 'UID') !== String(uid)) continue
    const state = field(s.text, 'STATE')
    if (state !== 'active' && state !== 'online') continue
    const display = field(s.text, 'DISPLAY')
    if (display && /^:\d+(\.\d+)?$/.test(display)) displays.push(display.split('.')[0])
  }
  return displays
}
