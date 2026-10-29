import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The composer's per-chat store, on its own. The maps are module state, so every test gets a fresh
 * module (the component tests in CanvasChat.composer.dom.test.tsx do the same).
 */
type Prefs = typeof import('./chatPrefs')
let p: Prefs

beforeEach(async () => {
  vi.resetModules()
  p = await import('./chatPrefs')
})

describe('chatPrefs', () => {
  it('reads the defaults for a chat that never touched a switch', () => {
    expect(p.readToggles('c1')).toEqual({
      webSearch: true,
      distancesOn: true,
      eurostatOn: true,
      useLibrary: false,
      comparisonOff: [],
      releasedBackgrounds: {}
    })
    expect(p.readDraft('c1')).toBe('')
  })

  it('keeps each switch per chat and per field', () => {
    p.writeToggle('c1', 'webSearch', false)
    p.writeToggle('c1', 'releasedBackgrounds', { agb: true })
    expect(p.readToggles('c1')).toMatchObject({
      webSearch: false,
      distancesOn: true,
      releasedBackgrounds: { agb: true }
    })
    expect(p.readToggles('c2').webSearch).toBe(true)
  })

  it('carries only the fields the placeholder holds, the draft included, and empties it', () => {
    p.writeToggle('c1', 'distancesOn', false)
    p.writeToggle(p.newChatKey('m'), 'webSearch', false)
    p.writeToggle(p.newChatKey('m'), 'comparisonOff', ['x'])
    p.writeDraft(p.newChatKey('m'), 'unsent')

    p.carryNewChat('m', 'c1')
    expect(p.readToggles('c1')).toEqual({
      webSearch: false,
      // Not held by the placeholder, so c1's own choice survives the carry-over.
      distancesOn: false,
      eurostatOn: true,
      useLibrary: false,
      comparisonOff: ['x'],
      releasedBackgrounds: {}
    })
    // The placeholder is emptied (29.09.2026): the next new chat starts at the defaults. The draft
    // moves with the toggles — it is what was typed while the first send created the chat.
    expect(p.readToggles(p.newChatKey('m'))).toEqual(p.readToggles('never-touched'))
    expect(p.readDraft('c1')).toBe('unsent')
    expect(p.readDraft(p.newChatKey('m'))).toBe('')
  })

  it("keeps the not-yet-created chat per model, and carries only the sending model's", () => {
    p.writeToggle(p.newChatKey('m'), 'webSearch', false)
    p.writeToggle(p.newChatKey('n'), 'useLibrary', true)
    expect(p.readToggles(p.newChatKey('n')).webSearch).toBe(true)
    expect(p.readToggles(p.newChatKey(null)).useLibrary).toBe(false)

    p.carryNewChat('n', 'c1')
    expect(p.readToggles('c1')).toMatchObject({ webSearch: true, useLibrary: true })
    expect(p.readToggles(p.newChatKey('m')).webSearch).toBe(false)
  })

  it('forgets a draft that was emptied', () => {
    // Deleting and storing '' read the same through this API; what matters is that an emptied box
    // reads as empty, and that the key can be written again afterwards.
    p.writeDraft('c1', 'half')
    p.writeDraft('c1', '')
    expect(p.readDraft('c1')).toBe('')
    p.writeDraft('c1', 'again')
    expect(p.readDraft('c1')).toBe('again')
  })
})
