import { useEffect, useRef, useState } from 'react'
import { mcpStatus, onMcpEvent, type McpStatusFull } from '../lib/mcp'

/**
 * The external-agent sessions (MCP), kept current from main's events: who is connected, what they
 * did, and — through `onRefresh` — which model they changed, so the canvas showing it reloads the
 * way it does after the in-app assistant's edits.
 *
 * Loaded once from `mcp:status` (a window reload must not lose the panel while sessions go on) and
 * then kept by `sessions` / `status` events. `null` until the first answer, which the callers treat
 * as "nothing connected".
 */
export function useExternalAgents(onRefresh: (database: string | null) => void): McpStatusFull | null {
  const [status, setStatus] = useState<McpStatusFull | null>(null)
  // The latest callback without re-subscribing: the refresh closes over the active model.
  const refreshRef = useRef(onRefresh)
  refreshRef.current = onRefresh
  useEffect(() => {
    let alive = true
    void mcpStatus()
      .then((s) => {
        if (alive) setStatus(s)
      })
      .catch(() => {})
    const off = onMcpEvent((ev) => {
      if (ev.type === 'sessions') {
        setStatus((s) => (s ? { ...s, sessions: ev.sessions } : s))
      } else if (ev.type === 'status') {
        setStatus((s) => (s ? { ...s, running: ev.running, url: ev.url } : s))
      } else if (ev.type === 'refresh') {
        refreshRef.current(ev.database)
      }
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  return status
}
