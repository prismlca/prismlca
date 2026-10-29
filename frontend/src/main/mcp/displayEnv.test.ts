import { describe, expect, it } from 'vitest'

import { resolveDisplayEnv } from './displayEnv'

/** A fake session: what exists on disk, what the runtime dir lists. */
function fs(opts: { existing?: string[]; runtime?: string[]; x11?: string[]; home?: string }) {
  const existing = new Set(opts.existing ?? [])
  return {
    exists: (p: string) => existing.has(p),
    list: (dir: string) =>
      dir === '/run/user/1000' ? (opts.runtime ?? []) : dir === '/tmp/.X11-unix' ? (opts.x11 ?? []) : [],
    home: opts.home ?? '/home/u'
  }
}

describe('resolveDisplayEnv', () => {
  it('keeps values the live session confirms', () => {
    const { env, notes } = resolveDisplayEnv(
      {
        XDG_RUNTIME_DIR: '/run/user/1000',
        WAYLAND_DISPLAY: 'wayland-0',
        DISPLAY: ':0',
        XAUTHORITY: '/run/user/1000/.mutter-Xwaylandauth.ABC'
      },
      fs({
        existing: [
          '/run/user/1000',
          '/run/user/1000/wayland-0',
          '/tmp/.X11-unix/X0',
          '/run/user/1000/.mutter-Xwaylandauth.ABC'
        ],
        runtime: ['wayland-0', '.mutter-Xwaylandauth.ABC', 'bus'],
        x11: ['X0']
      })
    )
    expect(env).toMatchObject({
      WAYLAND_DISPLAY: 'wayland-0',
      DISPLAY: ':0',
      XAUTHORITY: '/run/user/1000/.mutter-Xwaylandauth.ABC'
    })
    expect(notes).toEqual([])
  })

  it('repairs stale values from a configuration written in an earlier login', () => {
    const { env, notes } = resolveDisplayEnv(
      {
        XDG_RUNTIME_DIR: '/run/user/1000',
        WAYLAND_DISPLAY: 'wayland-1',
        DISPLAY: ':1',
        XAUTHORITY: '/run/user/1000/.mutter-Xwaylandauth.OLD'
      },
      fs({
        existing: ['/run/user/1000', '/run/user/1000/wayland-0', '/tmp/.X11-unix/X0', '/run/user/1000/bus'],
        runtime: ['wayland-0', '.mutter-Xwaylandauth.NEW', 'bus'],
        x11: ['X0']
      })
    )
    expect(env).toMatchObject({
      WAYLAND_DISPLAY: 'wayland-0',
      DISPLAY: ':0',
      XAUTHORITY: '/run/user/1000/.mutter-Xwaylandauth.NEW',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus'
    })
    expect(notes).toHaveLength(3)
    expect(notes.join(' ')).toMatch(/stale.*wayland-0/)
  })

  it('knows KDE/SDDM authority files, keeps a remote DISPLAY, and takes an absolute Wayland path', () => {
    const kde = resolveDisplayEnv(
      { XDG_RUNTIME_DIR: '/run/user/1000' },
      fs({
        existing: ['/run/user/1000', '/tmp/.X11-unix/X0'],
        runtime: ['xauth_ZQjUvD', 'wayland-0'],
        x11: ['X0']
      })
    )
    expect(kde.env.XAUTHORITY).toBe('/run/user/1000/xauth_ZQjUvD')
    const remote = resolveDisplayEnv(
      { XDG_RUNTIME_DIR: '/run/user/1000', DISPLAY: 'localhost:10.0' },
      fs({ existing: ['/run/user/1000'] })
    )
    expect(remote.env.DISPLAY).toBe('localhost:10.0')
    expect(remote.notes).toEqual([])
    const abs = resolveDisplayEnv(
      { XDG_RUNTIME_DIR: '/run/user/1000', WAYLAND_DISPLAY: '/tmp/session/wayland-0' },
      fs({ existing: ['/run/user/1000', '/tmp/session/wayland-0'] })
    )
    expect(abs.env.WAYLAND_DISPLAY).toBe('/tmp/session/wayland-0')
  })

  it("never hands a forwarded display the desktop session's authority cookie", () => {
    const r = resolveDisplayEnv(
      { XDG_RUNTIME_DIR: '/run/user/1000', DISPLAY: 'localhost:10.0' },
      fs({ existing: ['/run/user/1000', '/home/u/.Xauthority'], runtime: ['xauth_ZQjUvD', 'wayland-0'] })
    )
    expect(r.env.DISPLAY).toBe('localhost:10.0')
    expect(r.env.XAUTHORITY).toBe('/home/u/.Xauthority')
    const none = resolveDisplayEnv(
      { XDG_RUNTIME_DIR: '/run/user/1000', DISPLAY: 'localhost:10.0' },
      fs({ existing: ['/run/user/1000'], runtime: ['xauth_ZQjUvD'] })
    )
    expect(none.env.XAUTHORITY).toBeUndefined()
  })

  it('finds a session with no variables at all, and reports none when there is no display', () => {
    const found = resolveDisplayEnv(
      { XDG_RUNTIME_DIR: '/run/user/1000' },
      fs({ existing: ['/run/user/1000', '/tmp/.X11-unix/X0', '/home/u/.Xauthority'], x11: ['X0'] })
    )
    expect(found.env).toMatchObject({ DISPLAY: ':0', XAUTHORITY: '/home/u/.Xauthority' })
    expect(found.env.WAYLAND_DISPLAY).toBeUndefined()
    const none = resolveDisplayEnv(
      { XDG_RUNTIME_DIR: '/run/user/1000' },
      fs({ existing: ['/run/user/1000'] })
    )
    expect(none.env.DISPLAY).toBeUndefined()
    expect(none.env.WAYLAND_DISPLAY).toBeUndefined()
  })
})
