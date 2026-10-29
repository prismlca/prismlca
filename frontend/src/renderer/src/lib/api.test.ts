import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makePrism } from '../test/prism'

/**
 * The renderer's one door to the backend: 28 modules import this, and every component test in the
 * project runs its error mapping for real rather than stubbing it. What it turns a failed response
 * INTO is therefore what every view's catch block sees.
 */

async function withPrism(routes: Record<string, unknown>) {
  vi.resetModules()
  const fixture = makePrism(routes)
  vi.stubGlobal('window', { prism: fixture.prism, addEventListener: () => {}, removeEventListener: () => {} })
  const mod = await import('./api')
  return { ...mod, fixture }
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('api()', () => {
  it('returns the body on success and records what it sent', async () => {
    const { api, fixture } = await withPrism({ 'GET /api/v1/models': { models: ['a'] } })
    await expect(api('GET', '/api/v1/models')).resolves.toEqual({ models: ['a'] })
    expect(fixture.calls).toEqual([{ method: 'GET', path: '/api/v1/models', body: undefined }])
  })

  it('joins the backend message and its hint into one readable sentence', async () => {
    // PrismError's envelope. The hint is the actionable half and used to be dropped on the floor.
    const { api } = await withPrism({
      'POST /api/v1/calc/lcia': {
        status: 404,
        body: {
          error: {
            message: "Activity 'x' not found.",
            hint: 'Check the activity code and database.',
            code: 'activity_not_found'
          }
        }
      }
    })
    await expect(api('POST', '/api/v1/calc/lcia', {})).rejects.toThrow(
      "Activity 'x' not found. — Check the activity code and database."
    )
  })

  it('carries the status and the backend code, which is what callers branch on', async () => {
    const { api, ApiError } = await withPrism({
      'POST /api/v1/calc/contribution': {
        status: 409,
        body: { error: { message: 'Superseded.', code: 'calc_superseded' } }
      }
    })
    await expect(api('POST', '/api/v1/calc/contribution', {})).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'calc_superseded'
    })
    await expect(api('POST', '/api/v1/calc/contribution', {})).rejects.toBeInstanceOf(ApiError)
  })

  it('omits the separator when there is no hint', async () => {
    const { api } = await withPrism({
      'POST /api/v1/x': { status: 400, body: { error: { message: 'Bad request.' } } }
    })
    await expect(api('POST', '/api/v1/x', {})).rejects.toThrow(/^Bad request\.$/)
  })

  it('reads what a non-envelope body still says, and falls back to the bare status only past that', async () => {
    // FastAPI's own 422 shape, a plain-string error page, or nothing at all. The first two used to
    // collapse to "HTTP 422"/"HTTP 500" here while the agent's unwrapper kept the detail — the
    // shared unwrapper (shared/backendError.ts) is the superset, so the field names and the string
    // body now reach the renderer too.
    const { api } = await withPrism({
      'GET /api/v1/a': { status: 422, body: { detail: [{ loc: ['body', 'code'], msg: 'field required' }] } },
      'GET /api/v1/b': { status: 500, body: 'upstream exploded' },
      'GET /api/v1/c': { status: 503 }
    })
    await expect(api('GET', '/api/v1/a')).rejects.toThrow('Invalid arguments — code: field required')
    await expect(api('GET', '/api/v1/b')).rejects.toThrow('upstream exploded')
    await expect(api('GET', '/api/v1/c')).rejects.toThrow('HTTP 503')
  })

  it('treats 400 as the failure boundary and 399 as success', async () => {
    const { api } = await withPrism({
      'GET /api/v1/ok': { status: 399, body: { fine: true } },
      'GET /api/v1/bad': { status: 400, body: {} }
    })
    await expect(api('GET', '/api/v1/ok')).resolves.toEqual({ fine: true })
    await expect(api('GET', '/api/v1/bad')).rejects.toThrow('HTTP 400')
  })
})

describe('isSuperseded()', () => {
  it('is true only for the 409 a newer results request raises', async () => {
    const { api, isSuperseded } = await withPrism({
      'POST /api/v1/calc/one': {
        status: 409,
        body: { error: { message: 'Superseded.', code: 'calc_superseded' } }
      },
      'POST /api/v1/calc/two': {
        status: 409,
        body: { error: { message: 'Name taken.', code: 'duplicate_name' } }
      },
      'POST /api/v1/calc/three': { status: 500, body: {} }
    })
    const err = async (p: string): Promise<unknown> => api('POST', p, {}).catch((e) => e)

    expect(isSuperseded(await err('/api/v1/calc/one'))).toBe(true)
    // A different 409 is a real failure the user must see — not something to swallow silently.
    expect(isSuperseded(await err('/api/v1/calc/two'))).toBe(false)
    expect(isSuperseded(await err('/api/v1/calc/three'))).toBe(false)
  })

  it('says no to anything that is not an ApiError at all', async () => {
    const { isSuperseded } = await withPrism({})
    expect(isSuperseded(new Error('calc_superseded'))).toBe(false)
    expect(isSuperseded(undefined)).toBe(false)
    expect(isSuperseded({ code: 'calc_superseded' })).toBe(false)
  })
})
