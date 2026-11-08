import { describe, expect, it } from 'vitest'

import { displayForLaunch, resolveDisplayEnv, xDisplayTarget, type DisplayFs } from './displayEnv'

const UID = 1000

/**
 * A fake session: what exists on disk, what the runtime dir lists, who owns what, which X servers
 * hold their sockets. By default the runtime dir is the user's (0700), every listed wayland-* and X
 * socket belongs to the user, and every X server of the user holds both its listeners.
 */
function fs(opts: {
  existing?: string[]
  runtime?: string[]
  x11?: string[]
  home?: string
  /** Owners that differ from the defaults (path → uid, or null = absent). */
  owners?: Record<string, { uid: number; mode?: number; socket?: boolean; dir?: boolean } | null>
  /** X servers by display number; default for a listed X<n>: the user's, holding both listeners. */
  servers?: Record<string, { uid: number; holds: boolean | null } | null>
  sessionDisplays?: string[]
  /** Owners of loopback TCP listeners by port; default: the user's own SSH forwarding on 6010. */
  tcp?: Record<number, number[]>
}): DisplayFs {
  const existing = new Set(opts.existing ?? [])
  const runtime = opts.runtime ?? []
  const x11 = opts.x11 ?? []
  return {
    exists: (p: string) => existing.has(p),
    list: (dir: string) => (dir === '/run/user/1000' ? runtime : dir === '/tmp/.X11-unix' ? x11 : []),
    home: opts.home ?? '/home/u',
    owner: (p: string) => {
      if (opts.owners && p in opts.owners) {
        const o = opts.owners[p]
        return o ? { mode: 0o700, socket: false, dir: false, ...o } : null
      }
      if (p === '/run/user/1000') return { uid: UID, mode: 0o700, socket: false, dir: true }
      const name = p.split('/').pop() ?? ''
      if (p.startsWith('/run/user/1000/') && runtime.includes(name) && name.startsWith('wayland-'))
        return { uid: UID, mode: 0o755, socket: true, dir: false }
      if (p.startsWith('/tmp/.X11-unix/') && x11.includes(name))
        return { uid: UID, mode: 0o777, socket: true, dir: false }
      if (existing.has(p)) return { uid: UID, mode: 0o755, socket: true, dir: false }
      return null
    },
    xServer: (n: string) => {
      if (opts.servers && n in opts.servers) return opts.servers[n]
      return x11.includes(`X${n}`) ? { uid: UID, holds: true } : null
    },
    sessionDisplays: () => opts.sessionDisplays ?? [],
    tcpListeners: (port: number) => (opts.tcp ?? { 6010: [UID, UID] })[port] ?? []
  }
}

/** X11 and Wayland displays are a Linux matter; the resolver runs only there (and works with POSIX paths). */
const linuxOnly = describe.skipIf(process.platform === 'win32')

linuxOnly('resolveDisplayEnv', () => {
  it('keeps values the live session confirms, and starts on its Wayland socket', () => {
    const { env, notes, platform } = resolveDisplayEnv(
      {
        XDG_RUNTIME_DIR: '/run/user/1000',
        WAYLAND_DISPLAY: 'wayland-0',
        DISPLAY: ':0',
        XAUTHORITY: '/run/user/1000/.mutter-Xwaylandauth.ABC'
      },
      fs({
        existing: ['/run/user/1000/.mutter-Xwaylandauth.ABC'],
        runtime: ['wayland-0', '.mutter-Xwaylandauth.ABC', 'bus'],
        x11: ['X0']
      }),
      UID
    )
    expect(env).toMatchObject({
      WAYLAND_DISPLAY: 'wayland-0',
      DISPLAY: ':0',
      XAUTHORITY: '/run/user/1000/.mutter-Xwaylandauth.ABC'
    })
    expect(notes).toEqual([])
    expect(platform).toBe('wayland')
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
        existing: ['/run/user/1000/bus'],
        runtime: ['wayland-0', '.mutter-Xwaylandauth.NEW', 'bus'],
        x11: ['X0']
      }),
      UID
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
      fs({ runtime: ['xauth_ZQjUvD', 'wayland-0'], x11: ['X0'] }),
      UID
    )
    expect(kde.env.XAUTHORITY).toBe('/run/user/1000/xauth_ZQjUvD')
    const remote = resolveDisplayEnv(
      { XDG_RUNTIME_DIR: '/run/user/1000', DISPLAY: 'localhost:10.0' },
      fs({}),
      UID
    )
    expect(remote.env.DISPLAY).toBe('localhost:10.0')
    expect(remote.notes).toEqual([])
    expect(remote.platform).toBe('x11')
    const abs = resolveDisplayEnv(
      { XDG_RUNTIME_DIR: '/run/user/1000', WAYLAND_DISPLAY: '/tmp/session/wayland-0' },
      fs({ existing: ['/tmp/session/wayland-0'] }),
      UID
    )
    expect(abs.env.WAYLAND_DISPLAY).toBe('/tmp/session/wayland-0')
    expect(abs.platform).toBe('wayland')
  })

  it("never hands a forwarded display the desktop session's authority cookie", () => {
    const r = resolveDisplayEnv(
      { XDG_RUNTIME_DIR: '/run/user/1000', DISPLAY: 'localhost:10.0' },
      fs({ existing: ['/home/u/.Xauthority'], runtime: ['xauth_ZQjUvD', 'wayland-0'] }),
      UID
    )
    expect(r.env.DISPLAY).toBe('localhost:10.0')
    expect(r.env.XAUTHORITY).toBe('/home/u/.Xauthority')
    // A forwarded display stays the one to start on, even beside the desktop's Wayland socket.
    expect(r.platform).toBe('x11')
    const none = resolveDisplayEnv(
      { XDG_RUNTIME_DIR: '/run/user/1000', DISPLAY: 'localhost:10.0' },
      fs({ runtime: ['xauth_ZQjUvD'] }),
      UID
    )
    expect(none.env.XAUTHORITY).toBeUndefined()
  })

  it('finds a session with no variables at all, and reports none when there is no display', () => {
    const found = resolveDisplayEnv(
      { XDG_RUNTIME_DIR: '/run/user/1000' },
      fs({ existing: ['/home/u/.Xauthority'], x11: ['X0'] }),
      UID
    )
    expect(found.env).toMatchObject({ DISPLAY: ':0', XAUTHORITY: '/home/u/.Xauthority' })
    expect(found.env.WAYLAND_DISPLAY).toBeUndefined()
    expect(found.platform).toBe('x11')
    const none = resolveDisplayEnv({ XDG_RUNTIME_DIR: '/run/user/1000' }, fs({}), UID)
    expect(none.env.DISPLAY).toBeUndefined()
    expect(none.env.WAYLAND_DISPLAY).toBeUndefined()
    expect(none.platform).toBeNull()
  })
})

linuxOnly('resolveDisplayEnv: only displays of this user', () => {
  const otherX0 = { '/tmp/.X11-unix/X0': { uid: 1001, mode: 0o777, socket: true } }

  it("starts on the user's Wayland socket and passes on no X display of another account", () => {
    const r = resolveDisplayEnv(
      { XDG_RUNTIME_DIR: '/run/user/1000', DISPLAY: ':0', XAUTHORITY: '/run/user/1000/xauth_A' },
      fs({
        existing: ['/run/user/1000/xauth_A'],
        runtime: ['wayland-0', 'xauth_A'],
        x11: ['X0'],
        owners: otherX0,
        servers: { '0': { uid: 1001, holds: true } }
      }),
      UID
    )
    expect(r.platform).toBe('wayland')
    expect(r.env.WAYLAND_DISPLAY).toBe('wayland-0')
    expect(r.env.DISPLAY).toBeUndefined()
    expect(r.env.XAUTHORITY).toBeUndefined()
  })

  it("passes over another account's display when scanning, and takes the user's", () => {
    const r = resolveDisplayEnv(
      { XDG_RUNTIME_DIR: '/run/user/1000' },
      fs({
        runtime: ['xauth_A'],
        x11: ['X0', 'X1'],
        owners: otherX0,
        servers: { '0': { uid: 1001, holds: true } }
      }),
      UID
    )
    expect(r.env.DISPLAY).toBe(':1')
    expect(r.env.XAUTHORITY).toBe('/run/user/1000/xauth_A')
    expect(r.platform).toBe('x11')
  })

  it('refuses a socket of the user whose server cannot be shown to hold it', () => {
    const run = (
      server: { uid: number; holds: boolean | null } | null
    ): ReturnType<typeof resolveDisplayEnv> =>
      resolveDisplayEnv(
        { XDG_RUNTIME_DIR: '/run/user/1000', DISPLAY: ':0' },
        fs({ runtime: ['xauth_A'], x11: ['X0'], servers: { '0': server } }),
        UID
      )
    // No live process behind the lock, a process that holds neither or only one of the listeners, a
    // process of another owner, descriptors that cannot be read.
    for (const server of [
      null,
      { uid: UID, holds: false },
      { uid: 1001, holds: true },
      { uid: UID, holds: null }
    ]) {
      const r = run(server)
      expect(r.env.DISPLAY).toBeUndefined()
      expect(r.env.XAUTHORITY).toBeUndefined()
      expect(r.platform).toBeNull()
      expect(r.notes.join(' ')).toMatch(/DISPLAY=:0 cannot be confirmed as a display of this user's session/)
    }
    expect(run({ uid: UID, holds: true }).env.DISPLAY).toBe(':0')
  })

  it("takes a display manager's X server only when logind assigns it to the user's session", () => {
    const rootX0 = { '/tmp/.X11-unix/X0': { uid: 0, mode: 0o777, socket: true } }
    const run = (sessionDisplays: string[]): ReturnType<typeof resolveDisplayEnv> =>
      resolveDisplayEnv(
        { XDG_RUNTIME_DIR: '/run/user/1000', DISPLAY: ':0' },
        fs({
          existing: ['/home/u/.Xauthority'],
          x11: ['X0'],
          owners: rootX0,
          servers: { '0': { uid: 0, holds: null } },
          sessionDisplays
        }),
        UID
      )
    expect(run([':0']).env).toMatchObject({ DISPLAY: ':0', XAUTHORITY: '/home/u/.Xauthority' })
    expect(run([':0']).platform).toBe('x11')
    expect(run([]).env.DISPLAY).toBeUndefined()
    expect(run([':1']).env.DISPLAY).toBeUndefined()
  })

  it('uses nothing from a runtime dir that is not closed to others', () => {
    for (const rt of [
      { uid: 1001, mode: 0o700, dir: true },
      { uid: UID, mode: 0o755, dir: true },
      { uid: UID, mode: 0o700, dir: false }
    ]) {
      const r = resolveDisplayEnv(
        { XDG_RUNTIME_DIR: '/run/user/1000', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
        fs({
          existing: ['/run/user/1000/bus'],
          runtime: ['wayland-0', 'xauth_A', 'bus'],
          x11: ['X0'],
          owners: { '/run/user/1000': rt }
        }),
        UID
      )
      expect(r.env.WAYLAND_DISPLAY).toBeUndefined()
      expect(r.env.XDG_RUNTIME_DIR).toBeUndefined()
      expect(r.env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
      // The X display is still the user's; its cookie does not come from that directory.
      expect(r.env.DISPLAY).toBe(':0')
      expect(r.env.XAUTHORITY).toBeUndefined()
    }
  })

  it("refuses a Wayland socket that is not the user's", () => {
    const r = resolveDisplayEnv(
      { XDG_RUNTIME_DIR: '/run/user/1000', WAYLAND_DISPLAY: '/tmp/shared/wayland-0' },
      fs({ owners: { '/tmp/shared/wayland-0': { uid: 1001, socket: true } } }),
      UID
    )
    expect(r.env.WAYLAND_DISPLAY).toBeUndefined()
    expect(r.platform).toBeNull()
  })
})

linuxOnly('xDisplayTarget', () => {
  it('reads DISPLAY the way libxcb does', () => {
    for (const d of [':0', ':0.1', 'unix:0', 'unix/:0', 'unix/somehost:0.0', ':00'])
      expect(xDisplayTarget(d)).toEqual({ via: 'unix', n: '0' })
    for (const d of ['localhost:10.0', 'tcp/localhost:10', 'inet6/::1:10', '127.0.0.1:10', 'LOCALHOST:10'])
      expect(xDisplayTarget(d)).toEqual({ via: 'loopback', n: '10' })
    for (const d of ['host:1', 'tcp/host.example:1', '192.168.1.5:1'])
      expect(xDisplayTarget(d)).toEqual({ via: 'remote', n: '1' })
    for (const d of ['/tmp/.X11-unix/X0', 'tcp/:0', 'other/:0', ':', ':x', ': 0', ':0.', 'host', ''])
      expect(xDisplayTarget(d)).toBeNull()
  })

  it('checks every local spelling for its owner, and uses no spelling it cannot read', () => {
    for (const d of ['unix/:0', 'unix/somehost:0', 'unix:0', ':0.0']) {
      const r = resolveDisplayEnv(
        { XDG_RUNTIME_DIR: '/run/user/1000', DISPLAY: d, XAUTHORITY: '/run/user/1000/xauth_A' },
        fs({
          existing: ['/run/user/1000/xauth_A'],
          runtime: ['wayland-0', 'xauth_A'],
          x11: ['X0'],
          owners: { '/tmp/.X11-unix/X0': { uid: 1001, mode: 0o777, socket: true } },
          servers: { '0': { uid: 1001, holds: true } }
        }),
        UID
      )
      expect(r.platform).toBe('wayland')
      expect(r.env.DISPLAY).toBeUndefined()
      expect(r.env.XAUTHORITY).toBeUndefined()
    }
    const own = resolveDisplayEnv(
      { XDG_RUNTIME_DIR: '/run/user/1000', DISPLAY: 'unix/:0' },
      fs({ runtime: ['xauth_A'], x11: ['X0'] }),
      UID
    )
    expect(own.env).toMatchObject({ DISPLAY: 'unix/:0', XAUTHORITY: '/run/user/1000/xauth_A' })
    expect(own.platform).toBe('x11')
    const path = resolveDisplayEnv(
      { XDG_RUNTIME_DIR: '/run/user/1000', DISPLAY: '/tmp/.X11-unix/X0' },
      fs({ runtime: ['xauth_A'] }),
      UID
    )
    expect(path.env.DISPLAY).toBeUndefined()
    expect(path.platform).toBeNull()
  })
})

linuxOnly('resolveDisplayEnv: a TCP display on this machine', () => {
  const run = (display: string, tcp: Record<number, number[]>, runtime: string[] = []) =>
    resolveDisplayEnv(
      { XDG_RUNTIME_DIR: '/run/user/1000', DISPLAY: display },
      fs({ existing: ['/home/u/.Xauthority'], runtime, tcp }),
      UID
    )

  it("keeps an SSH-forwarded display whose listeners are all the user's", () => {
    for (const d of ['localhost:10.0', '127.0.0.1:10', 'tcp/localhost:10.0']) {
      const r = run(d, { 6010: [UID, UID] }, ['wayland-0'])
      expect(r.env).toMatchObject({ DISPLAY: d, XAUTHORITY: '/home/u/.Xauthority' })
      expect(r.platform).toBe('x11')
    }
  })

  it('drops it when a listener on its port belongs to another account, or none listens', () => {
    const cases: Array<Record<number, number[]>> = [
      { 6010: [1001] },
      { 6010: [UID, 1001] },
      {},
      { 6011: [UID] }
    ]
    for (const tcp of cases) {
      const r = run('localhost:10.0', tcp)
      expect(r.env.DISPLAY).toBeUndefined()
      expect(r.env.XAUTHORITY).toBeUndefined()
      expect(r.platform).toBeNull()
      expect(r.notes.join(' ')).toMatch(/cannot be confirmed/)
    }
    const wl = run('localhost:10.0', { 6010: [1001] }, ['wayland-0'])
    expect(wl.platform).toBe('wayland')
    expect(wl.env.DISPLAY).toBeUndefined()
  })

  it('keeps a display on another host as given', () => {
    const r = run('build-server:1', {})
    expect(r.env.DISPLAY).toBe('build-server:1')
    expect(r.platform).toBe('x11')
  })
})

linuxOnly('displayForLaunch', () => {
  it('drops inherited display values that failed the checks, and names the platform', () => {
    const base = {
      PATH: '/usr/bin',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DISPLAY: ':0',
      XAUTHORITY: '/run/user/1000/xauth_A'
    }
    const d = displayForLaunch(
      base,
      fs({
        existing: ['/run/user/1000/xauth_A'],
        runtime: ['wayland-0', 'xauth_A'],
        x11: ['X0'],
        owners: { '/tmp/.X11-unix/X0': { uid: 1001, mode: 0o777, socket: true } },
        servers: { '0': { uid: 1001, holds: true } }
      }),
      UID
    )
    expect(d.platform).toBe('wayland')
    expect(d.args).toEqual(['--ozone-platform=wayland'])
    expect(d.env.PATH).toBe('/usr/bin')
    expect('DISPLAY' in d.env).toBe(false)
    expect('XAUTHORITY' in d.env).toBe(false)
    expect(d.env.WAYLAND_DISPLAY).toBe('wayland-0')
    expect(base.DISPLAY).toBe(':0') // the caller's object is left alone

    const x = displayForLaunch(
      { XDG_RUNTIME_DIR: '/run/user/1000', WAYLAND_DISPLAY: 'wayland-9' },
      fs({ existing: ['/home/u/.Xauthority'], x11: ['X0'] }),
      UID
    )
    expect(x.args).toEqual(['--ozone-platform=x11'])
    expect('WAYLAND_DISPLAY' in x.env).toBe(false)
    expect(x.env.DISPLAY).toBe(':0')

    const none = displayForLaunch({ DISPLAY: ':0' }, fs({ x11: ['X0'], servers: { '0': null } }), UID)
    expect(none.platform).toBeNull()
    expect(none.args).toEqual([])
  })
})
