/**
 * A sealed instance: a driven test instance that cannot reach anything outside this computer and writes
 * down what it tried. For an explorer that clicks at random (`control-prism launch --sealed`): a block list
 * of controls by name missed links, a switch without a name and a native dialog, and the instance fetched
 * the news. The seal acts on the effect instead, wherever the click came from:
 *
 * - web links, files and folders handed to the desktop, and native dialogs (desktop.ts, choosers.ts);
 * - the network of the main process and of the programs it starts (network.ts);
 * - the backend's own requests, refused in the backend (prism_lca/seal.py), which reads the same variable.
 *
 * The switch is PRISM_SEALED, the path of the log both processes append to (log.ts). Only a build run from
 * source honours it; an installed app drops it before anything reads it, so it can never be sealed by
 * accident. What stays open is this computer: the IPC, the backend's port, the driver's connection.
 */
import { app, dialog, session, shell } from 'electron'
import { Socket } from 'node:net'
import { sealChoosers } from './choosers'
import { sealDialogs, sealShell } from './desktop'
import { openSealLog } from './log'
import { guardSessions, guardSockets, HOST_RESOLVER_RULES, startProxyTrap, trapEnv } from './network'

export const SEAL_ENV = 'PRISM_SEALED'

export interface Seal {
  /** The log both processes write to. */
  log: string
  /** Settles once the programs the app starts from now on inherit the trap; await it before starting one.
   *  Rejects when the trap could not start: then no program may be started. */
  ready: Promise<void>
}

/** Seals the main process when PRISM_SEALED asks for it and the app runs from source. Call it before
 *  `ready`, before any window, session or request. */
export function sealFromEnv(): Seal | null {
  const path = process.env[SEAL_ENV]?.trim()
  if (!path) return null
  if (app.isPackaged) {
    delete process.env[SEAL_ENV]
    console.warn(`[sealed] ${SEAL_ENV} is for a build run from source; an installed app ignores it`)
    return null
  }
  const log = openSealLog(path)
  sealShell(shell, log)
  sealDialogs(dialog, log)
  sealChoosers(app, log)
  guardSockets(Socket.prototype, log)
  app.commandLine.appendSwitch('host-resolver-rules', HOST_RESOLVER_RULES)
  guardSessions(app, () => session.defaultSession, log)
  const ready = startProxyTrap(log).then(
    (url) => {
      Object.assign(process.env, trapEnv(url))
      log.write(
        'sealed',
        `links, files, dialogs, Node and Chromium requests; child processes through ${url}`,
        'main',
        'in place'
      )
    },
    (e: Error) => {
      // Without the trap a child's proxied request would go out directly — `uv` before Python's audit hook
      // is in place, native code after. So nothing is started: the backend never comes up, and the app
      // says why in place of its pages.
      log.write('sealed', `child processes unsealed: ${e.message}`, 'proxy', 'failed')
      throw new Error(`the seal's proxy trap did not start (${e.message}), so the backend was not started`)
    }
  )
  // Awaited only once the app is ready; until then a failure must not count as unhandled.
  ready.catch(() => undefined)
  return { log: path, ready }
}
