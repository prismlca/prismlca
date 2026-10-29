import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import AuditLog from './AuditLog'
import { isAttributed, type AuditEntry } from '../lib/api'

/**
 * The half of the model-scoped history that lives in the browser: which entries are shown as this
 * model's, and which are set aside.
 *
 * What can silently break here is the *mixing*. The backend answers a model-scoped request with that
 * model's entries **plus** the ones that name no model — 1107 of 1268 lines in the development log,
 * written before the field existed. Rendering them in one list would put `Set parameter 'tube_mass'
 * = 0.4` in a model that may never have had a `tube_mass`, which is exactly the confusion the field
 * was added to end and would look perfectly fine on a screenshot.
 */
const entry = (index: number, over: Partial<AuditEntry> = {}): AuditEntry => ({
  index,
  timestamp: '2026-08-24T10:00:00+00:00',
  source: 'user',
  action: 'set_parameter',
  summary: `Set parameter 'p${index}' = ${index}`,
  undoable: true,
  ...over
})

describe('the audit log of one model', () => {
  const own = [entry(10, { database: 'Shampoo' }), entry(11, { database: 'Shampoo' })]
  const earlier = [entry(1), entry(2), entry(3)]

  it('keeps the unattributed history out of the model list, behind a collapsed block', () => {
    // The fixture has to be the two kinds, or the assertions below are about nothing.
    expect(own.every(isAttributed)).toBe(true)
    expect(earlier.some(isAttributed)).toBe(false)

    const { container } = render(<AuditLog entries={[...earlier, ...own]} />)
    const lists = container.querySelectorAll('.audit-list')
    expect(lists).toHaveLength(1) // collapsed: only the model's own list is rendered
    expect(lists[0].querySelectorAll('.aud')).toHaveLength(2)
    expect(lists[0].textContent).toContain("Set parameter 'p11'")
    expect(lists[0].textContent).not.toContain("Set parameter 'p1'")

    const toggle = screen.getByRole('button', { name: /earlier history/i })
    expect(toggle.textContent).toContain('not attributable to a model')
    expect(toggle.textContent).toContain('3')

    fireEvent.click(toggle)
    const expanded = container.querySelectorAll('.audit-list')
    expect(expanded).toHaveLength(2)
    expect(expanded[1].querySelectorAll('.aud')).toHaveLength(3)
  })

  it('says what Undo does on this model', () => {
    // Undo is scoped to the model now — but only as a guard on the newest step
    // of the one workspace stack, so the list has to say that a newer change elsewhere comes first.
    render(<AuditLog entries={own} />)
    const note = document.querySelector('.audit-note')
    expect(note?.textContent).toMatch(/Undo takes back only these/i)
    expect(note?.textContent).toMatch(/past other models’ newer edits/i)
    expect(note?.textContent).toMatch(/holds Undo here/i)
    expect(note?.textContent).toMatch(/editing the value directly/i)
    expect(note?.textContent).toMatch(/this session/i)
  })

  it('shows no block when there is no unattributed history', () => {
    render(<AuditLog entries={own} />)
    expect(screen.queryByRole('button', { name: /earlier history/i })).toBeNull()
  })

  it('distinguishes an empty log from a model with no history of its own', () => {
    const { container, unmount } = render(<AuditLog entries={[]} />)
    expect(container.textContent).toContain('No actions recorded yet')
    unmount()
    // Only pre-field entries: the model itself has nothing, and that is a different sentence.
    render(<AuditLog entries={earlier} />)
    expect(screen.getByText(/No entry names this model\. Entries name their model since/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /earlier history/i })).toBeTruthy()
  })

  it('says that a model is gone rather than letting its entries go missing', () => {
    // The history outlives the model — that is what append-only is for. A line pointing at a
    // name that means nothing any more is worse than no line, so the backend resolves it and this
    // renders it. The fixture has to be a resolved pair, or the assertions below are about nothing.
    const gone = entry(30, { database: 'Deleted model', model_gone: true })
    const renamed = entry(31, { database: 'Werke', current_name: 'Works' })
    expect(isAttributed(gone) && isAttributed(renamed)).toBe(true)

    render(<AuditLog entries={[gone, renamed, entry(32, { database: 'Works' })]} />)
    expect(screen.getByText('model no longer exists').getAttribute('title')).toContain('Deleted model')
    expect(screen.getByText('now Works').getAttribute('title')).toContain('renamed')
    // The line already carrying today's name says nothing extra — three entries, two markers.
    expect(document.querySelectorAll('.aud').length).toBe(3)
    expect(screen.queryAllByText(/no longer exists|now Works/)).toHaveLength(2)
  })

  it('points a copied model at the model it came from', () => {
    // A duplicate starts with one line and looks like it came from nothing. The backend marks
    // the single entry that created it, so this needs no knowledge of which model it is showing.
    render(
      <AuditLog
        entries={[
          entry(40, {
            database: 'Copy',
            related: 'Source',
            copied_from: 'Source',
            action: 'duplicate_model',
            summary: "Duplicate model 'Source' → 'Copy'"
          }),
          entry(41, { database: 'Copy' })
        ]}
      />
    )
    const origin = document.querySelector('.audit-origin')
    expect(origin?.textContent).toMatch(/Copied from\s*Source/)
    expect(origin?.textContent).toMatch(/see its history/i)
  })

  it('shows no provenance line for a model that came from nowhere', () => {
    render(<AuditLog entries={own} />)
    expect(document.querySelector('.audit-origin')).toBeNull()
  })

  it('marks where a change came from and which actions were workspace-wide', () => {
    render(
      <AuditLog
        entries={[
          entry(20, { database: 'Dst', related: 'Src', action: 'copy_to_foreground' }),
          entry(21, { databases: ['Dst', 'Other'], action: 'delete_tag_group' })
        ]}
      />
    )
    expect(screen.getByText('from Src')).toBeTruthy()
    expect(screen.getByText('workspace-wide').getAttribute('title')).toContain('Dst, Other')
  })
})

/**
 * Consecutive entries written under one assistant turn render as one dashed group with a
 * header naming the count — grouped on the WRITTEN `turn` field only, never on source+time
 * proximity (that guess is a known family of bug). A user change between two turns splits them.
 */
describe('assistant-turn grouping', () => {
  it('boxes a contiguous turn, splits on foreign entries, leaves a one-entry turn bare', () => {
    const entries = [
      entry(20, { database: 'Shampoo', source: 'ai', turn: 'turn-a' }),
      entry(21, { database: 'Shampoo', source: 'ai', turn: 'turn-a' }),
      entry(22, { database: 'Shampoo' }), // the user, mid-session — no group
      entry(23, { database: 'Shampoo', source: 'ai', turn: 'turn-b' })
    ]
    const { container } = render(<AuditLog entries={entries} />)
    const groups = container.querySelectorAll('.aud-turn')
    // turn-a gets a box (2 entries). turn-b is a single entry and gets none: a box around one row
    // groups nothing, and the row already names the assistant as its source.
    expect(groups).toHaveLength(1)
    expect(groups[0].querySelectorAll('.aud')).toHaveLength(2)
    expect(groups[0].textContent).toContain('assistant turn · 2 changes')
    // The user's entry and turn-b's single entry sit bare in the list.
    const list = container.querySelector('.audit-list')!
    expect(list.querySelectorAll(':scope > .aud')).toHaveLength(2)
  })

  it('does not group entries that merely share a source without a turn', () => {
    const entries = [
      entry(30, { database: 'Shampoo', source: 'ai' }),
      entry(31, { database: 'Shampoo', source: 'ai' })
    ]
    const { container } = render(<AuditLog entries={entries} />)
    expect(container.querySelectorAll('.aud-turn')).toHaveLength(0)
  })
})

/**
 * A workspace-wide action (a tag group, a tag) names no model because it changes none. Every view of
 * the log is model-scoped, so it stands in every model's list — in its place, marked —
 * and not in the "earlier history" block, whose label would be wrong for it.
 */
describe('workspace-wide entries', () => {
  it('stand in the list, marked, not in the earlier history', () => {
    const entries = [
      entry(40, { database: 'Shampoo' }),
      entry(41, { action: 'create_tag_group', summary: "Create tag group 'Phase'", workspace: true }),
      entry(42, { database: 'Shampoo' })
    ]
    const { container } = render(<AuditLog entries={entries} />)
    const list = container.querySelector('.audit-list')!
    expect(list.textContent).toContain("Create tag group 'Phase'")
    expect(list.textContent).toContain('workspace-wide')
    expect(screen.queryByRole('button', { name: /earlier history/i })).toBeNull()
  })
})
