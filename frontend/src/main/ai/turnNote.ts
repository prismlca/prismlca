/**
 * The bracketed note the app puts in front of every user turn of the chat — the study language and
 * today's date, plus the title instruction in a new chat — and keeping the model's copies of it out of
 * the reply.
 *
 * It rides on the USER turn, not in the system prompt (V418): the study language (unset in turn 1, "de"
 * by turn 2 of every build) and the new-chat title instruction were the two lines that made the system
 * block of turn 2 differ from turn 1 — and a changed system block invalidates the entire cached prefix,
 * so the first follow-up question of a long chat paid the whole context uncached (0.82 $ / 263k tokens,
 * twice measured). Here it sits behind the cached prefix and costs a few tokens. Today's date rides
 * here too: no model knows it, and one guessed a study date three months back. The renderer shows only
 * what the user typed.
 *
 * Some models open their reply with a copy of the note anyway — GPT-6 Luna in nearly every answer, even
 * an updated one (`[Study language: English]` after it had recorded the language under a turn that
 * said none was recorded), Hy4 now and then. The prompt says the note is no part of a reply;
 * `noteEcho` is the guard for the models that copy it regardless.
 */
import { localDate } from './localTime'
import { LANGUAGE_NAMES } from './systemPrompt'

/** The note for one user turn. `today` is a parameter for the tests only. */
export function turnNote(studyLanguage: string | undefined, isNewChat: boolean, today = localDate()): string {
  const langName = studyLanguage ? (LANGUAGE_NAMES[studyLanguage] ?? studyLanguage) : undefined
  return [
    langName ? `[Study language: ${langName}]` : '[No study language recorded yet]',
    `[Today: ${today}]`,
    isNewChat
      ? 'This is a NEW chat: your first action must be to call `set_chat_title` with a short, punchy title (3–6 words) for the conversation. Do not mention the title to the user.'
      : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/** One line of the note in the form the app writes it — the only text the guard ever drops. A copy that
 *  names a language the app never wrote is dropped too: the line is ours either way. */
const NOTE_LINE =
  /^\[(?:Study language: [^\]\n]{1,40}|No study language recorded yet|Today: [^\]\n]{1,40})\]$/
const NOTE_OPENINGS = ['[Study language: ', '[No study language recorded yet]', '[Today: ']
/** The note has two such lines. A third one in a row is no copy but a model stuck on the line: it passes,
 *  so the loop's repetition cut-off sees it instead of a stream that grows nowhere until its limit. */
const MAX_DROPPED = 2

/** Whether a line that has not ended yet may still turn out to be a note line. */
function mayBecomeNote(line: string): boolean {
  if (NOTE_LINE.test(line)) return true // complete, but its line break has not arrived yet
  if (line.length > 60) return false
  return NOTE_OPENINGS.some((o) => o.startsWith(line) || (line.startsWith(o) && !line.includes(']')))
}

export interface NoteEcho {
  /** What of `delta` may be shown now: '' while the opening of the round is still undecided. */
  pass(delta: string): string
  /** At the end of the stream: what is still held back, unless it was only a copy of the note. */
  end(): string
  /** How many copied note lines were dropped. */
  readonly dropped: number
}

/**
 * The guard for one round of streamed text. It holds back the opening of the round until that is
 * either a copy of a note line — dropped, with the blank lines after it — or plainly something else,
 * which then passes unchanged. Only the opening: the copies seen so far all stood there (after the
 * questions-and-answers block the app inserts, or after the text of an earlier round), and a line
 * further down may be the model quoting the note on purpose. Text that starts with a bracket for its own
 * reasons (`[1]`, a Markdown link) is released at the first character that no note line has.
 */
export function noteEcho(): NoteEcho {
  let held = ''
  let open = false
  let dropped = 0
  return {
    get dropped() {
      return dropped
    },
    pass(delta) {
      if (open) return delta
      held += delta
      for (;;) {
        const rest = held.trimStart()
        const br = rest.indexOf('\n')
        const line = (br < 0 ? rest : rest.slice(0, br)).trimEnd()
        const guarding = dropped < MAX_DROPPED
        if (guarding && br >= 0 && NOTE_LINE.test(line)) {
          held = rest.slice(br + 1)
          dropped++
          continue
        }
        if (br < 0 && (!rest || (guarding && mayBecomeNote(rest)))) return ''
        open = true
        // After a dropped copy the reply starts at its first word, not at the blank lines that
        // separated it from the note.
        const out = dropped ? rest : held
        held = ''
        return out
      }
    },
    end() {
      if (open) return ''
      open = true
      const all = held
      held = ''
      if (dropped < MAX_DROPPED && NOTE_LINE.test(all.trim())) {
        dropped++
        return ''
      }
      return dropped ? all.trimStart() : all
    }
  }
}
