import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import SearchedAs from './SearchedAs'

/**
 * The line that says what the search added to the query ("PET" → polyethylene terephthalate) and offers
 * the search exactly as typed instead — for that one search.
 */
describe('SearchedAs', () => {
  it('says what was also searched and repeats the search literally on request', () => {
    const onLiteral = vi.fn()
    render(
      <SearchedAs
        alsoSearchedAs="polyethylene terephthalate"
        searchedLiterally={null}
        sentQuery="PET"
        onLiteral={onLiteral}
      />
    )
    expect(screen.getByText('polyethylene terephthalate')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Search only for “PET”' }))
    expect(onLiteral).toHaveBeenCalledTimes(1)
  })

  it('says that the last search took the text as typed', () => {
    const { container } = render(
      <SearchedAs alsoSearchedAs={null} searchedLiterally="PET" sentQuery="PET" onLiteral={() => {}} />
    )
    expect(container.textContent).toBe('Searched only for “PET”, as typed.')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says nothing when the search added nothing', () => {
    const { container } = render(
      <SearchedAs alsoSearchedAs={null} searchedLiterally={null} sentQuery="steel" onLiteral={() => {}} />
    )
    expect(container.textContent).toBe('')
  })
})
