import { setAS, useAppSettings } from '../../lib/appSettings'

/** May PrismLCA hold off the computer's idle sleep while long work runs? On by default — main decides
 *  when, from what is running and whether the computer is plugged in (main/keepAwake.ts). */
export function KeepAwakeFields(): JSX.Element {
  const on = useAppSettings().keepAwake !== false
  return (
    <>
      <h4>Sleep</h4>
      <label className="settings-field">
        <span>Keep the computer awake during long tasks</span>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={on}
          onChange={(e) => setAS({ keepAwake: e.target.checked })}
        />
      </label>
      <p className="settings-hint">
        While PrismLCA imports a database, builds the search index, calculates, or the assistant or report
        writer is working, the computer does not go to sleep on its own. Only while plugged in; the screen may
        still turn off.
      </p>
    </>
  )
}
