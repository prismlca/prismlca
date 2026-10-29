import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { makePrism, type PrismFixture } from '../test/prism'
import { getAS, initAppSettings, setAS } from './appSettings'
import { rememberRecentModel } from './recentModels'
import NewsCard, { resetNewsSession } from '../views/overview/NewsCard'
import WelcomeTour from '../welcome/WelcomeTour'
import { TOUR_CARDS } from '../welcome/tourCards'

/**
 * Main answers every settings write with the whole object as it stood after THAT write. When the
 * answers arrive late — later writes already sent — an answer must not undo them.
 * Here main applies each write at once, as it does, and the test decides when each answer arrives.
 */
describe('settings writes answered late', () => {
  let fixture: PrismFixture
  let answers: Array<() => void>

  beforeEach(async () => {
    resetNewsSession()
    fixture = makePrism(
      {},
      { news: { fetch: vi.fn(async () => ({ items: [], source: 'prismlca.com', fetchedAt: '' })) } }
    )
    ;(window as unknown as { prism: unknown }).prism = fixture.prism
    await initAppSettings()
    setAS({ recentModels: [], newsAutoLoad: false })
    await waitFor(() => expect(fixture.settings.newsAutoLoad).toBe(false))
    // From here on every answer waits for the test.
    const set = fixture.prism.appSettings.set
    answers = []
    fixture.prism.appSettings.set = ((patch: Record<string, unknown>) => {
      const answer = set(patch) // main has applied it already
      return new Promise((resolve) => answers.push(() => resolve(answer)))
    }) as typeof set
  })

  afterEach(async () => {
    // Release anything still held, so no answer from this test lands in the next.
    for (const a of answers) a()
    await act(async () => {})
  })

  const answer = async (i: number): Promise<void> => {
    await act(async () => {
      answers[i]()
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  it('keeps the recent-model history when an older answer lands: A, B, ack A, C → C, B, A', async () => {
    rememberRecentModel('p', 'A')
    rememberRecentModel('p', 'B')
    await answer(0)
    expect(getAS().recentModels.map((r) => r.db)).toEqual(['B', 'A'])
    rememberRecentModel('p', 'C')
    await answer(1)
    await answer(2)
    expect(getAS().recentModels.map((r) => r.db)).toEqual(['C', 'B', 'A'])
    expect((fixture.settings.recentModels as Array<{ db: string }>).map((r) => r.db)).toEqual(['C', 'B', 'A'])
  })

  it('keeps an opt-out when the older opt-in is answered after it, and fetches nothing', async () => {
    render(<NewsCard />)
    act(() => {
      setAS({ newsAutoLoad: true })
      setAS({ newsAutoLoad: false })
    })
    await answer(0)
    expect(getAS().newsAutoLoad).toBe(false)
    await answer(1)
    expect(getAS().newsAutoLoad).toBe(false)
    expect(fixture.prism.news.fetch).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Load news from prismlca.com' })).toBeInTheDocument()
  })

  it('ticking the tour’s news box and then Finish closes the tour for good', async () => {
    const user = userEvent.setup()
    act(() => setAS({ welcomeTourDone: false }))
    await answer(0)
    render(<WelcomeTour />)
    await screen.findByText(TOUR_CARDS[0].title)
    for (let i = 0; i < TOUR_CARDS.length - 1; i++)
      await user.click(screen.getByRole('button', { name: 'Next' }))
    const last = TOUR_CARDS[TOUR_CARDS.length - 1]

    await user.click(screen.getByRole('checkbox', { name: 'Load news from prismlca.com at every start' }))
    await user.click(screen.getByRole('button', { name: 'Finish' }))
    // The checkbox's answer still says "tour not finished" — it must not reopen the tour.
    await answer(1)
    expect(screen.queryByText(last.title)).toBeNull()
    expect(screen.queryByText(TOUR_CARDS[0].title)).toBeNull()
    expect(getAS().welcomeTourDone).toBe(true)
    expect(getAS().newsAutoLoad).toBe(true)
    await answer(2)
    expect(getAS().welcomeTourDone).toBe(true)
    expect(getAS().newsAutoLoad).toBe(true)
    act(() => setAS({ newsAutoLoad: false, welcomeTourDone: false }))
  })
})
