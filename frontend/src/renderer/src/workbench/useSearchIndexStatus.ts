/**
 * Poll the search-index build status: fast while a build runs (progress bar), lazily otherwise
 * (to notice builds started elsewhere, e.g. by the Setup import). Extracted from Workbench.tsx
 * (wave 4.1) — it shares nothing with the canvas but a spot in the sidebar.
 *
 * The answer is only handed on when a FIELD of it changed. Every poll deserialises a fresh object
 * over IPC, so storing it unconditionally gave the Workbench a new value every ten seconds for the
 * lifetime of the app — and the Workbench renders the chat, whose transcript re-parses every
 * message's Markdown on each render (react-markdown has no cache). An idle window was therefore
 * doing the work of a whole conversation six times a minute, which is what a reader feels as a
 * scroll that hitches every few seconds (11.09.2026).
 *
 * Deliberately a field comparison and not a shallow-equal helper: the progress bar reads `count`
 * while a build runs, so those updates must still get through — only a genuinely unchanged status
 * is swallowed.
 */
import { useEffect, useState } from 'react'
import { api } from '../lib/api'

export interface IndexBuildStatus {
  state: 'idle' | 'running' | 'done' | 'error'
  database: string | null
  detail: string
  count: number
  total: number
  /** Databases whose build waits behind the running one (an import that finished meanwhile), in turn order. */
  queued?: string[]
}

/** Same build, same progress, same message — nothing a consumer could render differently. */
function same(a: IndexBuildStatus | null, b: IndexBuildStatus): boolean {
  return (
    a !== null &&
    a.state === b.state &&
    a.database === b.database &&
    a.detail === b.detail &&
    a.count === b.count &&
    a.total === b.total &&
    (a.queued ?? []).join('\n') === (b.queued ?? []).join('\n')
  )
}

export function useSearchIndexStatus(): IndexBuildStatus | null {
  const [status, setStatus] = useState<IndexBuildStatus | null>(null)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async (): Promise<void> => {
      let next = 10_000
      try {
        const st = await api<IndexBuildStatus>('GET', '/api/v1/search/status')
        if (!alive) return
        setStatus((prev) => (same(prev, st) ? prev : st))
        if (st.state === 'running') next = 1_500
      } catch {
        /* backend briefly unavailable — retry lazily */
      }
      if (alive) timer = setTimeout(() => void tick(), next)
    }
    void tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [])
  return status
}
