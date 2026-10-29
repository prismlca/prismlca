/**
 * Proxy settings of Chromium's network stack: none, except while the update check runs.
 *
 * PrismLCA's own requests (AI providers, routing, statistics, news) go through Node's `fetch`. Chromium's
 * stack serves the windows, which reach the backend over IPC, and the update check. Left at the system
 * settings it still goes out on its own wherever the system detects proxies automatically, as Windows
 * does by default: it asks the local network for `http://wpad/wpad.dat` (seen at start-up on Windows)
 * and asks again after every network change — a new address, a VPN, another Wi-Fi. Nobody asked for
 * that request. So every session starts without a proxy and without discovery, and the update check, a
 * request the user did ask for, uses the system's settings for as long as it runs — a company proxy
 * still carries it.
 */
import { app, type Session } from 'electron'

/** Before `ready`: every session starts without a proxy, so none looks for one. */
export function disableProxyDiscovery(): void {
  app.commandLine.appendSwitch('no-proxy-server')
}

/** How many `withSystemProxy` runs are under way per session — the last one to finish switches back. */
const running = new WeakMap<Session, number>()

/** Run `work` with the system's proxy settings on `ses`, then return the session to none. */
export async function withSystemProxy<T>(ses: Session, work: () => Promise<T>): Promise<T> {
  const before = running.get(ses) ?? 0
  running.set(ses, before + 1)
  try {
    if (before === 0)
      // Without the system's settings the request goes direct, which works everywhere but behind a
      // proxy that is mandatory — worth a log line, not a failed check.
      await ses.setProxy({ mode: 'system' }).catch((e) => console.error('[proxy] system settings:', e))
    return await work()
  } finally {
    const left = (running.get(ses) ?? 1) - 1
    running.set(ses, left)
    if (left === 0) await ses.setProxy({ mode: 'direct' }).catch((e) => console.error('[proxy] direct:', e))
  }
}
