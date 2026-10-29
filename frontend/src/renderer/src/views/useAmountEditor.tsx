import { useEffect, useRef, useState } from 'react'
import { useSettings, fmtSig } from '../lib/settings'
import FormulaInput from '../components/FormulaInput'
import type { ParamName } from '../lib/formula'
import { parseAmount } from '../lib/numberFormat'
import { copyNumber } from '../lib/copyNumber'
import { IdleRoundedInput } from '../components/IdleRoundedInput'

/**
 * The amount of one exchange as it is edited: a typed number or, with fx, a formula over the model's
 * parameters (Umberto "specifications"). The flow rows and the reference product both use it, so the two
 * read, refuse and commit an amount the same way.
 *
 * Returns two parts, like useFlowNote, because the caller decides where they go: the `cell` (the field
 * and its fx toggle, or the read-only figure) and the full-width formula `editor`, which a flow row lets
 * span its whole grid row and the reference block puts under its line.
 */
export function useAmountEditor({
  flow,
  readOnly,
  reference,
  params,
  onAmount,
  onFormula
}: {
  flow: { uid: string; amount: number; formula: string | null }
  readOnly: boolean
  /** The reference amount: zero is refused, since every other flow of the process is per this amount. */
  reference: boolean
  /** The model's parameters, for the formula field's completion and name check; null while unknown. */
  params: ParamName[] | null
  onAmount: (uid: string, amount: number) => void
  onFormula: (uid: string, formula: string | null) => void
}): { cell: JSX.Element; editor: JSX.Element | null } {
  const { round } = useSettings()
  const [mode, setMode] = useState<'amount' | 'formula'>(flow.formula ? 'formula' : 'amount')
  const [amt, setAmt] = useState(String(flow.amount ?? ''))
  const [fx, setFx] = useState(flow.formula ?? '')
  const [fxOpen, setFxOpen] = useState(false) // formula field expanded to the full-width multi-line editor
  useEffect(() => {
    setAmt(String(flow.amount ?? ''))
    setFx(flow.formula ?? '')
    setMode(flow.formula ? 'formula' : 'amount')
  }, [flow.amount, flow.formula])

  // Formulas are single expressions — collapse any pasted newlines so the value stays valid.
  const cleanFx = (s: string): string => s.replace(/\s+/g, ' ').trim()
  // Said while it is being typed, not after the commit swallowed it. A reference amount of zero is
  // refused as well: every other flow of the process is per this amount, and the matrix cannot scale it.
  const typed = amt.trim() === '' ? undefined : parseAmount(amt)
  const zeroRef = reference && typed === 0
  const amtBad = typed === null || zeroRef
  // Escape sets the field back and blurs; the blur's commit still runs with the render's old `amt`
  // and used to write the abandoned value. The flag makes that commit a no-op.
  const abandoning = useRef(false)
  const commit = (): void => {
    if (abandoning.current) {
      abandoning.current = false
      return
    }
    if (mode === 'formula') {
      const v = cleanFx(fx)
      if (v && v !== (flow.formula ?? '')) onFormula(flow.uid, v)
    } else {
      const n = parseAmount(amt)
      // Unreadable, or empty: put the stored amount back. This used to be `Number(amt)`, and
      // `Number('')` is 0, not NaN — so clearing the field and tabbing away wrote a zero over the
      // value, and so did every keystroke the old number input refused.
      if (n === null || (reference && n === 0)) return setAmt(String(flow.amount ?? ''))
      setAmt(String(n)) // "0,5" reads back as "0.5": the field shows what was understood
      if (n !== flow.amount) onAmount(flow.uid, n)
    }
  }

  // A double-click on a figure that cannot be edited (a background dataset's) copies the stored amount —
  // unrounded, whatever the display rounds to. In an editable field the double-click stays what it is
  // everywhere else: selecting the number to type over it.
  const cell = readOnly ? (
    <div
      className="flow-amt ro"
      title={flow.formula ?? undefined}
      onDoubleClick={(e) => void copyNumber(flow.amount, e)}
    >
      {fmtSig(flow.amount, round.io)}
      {flow.formula ? (
        <span className="fx-mark" title={flow.formula}>
          ƒ
        </span>
      ) : null}
    </div>
  ) : (
    <div className="flow-amt">
      {mode === 'formula' ? (
        // Compact display; clicking/focusing opens the full-width multi-line editor below
        // (the flows list scrolls and would clip a popover, so the editor expands in-flow).
        <input
          className="fx-input"
          value={fx}
          readOnly
          placeholder="e.g. mass * 2"
          title="Click to edit the formula"
          onFocus={() => setFxOpen(true)}
          onClick={() => setFxOpen(true)}
        />
      ) : (
        // Text, not `type="number"`: that input let Chromium's locale decide what a comma
        // means, so the same keystrokes gave 0.5 on a German machine and 5 on an English one.
        // `parseAmount` decides instead, and it decides the same way everywhere. Rounded to the
        // Inputs / Outputs digits while idle, in full while edited — but only when the text IS the
        // stored amount: a refused or not-yet-written entry is shown as typed.
        <IdleRoundedInput
          idle={amt === String(flow.amount ?? '') ? fmtSig(flow.amount, round.io) : null}
          type="text"
          inputMode="decimal"
          className={amtBad ? 'refused' : undefined}
          aria-invalid={amtBad ? true : undefined}
          title={
            zeroRef
              ? 'The reference amount cannot be zero — every other flow is per this amount'
              : amtBad
                ? 'Not a number — use 0.5 or 0,5'
                : undefined
          }
          value={amt}
          onChange={(e) => setAmt(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            // Escape abandons the edit: restore the stored amount, then blur past the commit.
            if (e.key === 'Escape') {
              abandoning.current = true
              setAmt(String(flow.amount ?? ''))
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
      )}
      <button
        className={`fxtog${mode === 'formula' ? ' on' : ''}`}
        title="Parameterise this flow with a formula (use global variable names)"
        onClick={() => {
          // Either way the field starts from what is STORED. Text typed and never written used to
          // survive a toggle in this row's state, so switching fx off and on again showed a
          // formula the model did not have, with the warnings about its names still under it.
          setFx(flow.formula ?? '')
          if (mode === 'formula') {
            setMode('amount')
            setFxOpen(false)
            if (flow.formula) onFormula(flow.uid, null) // clearing reverts to a fixed amount
          } else {
            setMode('formula')
            setFxOpen(true)
          }
        }}
      >
        fx
      </button>
    </div>
  )

  const editor =
    !readOnly && mode === 'formula' && fxOpen ? (
      <FormulaInput
        className="fx-expand"
        value={fx}
        autoFocus
        params={params}
        placeholder="e.g. mass * (1 - recycled_share)"
        onChange={setFx}
        onCommit={(problem) => {
          // A refused formula stays open, with the problem under it: the text was typed here, and
          // here is where it gets fixed. Only a clean one closes the editor and is written.
          if (problem) return
          setFxOpen(false)
          commit()
        }}
        onAbandon={() => {
          setFx(flow.formula ?? '')
          setFxOpen(false)
        }}
      />
    ) : null

  return { cell, editor }
}
