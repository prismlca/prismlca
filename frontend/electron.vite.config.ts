import { execSync } from 'child_process'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * Build facts for main/buildInfo.ts. Only the release
 * workflow sets PRISM_BUILD_KIND=release, so every local build — packaged or not — is `dev` and never
 * asks GitHub for updates. The commit comes from CI (GITHUB_SHA) or git; a build from a source archive
 * without git says `unknown` and still builds.
 */
function prismBuild(): { commit: string; kind: string; feedUrl?: string } {
  const requested = process.env.PRISM_BUILD_KIND ?? ''
  const kind = requested === 'release' || requested === 'feedtest' ? requested : 'dev'
  let commit = (process.env.GITHUB_SHA ?? '').slice(0, 7)
  if (!commit) {
    try {
      commit = execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim()
    } catch {
      commit = 'unknown'
    }
  }
  const feedUrl = kind === 'feedtest' ? process.env.PRISM_FEEDTEST_URL || 'http://127.0.0.1:8765/' : undefined
  return { commit: commit || 'unknown', kind, ...(feedUrl ? { feedUrl } : {}) }
}

export default defineConfig({
  main: {
    build: { outDir: 'out/main' },
    define: { __PRISM_BUILD__: JSON.stringify(prismBuild()) }
  },
  preload: {
    build: { outDir: 'out/preload' }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') }
    },
    plugins: [react()]
  }
})
