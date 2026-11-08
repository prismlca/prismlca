import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests: the built app (`npm run build`), started with `npx playwright test` as a real Electron
 * process with its real Python backend, in throwaway data directories (e2e/app.ts). Few on purpose —
 * each one covers a whole path through window, preload, main process and backend that the unit tests
 * fake at one seam or another. Serial, because one app instance per test is what a user has.
 */
export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.e2e.ts',
  // A cold backend start plus an import and a calculation; generous, because a slow CI runner is not a bug.
  timeout: 300_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results'
})
