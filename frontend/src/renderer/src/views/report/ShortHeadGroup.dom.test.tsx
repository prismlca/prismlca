// @vitest-environment jsdom
/**
 * The short report's "Title & language": the reference process stands in as long as no title is set, and
 * title, subtitle and language each write their own field.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ShortHeadGroup, { NO_SHORT_HEAD } from './ShortHeadGroup'

describe('the short report title', () => {
  it('shows the reference process until a title of its own is set, and writes each field', () => {
    const onHead = vi.fn()
    const onLang = vi.fn()
    const { rerender } = render(
      <ShortHeadGroup
        head={NO_SHORT_HEAD}
        onHead={onHead}
        lang="en"
        onLang={onLang}
        refName="Glass bottle, 0.75 l"
        grp={{ open: false, onToggle: () => {} }}
      />
    )
    // Shut, the summary says what the cover will print.
    expect(screen.getByText('Glass bottle, 0.75 l · English')).toBeTruthy()

    rerender(
      <ShortHeadGroup
        head={NO_SHORT_HEAD}
        onHead={onHead}
        lang="en"
        onLang={onLang}
        refName="Glass bottle, 0.75 l"
        grp={{ open: true, onToggle: () => {} }}
      />
    )
    const title = screen.getByLabelText('Report title') as HTMLInputElement
    expect(title.placeholder).toBe('Glass bottle, 0.75 l')
    fireEvent.change(title, { target: { value: 'Glass or PET?' } })
    expect(onHead).toHaveBeenLastCalledWith({ title: 'Glass or PET?', subtitle: '' })
    fireEvent.change(screen.getByLabelText('Report subtitle'), { target: { value: 'A first look' } })
    expect(onHead).toHaveBeenLastCalledWith({ title: '', subtitle: 'A first look' })
    fireEvent.change(screen.getByLabelText('Report language'), { target: { value: 'de' } })
    expect(onLang).toHaveBeenCalledWith('de')
  })
})
