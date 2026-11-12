import { useState } from 'react'
import { unitSymbol } from '../lib/units'
import UnitCombo from './UnitCombo'

/**
 * The search's unit filter: a field suggesting the units the ticked databases hold, short form first
 * ("kg · kilogram", most frequent first), the chosen units as chips, and one line saying what they do.
 * Always a hard filter, one unit as much as several: unlike a region, a unit has no proxy to rank behind
 * it. The values stay as the index writes them ("kilogram"); only what is shown is the short form.
 */
export default function UnitFilter({
  unitSel,
  unitOptions,
  addUnit,
  removeUnit,
  loadUnits,
  listing
}: {
  unitSel: string[]
  unitOptions: string[]
  addUnit: (u: string) => void
  removeUnit: (u: string) => void
  loadUnits: () => void
  /** A whole database is listed, not searched — the line under the chips is then said once for all filters. */
  listing: boolean
}): JSX.Element {
  const [typed, setTyped] = useState('')
  // The long form beside the short one, and only where they differ ("unit" has no short form).
  const longForm = (u: string): string | undefined => (unitSymbol(u) !== u ? u : undefined)
  return (
    <div className="region-box unit-box">
      <UnitCombo
        value={typed}
        units={unitOptions.filter((u) => !unitSel.includes(u))}
        onChange={setTyped}
        onPick={(u) => {
          addUnit(u)
          setTyped('')
        }}
        label={unitSymbol}
        describe={longForm}
        onFocus={loadUnits}
        max={60}
        ariaLabel="Filter units"
        placeholder="Filter units… (type to find)"
      />
      {unitSel.length ? (
        <>
          <div className="region-chips">
            {unitSel.map((u) => (
              <span key={u} className="rchip" title={u}>
                {unitSymbol(u)}
                <button onClick={() => removeUnit(u)} aria-label={`Remove ${unitSymbol(u)}`}>
                  ×
                </button>
              </span>
            ))}
          </div>
          {listing ? null : (
            <div className="region-note">
              Only datasets in {unitSel.map(unitSymbol).join(', ')} — others are hidden.
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}
