/** Translating the study's own texts into the report language, in batches and lanes. */
import { providerDefaults } from '../models'
import { getActiveProvider } from '../providers/state'
import type { ChatMessage } from '../providers/types'
import type { CostSink } from '../subagent'
import { collectText } from '../stream'
import { parseMap } from './text'

/**
 * How much source text one translation call carries, measured in characters.
 *
 * Characters and not texts, because the reply repeats every text in full: five 2000-character
 * process notes and five scenario names are the same count and nothing like the same call. The
 * output tokens are the bottleneck here — one call with all 48 texts of a practice study took 9
 * minutes 34 of a 22-minute run, and a reply that long is also the one most likely to be cut off
 * (V171). 6000 characters is roughly 1500–2000 tokens in and about as many back, which stays well
 * inside every writer model's reply limit even after JSON quoting, while still being large enough
 * that an ordinary study needs a handful of calls rather than dozens.
 */
const TRANSLATE_BATCH_CHARS = 6000

/** How many translation batches are in flight at once — the same appetite as WRITE_LANES. */
const TRANSLATE_LANES = 4

/**
 * Cut the candidates into batches of at most `limit` characters.
 *
 * A single text longer than the whole limit rides alone rather than not at all: splitting a
 * paragraph across two calls would hand the model half a sentence, and half a sentence translates
 * wrong. Order is kept, so a batch is a run of neighbouring texts and reads as one subject.
 */
export function translationBatches<T extends { key: string; text: string }>(
  candidates: T[],
  limit = TRANSLATE_BATCH_CHARS
): T[][] {
  const batches: T[][] = []
  let batch: T[] = []
  let size = 0
  for (const candidate of candidates) {
    const cost = candidate.key.length + candidate.text.length
    if (batch.length && size + cost > limit) {
      batches.push(batch)
      batch = []
      size = 0
    }
    batch.push(candidate)
    size += cost
  }
  if (batch.length) batches.push(batch)
  return batches
}

/**
 * How many model answers a translation waits for in sequence — the backstop's multiplier.
 *
 * Two per batch, because a batch whose reply came back unreadable is asked once more (V171), and the
 * batches themselves run `TRANSLATE_LANES` at a time, so only every fourth batch adds to the wait.
 * A study with a handful of texts therefore keeps the plain one-answer budget; one with fifty gets
 * the minutes it actually needs instead of being cut off halfway.
 */
export function translationAnswers(
  candidates: Array<{ key: string; text: string }>,
  opts?: { batchChars?: number; lanes?: number }
): number {
  const batches = translationBatches(candidates, opts?.batchChars ?? TRANSLATE_BATCH_CHARS).length
  return 2 * Math.ceil(batches / Math.max(1, opts?.lanes ?? TRANSLATE_LANES))
}

/**
 * Translate the study's own prose into the report language — and translate is the whole job.
 *
 * The backend collected the candidates deterministically (engine/report_translations) and will drop
 * any key that was not one, so the model can only be wrong about a wording, never about *what* gets
 * translated. Texts already in the target language come back unchanged on purpose: the backend
 * stores them as "checked", which is what makes the open count reach zero.
 *
 * Batched and run in lanes, like `writeAll` and for the same two reasons. It used to be one call
 * carrying every text: nearly half the run's wall clock, with no sign of progress, and the whole of
 * it staked on one reply parsing — a truncated answer lost all 48 translations and the tokens they
 * had cost (V171). Now a batch that comes back unreadable loses only its own texts, after one
 * second attempt, and every batch is billed through `onCost` on its own.
 */
export async function translateStudyTexts(opts: {
  candidates: Array<{ key: string; text: string }>
  language?: string
  model?: string
  signal?: AbortSignal
  onCost?: CostSink
  /** Settings → AI → Limits "Max tokens per writer reply"; absent = the provider default ceiling. */
  maxTokens?: number
  /** Called as each batch lands, so a step that takes minutes can say how far along it is. */
  onProgress?: (p: { done: number; total: number; batches: number }) => void
  batchChars?: number
  lanes?: number
}): Promise<{ resolved: Record<string, string>; model: string }> {
  const model = opts.model || providerDefaults(getActiveProvider()).writerFallback
  if (!opts.candidates.length) return { resolved: {}, model }

  const batches = translationBatches(opts.candidates, opts.batchChars ?? TRANSLATE_BATCH_CHARS)
  const total = opts.candidates.length
  const resolved: Record<string, string> = {}
  let done = 0

  const translateBatch = async (
    batch: Array<{ key: string; text: string }>
  ): Promise<Record<string, string>> => {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You translate the documentation of a life cycle assessment study. Answer with a JSON ' +
          'object mapping each id exactly as given to the translated text, and nothing else. ' +
          'Keep units, URLs, dataset names in quotes and parameter names exactly as they are. ' +
          'Keep every numeric VALUE exactly as it is too — never round, convert or recompute one. ' +
          'Write it in the TARGET language\'s notation, though: German "0,196 kg" becomes ' +
          '"0.196 kg" in English, and English "1,250" becomes "1.250" in German. The digits and ' +
          'the unit do not change; only the decimal and thousands marks do. (Until this was said, a ' +
          'faithful translator kept the German comma and an English report printed "0,196 kg" one ' +
          'paragraph above the same figure written "0.196 kg".) ' +
          'Short labels are translated like everything else — scenario names such as ' +
          '"Wenige Umläufe (5)" appear on chart axes and in tables, so they must come out in the ' +
          'target language ("Few cycles (5)"), keeping any number or parenthesis. A text that is ' +
          'already in the target language is returned unchanged. Translate faithfully — these ' +
          'sentences state assumptions and sources, and a reworded assumption is a wrong one.'
      },
      {
        role: 'user',
        content: [
          `Target language: ${opts.language || 'en'}.`,
          'Texts, one per line as "id: text":',
          ...batch.map((c) => `${c.key}: ${c.text.replace(/\n/g, ' ')}`),
          '',
          'Reply with the JSON object only.'
        ].join('\n')
      }
    ]

    const raw = await collectText({
      model,
      messages,
      signal: opts.signal,
      onCost: opts.onCost,
      maxTokens: opts.maxTokens
    })
    return parseMap(raw)
  }

  const queue = [...batches]
  const lane = async (): Promise<void> => {
    for (let batch = queue.shift(); batch; batch = queue.shift()) {
      let got: Record<string, string> = {}
      // Two goes at most. An unreadable reply is usually a truncated one and a second attempt often
      // lands; a third would only be paying again for the same silence. What a batch cannot deliver
      // is lost by that batch alone — which is the point of cutting the call up in the first place.
      for (let attempt = 0; attempt < 2 && !Object.keys(got).length; attempt++) {
        if (opts.signal?.aborted) return
        try {
          got = await translateBatch(batch)
        } catch (e) {
          if (opts.signal?.aborted) return
          console.log(
            `[translate] batch of ${batch.length} failed: ${e instanceof Error ? e.message : String(e)}`
          )
        }
      }
      Object.assign(resolved, got)
      // Counted as handled, not as translated: this figure exists to tell the author how much of the
      // wait is left. What actually landed is counted by the backend when it stores the answers.
      done += batch.length
      opts.onProgress?.({ done, total, batches: batches.length })
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.lanes ?? TRANSLATE_LANES, queue.length) }, lane))
  return { resolved, model }
}
