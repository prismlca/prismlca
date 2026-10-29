import { useState } from 'react'
import { PencilIcon } from '../components/icons'
import type { AskQuestion } from './askCards'

/**
 * Answering an ask_user form: which options are picked, and each question's answer in the user's
 * own words. Shared by the chat's question card and the external-agents drawer's, so a typed answer
 * means the same thing to the agent whichever window it came from.
 *
 * Under every question's options sits "Something else…": closed it is one quiet row, opened it is a
 * text field whose words count as that question's answer. The options are the agent's guesses at
 * what the user will say; the field is for when none of them fits. `ownWords` tells main which
 * answers were typed, so the agent reads them as the user's words and not as one of its labels.
 */

/** One question's answer in the user's own words: whether its field is open, and what is typed. */
export interface OwnAnswer {
  open: boolean
  text: string
}

export function useAskAnswers(questions: AskQuestion[]): {
  picked: (qi: number, oi: number) => boolean
  own: (qi: number) => OwnAnswer | undefined
  pick: (qi: number, oi: number) => void
  openOwn: (qi: number) => void
  setOwnField: (qi: number, change: Partial<OwnAnswer>) => void
  complete: boolean
  answers: () => { answers: string[][]; ownWords: boolean[] }
} {
  // Selection per question; a set so multi_select works the same as before.
  const [sel, setSel] = useState<Record<number, Set<number>>>({})
  const [own, setOwn] = useState<Record<number, OwnAnswer>>({})
  /** The typed answer that counts: only from an open field, so closing it withdraws the text. */
  const ownText = (qi: number): string => (own[qi]?.open ? own[qi].text.trim() : '')
  const setOwnField = (qi: number, change: Partial<OwnAnswer>): void =>
    setOwn((o) => ({ ...o, [qi]: { ...(o[qi] ?? { open: false, text: '' }), ...change } }))
  const pick = (qi: number, oi: number): void => {
    const multi = questions[qi]?.multiSelect
    setSel((s) => {
      const cur = new Set(s[qi] ?? [])
      if (multi) {
        if (cur.has(oi)) cur.delete(oi)
        else cur.add(oi)
      } else {
        cur.clear()
        cur.add(oi)
      }
      return { ...s, [qi]: cur }
    })
    // A single choice and an own answer exclude each other. The text stays for a reopen.
    if (!multi && own[qi]?.open) setOwnField(qi, { open: false })
  }
  const openOwn = (qi: number): void => {
    setOwnField(qi, { open: true })
    if (!questions[qi]?.multiSelect) setSel((s) => ({ ...s, [qi]: new Set() }))
  }
  return {
    picked: (qi, oi) => !!sel[qi]?.has(oi),
    own: (qi) => own[qi],
    pick,
    openOwn,
    setOwnField,
    // Every question needs an answer before the form can go back; a half-answered form would leave
    // the agent guessing which half it got.
    complete: questions.every((_, qi) => (sel[qi]?.size ?? 0) > 0 || !!ownText(qi)),
    answers: () => ({
      answers: questions.map((q, qi) => [
        ...q.options.filter((_, oi) => sel[qi]?.has(oi)).map((o) => o.label),
        ...(ownText(qi) ? [ownText(qi)] : [])
      ]),
      ownWords: questions.map((_, qi) => !!ownText(qi))
    })
  }
}

/**
 * A question's "Something else…" row: the quiet button while closed, the text field once opened.
 * The field grows with its text. Enter sends the card once every question is answered, as the chat
 * input does; Shift+Enter breaks the line, Escape closes the field (and only the field, not the
 * dialog around it). A card without an Answer button gets a Send beside the field.
 */
export function OwnAnswerRow({
  question,
  own,
  withSend,
  canSubmit,
  onOpen,
  onChange,
  onClose,
  onSubmit
}: {
  question: string
  own: OwnAnswer | undefined
  withSend: boolean
  canSubmit: boolean
  onOpen: () => void
  onChange: (text: string) => void
  onClose: () => void
  onSubmit: () => void
}): JSX.Element {
  if (!own?.open)
    return (
      <button type="button" className="chat-ask-own" onClick={onOpen}>
        <PencilIcon />
        Something else…
      </button>
    )
  return (
    <div className={`chat-ask-own-box${own.text.trim() ? ' on' : ''}`}>
      <div className="chat-ask-own-head">
        <PencilIcon />
        Your own answer
      </div>
      <div className="chat-ask-own-row">
        <textarea
          autoFocus
          rows={1}
          value={own.text}
          placeholder="Type your answer…"
          aria-label={`Your own answer to: ${question}`}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              onClose()
            } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (canSubmit) onSubmit()
            }
          }}
        />
        {withSend ? (
          <button type="button" className="chat-ask-send" disabled={!own.text.trim()} onClick={onSubmit}>
            Send
          </button>
        ) : null}
      </div>
    </div>
  )
}
