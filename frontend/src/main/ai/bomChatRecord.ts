/**
 * What the chat has on record for the page a known part of a bill of materials cites (bomKnownParts.ts), and so
 * whether that part's `cited_by_search` may say a lookup backs the page.
 *
 * Backed means that a lookup returned or opened the page: one of this chat's own searches, page fetches or
 * citations; a research tool's answer that vouches for it (a page its engine cited, a figure it marked
 * `cited_by_search: true`); or the model's research log, where the page stands as backed. Nothing else upgrades an
 * address. A page the user wrote says where a figure is meant to come from, not that anybody read it there. A page
 * in a note, beside an alternative figure or under a whole-product total carries no verdict at all. And an address
 * once logged as not backed stays so until a lookup of this chat returns it: weighing a list again is no evidence.
 *
 * Unknown stays unknown. Where the provider names none of the pages it looked up (OpenRouter only counts them) and
 * the log holds no verdict, the part gets no verdict either: absence there says nothing.
 */
import { urlKey } from './citationBook'
import type { ChatMessage, WebRecord } from './providers/types'

export interface ChatRecord {
  /** Pages a lookup returned, opened or vouched for. */
  backed: Set<string>
  /** Pages the log holds as not backed, and no lookup of this chat returned since. */
  flagged: Set<string>
  /** Whether the chat's provider names the pages it looked up at all. */
  named: boolean
}

/** The research tools whose answers can vouch for a page. */
const RESEARCH_TOOLS = new Set(['research_bom', 'research_web'])

/** Every research tool answer in this chat, parsed — as far as its carried rounds hold them. */
export function researchAnswers(messages: ChatMessage[]): unknown[] {
  const ids = new Set(
    messages.flatMap((m) =>
      (m.tool_calls ?? []).filter((c) => RESEARCH_TOOLS.has(c.function.name)).map((c) => c.id)
    )
  )
  const out: unknown[] = []
  for (const m of messages) {
    if (m.role !== 'tool' || !m.tool_call_id || !ids.has(m.tool_call_id) || typeof m.content !== 'string')
      continue
    try {
      out.push(JSON.parse(m.content))
    } catch {
      /* an answer that is no JSON vouches for nothing */
    }
  }
  return out
}

/**
 * The pages a research answer vouches for: the engine-cited pages under `evidence`, and the page of every figure
 * marked `cited_by_search: true`. A page that stands anywhere else — a note, an alternative, a total, a figure the
 * engine never returned — is no evidence.
 */
export function vouchedPages(answer: unknown): string[] {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n)
      return
    }
    if (!node || typeof node !== 'object') return
    const o = node as Record<string, unknown>
    if (o.cited_by_search === true) {
      if (typeof o.source_url === 'string') out.push(o.source_url)
      for (const s of Array.isArray(o.sources) ? o.sources : []) if (typeof s === 'string') out.push(s)
    }
    for (const e of Array.isArray(o.evidence) ? o.evidence : [])
      if (e && typeof e === 'object' && typeof (e as { url?: unknown }).url === 'string')
        out.push((e as { url: string }).url)
    for (const [k, v] of Object.entries(o)) if (k !== 'evidence' && v && typeof v === 'object') walk(v)
  }
  walk(answer)
  return out
}

/** The log's verdicts on pages: backed where a finding with a page is marked cited, flagged where it is marked not. */
export function loggedVerdicts(log: unknown): { backed: string[]; flagged: string[] } {
  const backed: string[] = []
  const flagged: string[] = []
  for (const entry of Array.isArray(log) ? log : []) {
    const findings = (entry as { findings?: unknown })?.findings
    for (const f of Array.isArray(findings) ? findings : []) {
      const finding = f as { sources?: unknown; cited_by_search?: unknown; unsourced?: unknown }
      const sources = Array.isArray(finding?.sources)
        ? finding.sources.filter((s): s is string => typeof s === 'string')
        : []
      if (finding?.cited_by_search === true && finding.unsourced !== true) backed.push(...sources)
      else if (finding?.cited_by_search === false) flagged.push(...sources)
    }
  }
  return { backed, flagged }
}

/** What this chat has on record: its own lookups, what its research answers vouch for, the log's verdicts. */
export function chatRecord(records: WebRecord[], answers: unknown[], log: unknown): ChatRecord {
  const backed = new Set<string>()
  let named = false
  const add = (url: string | undefined): void => {
    if (url) backed.add(urlKey(url))
  }
  for (const r of records) {
    for (const s of r.searches ?? []) {
      // A search that names what it returned names its pages, also when it returned none.
      if (Array.isArray(s.results)) named = true
      for (const p of s.results ?? []) add(p.url)
    }
    for (const f of r.fetched ?? [])
      if (!f.error) {
        named = true
        add(f.url)
      }
    for (const c of r.cited ?? []) {
      named = true
      add(c.url)
    }
  }
  for (const a of answers) for (const u of vouchedPages(a)) add(u)
  const verdicts = loggedVerdicts(log)
  for (const u of verdicts.backed) add(u)
  const flagged = new Set(verdicts.flagged.map(urlKey).filter((k) => !backed.has(k)))
  return { backed, flagged, named }
}

/**
 * Whether a known part's page is backed: true when a lookup backs it; false when the log flagged it, or when the
 * provider names its pages and none of them is this one; undefined when nothing can be said.
 */
export function onChatRecord(record: ChatRecord, url: string): boolean | undefined {
  const key = urlKey(url)
  if (record.backed.has(key)) return true
  if (record.flagged.has(key)) return false
  return record.named ? false : undefined
}
