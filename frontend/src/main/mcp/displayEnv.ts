/**
 * Where the app can show its window — worked out from the live session, not from values frozen into a
 * client configuration at an earlier login. Electron-free, so it is tested with a fake file system.
 */
import { join } from 'node:path'

/**
 * Linux display variables, checked against the live session and repaired where the session says
 * otherwise: a Wayland socket that exists, an X socket that exists, an Xauthority file that exists
 * (GNOME's Xwayland auth file carries a per-login suffix — the value a client configuration froze
 * at configure time is stale after the next login). Pure, for the test; `fs` comes in.
 */
export function resolveDisplayEnv(
  env: Record<string, string | undefined>,
  fs: { exists: (p: string) => boolean; list: (dir: string) => string[]; home: string }
): { env: Record<string, string>; notes: string[] } {
  const out: Record<string, string> = {}
  const notes: string[] = []
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? ''}`
  if (fs.exists(runtime)) out.XDG_RUNTIME_DIR = runtime
  // Wayland: the socket named by WAYLAND_DISPLAY (absolute, or relative to the runtime dir), or any
  // wayland-* socket of this session.
  const wl = env.WAYLAND_DISPLAY
  if (wl && fs.exists(wl.startsWith('/') ? wl : join(runtime, wl))) out.WAYLAND_DISPLAY = wl
  else {
    const found = fs.list(runtime).find((n) => /^wayland-\d+$/.test(n))
    if (found) {
      out.WAYLAND_DISPLAY = found
      if (wl) notes.push(`WAYLAND_DISPLAY=${wl} from the configuration is stale; the session has ${found}.`)
    }
  }
  // X11: a LOCAL display (":0", "unix:0") is checked against its socket; a remote or TCP display
  // ("localhost:10.0", "host:1") has no socket here and is kept as given — an SSH-forwarded session
  // is a supported way to work, not a stale value.
  const x = env.DISPLAY
  const local = (d: string): boolean => /^(unix)?:\d+(\.\d+)?$/.test(d)
  const xSock = (d: string): string => join('/tmp/.X11-unix', `X${d.replace(/^(unix)?:/, '').split('.')[0]}`)
  if (x && !local(x)) out.DISPLAY = x
  else if (x && fs.exists(xSock(x))) out.DISPLAY = x
  else {
    const found = fs.list('/tmp/.X11-unix').find((n) => /^X\d+$/.test(n))
    if (found) {
      out.DISPLAY = `:${found.slice(1)}`
      if (x) notes.push(`DISPLAY=${x} from the configuration is stale; the session has :${found.slice(1)}.`)
    }
  }
  // Xauthority: the configured file if it still exists, else the session's — GNOME writes
  // .mutter-Xwaylandauth.<rand>, KDE/SDDM xauth_<rand> (measured on KDE:
  // the GNOME-only lookup left X without authorization) — else the classic ~/.Xauthority.
  const xa = env.XAUTHORITY
  const remoteX = !!x && !local(x)
  if (xa && fs.exists(xa)) out.XAUTHORITY = xa
  else if (remoteX) {
    // A forwarded display (SSH) carries its cookie in the configured file or in ~/.Xauthority —
    // never in the desktop session's xauth_* file, which would hand it unrelated credentials.
    const classic = join(fs.home, '.Xauthority')
    if (fs.exists(classic)) out.XAUTHORITY = classic
    if (xa) notes.push(`XAUTHORITY=${xa} from the configuration is gone; leaving the default for ${x}.`)
  } else {
    const session = fs
      .list(runtime)
      .find((n) => n.startsWith('.mutter-Xwaylandauth.') || n.startsWith('xauth_') || n === '.Xauthority')
    const classic = join(fs.home, '.Xauthority')
    const pick = session ? join(runtime, session) : fs.exists(classic) ? classic : undefined
    if (pick) {
      out.XAUTHORITY = pick
      if (xa) notes.push(`XAUTHORITY=${xa} from the configuration is gone; using ${pick}.`)
    }
  }
  if (env.DBUS_SESSION_BUS_ADDRESS) out.DBUS_SESSION_BUS_ADDRESS = env.DBUS_SESSION_BUS_ADDRESS
  else if (fs.exists(join(runtime, 'bus'))) out.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(runtime, 'bus')}`
  return { env: out, notes }
}
