// @vitest-environment jsdom
/**
 * The search's filters act at once, and the unit filter speaks in short forms. A changed filter used to
 * wait for Enter, so the old hits stood under a line that already described the new choice; a unit is
 * offered as "kg · kilogram" and sent as the index writes it; a late answer never replaces a newer one.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Answer = { hits: { code: string; name: string }[]; units_not_in_databases?: string[] }
const sent: Record<string, unknown>[] = []
/** Answers for the next searches, in order; when empty, a search answers with one hit named after its turn. */
const queued: Promise<Answer>[] = []

vi.mock('../lib/api', async (actual) => ({
  ...(await actual<typeof import('../lib/api')>()),
  api: vi.fn(async (method: string, path: string, body?: Record<string, unknown>) => {
    if (path.startsWith('/api/v1/search/units/'))
      return [
        { unit: 'kilogram', count: 5 },
        { unit: 'kilowatt hour', count: 3 },
        { unit: 'unit', count: 1 }
      ]
    if (path.startsWith('/api/v1/search/geographies/')) return ['DE', 'GLO']
    if (method === 'POST' && path === '/api/v1/search/activities') {
      sent.push(body ?? {})
      const n = sent.length
      return queued.shift() ?? { hits: [{ code: `c${n}`, name: `hit ${n}` }] }
    }
    return {}
  })
}))

import { useActivitySearch } from '../lib/search'
import SearchFilters from './SearchFilters'

const errors: (string | null)[] = []

function Harness({ dbs = ['ecoinvent-3.12-cutoff'] }: { dbs?: string[] }): JSX.Element {
  const s = useActivitySearch(dbs, (e) => errors.push(e))
  return (
    <>
      <input
        aria-label="query"
        value={s.query}
        onChange={(e) => s.setQuery(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && s.doSearch()}
      />
      <SearchFilters s={s} />
      <ul aria-label="hits">
        {s.hits.map((h) => (
          <li key={h.code}>{h.name}</li>
        ))}
      </ul>
      <ul aria-label="notes">
        {s.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </>
  )
}

function search(text: string): void {
  const box = screen.getByRole('textbox', { name: 'query' })
  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key: 'Enter' })
}

function openUnits(): HTMLElement {
  const box = screen.getByRole('combobox', { name: 'Filter units' })
  act(() => box.focus())
  return box
}

beforeEach(() => {
  sent.length = 0
  queued.length = 0
  errors.length = 0
})

describe('the unit filter', () => {
  it('offers the short form first, the most frequent unit on top, and finds a unit by either form', async () => {
    render(<Harness />)
    const box = openUnits()
    await waitFor(() => expect(screen.getByRole('option', { name: 'kg · kilogram' })).toBeTruthy())
    const listed = screen.getAllByRole('option').map((b) => b.textContent)
    expect(listed).toEqual(['kg · kilogram', 'kWh · kilowatt hour', 'unit'])

    fireEvent.change(box, { target: { value: 'kw' } })
    expect(screen.getByRole('option', { name: 'kWh · kilowatt hour' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'kg · kilogram' })).toBeNull()
  })

  it('narrows the last search at once and sends the unit as the index writes it', async () => {
    render(<Harness />)
    search('steel')
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].units).toBeUndefined()

    openUnits()
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'kg · kilogram' }))
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]).toMatchObject({ query: 'steel', units: ['kilogram'] })
    expect(screen.getByText('Only datasets in kg — others are hidden.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Remove kg' }))
    await waitFor(() => expect(sent).toHaveLength(3))
    expect(sent[2].units).toBeUndefined()
  })

  it('says when a chosen unit is in none of the searched databases', async () => {
    queued.push(
      Promise.resolve({ hits: [] }),
      Promise.resolve({ hits: [], units_not_in_databases: ['cubic meter'] })
    )
    render(<Harness />)
    search('water')
    await waitFor(() => expect(sent).toHaveLength(1))
    openUnits()
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'unit' }))
    await waitFor(() =>
      expect(screen.getByText('No dataset in the searched databases is in m³.')).toBeTruthy()
    )
  })
})

describe('filters act at once', () => {
  it('a type chip repeats the last search with it', async () => {
    render(<Harness />)
    search('electricity')
    await waitFor(() => expect(sent).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Market' }))
    await waitFor(() => expect(sent).toHaveLength(2))
    expect(sent[1]).toMatchObject({ query: 'electricity', activity_types: ['M'] })
  })

  it('before the first search a filter only waits', async () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Market' }))
    await act(async () => {})
    expect(sent).toHaveLength(0)
  })

  it('a late answer never replaces the newer one', async () => {
    let answerFirst: (a: Answer) => void = () => {}
    queued.push(new Promise<Answer>((resolve) => (answerFirst = resolve)))
    render(<Harness />)
    search('steel')
    await waitFor(() => expect(sent).toHaveLength(1))
    // The first search is still out; the filter change searches again and is answered first.
    fireEvent.click(screen.getByRole('button', { name: 'Market' }))
    await waitFor(() => expect(screen.getByText('hit 2')).toBeTruthy())
    await act(async () => answerFirst({ hits: [{ code: 'old', name: 'first answer' }] }))
    expect(screen.queryByText('first answer')).toBeNull()
    expect(screen.getByText('hit 2')).toBeTruthy()
  })
})

describe('what a filter change leaves on screen', () => {
  it('a repeat that fails takes the old hits away and says why', async () => {
    render(<Harness />)
    search('steel')
    await waitFor(() => expect(screen.getByText('hit 1')).toBeTruthy())
    queued.push(new Promise<Answer>((_, reject) => setTimeout(() => reject(new Error('index is gone')), 0)))
    fireEvent.click(screen.getByRole('button', { name: 'Market' }))
    await waitFor(() => expect(errors).toContain('index is gone'))
    expect(screen.queryByText('hit 1')).toBeNull()
  })

  it('a filter changed with no database ticked clears the list instead of searching', async () => {
    const { rerender } = render(<Harness />)
    search('steel')
    await waitFor(() => expect(screen.getByText('hit 1')).toBeTruthy())
    rerender(<Harness dbs={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Market' }))
    await act(async () => {})
    expect(sent).toHaveLength(1)
    expect(screen.queryByText('hit 1')).toBeNull()
  })

  it('a panel taken down mid-search reports nothing afterwards', async () => {
    let fail: (e: Error) => void = () => {}
    queued.push(new Promise<Answer>((_, reject) => (fail = reject)))
    const { unmount } = render(<Harness />)
    search('steel')
    await waitFor(() => expect(sent).toHaveLength(1))
    unmount()
    await act(async () => fail(new Error('from the old workspace')))
    expect(errors).not.toContain('from the old workspace')
  })
})
