/**
 * Build facts that are fixed when the app is built, not when it runs: the commit and the build kind.
 * electron.vite.config.ts writes them into
 * `__PRISM_BUILD__`; tests and anything run outside that build see the dev defaults.
 */
import { app, ipcMain } from 'electron'
import { arch, release } from 'node:os'

import type { BuildInfo, BuildKind } from '../shared/buildInfo'

declare const __PRISM_BUILD__: { commit?: string; kind?: string; feedUrl?: string } | undefined

const raw = typeof __PRISM_BUILD__ !== 'undefined' ? __PRISM_BUILD__ : undefined
const KINDS: BuildKind[] = ['release', 'feedtest', 'dev']

export const BUILD: { commit: string; kind: BuildKind; feedUrl?: string } = {
  commit: raw?.commit || 'unknown',
  kind: KINDS.includes(raw?.kind as BuildKind) ? (raw?.kind as BuildKind) : 'dev',
  feedUrl: raw?.kind === 'feedtest' ? raw?.feedUrl : undefined
}

export function buildInfo(): BuildInfo {
  return {
    version: app.getVersion(),
    commit: BUILD.commit,
    kind: BUILD.kind,
    electron: process.versions.electron ?? '',
    os: `${process.platform} ${arch()} ${release()}`
  }
}

export function registerBuildInfoIpc(): void {
  ipcMain.handle('prism:buildInfo', () => buildInfo())
}
