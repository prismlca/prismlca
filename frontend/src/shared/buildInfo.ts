/**
 * What the About page shows and "Copy version info" copies (main/buildInfo.ts). One definition for
 * main, the preload bridge and the renderer.
 *
 * `kind`: `release` is a build from a release tag in CI and the only one that asks GitHub for
 * updates; `feedtest` asks only a local test feed; `dev` (every local build, packaged or not) has the
 * update check switched off.
 */
export type BuildKind = 'release' | 'feedtest' | 'dev'

export interface BuildInfo {
  version: string
  /** Short commit hash, or `unknown` for a build from a source archive without git. */
  commit: string
  kind: BuildKind
  electron: string
  /** Operating system and architecture, e.g. `linux x64 6.19.10`. */
  os: string
}
