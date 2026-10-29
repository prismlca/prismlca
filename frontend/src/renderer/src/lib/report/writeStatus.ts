/** The write buttons' wording and the live status line of a running chapter write.
 *
 * Moved out of views/ReportSections.tsx (wave 3.1): these are pure helpers that lived in a view
 * file only because nobody had moved them — eleven test files already covered them from outside.
 * ReportSections re-exports every name, so those tests keep their import path.
 */
import type { WritePhase } from '../ai'
import type { ConfirmSpec } from '../../views/ConfirmDialog'
import { chapterLabel, COMMENTABLE } from './model'

/**
 * The single Write button's tooltip.
 *
 * It promised the same thing on an empty chapter and on one holding an approved text — "Let a model
 * write this chapter from the study metadata and the numbers" — with no word about the text it was
 * about to replace. The bulk button had said "Rewrite all chapters" for exactly this reason; the per-row one
 * had not caught up.
 */
export function writeTooltip(
  section: { kind: string; text?: string; locked?: boolean },
  blocked: string | null
): string {
  if (section.locked) return 'Locked — unlock it first'
  if (blocked) return blocked
  const comment = COMMENTABLE.has(section.kind)
  if (!(section.text ?? '').trim())
    return comment
      ? 'Let a model write the comment under this chapter’s tables'
      : 'Let a model write this chapter from the study metadata and the numbers'
  return (
    `Let a model write ${comment ? 'the comment under this chapter’s tables' : 'this chapter'} again. ` +
    'This replaces the present wording — you are asked first, and what it replaces stays recoverable.'
  )
}

/**
 * The question a single Write has to ask, and `null` when there is nothing to ask about.
 *
 * The bulk run has the plan dialog: every chapter, what would happen to it, and a tick per row. One
 * chapter had nothing — Write on a written chapter replaced an approved, paid-for text on one click.
 * An empty chapter deliberately gets no dialog: a box in front of the ordinary action is noise.
 *
 * Not `danger`, and the wording says why: the previous wording is kept, so this is a confirmation and
 * not a warning. A draft (refused text, not in the document) leaves `text` empty and asks nothing —
 * there is no approved wording under it to lose.
 */
export function writeConfirmSpec(
  section: { kind: string; title?: string; text?: string },
  markedRead: boolean,
  write: () => void
): ConfirmSpec | null {
  if (!(section.text ?? '').trim()) return null
  const comment = COMMENTABLE.has(section.kind)
  const holds = comment ? 'a comment' : 'text'
  return {
    title: comment ? 'Replace this comment?' : 'Replace this chapter?',
    message:
      `“${chapterLabel(section)}” ${
        markedRead ? `holds ${holds} you have released` : `already holds ${holds}`
      }. Writing asks the model again — a paid call — and puts its answer in place of what is there. ` +
      `The ${markedRead ? 'wording you approved' : 'present wording'} is kept as the previous version: ` +
      '“before” on the chapter’s row shows it against the new one, and “Put it back” restores it.',
    confirmLabel: comment ? 'Replace the comment' : 'Replace the chapter',
    onConfirm: write
  }
}

/**
 * What a single chapter's write is doing, plus what the panel adds at either end of the writer's own
 * phases: the brief being computed before, and the store call after.
 */
export type WriteStage = WritePhase | { phase: 'brief' } | { phase: 'storing' }

/** m:ss above a minute. "385 s" is a number the reader has to divide before it means anything. */
export function elapsedLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * The line a single chapter's write shows while it runs — a pure function of what the writer last
 * reported and how long ago it was asked.
 *
 * A chapter once took 158 s and 385 s behind `<Busy label="Writing" />` and nothing
 * else: no way to tell a thinking model from a dead stream, and the second attempt after a refused
 * first one — a whole extra model call — was invisible. Nothing here goes in the button: a live
 * counter inside it makes it change width and walk out from under the cursor, the same mistake the
 * "Rewrite all chapters" label was fixed for.
 */
/** How long a model may think before the line says so. Six minutes: one chapter's reasoning on a slow
 *  provider runs three to four, a real hang ran ten, and a hint that fires at three would
 *  interrupt work that was about to finish. */
export const THINKING_LONG_S = 360

export function writeStatus(label: string, stage: WriteStage | null, seconds: number): string {
  const what = ((): string => {
    switch (stage?.phase) {
      case 'sent':
        return 'waiting for the model'
      case 'thinking':
        // The reasoning character count is deliberately NOT shown: how many characters of hidden
        // thought have arrived is not something an author can act on. That it is thinking is — and it
        // is a different fact from "the request is open", which is why the two are separate phases:
        // a minute of "waiting" is a provider queue, a minute of "thinking" is work.
        return seconds >= THINKING_LONG_S
          ? 'the model is still thinking — unusually long for one chapter; Cancel and try again, or pick another writing model under Settings → AI → Models'
          : 'the model is thinking'
      case 'writing':
        return `${stage.chars.toLocaleString('en-US')} characters so far`
      case 'lookup':
        return `looking up ${stage.name} (${stage.spent} of ${stage.allowance})`
      case 'checking':
        return 'checking the text against the numbers'
      case 'revising':
        return `refused by the check, revising (attempt ${stage.attempt})`
      case 'storing':
        return 'storing'
      default:
        // 'brief', and the moment before the first phase arrives. The brief computes the report data
        // when it is not cached, which is minutes of its own on an ecoinvent model.
        return 'collecting the numbers'
    }
  })()
  return `Writing “${label}” — ${what} · ${elapsedLabel(seconds)}`
}

/**
 * The same state in three or four words, for a run that has four lanes going at once.
 *
 * The run's foot line used to name the open chapters and nothing else, so a chapter working through
 * thirteen lookups looked identical to a hung one — seventeen minutes on "3 of 11" with no way to
 * tell (V269). One shared status line was rightly refused: four lanes talking over it is worse than
 * silence. Naming the activity PER open chapter is the version that fits, and the lookup counter is
 * the number that matters, because it is the only one that says how much of the wait is left.
 */
export function stageBrief(stage: WriteStage | null): string {
  switch (stage?.phase) {
    case 'lookup':
      return `lookup ${stage.spent} of ${stage.allowance}`
    case 'thinking':
      return 'thinking'
    case 'writing':
      return 'writing'
    case 'checking':
      return 'checking'
    case 'revising':
      return `revising ${stage.attempt}`
    case 'storing':
      return 'storing'
    case 'sent':
      return 'waiting'
    case 'brief':
      // Main reports it per lane since V422: the first Write-all wave of the Silikon
      // report sat 125 s in the brief with nothing but the chapter names on the foot line.
      return 'collecting the numbers'
    default:
      return ''
  }
}
