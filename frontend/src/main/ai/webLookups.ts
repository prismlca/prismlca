/**
 * The provider-side web lookups of one reply, in words.
 *
 * OpenRouter runs its web search and page fetch inside a reply and reports only counters. The chat's
 * trace row, the round's log line and the log line of a research or review request all name them the
 * same way, from here.
 */

/**
 * Put OpenRouter's `server_tool_use` counters into words. `web_search_requests` and
 * `web_fetch_requests` are the two known kinds; any other `*_requests` counter is named as it comes.
 * Returns null when nothing ran, so a round without lookups adds no row.
 */
export function describeWebLookups(
  use: Record<string, number> | undefined
): { short: string; preview: string; total: number } | null {
  if (!use || typeof use !== 'object') return null
  const parts: string[] = []
  let total = 0
  for (const [key, raw] of Object.entries(use)) {
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(n) || n <= 0) continue
    total += n
    const kind = key.replace(/_requests$/, '')
    const noun =
      kind === 'web_search'
        ? n === 1
          ? 'web search'
          : 'web searches'
        : kind === 'web_fetch'
          ? n === 1
            ? 'page fetched'
            : 'pages fetched'
          : `${kind.replace(/_/g, ' ')} ${n === 1 ? 'call' : 'calls'}`
    parts.push(`${n} ${noun}`)
  }
  if (!total) return null
  const short = parts.join(', ')
  const preview =
    `${short} — run by the provider inside this reply. Every lookup makes the model read the whole ` +
    `conversation again, so this round's input tokens and cost cover ${total + 1} passes, not one. ` +
    `Settings → AI → Chat caps how many lookups one reply may run.`
  return { short, preview, total }
}
