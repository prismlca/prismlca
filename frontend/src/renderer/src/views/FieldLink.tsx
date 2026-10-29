import { ArrowRightIcon } from '../components/icons'

/** A quiet text link that sits on a field's label line, right-aligned (the inspector's Details and
 *  Properties). One component so both look alike; the field puts it beside its label. */
export default function FieldLink({
  label,
  title,
  onClick
}: {
  label: string
  title: string
  onClick: () => void
}): JSX.Element {
  return (
    <button type="button" className="field-link" title={title} onClick={onClick}>
      <span className="field-link-text">{label}</span>
      <ArrowRightIcon />
    </button>
  )
}
