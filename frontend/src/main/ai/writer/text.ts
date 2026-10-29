/** Reading model replies: strip the wrappers models add around prose, and pull out the JSON inside. */

/** Read a revision reply: either replacements or a whole new chapter. Tolerates a code fence. */
export function parseRevision(
  raw: string
): { replacements: Array<{ old: string; new: string; all?: boolean }> } | { chapter: string } | null {
  const text = clean(raw)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    if (Array.isArray(parsed.replacements)) {
      const ops = (parsed.replacements as Array<Record<string, unknown>>)
        .filter((o) => typeof o.old === 'string' && typeof o.new === 'string')
        .map((o) => ({ old: String(o.old), new: String(o.new), all: o.all === true }))
      return ops.length ? { replacements: ops } : null
    }
    if (typeof parsed.chapter === 'string' && parsed.chapter.trim()) return { chapter: parsed.chapter }
    return null
  } catch {
    return null
  }
}

/**
 * Strip what models add around prose despite being asked not to: a Markdown heading, a code fence, a
 * "Here is the chapter:" opener. Cheaper and more reliable than another round trip asking for it again.
 */
export function clean(raw: string): string {
  let text = (raw ?? '').trim()
  const fence = text.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i)
  if (fence) text = fence[1].trim()
  text = text.replace(/^#{1,6}\s+.*\n+/, '') // a heading — the report supplies its own
  text = text.replace(/^(?:here (?:is|'s)|below is)\b[^\n]*:\s*\n+/i, '')
  return text.trim()
}

/** Pull a flat string map out of a reply, tolerating a code fence or a sentence around it. */
export function parseMap(raw: string): Record<string, string> {
  const text = clean(raw)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return {}
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.trim()) out[key] = value.trim()
    }
    return out
  } catch {
    return {} // a malformed reply resolves nothing; the backend guard would drop it anyway
  }
}
