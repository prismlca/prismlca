/**
 * `launch --seed`: a fresh instance with background data in it, so the Model and Results pages can be
 * reached at all — a fresh install stops at the welcome tour and then at "Bring your background data".
 *
 * The seed walks the same setup sheet a person uses, with the two invented BAFU datasets the end-to-end
 * test imports (backend/tests/fixtures/import/bafu-mini; the import adds bw2io's bundled flow list and
 * impact methods). One step is not a person's: the folder dialog is native and cannot be clicked, so the
 * driver answers it in the main process. That makes the seed preparation, never evidence — a change to
 * the setup sheet or the import is proven by driving them, not by seeding.
 */
import { join } from 'node:path'
import { expect } from '@playwright/test'
import { FIXTURES, type RunningApp } from '../../e2e/app'
import { answerNextFolderDialog, finishWelcomeTour } from '../../e2e/steps'

export const SEED_FOLDER = join(FIXTURES, 'import', 'bafu-mini')

export async function seed(running: RunningApp, log: (line: string) => void): Promise<void> {
  const { page } = running
  log('seed: finishing the welcome tour')
  await finishWelcomeTour(page)
  await expect(page.getByText('Bring your background data')).toBeVisible()
  log(
    'seed: importing the BAFU fixture through the setup sheet (the folder dialog is answered by the driver)'
  )
  await page.getByRole('button', { name: 'Import BAFU' }).click()
  await answerNextFolderDialog(running, SEED_FOLDER)
  await page.getByRole('button', { name: 'Choose folder…' }).click()
  await page.getByRole('button', { name: 'Start import' }).click()
  const result = page.locator('.setup-result')
  await expect(result).toBeVisible({ timeout: 300_000 })
  await expect(result).toContainText('Imported')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByText('Bring your background data')).toBeHidden()
  log('seed: workspace "Main" holds the two fixture datasets and the bundled methods')
}
