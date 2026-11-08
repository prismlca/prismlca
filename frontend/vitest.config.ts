import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * Two projects, because the two kinds of test want opposite things.
 *
 * `node` is what this file used to be, unchanged: plain node, no setup, no plugins — the ~197
 * main-process tests and the renderer's pure-logic tests run in about a second and that is worth
 * protecting. It also happily imports a `.tsx` module to reach one exported helper (see
 * `views/planTicks.test.ts`), which stays the cheapest way to test logic that lives inside a big view.
 *
 * `dom` is for tests that mount something: jsdom, Testing Library, the React plugin, and a setup file
 * with the browser APIs jsdom lacks. Selected by FILE NAME (`*.dom.test.tsx`) rather than by
 * directory, so a view's component test can sit next to its helper test.
 *
 * `environmentMatchGlobs` would have been the other way round — it was removed in Vitest 4.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Main process, preload and shared code too: the glue between them (window, bridge, IPC) is where
      // the unit tests are thinnest, and a renderer-only number hid exactly that.
      include: ['src/**'],
      // Tests and their harnesses are not the subject under test; counting them flatters the number.
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/test/**']
      // Deliberately no thresholds: CI publishes the report to show where tests are thin. A percentage
      // gate is met by the cheapest lines, not the riskiest, or it stays red and teaches people to ignore it.
    },
    projects: [
      {
        // `resources/THIRD-PARTY-NOTICES.md?asset` (main/licence.ts) is an electron-vite asset import;
        // Vite knows .txt and .png as assets but not .md, and without this the node project parsed the
        // notices as JavaScript and every test importing coreIpc failed (30.09.2026). Per project —
        // a top-level `assetsInclude` does not reach the projects.
        assetsInclude: ['**/*.md'],
        test: {
          name: 'node',
          include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/*.dom.test.tsx'],
          environment: 'node'
        }
      },
      {
        plugins: [react()],
        test: {
          name: 'dom',
          include: ['src/renderer/**/*.dom.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['./src/renderer/src/test/setup.ts'],
          restoreMocks: true
        }
      }
    ]
  }
})
