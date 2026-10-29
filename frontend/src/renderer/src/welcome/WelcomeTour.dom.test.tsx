import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import WelcomeTour from './WelcomeTour'
import { restartWelcomeTour } from './restartTour'
import { TOUR_CARDS } from './tourCards'
import { renderWithPrism } from '../test/render'
import { makePrism } from '../test/prism'
import { getAS, initAppSettings, setAS } from '../lib/appSettings'

/**
 * The tour's whole contract is "you cannot get out of it early", and that is what is tested here:
 * no skip, no cross, no Escape, and — the one that actually costs money if it regresses — the seen
 * flag is written by Finish and by nothing else. A tour that marks itself done on the first card
 * would quietly retire the two cards nobody may miss (what a report is not, and whose bill it is).
 */
describe('welcome tour', () => {
  // Two things the store needs before any of this means anything: a bridge (`setAS` writes through
  // it, and these tests call it before rendering) and main's answer, because the tour refuses to
  // act on the pre-answer seed. renderWithPrism installs its own fixture over this one.
  beforeEach(async () => {
    ;(window as unknown as { prism: unknown }).prism = makePrism().prism
    await initAppSettings()
  })
  // The appSettings store is a module singleton: a flag left true would hide the tour from the
  // next test and read as a pass.
  afterEach(() => setAS({ welcomeTourDone: false }))

  const openTour = (): ReturnType<typeof renderWithPrism> => {
    setAS({ welcomeTourDone: false })
    return renderWithPrism(<WelcomeTour />)
  }

  it('opens on a fresh install and offers no way out but forward', async () => {
    openTour()
    await screen.findByText(TOUR_CARDS[0].title)

    // The three absences, asserted as a user would look for them.
    expect(screen.queryByRole('button', { name: /skip/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /close|dismiss/i })).toBeNull()
    // The only checkbox is the news question in the footer — there is no "don't show this again".
    expect(screen.queryByRole('checkbox', { name: /show|again|skip|remind/i })).toBeNull()
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)

    // Back exists but cannot leave the first card.
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument()
  })

  it('ignores Escape — the way out is the last card', async () => {
    const user = userEvent.setup()
    openTour()
    await screen.findByText(TOUR_CARDS[0].title)

    await user.keyboard('{Escape}')

    expect(screen.getByText(TOUR_CARDS[0].title)).toBeInTheDocument()
    expect(getAS().welcomeTourDone).toBe(false)
  })

  it('writes the seen flag only once Finish is pressed on the last card', async () => {
    const user = userEvent.setup()
    const { prism } = openTour()
    // The fixture's settings object is main's stand-in — the assertion at the end reads it back.
    await screen.findByText(TOUR_CARDS[0].title)

    // Every card but the last: forward, and still not marked as seen.
    for (let i = 0; i < TOUR_CARDS.length - 1; i++) {
      expect(screen.getByText(TOUR_CARDS[i].title)).toBeInTheDocument()
      expect(screen.getByText(`${i + 1} of ${TOUR_CARDS.length}`)).toBeInTheDocument()
      expect(getAS().welcomeTourDone).toBe(false)
      await user.click(screen.getByRole('button', { name: 'Next' }))
    }

    // The last card ends in Finish, not Next.
    const last = TOUR_CARDS[TOUR_CARDS.length - 1]
    expect(screen.getByText(last.title)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Finish' }))

    await waitFor(() => expect(screen.queryByText(last.title)).toBeNull())
    expect(getAS().welcomeTourDone).toBe(true)
    // Written through to main, like every other setting in this app — not just held in the renderer.
    await waitFor(async () =>
      expect(await prism.prism.appSettings.get()).toMatchObject({ welcomeTourDone: true })
    )
  })

  it('stays shut once the flag is set', async () => {
    setAS({ welcomeTourDone: true })
    renderWithPrism(<WelcomeTour />)
    await waitFor(() => expect(screen.queryByText(TOUR_CARDS[0].title)).toBeNull())
  })

  it('reopens when Overview clears the flag, without a renderer reload', async () => {
    setAS({ welcomeTourDone: true })
    renderWithPrism(<WelcomeTour />)
    await waitFor(() => expect(screen.queryByText(TOUR_CARDS[0].title)).toBeNull())

    // What "Take the tour again" does — the component must notice the setting, not a new mount.
    restartWelcomeTour()

    await screen.findByText(TOUR_CARDS[0].title)
    expect(screen.getByText(`1 of ${TOUR_CARDS.length}`)).toBeInTheDocument()
  })

  describe('the callout on a card with an anchor', () => {
    // jsdom lays nothing out, so the boxes are handed to it: the card, and the element the second card
    // points at. On a fresh install that element is the start screen's import tiles, in the middle of
    // the window — under the card.
    const box = (left: number, top: number, width: number, height: number): DOMRect =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect
    const CARD = box(212, 184, 600, 400)
    const showCardWithAnchorAt = async (anchorBox: DOMRect): Promise<void> => {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement
      ) {
        if (this.classList.contains('wt-card')) return CARD
        if (this.dataset.tour === 'background') return anchorBox
        return box(0, 0, 0, 0)
      })
      const anchor = document.createElement('div')
      anchor.dataset.tour = 'background'
      document.body.appendChild(anchor)
      const user = userEvent.setup()
      openTour()
      const target = TOUR_CARDS.findIndex((c) => c.anchor === 'background')
      for (let n = 0; n < target; n++) await user.click(await screen.findByRole('button', { name: 'Next' }))
      await screen.findByText(TOUR_CARDS[target].title)
    }
    afterEach(() => {
      vi.restoreAllMocks()
      document.querySelectorAll('[data-tour]').forEach((el) => el.remove())
    })

    it('leaves out ring and note when the anchor lies under the card', async () => {
      await showCardWithAnchorAt(box(312, 334, 400, 100))
      expect(document.querySelector('.wt-anchor-note')).toBeNull()
      expect(document.querySelector('.wt-ring')).toBeNull()
      expect(document.querySelector('.wt-backdrop')).not.toBeNull() // dimmed as a card without anchor
    })

    it('rings an anchor beside the card and puts the note next to it', async () => {
      await showCardWithAnchorAt(box(20, 20, 100, 30))
      expect(document.querySelector('.wt-ring')).not.toBeNull()
      expect(screen.getByText('Import happens here — now or later.')).toBeInTheDocument()
    })
  })

  it('calls BAFU free, and says in the same breath what free does not mean', () => {
    // "Free" is a licence statement in the product. It may stand only next to BAFU's two conditions,
    // so a later trim of this card cannot leave the promise behind without them.
    const text = JSON.stringify(TOUR_CARDS.find((c) => c.id === 'data')?.body)
    expect(text).toMatch(/free to use/i)
    expect(text).toMatch(/cited/i)
    expect(text).toMatch(/resold/i)
  })

  it('names every way out of the machine, and that they can be closed', () => {
    // The privacy promise is a claim about the product, so it is asserted as a claim: a card that
    // stops naming one of the services has quietly narrowed what the user was told. Prose and
    // picture are read together here, because the reader sees them together — the prose keeps the
    // sentence short by saying "a routing service", and the panel beside it gives the name.
    const privacy = TOUR_CARDS.find((c) => c.id === 'privacy')
    const text = JSON.stringify([privacy?.body, privacy?.visual])
    for (const service of [
      'OpenRouter',
      'OpenAI',
      'OpenRouteService',
      'Eurostat',
      'Whisper',
      'prismlca.com'
    ]) {
      expect(text).toContain(service)
    }
    // Two uses of the same key that a reader would not expect from the word "assistant": a printed
    // chapter, and the recording made when dictating into the chat.
    expect(text).toMatch(/report writer/i)
    expect(text).toMatch(/recording/i)
    expect(text).toMatch(/switched off/i)
    // The news is the one door that starts shut, and the card says where its switch is.
    expect(text).toMatch(/if you allow it/i)
    expect(text).toMatch(/Settings → General/)
    expect(text).toMatch(/Eight features/)
    // The two doors that came with the privacy work: neither opens on its own.
    expect(text).toMatch(/huggingface\.co/)
    expect(text).toMatch(/github\.com/)
    // The eighth opens the other way — a client on this machine drives the app — and
    // starts shut like the news.
    expect(text).toMatch(/MCP server/)
    expect(text).toMatch(/Settings → AI → MCP/)
  })

  it('asks about the news in the footer, on every card, without leaving the tour', async () => {
    const user = userEvent.setup()
    const { prism } = openTour()
    await screen.findByText(TOUR_CARDS[0].title)
    // The box is in the footer bar from the first card on, not on the last card only.
    const first = screen.getByRole('checkbox', { name: 'Load news from prismlca.com at every start' })
    expect(first).not.toBeChecked()
    expect(first.closest('label')).not.toHaveClass('wt-choice-mark')
    for (let i = 0; i < TOUR_CARDS.length - 1; i++)
      await user.click(screen.getByRole('button', { name: 'Next' }))
    const last = TOUR_CARDS[TOUR_CARDS.length - 1]
    expect(screen.getByText(last.title)).toBeInTheDocument()

    const box = screen.getByRole('checkbox', { name: 'Load news from prismlca.com at every start' })
    // On the last card the label is swept with the highlighter (a class; the motion is CSS).
    expect(box.closest('label')).toHaveClass('wt-choice-mark')
    expect(box).not.toBeChecked()
    await user.click(box)
    expect(box).toBeChecked()
    await waitFor(() => expect(prism.settings.newsAutoLoad).toBe(true))

    // Enter and Space on the box belong to the box: the tour is still open, and not marked as seen.
    box.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByText(last.title)).toBeInTheDocument()
    expect(box).toBeChecked()
    await user.keyboard(' ')
    expect(box).not.toBeChecked()
    expect(screen.getByText(last.title)).toBeInTheDocument()
    expect(getAS().welcomeTourDone).toBe(false)
    setAS({ newsAutoLoad: false })
  })

  it('opens external links in the browser rather than navigating the app away', async () => {
    const user = userEvent.setup()
    openTour()
    await screen.findByText(TOUR_CARDS[0].title)
    // The fixture's openExternal is a plain stub; the spy goes on after the bridge is installed.
    const opened = vi.fn()
    ;(window as unknown as { prism: { openExternal: unknown } }).prism.openExternal = opened

    // Straight to the card that carries the provider links.
    const byok = TOUR_CARDS.findIndex((c) => c.id === 'byok')
    for (let i = 0; i < byok; i++) await user.click(screen.getByRole('button', { name: 'Next' }))

    await user.click(screen.getByRole('button', { name: 'openrouter.ai/keys' }))
    // A bare host in the card, a real URL at the door — and never an in-app navigation.
    expect(opened).toHaveBeenCalledWith('https://openrouter.ai/keys')
  })

  it('ends on the ask, with the money card right before it', () => {
    // The tour closes on the request to report what breaks — the last word is an
    // invitation, not a warning. The money card keeps the place right in front of it, where it is
    // still read: both are behind every other card, which is what having no skip button is for.
    const ids = TOUR_CARDS.map((c) => c.id)
    expect(ids[ids.length - 1]).toBe('bugs')
    expect(ids[ids.length - 2]).toBe('bill')

    openTour()
    // The claim itself, not its wording: a card that no longer says the provider's limit is the one
    // that holds has lost its point.
    const text = JSON.stringify(TOUR_CARDS.find((c) => c.id === 'bill')?.body)
    expect(text).toMatch(/hard spending limit at the provider/i)
    expect(text).toMatch(/beta/i)
  })
})
