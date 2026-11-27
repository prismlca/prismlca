import { ModelIcon, SlidersIcon } from '../components/icons'

/** An exchange whose formula names the parameter. */
export interface ExchangeUse {
  activity_code: string
  activity_name: string
  input: string
  formula: string
}
/** Another parameter whose formula names it. */
export interface ParamUse {
  name: string
  formula: string
}

/**
 * The "Used by" cell of a parameter row: who depends on this number. Without it, changing a parameter is a
 * blind edit and deciding whether one is still needed means reading every formula in the model by hand —
 * and an unused parameter is worth seeing, because it is usually a leftover.
 *
 * Each entry is a way there: a process opens on the canvas, a parameter is shown on this page. The two
 * carry the icons of their pages in the navigation, so a link says where it goes before it is clicked.
 */
export default function ParamUsedBy({
  exchanges,
  params,
  onJumpToProcess,
  onShowParam,
  shown
}: {
  exchanges?: ExchangeUse[]
  params?: ParamUse[]
  /** Open the Model page with this process selected and centred. */
  onJumpToProcess?: (code: string) => void
  /** Bring this parameter's row into view and light it. */
  onShowParam: (name: string) => void
  /** Whether this page has the parameter, so a link to it leads somewhere. */
  shown: (name: string) => boolean
}): JSX.Element {
  // One entry per process, however many of its exchanges the formula drives.
  const drives = exchanges ?? []
  const processes = [...new Map(drives.map((u) => [u.activity_code, u])).values()]
  return (
    <span className="pc-uses">
      {processes.map((u) => {
        const n = drives.filter((x) => x.activity_code === u.activity_code).length
        return (
          <button
            key={u.activity_code}
            className="pc-use"
            title={`Jump to “${u.activity_name}” on the canvas — drives ${n} ${n === 1 ? 'input' : 'inputs'} (${u.formula})`}
            disabled={!onJumpToProcess}
            onClick={() => onJumpToProcess?.(u.activity_code)}
          >
            <ModelIcon />
            <span className="t">{u.activity_name}</span>
            {n > 1 ? <span className="n">{n}×</span> : null}
          </button>
        )
      })}
      {/* A parameter behind another parameter drives no exchange of its own — a volume and a density
          behind a mass. Saying "No process" about it was true and read as "delete me". */}
      {(params ?? []).map((u) => (
        <button
          key={u.name}
          className="pc-use"
          aria-label={`Show parameter ${u.name}`}
          title={`Show “${u.name}” — ${u.name} = ${u.formula}`}
          disabled={!shown(u.name)}
          onClick={() => onShowParam(u.name)}
        >
          <SlidersIcon />
          <span className="t">{u.name}</span>
        </button>
      ))}
      {!processes.length && !params?.length ? (
        <span className="pc-use-none" title="No formula in this model references it">
          Nothing
        </span>
      ) : null}
    </span>
  )
}
