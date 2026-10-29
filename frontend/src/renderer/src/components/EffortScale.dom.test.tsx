import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { EffortDial, EffortScale } from './EffortScale'

describe('EffortScale', () => {
  it('offers Default plus the documented levels, in order, and reports a tick click', () => {
    const onChange = vi.fn()
    render(
      <EffortScale label="Reasoning effort" levels={['low', 'high', 'xhigh']} value="" onChange={onChange} />
    )
    const slider = screen.getByRole('slider', { name: 'Reasoning effort' }) as HTMLInputElement
    expect(slider.min).toBe('0')
    expect(slider.max).toBe('3')
    expect(slider.value).toBe('0')
    fireEvent.click(screen.getByTitle('High'))
    expect(onChange).toHaveBeenCalledWith('high')
  })

  it('maps the slider position back to a level, and position 0 to Default', () => {
    const onChange = vi.fn()
    render(<EffortScale label="Reasoning effort" levels={['low', 'high']} value="high" onChange={onChange} />)
    const slider = screen.getByRole('slider') as HTMLInputElement
    expect(slider.value).toBe('2')
    fireEvent.change(slider, { target: { value: '1' } })
    expect(onChange).toHaveBeenLastCalledWith('low')
    fireEvent.change(slider, { target: { value: '0' } })
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  it('locks the scale and says why when the model documents no levels', () => {
    render(<EffortScale label="Reasoning effort" levels={[]} value="" onChange={() => {}} />)
    expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByText(/No levels documented/)).toBeInTheDocument()
  })
})

describe('EffortDial', () => {
  it('names every step beside the track, Default at the foot, and maps the slider to the levels', () => {
    const onChange = vi.fn()
    render(
      <EffortDial
        label="Reasoning effort"
        levels={['low', 'medium', 'high']}
        value="medium"
        onChange={onChange}
      />
    )
    const names = Array.from(document.querySelectorAll('.effort-dial-name'))
    expect(names.map((e) => e.textContent)).toEqual(['Default', 'Low', 'Medium', 'High'])
    expect(names.find((e) => e.classList.contains('on'))?.textContent).toBe('Medium')
    const slider = screen.getByRole('slider', { name: 'Reasoning effort' }) as HTMLInputElement
    expect(slider.value).toBe('2')
    fireEvent.change(slider, { target: { value: '3' } })
    expect(onChange).toHaveBeenLastCalledWith('high')
    fireEvent.click(names[0])
    expect(onChange).toHaveBeenLastCalledWith('')
  })
})
