import { expect, test } from '@playwright/test'
import { freshInstall, launch, quit, removeInstall } from './app'

test('a fresh install starts, asks for background data and quits cleanly', async () => {
  const install = freshInstall()
  const running = await launch(install)
  try {
    await expect(running.page.getByText('Bring your background data')).toBeVisible({ timeout: 180_000 })
    // The bridge is alive end to end: a request from the page reaches the backend and comes back.
    const health = await running.page.evaluate(() => window.prism.api('GET', '/api/v1/system/health'))
    expect(health.status).toBe(200)
    expect(running.rendererErrors).toEqual([])
  } finally {
    await quit(running)
    removeInstall(install)
  }
})
