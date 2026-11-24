import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { FIXTURES, freshInstall, launch, quit, removeInstall, type Install, type RunningApp } from './app'
import { expectRest } from './idle'
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
  await expectRest(page, 'the import')
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByText('Bring your background data')).toBeHidden()
  await expectRest(page, 'closing the setup sheet')
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
  // The canvas is open with a selected process: where the Workbench once rendered without pause.
  await expectRest(page, 'a new process on the canvas')

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
  await expectRest(page, 'a calculation on the canvas')

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
  // The app asked its backend to leave, and it left in order rather than being ended by a signal — on
  // Windows that signal is TerminateProcess, which cuts off whatever the backend was writing.
  const quitOutput = running!.output.join('')
  expect(quitOutput).toContain('[prism] the backend left in order')
  expect(quitOutput).toContain('Shutting down')
  running = await launch(install)
  page = running.page
  await expect(page.getByText('Bring your background data')).toBeHidden()
  await page.locator('.navitem', { hasText: 'Model' }).click()
  // The reopened canvas is drawn from the cached view first and then from the backend's answer; a click
  // on the box between the two was seen to lose its selection. So the click waits until the canvas rests.
  await expect(processBox(page, 'bottle')).toBeVisible()
  await expectRest(page, 'the model reopening after the restart')
  await processBox(page, 'bottle').click()
  await chooseMethod(page, GWP100)
  await calculateExpecting(page, 2)
  await expectRest(page, 'a calculation after the restart')
  expect(running.rendererErrors).toEqual([])
})

test('Results: the model is computed for a picked indicator, and taken apart in its decomposition tree', async () => {
  const { page } = running!
  await page.locator('.navitem', { hasText: 'Results' }).click()
  // A tab's view stays mounted once seen, beside the others; only the one on show is visible.
  const overview = page.locator('.results-view').filter({ visible: true })
  // A model opens on its reference process; its indicators are picked here.
  await expect(overview.locator('.results-rail')).toContainText('bottle')
  await expectRest(page, 'opening Results')
  await openGroup(overview, 'Indicators')
  await overview.getByRole('button', { name: '+ Add indicator' }).click()
  await overview.locator('select.ind-family').selectOption(GWP100_PATH[0])
  await overview.getByPlaceholder('Filter indicators…').fill(GWP100_PATH[1])
  await overview.locator(`.ind-row[title="${GWP100_PATH.slice(1).join(' · ')}"]`).click()
  await overview.getByRole('button', { name: 'Done' }).click()
  await overview.getByRole('button', { name: 'Calculate' }).click()
  // Loaded: the rail reports the finished run, and the table holds the score.
  await expect(overview.getByText(/^Computed in/)).toBeVisible()
  await expect(overview.locator('.results-table tbody tr').filter({ hasText: 'bottle' })).toContainText(
    '2.00'
  )
  await expectRest(page, 'a calculation on the Results page')

  await page.getByRole('tab', { name: 'Decomposition tree' }).click()
  const tree = page.locator('.results-view.dr')
  await expect(tree).toBeVisible()
  await openGroup(tree, 'Impact category')
  // By role: a label wrapped around a select reads the select's options too, so getByLabel would not match.
  await tree.getByRole('combobox', { name: 'Method family', exact: true }).selectOption(GWP100_PATH[0])
  await tree
    .getByRole('combobox', { name: 'Indicator', exact: true })
    .selectOption({ label: `★ ${GWP100_PATH.slice(1).join(' · ')} [kg CO2-Eq]` })
  await tree.getByRole('button', { name: 'Calculate' }).click()
  // Loaded: the run is reported, and the flow list names the one emission with the whole score.
  await expect(tree.getByText(/^Computed in/)).toBeVisible()
  await expect(tree.getByText('Carbon dioxide, fossil')).toBeVisible()
  await expect(tree.getByText('100.0%').first()).toBeVisible()
  await expectRest(page, 'drawing the decomposition tree')
  expect(running!.rendererErrors).toEqual([])
})

test('Report: a short report is typeset, and a new stored report opens with its chapters', async () => {
  const { page } = running!
  await page.locator('.navitem', { hasText: 'Report' }).click()
  await page.getByRole('tab', { name: 'Short reports (w/o AI)' }).click()
  // The stored reports' rail stays mounted beside it, hidden.
  const short = page.locator('.report-setup').filter({ visible: true })
  await expect(short).toContainText('Deterministic and unstored')
  await expectRest(page, 'opening the short reports')
  await openGroup(short, 'Indicators')
  await short.getByRole('button', { name: '+ Add indicator' }).click()
  await short.getByLabel('Method family').selectOption(GWP100_PATH[0])
  await short.getByPlaceholder('Filter indicators…').fill(GWP100_PATH[1])
  await short.locator('.report-method').filter({ hasText: GWP100_PATH[1] }).getByRole('checkbox').check()
  await short.getByRole('button', { name: 'Done' }).click()
  await short.getByRole('button', { name: 'Generate' }).click()
  // Loaded: the first page is on screen and nothing is being typeset any more.
  await expect(page.getByAltText(/^Page 1 of \d+$/)).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.report-working')).toBeHidden()
  await expectRest(page, 'typesetting a short report')

  await page.getByRole('tab', { name: 'Full reports (AI)' }).click()
  await page.getByRole('button', { name: 'New report' }).click()
  // Loaded: the new report's chapters are listed — where the page once stayed on "Loading…" at full CPU.
  const stored = page.locator('.report-setup').filter({ visible: true })
  await expect(stored.getByText('Title page', { exact: true })).toBeVisible()
  await expect(stored.getByText('Loading…')).toBeHidden()
  await expectRest(page, 'opening a new stored report')
  // Back where the next test expects the window: the model on its canvas.
  await page.locator('.navitem', { hasText: 'Model' }).click()
  expect(running!.rendererErrors).toEqual([])
})

test('tag groups belong to their model: kept over a restart, unseen by the next model, taken over on request', async () => {
  let { page } = running!
  // The model the tests before built is open on its canvas. It gets a group, a tag, and the tag on its process.
  await openTags(page)
  const tags = page.locator('.tagman-modal')
  await tags.getByPlaceholder('New group name (e.g. Life-cycle phase)').fill('Component')
  await tags.getByRole('button', { name: 'Add group' }).click()
  await tags.getByPlaceholder('New tag…').fill('Body')
  await tags.getByRole('button', { name: 'Add a tag' }).click()
  await expect(tags.locator('.tagman-chip', { hasText: 'Body' })).toHaveClass(/unused/)
  await tags.getByRole('button', { name: 'Close' }).click()

  await processBox(page, 'bottle').getByTitle('Assign tags').click()
  await page.locator('.tagmenu select.search-sel').selectOption('Body')
  await expect(processBox(page, 'bottle').locator('.pnode-tag', { hasText: 'Body' })).toBeVisible()
  await page.locator('.ctx-backdrop').click()

  await quit(running!, install)
  running = await launch(install)
  page = running.page
  await page.locator('.navitem', { hasText: 'Model' }).click()
  await expect(processBox(page, 'bottle').locator('.pnode-tag', { hasText: 'Body' })).toBeVisible()
  await openTags(page)
  await expect(page.locator('.tagman-name', { hasText: 'Component' })).toBeVisible()
  // Carried by the process now, so no longer marked as unused.
  await expect(page.locator('.tagman-chip', { hasText: 'Body' })).not.toHaveClass(/unused/)
  await page.locator('.tagman-modal').getByRole('button', { name: 'Close' }).click()

  // A second model starts without tag groups — the first model's are its own.
  await page.getByTitle('Create another model, or duplicate an existing one').first().click()
  await page.getByLabel('Model name (e.g. pet-bottle-2025)').fill('e2e-can')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(processBox(page, 'bottle')).toBeHidden()
  await openTags(page)
  const second = page.locator('.tagman-modal')
  await expect(second.getByText('No tag groups yet — create one below.')).toBeVisible()

  // Taken over, they arrive as vocabulary: the group and its tag, which nothing here carries yet.
  await second.getByLabel('Model to take the tag groups from').selectOption('e2e-bottle')
  await second.getByRole('button', { name: 'Take over' }).click()
  await expect(second.locator('.tagman-name', { hasText: 'Component' })).toBeVisible()
  await expect(second.locator('.tagman-chip', { hasText: 'Body' })).toHaveClass(/unused/)
  await second.getByRole('button', { name: 'Close' }).click()

  // One step of this model, and Undo takes it back.
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveAttribute('title', /Take over tag groups/)
  await page.getByRole('button', { name: 'Undo' }).click()
  await openTags(page)
  await expect(page.locator('.tagman-modal').getByText('No tag groups yet — create one below.')).toBeVisible()
  await page.locator('.tagman-modal').getByRole('button', { name: 'Close' }).click()
  expect(running.rendererErrors).toEqual([])
})

test('a model name with a slash is refused, and one with the other odd characters works on every page', async () => {
  const { page } = running!
  const banner = page.locator('.wb-error')
  // A slash would cut the name in two in the app's own addresses, and every page would answer "Not Found".
  // The dialog stays open with the reason and a name that would do.
  await newModel(page, 'PET/glass')
  const dialog = page.locator('.modal-backdrop')
  await expect(dialog.getByRole('alert')).toContainText('cannot contain a slash')
  await expect(dialog.getByRole('alert')).toContainText('‘PET-glass’')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  // Every other character travels percent-encoded: the ones a URL gives a meaning to, and a dot segment.
  for (const name of ['odd #1 50% ?a=b&c+d \\ x', '..']) {
    await newModel(page, name)
    await page.getByTitle('Add a new process to the model').click()
    await page.getByLabel('Name', { exact: true }).fill('bottle')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(processBox(page, 'bottle')).toBeVisible()
    for (const view of ['Parameters', 'Scenarios', 'LCIA', 'Results', 'Report', 'Model']) {
      const item = page.locator('.navitem', { hasText: view })
      await item.click()
      await expect(item).toHaveAttribute('aria-current', 'page')
      await expectRest(page, `opening ${view} for the model ${name}`)
      await expect(banner).toBeHidden()
    }
  }
  expect(running!.rendererErrors).toEqual([])
})

async function newModel(page: Page, name: string): Promise<void> {
  await page.getByTitle('Create another model, or duplicate an existing one').first().click()
  await page.getByLabel('Model name (e.g. pet-bottle-2025)').fill(name)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
}

async function openTags(page: Page): Promise<void> {
  await page
    .getByTitle('Manage tag groups and values (assign tags via the tag button on a process box)')
    .click()
  await expect(page.locator('.tagman-modal')).toBeVisible()
}

const GWP100 = '★ CML v4.8 2016 · climate change · global warming potential (GWP100)'
/** The same indicator as family, category and indicator, for the pickers that list them apart. */
const GWP100_PATH = ['CML v4.8 2016', 'climate change', 'global warming potential (GWP100)']

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

/** Opens one group of a rail's accordion, unless it already is (the open group is remembered). */
async function openGroup(scope: Locator, title: string): Promise<void> {
  const head = scope.locator('.acc-ghead').filter({ hasText: title })
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click()
  await expect(head).toHaveAttribute('aria-expanded', 'true')
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
