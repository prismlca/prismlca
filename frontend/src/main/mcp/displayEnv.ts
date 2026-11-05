/**
 * Where the app can show its window — worked out from the live session, not from values frozen into a
 * client configuration at an earlier login. Electron-free, so it is tested with a fake machine; the
 * real one is displayProbe.ts.
 *
 * Only displays of this user's own live session are used: the user's Wayland socket first, an X display
 * only when its server is shown to belong to the user's session.
 */
import { join } from 'node:path'

/** What the resolver asks about the machine. */
export interface DisplayFs {
  exists: (p: string) => boolean
  list: (dir: string) => string[]
  home: string
  /** lstat (a link is not followed): owner, permission bits, kind; null when absent. */
  owner: (p: string) => { uid: number; mode: number; socket: boolean; dir: boolean } | null
  /**
   * The X server of display n, as /tmp/.X<n>-lock names it: the owner shared by the lock and the live
   * process it names, and whether that process itself holds both listening sockets of :n — the file
   * and the abstract name (null when its descriptors cannot be read, as for a server run as root).
   * null without such a lock and process.
   */
  xServer: (n: string) => { uid: number; holds: boolean | null } | null
  /** The X displays (":0") systemd-logind lists for this user's live sessions. */
  sessionDisplays: () => string[]
}

export type DisplayPlatform = 'wayland' | 'x11'

const X11_DIR = '/tmp/.X11-unix'

/**
 * Linux display variables, checked against the live session and repaired where the session says
 * otherwise: the user's own Wayland socket, an X display served by the user's session, an Xauthority
 * file that exists (GNOME's Xwayland auth file carries a per-login suffix — the value a client
 * configuration froze at configure time is stale after the next login). Pure, for the test; `fs`
 * comes in. `platform` is what the app should start on; null = no display it may use.
 */
export function resolveDisplayEnv(
  env: Record<string, string | undefined>,
  fs: DisplayFs,
  uid: number | undefined = process.getuid?.()
): { env: Record<string, string>; notes: string[]; platform: DisplayPlatform | null } {
  const out: Record<string, string> = {}
  const notes: string[] = []
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${uid ?? ''}`
  // The runtime dir's sockets and files are this user's only when the dir is: owned by the user and
  // closed to everyone else (what the XDG spec demands of it).
  const rt = fs.owner(runtime)
  const runtimeOurs = !!rt && rt.dir && rt.uid === uid && (rt.mode & 0o077) === 0
  if (runtimeOurs) out.XDG_RUNTIME_DIR = runtime
  const ownSocket = (p: string): boolean => {
    const o = fs.owner(p)
    return !!o && o.socket && o.uid === uid
  }
  // Wayland: the socket named by WAYLAND_DISPLAY (absolute, or relative to the runtime dir), or any
  // wayland-* socket of this session — always one the user owns.
  const wl = env.WAYLAND_DISPLAY
  const wlPath = wl ? (wl.startsWith('/') ? wl : runtimeOurs ? join(runtime, wl) : null) : null
  if (wl && wlPath && ownSocket(wlPath)) out.WAYLAND_DISPLAY = wl
  else if (runtimeOurs) {
    const found = fs.list(runtime).find((n) => /^wayland-\d+$/.test(n) && ownSocket(join(runtime, n)))
    if (found) {
      out.WAYLAND_DISPLAY = found
      if (wl) notes.push(`WAYLAND_DISPLAY=${wl} from the configuration is stale; the session has ${found}.`)
    }
  }
  // X11: a LOCAL display (":0", "unix:0") must be this user's (xOurs); a remote or TCP display
  // ("localhost:10.0", "host:1") has no socket here and is kept as given — an SSH-forwarded session
  // is a supported way to work, not a stale value.
  const x = env.DISPLAY
  const local = (d: string): boolean => /^(unix)?:\d+(\.\d+)?$/.test(d)
  const num = (d: string): string => d.replace(/^(unix)?:/, '').split('.')[0]
  // An X display is this user's when the live process its lock names, of the socket's owner, holds both
  // of its listeners itself — the file and the abstract name, which X clients try first. A server run
  // as root (a display manager's) counts when logind assigns its display to one of this user's sessions.
  const xOurs = (n: string): boolean => {
    const s = fs.owner(join(X11_DIR, `X${n}`))
    if (!s || !s.socket) return false
    const server = fs.xServer(n)
    if (!server || server.uid !== s.uid) return false
    if (s.uid === uid) return server.holds === true
    return s.uid === 0 && server.holds !== false && fs.sessionDisplays().includes(`:${n}`)
  }
  if (x && !local(x)) out.DISPLAY = x
  else if (x && xOurs(num(x))) out.DISPLAY = x
  else {
    const found = fs.list(X11_DIR).find((n) => /^X\d+$/.test(n) && xOurs(n.slice(1)))
    if (found) {
      out.DISPLAY = `:${found.slice(1)}`
      if (x)
        notes.push(
          `DISPLAY=${x} from the configuration is stale or not this user's; the session has :${found.slice(1)}.`
        )
    } else if (x)
      notes.push(`DISPLAY=${x} cannot be confirmed as a display of this user's session; it is not used.`)
  }
  // Xauthority — only for a display that passed the checks above: the configured file if it still
  // exists, else the session's — GNOME writes .mutter-Xwaylandauth.<rand>, KDE/SDDM xauth_<rand>
  // (measured on KDE: the GNOME-only lookup left X without authorization) — else the classic
  // ~/.Xauthority.
  const remoteX = !!out.DISPLAY && !local(out.DISPLAY)
  if (out.DISPLAY) {
    const xa = env.XAUTHORITY
    if (xa && fs.exists(xa)) out.XAUTHORITY = xa
    else if (remoteX) {
      // A forwarded display (SSH) carries its cookie in the configured file or in ~/.Xauthority —
      // never in the desktop session's xauth_* file, which would hand it unrelated credentials.
      const classic = join(fs.home, '.Xauthority')
      if (fs.exists(classic)) out.XAUTHORITY = classic
      if (xa)
        notes.push(`XAUTHORITY=${xa} from the configuration is gone; leaving the default for ${out.DISPLAY}.`)
    } else {
      const session = runtimeOurs
        ? fs
            .list(runtime)
            .find(
              (n) => n.startsWith('.mutter-Xwaylandauth.') || n.startsWith('xauth_') || n === '.Xauthority'
            )
        : undefined
      const classic = join(fs.home, '.Xauthority')
      const pick = session ? join(runtime, session) : fs.exists(classic) ? classic : undefined
      if (pick) {
        out.XAUTHORITY = pick
        if (xa) notes.push(`XAUTHORITY=${xa} from the configuration is gone; using ${pick}.`)
      }
    }
  }
  if (env.DBUS_SESSION_BUS_ADDRESS) out.DBUS_SESSION_BUS_ADDRESS = env.DBUS_SESSION_BUS_ADDRESS
  else if (runtimeOurs && fs.exists(join(runtime, 'bus')))
    out.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(runtime, 'bus')}`
  // A forwarded display is where the person working over SSH looks; otherwise the user's own Wayland
  // socket comes first.
  const platform: DisplayPlatform | null = remoteX
    ? 'x11'
    : out.WAYLAND_DISPLAY
      ? 'wayland'
      : out.DISPLAY
        ? 'x11'
        : null
  return { env: out, notes, platform }
}

/**
 * The environment and command-line switch for an app the bridge starts on Linux. Only display values
 * the live session confirmed reach it — an inherited one that failed the checks is dropped, not
 * passed through — and the platform is named on the command line: Electron's automatic choice reads
 * XDG_SESSION_TYPE, which a reduced client environment lacks, and would fall back to X11 even beside
 * the user's own Wayland socket. `platform` null = nothing to start on.
 */
export function displayForLaunch(
  base: Record<string, string | undefined>,
  fs: DisplayFs,
  uid: number | undefined = process.getuid?.()
): {
  env: Record<string, string | undefined>
  args: string[]
  notes: string[]
  platform: DisplayPlatform | null
} {
  const { env: fixed, notes, platform } = resolveDisplayEnv(base, fs, uid)
  const env = { ...base }
  for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY'] as const) delete env[k]
  Object.assign(env, fixed)
  return { env, args: platform ? [`--ozone-platform=${platform}`] : [], notes, platform }
}
