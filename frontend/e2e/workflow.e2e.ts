import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { FIXTURES, freshInstall, launch, quit, removeInstall, type Install, type RunningApp } from './app'
import { answerNextFolderDialog, finishWelcomeTour } from './steps'

// One installation for the whole path, as a person has it: the first test imports the background data,
// the next ones build on it. Serial, so a failed import skips what depends on it.
test.describe.configure({ mode: 'serial' })

let install: Install
let running: RunningApp | undefined

test.beforeAll(() => {
  install = freshInstall()
})

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && running) {
    if (!running.stopped) {
      await info.attach('window', { body: await running.page.screenshot(), contentType: 'image/png' })
    }
    await info.attach('app output', { body: running.output.join(''), contentType: 'text/plain' })
  }
})

test.afterAll(async () => {
  if (running) await quit(running, install)
  removeInstall(install)
})

test('BAFU background data imports through the setup sheet', async () => {
  running = await launch(install)
  const { page } = running
  await finishWelcomeTour(page)
  await expect(page.getByText('Bring your background data')).toBeVisible()

  await page.getByRole('button', { name: 'Import BAFU' }).click()
  await expect(page.getByLabel('Workspace name')).toHaveValue('Main')
  // Two invented ecoSpold-1 datasets (backend/tests/fixtures/import/bafu-mini); with no ecoinvent in the
  // workspace the import installs bw2io's bundled flow list and impact methods as well.
  await answerNextFolderDialog(running, join(FIXTURES, 'import', 'bafu-mini'))
  await page.getByRole('button', { name: 'Choose folder…' }).click()
  await page.getByRole('button', { name: 'Start import' }).click()

  const result = page.locator('.setup-result')
  await expect(result).toBeVisible({ timeout: 240_000 })
  await expect(result).toContainText('Imported')
  await expect(result).toContainText('2 datasets')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByText('Bring your background data')).toBeHidden()
  expect(running.rendererErrors).toEqual([])
})

test('a model is built, calculated, changed, undone and still there after a restart', async () => {
  let { page } = running!
  await page.getByTitle('Create another model, or duplicate an existing one').first().click()
  await page.getByLabel('Model name (e.g. pet-bottle-2025)').fill('e2e-bottle')
  await page.getByRole('button', { name: 'Create', exact: true }).click()

  await page.getByTitle('Add a new process to the model').click()
  await page.getByLabel('Name', { exact: true }).fill('bottle')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(processBox(page, 'bottle')).toBeVisible()

  // The new process is selected and open in the inspector: it emits 2 kg of fossil CO2 to air.
  await page.getByRole('tab', { name: /Outputs/ }).click()
  await page.getByRole('button', { name: '+ Add output flow' }).click()
  const picker = page.locator('.flowpick-modal')
  await picker.locator('.flowpick-search').fill('carbon dioxide, fossil')
  // To air in general — the sub-compartments (urban air, high stacks, …) are rows of their own.
  await picker
    .locator('.flowpick-row')
    .filter({ hasText: 'Carbon dioxide, fossil' })
    .filter({ has: page.getByText('air', { exact: true }) })
    .click()
  await picker.getByTitle('Amount').fill('2')
  await picker.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(picker).toBeHidden()

  // One kg CO2-eq per kg of fossil CO2 in CML's GWP100: the score is the amount.
  await chooseMethod(page, GWP100)
  await calculateExpecting(page, 2)

  // Enter commits the amount; the Undo button's tooltip names the step once the backend has stored it.
  await co2Amount(page).fill('4')
  await co2Amount(page).press('Enter')
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveAttribute('title', /Set amount .* to 4/)
  await calculateExpecting(page, 4)

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(co2Amount(page)).toHaveValue('2')
  await calculateExpecting(page, 2)

  // A restart brings the model back as it was, from the backend's store and the window's own settings.
  await quit(running!, install)
  running = await launch(install)
  page = running.page
  await expect(page.getByText('Bring your background data')).toBeHidden()
  await page.locator('.navitem', { hasText: 'Model' }).click()
  await processBox(page, 'bottle').click()
  await chooseMethod(page, GWP100)
  await calculateExpecting(page, 2)
  expect(running.rendererErrors).toEqual([])
})

const GWP100 = '★ CML v4.8 2016 · climate change · global warming potential (GWP100)'

function processBox(page: Page, name: string): Locator {
  return page.locator('.react-flow__node').filter({ hasText: name })
}

function co2Amount(page: Page): Locator {
  return page
    .locator('.flow-list .flow')
    .filter({ hasText: 'Carbon dioxide, fossil' })
    .locator('input')
    .first()
}

async function chooseMethod(page: Page, label: string): Promise<void> {
  await page.locator('select.search-sel').first().selectOption({ label })
}

/** Runs one calculation for the selected process and waits for the result bar to show `expected`. One
 *  click only: a result that stays stale after a change must fail here, not be clicked away. */
async function calculateExpecting(page: Page, expected: number): Promise<void> {
  // Below a certain window width the button shows only its icon; its title then names it.
  await page.getByRole('button', { name: /^(Calculate|Compute LCIA)$/ }).click()
  const total = page.locator('.result-bar b').first()
  await expect
    .poll(async () => ((await total.count()) ? Number.parseFloat(await total.innerText()) : NaN))
    .toBeCloseTo(expected, 6)
}
