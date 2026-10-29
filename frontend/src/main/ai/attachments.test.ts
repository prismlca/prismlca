import { beforeEach, describe, expect, it, vi } from 'vitest'

const files = new Map<string, Buffer>()

vi.mock('node:fs/promises', () => ({
  stat: async (p: string) => {
    const f = files.get(p)
    if (!f) throw new Error('ENOENT')
    return { size: f.length }
  },
  readFile: async (p: string) => {
    const f = files.get(p)
    if (!f) throw new Error('ENOENT')
    return f
  }
}))

const { MAX_FILES, MAX_TEXT_BYTES, addAttachments, attachmentParts, attachmentStub, stubForPartText } =
  await import('./attachments')

/** A backend that stores anything and echoes back what the real one would. */
function backend(overrides: Record<string, unknown> = {}) {
  const calls: string[] = []
  const api = async (method: string, path: string, body?: unknown) => {
    calls.push(`${method} ${path}`)
    if (path.endsWith('/raw')) return { status: 200, body: { data_b64: 'QUFB' } }
    if (path.endsWith('/text')) return { status: 200, body: { text: 'converted text', truncated: false } }
    const name = (body as { name: string }).name
    return {
      status: 200,
      body: { id: `hash-${name}`, name, kind: 'text', bytes: 3, warning: '', ...overrides }
    }
  }
  return { api, calls }
}

beforeEach(() => files.clear())

describe('addAttachments', () => {
  it('returns one entry per path, in order', async () => {
    files.set('/a.txt', Buffer.from('aaa'))
    files.set('/b.txt', Buffer.from('bbb'))
    const out = await addAttachments(['/a.txt', '/b.txt'], backend().api)
    expect(out.map((a) => a.name)).toEqual(['a.txt', 'b.txt'])
  })

  it('reports a refused file instead of dropping it', async () => {
    // Silently attaching four of five files is the failure nobody notices until the answer is wrong.
    files.set('/small.txt', Buffer.from('ok'))
    files.set('/huge.txt', Buffer.alloc(MAX_TEXT_BYTES + 1))
    const out = await addAttachments(['/small.txt', '/huge.txt'], backend().api)
    expect(out).toHaveLength(2)
    expect(out[0].error).toBeUndefined()
    expect(out[1].error).toContain('Too large')
  })

  it('names the files it would not take beyond the per-message count', async () => {
    const paths: string[] = []
    for (let i = 0; i < MAX_FILES + 2; i++) {
      paths.push(`/f${i}.txt`)
      files.set(`/f${i}.txt`, Buffer.from('x'))
    }
    const out = await addAttachments(paths, backend().api)
    expect(out).toHaveLength(MAX_FILES + 2)
    expect(out.slice(MAX_FILES).every((a) => a.error?.includes('More than'))).toBe(true)
  })

  it('surfaces what the backend refused rather than a generic failure', async () => {
    files.set('/x.zip', Buffer.from('PK'))
    const api = async () => ({ status: 415, body: { detail: 'Cannot attach .zip files' } })
    const [entry] = await addAttachments(['/x.zip'], api)
    expect(entry.error).toBe('Cannot attach .zip files')
  })

  it('does not read a file it has already refused on size', async () => {
    files.set('/huge.txt', Buffer.alloc(MAX_TEXT_BYTES + 1))
    const b = backend()
    await addAttachments(['/huge.txt'], b.api)
    expect(b.calls).toEqual([])
  })
})

describe('attachmentParts', () => {
  const meta = { id: 'abc', name: 'spec.pdf', kind: 'pdf' as const, bytes: 10, pages: 80 }

  it('sends a PDF as a file part and names it beside itself', async () => {
    const parts = await attachmentParts([meta], backend().api, { vision: true })
    expect(parts[0].type).toBe('file')
    // The caption is what compaction is left holding, so it has to carry the id.
    expect(String(parts[1].text)).toContain('id "abc"')
    expect(String(parts[1].text)).toContain('80 pages')
  })

  it('tells a blind model what it was sent instead of sending an image it cannot read', async () => {
    // An image part to a model without vision is a 400 from the provider, i.e. a dead turn.
    const image = { id: 'i1', name: 'photo.png', kind: 'image' as const, bytes: 10 }
    const parts = await attachmentParts([image], backend().api, { vision: false })
    expect(parts).toHaveLength(1)
    expect(parts[0].type).toBe('text')
    expect(String(parts[0].text)).toContain('cannot see images')
  })

  it('skips an entry that never stored', async () => {
    const bad = { id: '', name: 'x.zip', kind: 'text' as const, bytes: 0, error: 'refused' }
    expect(await attachmentParts([bad], backend().api, { vision: true })).toEqual([])
  })
})

describe('stubForPartText', () => {
  it('recognises both shapes an attachment caption takes', () => {
    expect(stubForPartText('[attached file: spec.pdf (80 pages) — id "abc"]')).toContain('abc')
    expect(
      stubForPartText('--- attached file: bom.xlsx (2 sheets) — id "def" ---\nrows\n--- end of file ---')
    ).toContain('def')
  })

  it('leaves ordinary text alone', () => {
    expect(stubForPartText('What does the datasheet say?')).toBeNull()
    expect(stubForPartText('[earlier canvas screenshot omitted to fit the context]')).toBeNull()
  })

  it('produces the same stub the writer would', () => {
    expect(stubForPartText('[attached file: spec.pdf (80 pages) — id "abc"]')).toBe(
      attachmentStub('spec.pdf (80 pages)', 'abc')
    )
  })
})
