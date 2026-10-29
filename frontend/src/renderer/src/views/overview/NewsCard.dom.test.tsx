import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import NewsCard, { resetNewsSession } from './NewsCard'
import { renderWithPrism } from '../../test/render'
import { makePrism } from '../../test/prism'
import { initAppSettings, setAS } from '../../lib/appSettings'
import { SUBSTACK_URL, NEWS_URL } from '../../lib/links'

/**
 * The privacy rule is the card's contract: no fetch until the user allowed it — by the setting, or by
 * a click — and then once per session, not once per visit to the start page.
 */
const FEED = {
  source: 'prismlca.com',
  fetchedAt: '2026-09-29T10:00:00.000Z',
  items: Array.from({ length: 7 }, (_, i) => ({
    title: `Item ${i + 1}`,
    link: `https://prismlca.com/news/${i + 1}`,
    date: new Date(Date.UTC(2026, 8, 24 - i)).toISOString(),
    teaser: `Teaser ${i + 1}`
  }))
}

describe('Latest news card', () => {
  beforeEach(async () => {
    resetNewsSession()
    ;(window as unknown as { prism: unknown }).prism = makePrism().prism
    await initAppSettings()
    setAS({ newsAutoLoad: false })
  })

  const mount = (fetch: () => Promise<unknown>) => {
    const spy = vi.fn(fetch)
    const r = renderWithPrism(<NewsCard />, { overrides: { news: { fetch: spy } } })
    return { ...r, fetch: spy }
  }

  it('asks before loading anything when autoload is off', async () => {
    const { fetch } = mount(async () => FEED)
    expect(screen.getByRole('button', { name: 'Load news from prismlca.com' })).toBeInTheDocument()
    expect(screen.getByText(/Nothing is loaded until you click/)).toHaveTextContent('Settings → General')
    await new Promise((r) => setTimeout(r, 20))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('loads once on click, shows three rows, and does not refetch on the next visit', async () => {
    const user = userEvent.setup()
    const first = mount(async () => FEED)
    await user.click(screen.getByRole('button', { name: 'Load news from prismlca.com' }))
    expect(await screen.findByText('Item 1')).toBeInTheDocument()
    expect(screen.getByText('Item 3')).toBeInTheDocument()
    expect(screen.queryByText('Item 4')).toBeNull()
    expect(screen.getByText('Sep 24, 2026')).toBeInTheDocument()
    expect(first.fetch).toHaveBeenCalledTimes(1)
    first.unmount()

    // Back on the start page in the same session: the rows are there, nothing is fetched again.
    const second = mount(async () => FEED)
    expect(screen.getByText('Item 1')).toBeInTheDocument()
    expect(second.fetch).not.toHaveBeenCalled()
  })

  it('loads on mount when autoload is on', async () => {
    setAS({ newsAutoLoad: true })
    const { fetch } = mount(async () => FEED)
    expect(await screen.findByText('Item 1')).toBeInTheDocument()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('says so when prismlca.com cannot be reached, and tries again on request', async () => {
    const user = userEvent.setup()
    let fail = true
    mount(async () => {
      if (fail)
        throw new Error(
          "Error invoking remote method 'news:fetch': Error: prismlca.com could not be reached."
        )
      return FEED
    })
    await user.click(screen.getByRole('button', { name: 'Load news from prismlca.com' }))
    expect(await screen.findByText('prismlca.com could not be reached.')).toBeInTheDocument()
    fail = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Item 1')).toBeInTheDocument()
  })

  it('opens an item, the news page and the Substack in the browser', async () => {
    const user = userEvent.setup()
    setAS({ newsAutoLoad: true })
    mount(async () => FEED)
    const opened = vi.fn()
    ;(window as unknown as { prism: { openExternal: unknown } }).prism.openExternal = opened
    await user.click(await screen.findByText('Item 2'))
    expect(opened).toHaveBeenLastCalledWith('https://prismlca.com/news/2')
    await user.click(screen.getByRole('button', { name: /Open in browser/ }))
    expect(opened).toHaveBeenLastCalledWith(NEWS_URL)
    await user.click(screen.getByRole('button', { name: /Subscribe/ }))
    expect(opened).toHaveBeenLastCalledWith(SUBSTACK_URL)
    await waitFor(() => expect(opened).toHaveBeenCalledTimes(3))
  })
})
