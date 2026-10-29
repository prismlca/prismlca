import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { makePrism } from '../test/prism'
import { useMcpUiTools, type McpUiToolsDeps } from './useMcpUiTools'

/**
 * `canvas_view open_model` as an external agent reaches it. The React copy of the database list is
 * refreshed after every mutation without being waited for, so a model `manage_model create` made
 * one call earlier is not in it yet — the open used to answer "No model … in this workspace" four
 * times out of four with an MCP client.
 */
function setup(databases: McpUiToolsDeps['databases'], fresh: McpUiToolsDeps['databases']) {
  const results: Array<{ ok: boolean; result: unknown }> = []
  const fixture = makePrism(
    {},
    { ai: { uiResult: (_id: string, ok: boolean, result: unknown) => results.push({ ok, result }) } }
  )
  ;(window as unknown as { prism: unknown }).prism = fixture.prism
  const openModel = vi.fn()
  const refreshDatabases = vi.fn(async () => fresh)
  renderHook(() =>
    useMcpUiTools({
      activeDb: 'old',
      databases,
      view: 'overview',
      setView: () => {},
      openModel,
      refreshDatabases,
      selected: [],
      resultsTab: 'overview',
      chatUi: {} as never
    })
  )
  const open = (name: string): void =>
    fixture.emitUiTool({ reqId: 'r1', name: 'open_model', args: { database: name }, sessionId: 's1' })
  return { results, openModel, refreshDatabases, open }
}

const OLD = { name: 'old', kind: 'foreground' }
const NEW = { name: 'QA MCP sofort 1', kind: 'foreground' }

describe('open_model from an external agent', () => {
  it('opens a model the React list has not caught up with yet', async () => {
    const t = setup([OLD], [OLD, NEW])
    t.open(NEW.name)
    await waitFor(() => expect(t.results).toHaveLength(1))
    expect(t.results[0].result).toEqual({ ok: true, active_model: NEW.name, view: 'model' })
    expect(t.openModel).toHaveBeenCalledWith(NEW.name)
  })

  it('does not ask the backend for a model the list already holds', async () => {
    const t = setup([OLD, NEW], [OLD, NEW])
    t.open(NEW.name)
    await waitFor(() => expect(t.results).toHaveLength(1))
    expect(t.refreshDatabases).not.toHaveBeenCalled()
  })

  it('still refuses a name that does not exist, and a background', async () => {
    const t = setup([OLD], [OLD, { name: 'ecoinvent', kind: 'background' }])
    t.open('nope')
    await waitFor(() => expect(t.results).toHaveLength(1))
    expect(t.results[0].result).toEqual({ error: 'No model "nope" in this workspace.' })
    t.open('ecoinvent')
    await waitFor(() => expect(t.results).toHaveLength(2))
    expect(t.results[1].result).toEqual({ error: '"ecoinvent" is a background database, not a model.' })
  })
})
