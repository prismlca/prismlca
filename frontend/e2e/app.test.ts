import { afterEach, describe, expect, it } from 'vitest'
import { cleanEnv } from './app'

describe('cleanEnv', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('keeps an import path of the calling shell from the backend', () => {
    process.env.PYTHONPATH = '/another/checkout/backend/src'
    process.env.PYTHONPATHS_NOTE = 'kept'
    const env = cleanEnv()
    expect(env.PYTHONPATH).toBeUndefined()
    expect(env.PYTHONPATHS_NOTE).toBe('kept')
    expect(env.PATH).toBe(process.env.PATH)
  })
})
