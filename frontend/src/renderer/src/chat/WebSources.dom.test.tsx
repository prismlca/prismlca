import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MessageRow } from './MessageRow'
import { ToolTraceList } from './ToolTraceList'
import { hostOf, webSourcesOf } from './turnSources'
import type { ChatMessage, ToolTrace } from '../lib/ai'

const row: ToolTrace = {
  name: 'web_lookups',
  status: 'ok',
  preview: '2 web searches — run by the provider inside this reply.',
  searches: [
    {
      query: 'avasco Atlas Gewicht',
      results: [
        { url: 'https://www.galaxus.ch/p/64601145', title: 'Avasco Steckregal Atlas 175' },
        { url: 'https://www.hornbach.de/p/12008577' }
      ]
    },
    { query: 'avasco Herkunft' }
  ],
  cited: [
    { url: 'https://www.galaxus.ch/p/64601145', title: 'Avasco Steckregal Atlas 175', excerpt: '24000 g' }
  ]
}

const answer = (tools: ToolTrace[]): ChatMessage => ({ role: 'assistant', content: 'About 24 kg.', tools })

describe('the sources of an answer', () => {
  it('reads the cited pages and the searches from the turn’s web lookups rows', () => {
    const second: ToolTrace = { ...row, searches: [{ query: 'q2', results: [] }], cited: [row.cited![0]] }
    const { cited, searches } = webSourcesOf([row, { name: 'list_models', status: 'ok' }, second])
    expect(cited.map((c) => c.url)).toEqual(['https://www.galaxus.ch/p/64601145'])
    expect(searches.map((s) => s.query)).toEqual(['avasco Atlas Gewicht', 'avasco Herkunft', 'q2'])
    expect(hostOf('https://www.galaxus.ch/p/1')).toBe('galaxus.ch')
    expect(hostOf('not a url')).toBe('not a url')
  })

  it('lists the cited pages under the answer and opens one in the browser', async () => {
    const user = userEvent.setup()
    const opened = vi.fn()
    ;(window as unknown as { prism: unknown }).prism = { openExternal: opened }
    const { container } = render(
      <MessageRow m={answer([row])} labels={{}} onJump={() => {}} onReveal={() => {}} />
    )
    // Under the answer, apart from the turn's trace (which lists them in its row as well).
    const sources = within(container.querySelector('.chat-sources') as HTMLElement)
    expect(sources.getByText('Sources')).toBeInTheDocument()
    // Listed as a source, and again among the pages its search returned.
    const [link] = sources.getAllByRole('link', { name: 'Avasco Steckregal Atlas 175' })
    expect(link.getAttribute('title')).toContain('“24000 g”')
    await user.click(link)
    expect(opened).toHaveBeenCalledWith('https://www.galaxus.ch/p/64601145')
    // The searches behind them, one line until opened.
    expect(sources.getByText('2 web searches · 2 pages found')).toBeInTheDocument()
    expect(sources.getByText('“avasco Atlas Gewicht”')).toBeInTheDocument()
    expect(sources.getByText('The provider does not report the pages it found.')).toBeInTheDocument()
  })

  it('shows nothing under an answer whose turn did not search', () => {
    render(
      <MessageRow
        m={answer([{ name: 'list_models', status: 'ok' }])}
        labels={{}}
        onJump={() => {}}
        onReveal={() => {}}
      />
    )
    expect(screen.queryByText('Sources')).toBeNull()
    expect(screen.queryByText(/web search/)).toBeNull()
  })

  it('opens no address that is not a web page', () => {
    const odd: ToolTrace = { ...row, searches: [], cited: [{ url: 'javascript:alert(1)', title: 'Odd' }] }
    const { container } = render(
      <MessageRow m={answer([odd])} labels={{}} onJump={() => {}} onReveal={() => {}} />
    )
    expect(screen.queryByRole('link', { name: 'Odd' })).toBeNull()
    expect(
      within(container.querySelector('.chat-sources') as HTMLElement).getByText('Odd')
    ).toBeInTheDocument()
  })

  it('lists the searches and the cited pages in the expanded trace row', () => {
    render(<ToolTraceList traces={[row]} labels={{}} />)
    expect(screen.getByText('Web lookups by the provider')).toBeInTheDocument()
    expect(screen.getByText('Cited in this reply')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'hornbach.de' })).toBeInTheDocument()
  })

  // Anthropic's page fetch names the pages a reply opened.
  const fetchedRow: ToolTrace = {
    name: 'web_lookups',
    status: 'ok',
    preview: '2 pages fetched — run by the provider inside this reply.',
    fetched: [
      { url: 'https://www.meffert.de/sds.pdf', title: 'Safety data sheet' },
      { url: 'https://www.meffert.de/gone', error: 'url_not_accessible' },
      { url: 'https://www.galaxus.ch/p/64601145', title: 'Avasco Steckregal Atlas 175' }
    ]
  }

  it('lists the opened pages under the answer, leaving out one it cites and one it could not open', () => {
    const { opened } = webSourcesOf([fetchedRow, fetchedRow])
    expect(opened.map((o) => o.url)).toEqual([
      'https://www.meffert.de/sds.pdf',
      'https://www.galaxus.ch/p/64601145'
    ])
    const { container } = render(
      <MessageRow m={answer([row, fetchedRow])} labels={{}} onJump={() => {}} onReveal={() => {}} />
    )
    const sources = within(container.querySelector('.chat-sources') as HTMLElement)
    expect(sources.getByText('Pages opened')).toBeInTheDocument()
    expect(sources.getByRole('link', { name: 'Safety data sheet' })).toBeInTheDocument()
    expect(sources.queryByText(/not opened/)).toBeNull()
    // The cited page is listed once, under Sources (and among its search's results), not as opened too.
    const opened2 = within(sources.getByText('Pages opened').nextElementSibling as HTMLElement)
    expect(opened2.queryByRole('link', { name: 'Avasco Steckregal Atlas 175' })).toBeNull()
  })

  it('shows the opened pages under an answer that only opened pages', () => {
    render(<MessageRow m={answer([fetchedRow])} labels={{}} onJump={() => {}} onReveal={() => {}} />)
    expect(screen.queryByText('Sources')).toBeNull()
    expect(screen.getByText('Pages opened')).toBeInTheDocument()
  })

  it('names in the trace row each page the reply opened, and why one was not', () => {
    render(<ToolTraceList traces={[fetchedRow]} labels={{}} />)
    expect(screen.getByText('Opened in this reply')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Safety data sheet' })).toBeInTheDocument()
    expect(screen.getByText(/not opened \(url_not_accessible\)/)).toBeInTheDocument()
  })
})
