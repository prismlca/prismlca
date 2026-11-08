/**
 * Steps a person takes in the app, shared by the end-to-end tests. They go through the visible interface
 * — buttons, labels, dialogs — and reach into the main process only where a native dialog would need a
 * hand on the mouse.
 */
import { expect, type Page } from '@playwright/test'
import type { RunningApp } from './app'

/** The welcome tour opens on a first start and covers the window until it is read to the end. */
export async function finishWelcomeTour(page: Page): Promise<void> {
  const tour = page.getByRole('dialog', { name: 'Welcome to PrismLCA' })
  await expect(tour).toBeVisible()
  for (let card = 0; card < 30 && (await tour.isVisible()); card++) {
    await tour.getByRole('button', { name: /^(Next|Finish)$/ }).click()
  }
  await expect(tour).toBeHidden()
}

/** The next folder dialog the main process opens answers with `dir`, as if the person had chosen it. */
export async function answerNextFolderDialog(running: RunningApp, dir: string): Promise<void> {
  await running.app.evaluate(({ dialog }, chosen) => {
    const original = dialog.showOpenDialog
    dialog.showOpenDialog = (async () => {
      dialog.showOpenDialog = original
      return { canceled: false, filePaths: [chosen] }
    }) as typeof dialog.showOpenDialog
  }, dir)
}
