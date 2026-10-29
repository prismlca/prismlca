import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

/**
 * The composer's per-chat state as a hook: loaded from `chatPrefs` whenever the shown chat changes,
 * written back under the chat it was changed in, and one reload skipped when the first send has just
 * created the chat (`adopt`). The store is module state, so each test gets a fresh module.
 */
type Hook = typeof import('./useChatPrefs')
type Store = typeof import('./chatPrefs')
let useChatPrefs: Hook['useChatPrefs']
let store: Store

beforeEach(async () => {
  vi.resetModules()
  store = await import('./chatPrefs')
  useChatPrefs = (await import('./useChatPrefs')).useChatPrefs
})

const rig = (chatId: string | null = null, comparedWith: string[] = ['x']) =>
  renderHook(
    ({ id, db = 'm' }: { id: string | null; db?: string | null }) =>
      useChatPrefs(id, {
        activeDb: db,
        comparedWith,
        backgroundDbs: ['ei', 'agb'],
        secondaryBackgroundDbs: ['agb']
      }),
    { initialProps: { id: chatId } as { id: string | null; db?: string | null } }
  )

describe('useChatPrefs', () => {
  it('reloads switches and draft from the store when the chat changes', () => {
    store.writeToggle('c2', 'webSearch', false)
    store.writeToggle('c2', 'releasedBackgrounds', { agb: true })
    store.writeDraft('c2', 'hi')
    const { result, rerender } = rig('c1')
    expect(result.current.webSearch).toBe(true)
    expect(result.current.searchedBackgrounds).toEqual(['ei'])
    expect(result.current.withheldBackgrounds).toEqual(['agb'])
    expect(result.current.input).toBe('')

    rerender({ id: 'c2' })
    expect(result.current.webSearch).toBe(false)
    expect(result.current.searchedBackgrounds).toEqual(['ei', 'agb'])
    expect(result.current.input).toBe('hi')
  })

  it('writes every change under the chat it was made in', () => {
    const { result } = rig('c1')
    act(() => result.current.setWebSearch((v) => !v))
    act(() => result.current.setComparisonOn('x', false))
    act(() => result.current.toggleBackground('agb'))
    act(() => result.current.typeInput('draft'))
    expect(result.current.comparisonOn).toEqual([])
    expect(store.readToggles('c1')).toMatchObject({
      webSearch: false,
      comparisonOff: ['x'],
      releasedBackgrounds: { agb: true }
    })
    expect(store.readDraft('c1')).toBe('draft')
    expect(store.readToggles(store.newChatKey('m')).webSearch).toBe(true)
  })

  it('keeps what is on screen for the adopted chat, and reloads it after a switch away and back', () => {
    const { result, rerender } = rig(null)
    act(() => result.current.setWebSearch(false))
    act(() => result.current.typeInput('draft'))

    act(() => result.current.adopt('c1', 'm'))
    // The placeholder's toggles and draft were carried over, and the placeholder emptied.
    expect(store.readToggles('c1').webSearch).toBe(false)
    expect(store.readDraft('c1')).toBe('draft')
    expect(store.readToggles(store.newChatKey('m')).webSearch).toBe(true)
    expect(store.readDraft(store.newChatKey('m'))).toBe('')
    // One key: a flip and a keystroke between adopt and the next render both land
    // under the new id (the draft used to stay under the placeholder). One act, so no render comes in
    // between — in the app, `send` sets the chat id right after `adopt`, and the next render shows it.
    act(() => {
      result.current.setUseLibrary(true)
      result.current.typeInput((v) => `${v} more`)
    })
    expect(store.readToggles('c1').useLibrary).toBe(true)
    expect(store.readDraft('c1')).toBe('draft more')
    expect(store.readToggles(store.newChatKey('m')).useLibrary).toBe(false)
    expect(store.readDraft(store.newChatKey('m'))).toBe('')

    rerender({ id: 'c1' })
    // The one reload for the adopted id is skipped: the box and the switches stay as they are.
    expect(result.current.input).toBe('draft more')
    expect(result.current.webSearch).toBe(false)
    expect(result.current.useLibrary).toBe(true)

    rerender({ id: 'c2' })
    expect(result.current.webSearch).toBe(true)
    expect(result.current.input).toBe('')
    rerender({ id: 'c1' })
    expect(result.current.webSearch).toBe(false)
    expect(result.current.useLibrary).toBe(true)
    expect(result.current.input).toBe('draft more')
  })

  it("adopt carries the sending model's placeholder and leaves the one on screen alone", () => {
    // The first send started on m; the panel has meanwhile switched to n.
    const { result, rerender } = rig(null)
    act(() => result.current.setWebSearch(false))
    rerender({ id: null, db: 'n' })
    act(() => result.current.setUseLibrary(true))
    act(() => result.current.typeInput('on n'))

    act(() => {
      result.current.adopt('c1', 'm')
      // Still under n's placeholder: the panel did not change what it shows.
      result.current.typeInput((v) => `${v}!`)
    })
    expect(store.readToggles('c1')).toMatchObject({ webSearch: false, useLibrary: false })
    expect(store.readDraft('c1')).toBe('')
    expect(store.readToggles(store.newChatKey('m')).webSearch).toBe(true)
    expect(store.readToggles(store.newChatKey('n'))).toMatchObject({ webSearch: true, useLibrary: true })
    expect(store.readDraft(store.newChatKey('n'))).toBe('on n!')
    expect(result.current.useLibrary).toBe(true)
  })

  it('keeps the not-yet-created chat per model: a model switch without a chat reloads', () => {
    const { result, rerender } = rig(null)
    act(() => result.current.setWebSearch(false))
    act(() => result.current.typeInput('on m'))
    rerender({ id: null, db: 'n' })
    expect(result.current.webSearch).toBe(true)
    expect(result.current.input).toBe('')
    rerender({ id: null, db: 'm' })
    expect(result.current.webSearch).toBe(false)
    expect(result.current.input).toBe('on m')
  })

  it('deletes an emptied draft, so the box reads empty after it', () => {
    const { result, rerender } = rig('c1')
    act(() => result.current.typeInput('x'))
    act(() => result.current.typeInput((v) => `${v}y`))
    expect(store.readDraft('c1')).toBe('xy')
    act(() => result.current.typeInput(''))
    expect(store.readDraft('c1')).toBe('')
    rerender({ id: 'c2' })
    rerender({ id: 'c1' })
    expect(result.current.input).toBe('')
  })

  it('keeps typeInput and adopt stable across renders and chat switches', () => {
    const { result, rerender } = rig('c1')
    const { typeInput, adopt } = result.current
    act(() => result.current.setWebSearch(false))
    rerender({ id: 'c2' })
    rerender({ id: null })
    expect(result.current.typeInput).toBe(typeInput)
    expect(result.current.adopt).toBe(adopt)
  })
})
