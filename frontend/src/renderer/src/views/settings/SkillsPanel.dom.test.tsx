/**
 * The skill viewer renders a skill's Markdown with the same URL filter as the chat: URLs that name a
 * host without a scheme are dropped, local images and web links stay.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Skill } from '../../lib/ai'

const SKILL: Skill = {
  id: 's1',
  name: 'Shared skill',
  description: 'From a colleague',
  content: [
    '# Steps',
    '',
    '![slashes](//host.example/img/x.png) ![mixed](/\\\\host.example/img/y.png)',
    '![local](images/flow.png) [web](https://example.org/guide) [other](//host.example/img/)'
  ].join('\n'),
  enabled: true
}

vi.mock('../../lib/ai', async (actual) => ({
  ...(await actual<typeof import('../../lib/ai')>()),
  listSkills: vi.fn(async () => ({ skills: [SKILL] }))
}))

const { SkillsPanel } = await import('./SkillsPanel')

describe('the skill viewer', () => {
  it('drops a host without a scheme from images and links, and keeps local images and web links', async () => {
    render(<SkillsPanel />)
    await userEvent.click(await screen.findByRole('button', { name: /Shared skill/ }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Steps' })).toBeInTheDocument())
    const view = document.querySelector('.skill-md')!
    expect(view.querySelector('img[alt="slashes"]')?.getAttribute('src') ?? '').toBe('')
    expect(view.querySelector('img[alt="mixed"]')?.getAttribute('src') ?? '').toBe('')
    expect(screen.getByText('other').getAttribute('href') ?? '').toBe('')
    expect(view.innerHTML).not.toContain('host.example')
    expect(view.querySelector('img[alt="local"]')?.getAttribute('src')).toBe('images/flow.png')
    expect(screen.getByRole('link', { name: 'web' })).toHaveAttribute('href', 'https://example.org/guide')
  })
})
