import { useLayoutEffect, useRef, useState } from 'react'

/** Space kept between the menu and the window edge. */
const EDGE = 8

/** Popover to assign one value per tag group to a process (opened from a node's 🏷 button). */
export default function TagMenu({
  pos,
  groups,
  current,
  inherited,
  onSet,
  onClose,
  onNewGroup,
  onNewValue
}: {
  pos: { x: number; y: number }
  /** `used`: the open model carries tags of this group (lib/tagGroupsUsed.ts) — listed first, marked. */
  groups: { name: string; color: string; values: string[]; used?: boolean }[]
  current: Record<string, string>
  /** Per group, the value a box inherits while its inputs hold none themselves (lib/occurrences.ts). */
  inherited?: Record<string, string>
  onSet: (group: string, value: string | null) => void
  onClose: () => void
  onNewGroup: (name: string) => void
  onNewValue: (group: string, value: string) => void
}): JSX.Element {
  // Inline inputs — Electron doesn't support window.prompt().
  const [newGroup, setNewGroup] = useState('')
  const [addingFor, setAddingFor] = useState<string | null>(null)
  const [newValue, setNewValue] = useState('')
  // Opened under the box's tag button, wherever that box is: near the right or bottom edge the menu ran
  // out of the window, and with many tag groups it was taller than the window anyway. Measured after
  // every render, because adding a group or opening an "add a tag" row changes its height.
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: pos.x, top: pos.y })
  // No dependency list on purpose (the height is the input, and it has no state); the comparison below
  // ends the cycle after one correction.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const left = Math.max(EDGE, Math.min(pos.x, window.innerWidth - EDGE - el.offsetWidth))
    const top = Math.max(EDGE, Math.min(pos.y, window.innerHeight - EDGE - el.offsetHeight))
    if (left !== place.left || top !== place.top) setPlace({ left, top })
  })
  return (
    <>
      <div
        className="ctx-backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div className="tagmenu" ref={ref} style={place} onClick={(e) => e.stopPropagation()}>
        <div className="tagmenu-title">Tags</div>
        {groups.length === 0 ? (
          <div className="tagmenu-empty">No tag groups yet — create one below.</div>
        ) : null}
        <div className="tagmenu-list">
          {groups.map((g) => (
            <div key={g.name}>
              <div className="tagmenu-row">
                <span className="tagmenu-dot" style={{ background: g.color }} />
                <span className="tagmenu-group" title={g.name}>
                  <span className="tagmenu-group-name">{g.name}</span>
                  {g.used ? (
                    <span className="tag-used-chip" title="This model carries tags of this group">
                      used
                    </span>
                  ) : null}
                </span>
                <select
                  className="search-sel"
                  value={current[g.name] ?? ''}
                  onChange={(e) => onSet(g.name, e.target.value || null)}
                >
                  <option value="">
                    {inherited?.[g.name] ? `— inherited: ${inherited[g.name]} —` : '— none —'}
                  </option>
                  {g.values.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
                <button
                  className="tagmenu-add"
                  title={`Add a tag to "${g.name}"`}
                  onClick={() => {
                    setAddingFor((cur) => (cur === g.name ? null : g.name))
                    setNewValue('')
                  }}
                >
                  ＋
                </button>
              </div>
              {addingFor === g.name ? (
                <div className="tagmenu-addrow">
                  <input
                    autoFocus
                    placeholder={`New tag for "${g.name}"…`}
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newValue.trim()) {
                        onNewValue(g.name, newValue.trim())
                        setNewValue('')
                        setAddingFor(null)
                      } else if (e.key === 'Escape') setAddingFor(null)
                    }}
                  />
                  <button
                    className="btn sm"
                    disabled={!newValue.trim()}
                    onClick={() => {
                      onNewValue(g.name, newValue.trim())
                      setNewValue('')
                      setAddingFor(null)
                    }}
                  >
                    Add a tag
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <div className="tagmenu-addrow tagmenu-newgroup">
          <input
            placeholder='New group (e.g. "Life-cycle phase")…'
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newGroup.trim()) {
                onNewGroup(newGroup.trim())
                setNewGroup('')
              }
            }}
          />
          <button
            className="btn sm primary"
            disabled={!newGroup.trim()}
            onClick={() => {
              onNewGroup(newGroup.trim())
              setNewGroup('')
            }}
          >
            Add group
          </button>
        </div>
      </div>
    </>
  )
}
