import type { ParamName } from '../lib/formula'
import { shortUnit } from '../lib/units'
import EditableField from './EditableField'
import FieldLink from './FieldLink'
import { useAmountEditor } from './useAmountEditor'
import { useFlowNote } from './useFlowNote'

/** The production exchange the block edits — the process's own, the one every other flow is per. */
interface ReferenceFlow {
  uid: string
  amount: number
  formula: string | null
  comment: string | null
  input: { name: string | null; code: string }
}

interface Props {
  /** The reference product's name and unit, both fields of the process. */
  product: string | null
  unit: string | null
  flow: ReferenceFlow | undefined
  /** Without its own exchange: whether the process has production exchanges at all (listed below as rows). */
  otherProduction?: boolean
  readOnly: boolean
  /** Known units for the unit field, and whether it is restricted to them (Settings → Modelling). */
  unitVocab: string[]
  restrictUnits: boolean
  params: ParamName[] | null
  /** The backend's warning after a unit change, shown in the block while that unit stands. */
  unitNotice: string | null
  onField: (field: 'product' | 'unit', value: string) => void
  onAmount: (uid: string, amount: number) => void
  onFormula: (uid: string, formula: string | null) => void
  onComment: (uid: string, comment: string) => void
  onShowProperties: () => void
}

/**
 * A process's reference product as one block: what it makes, how much of it, in which unit — the
 * amount every input and output below is per. Name, amount and unit sat in three places of the inspector
 * before (a product field at the top, the unit beside the location, the production row above the flows),
 * and the reader had to put them together.
 *
 * A negative amount makes the process a treatment (the ecoinvent convention): every exchange that
 * supplies it then carries a negative amount. The heading says so, because nothing else on the screen does.
 */
export default function ReferenceProduct(props: Props): JSX.Element {
  const treatment = (props.flow?.amount ?? 0) < 0
  return (
    <>
      <div className="flow-head">
        Reference product
        {treatment ? (
          <span
            className="ref-badge"
            title="Negative reference amount: a treatment process. Processes that send it their waste take it in with a negative amount."
          >
            Treatment
          </span>
        ) : null}
        <FieldLink
          label="Properties"
          title={props.readOnly ? 'View flow properties' : 'View / edit flow properties'}
          onClick={props.onShowProperties}
        />
      </div>
      {props.flow ? (
        // Keyed by the exchange: the library sheet mounts the editor without a key, and a formula draft left
        // in one process's field must not turn up in the next one's.
        <ReferenceBody key={props.flow.uid} {...props} flow={props.flow} treatment={treatment} />
      ) : (
        // Without an exchange of its own (an odd import) a process still has a product and a unit, to read
        // or to correct; only the amount needs the exchange.
        <div className={`refblock${props.readOnly ? ' ro' : ''}`}>
          {props.readOnly ? (
            <div className="refline">
              <span className="ref-name">{props.product ?? '—'}</span>
              <span />
              <span className="flow-unit" title={props.unit ?? undefined}>
                {shortUnit(props.unit) ?? ''}
              </span>
              <span />
            </div>
          ) : (
            <>
              <ProductField {...props} />
              <UnitField {...props} />
            </>
          )}
          <p className="empty">
            {props.otherProduction
              ? 'No production exchange of its own — its outputs are listed below.'
              : 'No production exchange.'}
          </p>
          {props.unitNotice ? <p className="settings-hint warn">{props.unitNotice}</p> : null}
        </div>
      )}
    </>
  )
}

/** The two fields of the block that are fields of the process, not of its exchange. */
function ProductField({ product, onField }: Pick<Props, 'product' | 'onField'>): JSX.Element {
  return (
    <EditableField
      value={product}
      readOnly={false}
      ariaLabel="Reference product"
      placeholder="What the process makes, e.g. PET bottle"
      onSave={(v) => onField('product', v)}
    />
  )
}
function UnitField({
  unit,
  unitVocab,
  restrictUnits,
  onField
}: Pick<Props, 'unit' | 'unitVocab' | 'restrictUnits' | 'onField'>): JSX.Element {
  return (
    <EditableField
      value={unit}
      readOnly={false}
      ariaLabel="Unit"
      suggestions={unitVocab}
      restrict={restrictUnits}
      onSave={(v) => onField('unit', v)}
    />
  )
}

/** The block under the heading. Its own component so its hooks only run when there is an exchange. */
function ReferenceBody({
  product,
  unit,
  flow,
  readOnly,
  unitVocab,
  restrictUnits,
  params,
  unitNotice,
  onField,
  onAmount,
  onFormula,
  onComment,
  treatment
}: Props & { flow: ReferenceFlow; treatment: boolean }): JSX.Element {
  const amount = useAmountEditor({ flow, readOnly, reference: true, params, onAmount, onFormula })
  const note = useFlowNote({ comment: flow.comment, readOnly, onSave: (c) => onComment(flow.uid, c) })

  if (readOnly) {
    // One line, like the flows under it: a background dataset is read, not edited.
    const name = product?.trim() || flow.input.name || flow.input.code
    return (
      <div className="refblock ro">
        <div className="refline">
          <span className="ref-name" title={name}>
            {name}
          </span>
          {amount.cell}
          {/* The canvas arrows' short form (kg, kWh, tkm); the stored long form rides in the tooltip. */}
          <span className="flow-unit" title={unit ?? undefined}>
            {shortUnit(unit) ?? ''}
          </span>
          {note.button ?? <span />}
        </div>
        {note.body}
      </div>
    )
  }
  return (
    <div className="refblock">
      <ProductField product={product} onField={onField} />
      <div className="refline">
        {amount.cell}
        <UnitField unit={unit} unitVocab={unitVocab} restrictUnits={restrictUnits} onField={onField} />
        {note.button ?? <span />}
      </div>
      {amount.editor}
      {note.body}
      <p className="ref-hint">
        Every input and output below is per this amount.
        {treatment
          ? ' A treatment: processes that send it their waste take it in with a negative amount.'
          : ''}
      </p>
      {unitNotice ? <p className="settings-hint warn">{unitNotice}</p> : null}
    </div>
  )
}
