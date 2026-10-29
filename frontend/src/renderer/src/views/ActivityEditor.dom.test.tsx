import { describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import ActivityEditor from './ActivityEditor'
import { renderWithPrism, type RenderWithPrism } from '../test/render'

/**
 * The inspector's first line names where a dataset comes from.
 *
 * The read-only flag alone cannot: My processes is writable, so a library dataset looked exactly
 * like a model's own process. The Workbench now hands the database's kind down, and the eyebrow
 * carries the same chip the search results use — purple for the library, navy with the short
 * label for a background — beside a single word: Background (with the padlock) or Process. The
 * padlock already says read-only, so the word does not repeat it.
 */
const activity = (database: string, read_only: boolean): object => ({
  activity: {
    database,
    code: 'c1',
    name: 'tap water',
    product: 'water',
    location: 'CH',
    unit: 'kg',
    read_only
  },
  exchanges: []
})

const mount = (database: string, read_only: boolean, kind?: string): void => {
  renderWithPrism(<ActivityEditor database={database} code="c1" kind={kind} onChanged={() => {}} />, {
    routes: { 'GET /api/v1/model/activities/:db/:code': activity(database, read_only) }
  })
}

describe('ActivityEditor → source of the dataset', () => {
  it('names the background database in short form, full name in the tooltip', async () => {
    mount('ecoinvent-3.12-cutoff', true, 'background')
    const chip = await screen.findByText('ecoinvent 3.12')
    expect(chip.className).toBe('chip bg')
    expect(chip.title).toBe('ecoinvent-3.12-cutoff')
    expect(chip.closest('.eyebrow')?.textContent?.trim()).toBe('Backgroundecoinvent 3.12')
  })

  it('shows My processes on a library dataset, although it is editable', async () => {
    mount('My processes', false, 'library')
    const chip = await screen.findByText('My processes')
    expect(chip.className).toBe('chip lib')
    expect(chip.closest('.eyebrow')?.textContent).toBe('ProcessMy processes')
  })

  it('leaves a model’s own process without a chip', async () => {
    mount('my model', false, 'foreground')
    await screen.findByText('Process')
    expect(document.querySelector('.eyebrow .chip')).toBeNull()
  })

  it('falls back to the read-only flag when no kind is known', async () => {
    mount('bafu-2026-v1', true)
    // BAFU wears the purple variant so it differs from ecoinvent's navy at a glance.
    expect((await screen.findByText('BAFU 2026')).className).toBe('chip bg bafu')
  })
})

/**
 * The reference product as one block: what the process makes, how much, in which unit. Its production
 * exchange points at the process itself, so the flow name the API sends is the PROCESS name — the row
 * once said "tap water" (the process) where it meant "water" (the product).
 */
const production = (amount: number, database = 'my model') => ({
  uid: 'p',
  type: 'production',
  direction: 'output',
  amount,
  formula: null,
  comment: null,
  input: { database, code: 'c1', name: 'tap water', unit: 'kg', location: 'CH' }
})
const mountBlock = (opts: { amount?: number; readOnly?: boolean } = {}): RenderWithPrism => {
  const db = opts.readOnly ? 'ecoinvent-3.12-cutoff' : 'my model'
  return renderWithPrism(
    <ActivityEditor
      database={db}
      code="c1"
      kind={opts.readOnly ? 'background' : 'foreground'}
      onChanged={() => {}}
    />,
    {
      routes: {
        'GET /api/v1/model/activities/:db/:code': {
          ...activity(db, !!opts.readOnly),
          exchanges: [production(opts.amount ?? 1, db)]
        },
        'POST /api/v1/model/activities/fields': {}
      }
    }
  )
}
const field = (name: string): HTMLInputElement =>
  document.querySelector(`.refblock input[aria-label="${name}"]`) as HTMLInputElement

describe('ActivityEditor → reference product block', () => {
  it('holds product, amount and unit together, and nowhere else', async () => {
    mountBlock()
    await screen.findByText('Every input and output below is per this amount.')
    expect(field('Reference product').value).toBe('water')
    expect(field('Unit').value).toBe('kg')
    expect((document.querySelector('.refblock .flow-amt input') as HTMLInputElement).value).toBe('1')
    // The old places are gone: no product field at the top, no unit beside the location.
    const labels = [...document.querySelectorAll('.efield > label')].map((l) => l.textContent)
    expect(labels).not.toContain('Reference product')
    expect(labels).not.toContain('Unit')
    expect(screen.queryByText('Treatment')).toBeNull()
  })

  it('writes a renamed product as the process’s field', async () => {
    const { prism } = mountBlock()
    await screen.findByText('Every input and output below is per this amount.')
    fireEvent.change(field('Reference product'), { target: { value: 'drinking water' } })
    fireEvent.blur(field('Reference product'))
    await waitFor(() =>
      expect(prism.calls.find((c) => c.path === '/api/v1/model/activities/fields')?.body).toEqual({
        database: 'my model',
        code: 'c1',
        product: 'drinking water'
      })
    )
  })

  it('marks a negative reference amount as a treatment', async () => {
    mountBlock({ amount: -1 })
    expect((await screen.findByText('Treatment')).className).toBe('ref-badge')
    expect(screen.getByText(/A treatment: processes that send it their waste/)).toBeTruthy()
  })

  it('leaves a production exchange of a separate product node a row with its own name', async () => {
    renderWithPrism(<ActivityEditor database="my model" code="c1" kind="foreground" onChanged={() => {}} />, {
      routes: {
        'GET /api/v1/model/activities/:db/:code': {
          ...activity('my model', false),
          exchanges: [
            {
              ...production(3),
              input: {
                database: 'my model',
                code: 'heat',
                name: 'heat, district',
                unit: 'MJ',
                location: 'CH'
              }
            }
          ]
        }
      }
    })
    await screen.findByText('No production exchange of its own — its outputs are listed below.')
    // Not labelled "water" in "kg": the row keeps the node's own name and unit, and the block has no amount.
    expect(document.querySelector('.flow.ref .flow-name-text')?.textContent).toBe('heat, district')
    expect(document.querySelector('.refblock .flow-amt')).toBeNull()
    expect(field('Reference product').value).toBe('water')
  })

  it('keeps product and unit of a read-only dataset without a production exchange', async () => {
    renderWithPrism(
      <ActivityEditor database="ecoinvent-3.12-cutoff" code="c1" kind="background" onChanged={() => {}} />,
      { routes: { 'GET /api/v1/model/activities/:db/:code': activity('ecoinvent-3.12-cutoff', true) } }
    )
    await screen.findByText('No production exchange.')
    expect(document.querySelector('.refblock.ro .ref-name')?.textContent).toBe('water')
    expect(document.querySelector('.refblock.ro .flow-unit')?.textContent).toBe('kg')
  })

  it('shows a background dataset’s product on one read-only line', async () => {
    mountBlock({ readOnly: true })
    await screen.findByText('ecoinvent 3.12')
    expect(document.querySelector('.refblock.ro .ref-name')?.textContent).toBe('water')
    expect(document.querySelector('.refblock input')).toBeNull()
  })
})

/**
 * A new unit keeps the number of every exchange consuming the process and changes what it means. The
 * backend warns when there are consumers; the inspector used to drop that answer on the floor.
 */
describe('ActivityEditor → unit change', () => {
  const warning = "Unit changed from 'kg' to 't': 2 consuming exchange amount(s) keep their numbers"

  const mountUnit = (reply: object): RenderWithPrism => {
    let unit = 'kg'
    return renderWithPrism(
      <ActivityEditor database="my model" code="c1" kind="foreground" onChanged={() => {}} />,
      {
        routes: {
          'GET /api/v1/model/activities/:db/:code': () => {
            const d = activity('my model', false) as { activity: object }
            return { ...d, activity: { ...d.activity, unit }, exchanges: [production(1)] }
          },
          'POST /api/v1/model/activities/fields': (body: unknown) => {
            unit = (body as { unit: string }).unit
            return reply
          }
        }
      }
    )
  }
  const unitInput = async (): Promise<HTMLInputElement> => {
    await screen.findByText('Every input and output below is per this amount.')
    return field('Unit')
  }

  it('shows the backend’s warning under the unit', async () => {
    mountUnit({ warning })
    const input = await unitInput()
    fireEvent.change(input, { target: { value: 't' } })
    fireEvent.blur(input)
    const note = await screen.findByText(warning)
    expect(note.className).toContain('warn')
    expect(note.closest('.refblock')).not.toBeNull()
  })

  it('stays quiet when nothing consumes the process', async () => {
    const { prism } = mountUnit({})
    const input = await unitInput()
    fireEvent.change(input, { target: { value: 't' } })
    fireEvent.blur(input)
    // The write, then the reload it triggers: only after both is "no warning" an answer.
    const reads = (): number =>
      prism.calls.filter((c) => c.method === 'GET' && c.path.includes('/activities/')).length
    await waitFor(() => expect(reads()).toBe(2))
    expect(document.querySelector('.settings-hint.warn')).toBeNull()
  })
})
