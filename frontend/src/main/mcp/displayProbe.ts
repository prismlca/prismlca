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
    sessionDisplays: () => (uid === undefined ? [] : sessionDisplaysOf(uid)),
    tcpListeners: (port) => tcpListenersOf(port)
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

/** The 16 bytes of a /proc/net/tcp6 address (four 32-bit words, each in host byte order). */
function ipv6Bytes(hex: string): number[] {
  const out: number[] = []
  for (let w = 0; w < 32; w += 8) {
    const word = hex.slice(w, w + 8)
    for (let b = 6; b >= 0; b -= 2) out.push(Number.parseInt(word.slice(b, b + 2), 16))
  }
  return out
}

/**
 * The owners of TCP listeners on `port` that a connection to this machine's loopback can reach: bound to
 * a loopback address or to the wildcard, IPv4 and IPv6 (/proc/net/tcp and tcp6, state 0A = LISTEN).
 */
export function tcpListenersOf(port: number, roots: ProbeRoots = LINUX_ROOTS): number[] {
  const owners: number[] = []
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0')
  for (const file of ['tcp', 'tcp6']) {
    let text: string
    try {
      text = readFileSync(join(roots.proc, 'net', file), 'utf-8')
    } catch {
      continue
    }
    for (const line of text.split('\n').slice(1)) {
      // sl local_address rem_address st tx:rx tr:when retrnsmt uid ...
      const f = line.trim().split(/\s+/)
      if (f.length < 8 || f[3] !== '0A') continue
      const [addr, p] = f[1].split(':')
      if (p?.toUpperCase() !== hexPort) continue
      let reachable: boolean
      if (addr.length === 8) {
        const first = Number.parseInt(addr.slice(6, 8), 16)
        reachable = addr === '00000000' || first === 127
      } else if (addr.length === 32) {
        const b = ipv6Bytes(addr)
        const zeros = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0)
        const any = zeros(0, 16)
        const one = zeros(0, 15) && b[15] === 1
        const mapped = zeros(0, 10) && b[10] === 0xff && b[11] === 0xff && (b[12] === 127 || zeros(12, 16))
        reachable = any || one || mapped
      } else continue
      if (reachable) owners.push(Number(f[7]))
    }
  }
  return owners
}
