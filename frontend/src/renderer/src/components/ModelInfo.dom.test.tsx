import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ModelInfo from './ModelInfo'
import { saveViewsNow } from '../lib/modelView'
import { fetchQuery } from '../lib/server/useQuery'
import { studyRoute } from '../lib/server/routes'
import { renderWithPrism } from '../test/render'

/**
 * Renaming a model, from the one dialog that is about a single model.
 *
 * Until now the route had exactly one caller — the assistant's tool — so a user could only rename a
 * model by asking the assistant to. The backend half is the careful one (it moves nine model-scoped
 * stores and drops the search index); what is tested here is the half that was missing: the name is
 * text with a pencil behind it, the pencil turns it into a field with a discard and a confirm, and a
 * rename tells its caller (the model list, the model dropdown and `activeDb` all still say the old
 * name), moves the model's own browser state, and shows a refused name instead of swallowing it.
 *
 * Nothing here commits on blur, on purpose: the two buttons are the only commit, and that is what
 * keeps this field out of the Escape-versus-blur race the parameter table had (`paramEdit.dom.test`).
 */
const STUDY = { goal: 'Compare two windows', language: 'de' }
const ROUTES = {
  'GET /api/v1/study': STUDY,
  'POST /api/v1/databases/foreground/rename': {}
}

const startRename = async (user: ReturnType<typeof userEvent.setup>): Promise<HTMLInputElement> => {
  await user.click(await screen.findByRole('button', { name: 'Rename this model' }))
  return (await screen.findByLabelText('Model name')) as HTMLInputElement
}

describe('ModelInfo → rename', () => {
  it('renames from the pencil, hands the new name upward and moves the model’s browser state', async () => {
    const user = userEvent.setup()
    localStorage.setItem('prism.params.shut.Old model', JSON.stringify(['Masses']))
    const onRenamed = vi.fn()
    const { prism } = renderWithPrism(
      <ModelInfo database="Old model" onClose={() => {}} onRenamed={onRenamed} />,
      { routes: ROUTES }
    )

    // The name is text until asked for.
    expect(screen.queryByLabelText('Model name')).toBeNull()
    const field = await startRename(user)
    await user.clear(field)
    await user.type(field, 'New model')
    await user.click(screen.getByRole('button', { name: 'Rename the model' }))

    await waitFor(() =>
      expect(prism.calls).toEqual(
        expect.arrayContaining([
          {
            method: 'POST',
            path: '/api/v1/databases/foreground/rename',
            body: { database: 'Old model', name: 'New model', source: 'user' }
          }
        ])
      )
    )
    expect(onRenamed).toHaveBeenCalledWith('New model')
    // The keys the backend cannot reach — folded parameter groups here — follow the name.
    expect(localStorage.getItem('prism.params.shut.New model')).toBe(JSON.stringify(['Masses']))
    expect(localStorage.getItem('prism.params.shut.Old model')).toBeNull()
    // The rename is not part of the study payload: it must not wait for the dialog to close.
    expect(prism.calls.some((c) => c.path === '/api/v1/study' && c.method === 'POST')).toBe(false)
  })

  it('renames on Enter too', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<ModelInfo database="Old model" onClose={() => {}} />, {
      routes: ROUTES
    })

    const field = await startRename(user)
    await user.clear(field)
    await user.type(field, 'Typed name{Enter}')

    await waitFor(() =>
      expect(prism.calls.find((c) => c.path === '/api/v1/databases/foreground/rename')?.body).toEqual({
        database: 'Old model',
        name: 'Typed name',
        source: 'user'
      })
    )
  })

  it('says why a name was refused and keeps what was typed, so it can be fixed', async () => {
    const user = userEvent.setup()
    const onRenamed = vi.fn()
    renderWithPrism(<ModelInfo database="Old model" onClose={() => {}} onRenamed={onRenamed} />, {
      routes: {
        ...ROUTES,
        'POST /api/v1/databases/foreground/rename': {
          status: 409,
          body: {
            error: {
              message: "Database 'Taken' already exists.",
              hint: 'Choose another name.',
              code: 'database_exists'
            }
          }
        }
      }
    })

    const field = await startRename(user)
    await user.clear(field)
    await user.type(field, 'Taken{Enter}')

    expect(await screen.findByText(/already exists/)).toBeTruthy()
    expect(field.value).toBe('Taken') // still there, one word away from a name that works
    expect(onRenamed).not.toHaveBeenCalled()
  })

  it('writes nothing when the rename is discarded — by ✕, by Escape, or by clicking away', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<ModelInfo database="Old model" onClose={() => {}} />, {
      routes: ROUTES
    })

    let field = await startRename(user)
    await user.clear(field)
    await user.type(field, 'Something else')
    await user.click(screen.getByRole('button', { name: 'Discard the new name' }))
    expect(screen.queryByLabelText('Model name')).toBeNull()

    field = await startRename(user)
    await user.clear(field)
    await user.type(field, 'Something else{Escape}')
    expect(screen.queryByLabelText('Model name')).toBeNull()

    // …and leaving the field open while clicking elsewhere is not a commit either.
    field = await startRename(user)
    await user.clear(field)
    await user.type(field, 'Something else')
    await user.tab()
    expect(prism.calls.filter((c) => c.method === 'POST')).toEqual([])
  })
})

/**
 * Goal & scope saves when the dialog closes, whichever way it closes. It used to
 * have Save and Cancel, and Escape or a click beside the sheet threw the text away without a word —
 * in an app whose tour says there is nothing to save. Only the changed fields go out, so a field the
 * user never touched cannot overwrite what the assistant wrote into it meanwhile.
 */
describe('ModelInfo → saves on close', () => {
  const studyPosts = (calls: { method: string; path: string; body?: unknown }[]): unknown[] =>
    calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/study').map((c) => c.body)

  const editGoal = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
    const goal = (await screen.findByLabelText(/^Goal/)) as HTMLTextAreaElement
    await waitFor(() => expect(goal.value).toBe('Compare two windows'))
    await user.type(goal, ' and a door')
  }

  for (const [how, act] of [
    [
      'the ✕',
      (u: ReturnType<typeof userEvent.setup>) => u.click(screen.getAllByRole('button', { name: 'Close' })[0])
    ],
    [
      'the Close button',
      (u: ReturnType<typeof userEvent.setup>) =>
        u.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    ],
    ['Escape', (u: ReturnType<typeof userEvent.setup>) => u.keyboard('{Escape}')],
    [
      'a click beside the sheet',
      (u: ReturnType<typeof userEvent.setup>) =>
        u.click(document.querySelector('.modal-backdrop') as HTMLElement)
    ]
  ] as const) {
    it(`sends only the changed field when closed by ${how}`, async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const { prism } = renderWithPrism(<ModelInfo database="M" onClose={onClose} />, {
        routes: { ...ROUTES, 'POST /api/v1/study': {} }
      })
      await editGoal(user)
      await act(user)
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
      expect(studyPosts(prism.calls)).toEqual([
        { database: 'M', goal: 'Compare two windows and a door', source: 'user' }
      ])
    })
  }

  it('writes nothing when nothing was changed', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const { prism } = renderWithPrism(<ModelInfo database="M" onClose={onClose} />, { routes: ROUTES })
    await screen.findByLabelText(/^Goal/)
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(studyPosts(prism.calls)).toEqual([])
  })

  it('locks the fields while the save is on its way, so nothing typed after Escape is lost', async () => {
    const user = userEvent.setup()
    let release: () => void = () => {}
    const onClose = vi.fn()
    renderWithPrism(<ModelInfo database="M" onClose={onClose} />, {
      routes: {
        ...ROUTES,
        'POST /api/v1/study': () => new Promise((r) => (release = () => r({})))
      }
    })
    await editGoal(user)
    await user.keyboard('{Escape}')
    const goal = screen.getByLabelText(/^Goal/) as HTMLTextAreaElement
    await waitFor(() => expect(goal.readOnly).toBe(true))
    release()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('does not close while a rename is on its way — the save would go to the old name', async () => {
    const user = userEvent.setup()
    let release: () => void = () => {}
    const onClose = vi.fn()
    const { prism } = renderWithPrism(<ModelInfo database="Old" onClose={onClose} />, {
      routes: {
        ...ROUTES,
        'POST /api/v1/databases/foreground/rename': () => new Promise((r) => (release = () => r({}))),
        'POST /api/v1/study': {}
      }
    })
    await editGoal(user)
    const field = await startRename(user)
    await user.clear(field)
    await user.type(field, 'New')
    await user.click(screen.getByRole('button', { name: 'Rename the model' }))
    await user.click(screen.getAllByRole('button', { name: 'Close' })[0])
    expect(onClose).not.toHaveBeenCalled()
    expect(studyPosts(prism.calls)).toEqual([])
    release()
  })

  it('saves the changed fields when the app is left with the sheet open', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<ModelInfo database="M" onClose={() => {}} />, {
      routes: { ...ROUTES, 'POST /api/v1/study': {} }
    })
    await editGoal(user)
    window.dispatchEvent(new Event('beforeunload'))
    await waitFor(() =>
      expect(studyPosts(prism.calls)).toEqual([
        { database: 'M', goal: 'Compare two windows and a door', source: 'user' }
      ])
    )
  })

  it('sends one write when the app is left while the close is still saving', async () => {
    const user = userEvent.setup()
    let release: () => void = () => {}
    const { prism } = renderWithPrism(<ModelInfo database="M" onClose={() => {}} />, {
      routes: { ...ROUTES, 'POST /api/v1/study': () => new Promise((r) => (release = () => r({}))) }
    })
    await editGoal(user)
    await user.keyboard('{Escape}')
    window.dispatchEvent(new Event('beforeunload'))
    release()
    await waitFor(() => expect(studyPosts(prism.calls)).toHaveLength(1))
    window.dispatchEvent(new Event('beforeunload')) // saved by now: nothing left to send
    expect(studyPosts(prism.calls)).toHaveLength(1)
  })

  it('on departure during a rename, waits for it and writes under the name that landed', async () => {
    const user = userEvent.setup()
    let release: () => void = () => {}
    const { prism } = renderWithPrism(<ModelInfo database="Old" onClose={() => {}} />, {
      routes: {
        ...ROUTES,
        'POST /api/v1/databases/foreground/rename': () => new Promise((r) => (release = () => r({}))),
        'POST /api/v1/study': {}
      }
    })
    await editGoal(user)
    const field = await startRename(user)
    await user.clear(field)
    await user.type(field, 'New')
    await user.click(screen.getByRole('button', { name: 'Rename the model' }))
    window.dispatchEvent(new Event('beforeunload'))
    let done = false
    const waiting = saveViewsNow().then(() => (done = true)) // an update would wait for all of it
    await new Promise((r) => setTimeout(r, 20))
    expect(studyPosts(prism.calls)).toEqual([])
    expect(done).toBe(false)
    release()
    await waiting
    expect(studyPosts(prism.calls)).toEqual([
      { database: 'New', goal: 'Compare two windows and a door', source: 'user' }
    ])
  })

  it('makes an update wait for the departure write before it stops the backend', async () => {
    const user = userEvent.setup()
    let release: () => void = () => {}
    renderWithPrism(<ModelInfo database="M" onClose={() => {}} />, {
      routes: { ...ROUTES, 'POST /api/v1/study': () => new Promise((r) => (release = () => r({}))) }
    })
    await editGoal(user)
    let done = false
    const waiting = saveViewsNow().then(() => (done = true))
    await new Promise((r) => setTimeout(r, 20))
    expect(done).toBe(false)
    release()
    await waiting
    expect(done).toBe(true)
  })

  it('stays open with the reason when the save is refused, so the text is not lost', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderWithPrism(<ModelInfo database="M" onClose={onClose} />, {
      routes: { ...ROUTES, 'POST /api/v1/study': { status: 500, body: { detail: 'Disk full' } } }
    })
    await editGoal(user)
    await user.keyboard('{Escape}')
    expect(await screen.findByText(/Disk full/)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect((screen.getByLabelText(/^Goal/) as HTMLTextAreaElement).value).toBe(
      'Compare two windows and a door'
    )
  })
})

describe('ModelInfo → opens on what is stored', () => {
  it('reads the study afresh, not the copy a view cached before the assistant wrote it', async () => {
    let stored: Record<string, string> = {}
    renderWithPrism(<div />, { routes: { 'GET /api/v1/study': () => stored } })
    // The Overview's snippet read the model while it was still empty: a clean entry in the cache.
    expect(await fetchQuery(studyRoute('Fresh'))).toEqual({})
    stored = { goal: 'Compare two dishwashing liquids' }
    const { prism } = renderWithPrism(<ModelInfo database="Fresh" onClose={() => {}} />, {
      routes: { 'GET /api/v1/study': () => stored }
    })
    const goal = (await screen.findByLabelText(/^Goal/)) as HTMLTextAreaElement
    await waitFor(() => expect(goal.value).toBe('Compare two dishwashing liquids'))
    expect(prism.calls.filter((c) => c.path.startsWith('/api/v1/study')).length).toBe(1)
  })
})
