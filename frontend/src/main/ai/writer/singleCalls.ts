/** The single-shot, toolless report calls: the abbreviations. */
import { providerDefaults } from '../models'
import { getActiveProvider } from '../providers/state'
import type { ChatMessage } from '../providers/types'
import type { CostSink } from '../subagent'
import { collectText } from '../stream'
import { parseMap } from './text'

/**
 * Ask a model what a list of abbreviations means.
 *
 * The list comes from the document, extracted deterministically — the model only supplies meanings, and
 * the backend drops anything whose key was not a candidate. Finding and explaining are different jobs:
 * a model asked to find abbreviations invents ones the text never used, while one asked to explain a
 * fixed list can only be wrong about a meaning, which a reader can check.
 */
export async function expandAbbreviations(opts: {
  candidates: string[]
  language?: string
  context?: string
  /** Where each abbreviation stands in the document — a text window per token (backend, V410). */
  contexts?: Record<string, string>
  model?: string
  signal?: AbortSignal
  onCost?: CostSink
  /** Settings → AI → Limits "Max tokens per writer reply"; absent = the provider default ceiling. */
  maxTokens?: number
}): Promise<{ resolved: Record<string, string>; model: string }> {
  const model = opts.model || providerDefaults(getActiveProvider()).writerFallback
  if (!opts.candidates.length) return { resolved: {}, model }

  // The token with its surroundings, not the token alone: shown bare, EURO was expanded as the
  // currency beside a lorry's emission class and LUX as Luxembourg beside LUX-TOOLS (V410).
  const contexts = opts.contexts ?? {}
  const lines = opts.candidates.map((c) => (contexts[c] ? `${c} — in the text: "${contexts[c]}"` : c))
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You expand abbreviations used in life cycle assessment reports. Answer with a JSON object ' +
        'mapping each abbreviation exactly as given to its meaning, and nothing else. ' +
        'Where a passage from the text is quoted beside an abbreviation, the meaning is the one that ' +
        'passage uses — the same letters mean different things in different places (EURO beside a ' +
        'lorry class is an emission standard, not a currency), and a token that is only part of a ' +
        'longer name is not an abbreviation at all. ' +
        'Leave out any abbreviation you are not sure about — a wrong expansion in a report is worse ' +
        'than a missing one.'
    },
    {
      role: 'user',
      content: [
        `Language for the meanings: ${opts.language || 'English'}.`,
        opts.context ? `Context: ${opts.context}` : '',
        'Abbreviations:',
        lines.join('\n'),
        '',
        'Reply with the JSON object only.'
      ]
        .filter(Boolean)
        .join('\n')
    }
  ]

  const raw = await collectText({
    model,
    messages,
    signal: opts.signal,
    onCost: opts.onCost,
    maxTokens: opts.maxTokens
  })
  return { resolved: parseMap(raw), model }
}
