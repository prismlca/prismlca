import type { Page } from '@playwright/test'
import { describe, expect, it } from 'vitest'
import { explainFailure, lastObstacle } from './actions'

/** A click on a toolbar button while a box's tag menu was open, as Playwright 1.64 logged it. */
const COVERED = `locator.click: Timeout 10000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Auto-layout', exact: true })
    - locator resolved to <button class="btn sm" title="Arrange with automatic layout">Auto-layout</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <div class="ctx-backdrop"></div> intercepts pointer events
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <div class="ctx-backdrop"></div> intercepts pointer events
    - retrying click action
      - waiting 500ms
`

/** A page on which every target names exactly one element. */
const onePerTarget = { locator: () => ({ count: async () => 1 }) } as unknown as Page

describe('lastObstacle', () => {
  it('names the element that took the click', () => {
    const said = lastObstacle(COVERED)
    expect(said).toMatch(/^<div class="ctx-backdrop"><\/div> lies on top of it and takes the pointer/)
    expect(said).toMatch(/press Escape, or click beside the menu/)
  })

  it('reads through terminal colours', () => {
    expect(
      lastObstacle(`\u001b[2m  - <div class="ctx-backdrop"></div> intercepts pointer events\u001b[22m`)
    ).toMatch(/^<div class="ctx-backdrop"><\/div> lies on top/)
  })

  it('takes the last reason: the state at the deadline, not the first attempt', () => {
    const log = [
      'Call log:',
      '  - attempting click action',
      '    - element is not stable',
      '  - retrying click action',
      '    - element is not enabled',
      '  - retrying click action',
      '    waiting for element to be visible, enabled and stable'
    ].join('\n')
    expect(lastObstacle(log)).toBe('it stayed disabled (its title often says why)')
  })

  it('names each state the target never reached', () => {
    expect(lastObstacle('  - element is not visible')).toMatch(/not visible/)
    expect(lastObstacle('  - element is not stable')).toMatch(/kept moving/)
    expect(lastObstacle('  - element is not editable')).toMatch(/read-only/)
    expect(lastObstacle('  - element is outside of the viewport')).toMatch(/outside the window/)
  })

  it('gives nothing when the log names no reason', () => {
    expect(
      lastObstacle('locator.click: Timeout 10000ms exceeded.\nCall log:\n  - attempting click action')
    ).toBe(null)
  })
})

describe('explainFailure', () => {
  it('leads with what covers the target, which the clipped call log leaves out', async () => {
    const said = await explainFailure(onePerTarget, 'css=.btn', new Error(COVERED))
    const [first, ...rest] = said.split('\n')
    expect(first).toMatch(/^css=\.btn is there but <div class="ctx-backdrop"><\/div> lies on top of it/)
    // The log lines after it are Playwright's first ones, as before.
    expect(rest[0]).toBe('locator.click: Timeout 10000ms exceeded.')
  })

  it('keeps the general hint when the log gives no reason', async () => {
    const said = await explainFailure(
      onePerTarget,
      'css=.btn',
      new Error('locator.click: Timeout 10000ms exceeded.\nCall log:\n  - attempting click action')
    )
    expect(said).toMatch(/^css=\.btn is there but did not become actionable/)
  })

  it('leaves a wait to its own expected/received lines', async () => {
    const said = await explainFailure(onePerTarget, 'css=.btn', new Error(COVERED), true)
    expect(said).not.toMatch(/lies on top/)
  })
})
