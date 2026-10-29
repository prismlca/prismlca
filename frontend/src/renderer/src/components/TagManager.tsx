import { Fragment, useState } from 'react'
import type { ConfirmSpec } from '../views/ConfirmDialog'
import EscapeCloser from './EscapeCloser'

export interface TagGroup {
  name: string
  color: string
  values: string[]
  /** The open model carries tags of this group (lib/tagGroupsUsed.ts): listed first, marked. */
  used?: boolean
}

/**
 * Tag-group management window (toolbar "Tag" button): create/delete groups and their allowed
 * values. Assigning tags to processes stays on the node tag buttons (TagMenu) — deliberately
 * not possible here. Group/value deletion cascades (untags every process), hence the confirms.
 *
 * The one action here that is not taxonomy is **Group on canvas**: it draws one group box per tag of
 * that group. It belongs here rather than on the canvas because the *tag group* is what you point at —
 * on the canvas there would be nothing to click. Whether it can be done at all is the caller's
 * question (a process carrying two tags of one group has no single box), so this only asks.
 */
export default function TagManager({
  groups,
  onClose,
  onGroupByTags,
  onCreateGroup,
  onDeleteGroup,
  onAddValue,
  onRemoveValue,
  onMergeValue,
  onMergeGroup,
  confirm
}: {
  groups: TagGroup[]
  onClose: () => void
  /** Draw one group box on the canvas per tag of this group; the caller may refuse (see Workbench). */
  onGroupByTags: (group: string) => void
  onCreateGroup: (name: string) => void
  onDeleteGroup: (name: string) => void
  onAddValue: (group: string, value: string) => void
  onRemoveValue: (group: string, value: string) => void
  /** Fold a value into another of the same group: its processes are retagged, the value disappears. */
  onMergeValue: (group: string, value: string, into: string) => void
  /** Fold a whole group into another: values and tags move, the group disappears. */
  onMergeGroup: (name: string, into: string) => void
  confirm: (spec: ConfirmSpec) => void
}): JSX.Element {
  const [newGroup, setNewGroup] = useState('')
  const [newValue, setNewValue] = useState<Record<string, string>>({})
  // Which chip or group head currently shows its "merge into…" picker (one at a time).
  const [merging, setMerging] = useState<{ kind: 'value' | 'group'; group: string; value?: string } | null>(
    null
  )

  const addGroup = (): void => {
    const name = newGroup.trim()
    if (!name) return
    onCreateGroup(name)
    setNewGroup('')
  }
  const addValue = (group: string): void => {
    const value = (newValue[group] ?? '').trim()
    if (!value) return
    onAddValue(group, value)
    setNewValue((m) => ({ ...m, [group]: '' }))
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={onClose} />
      <div className="modal sheet tagman-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-head-grow">
            <h3>Tags</h3>
            <p>
              Manage tag groups and their tags. Assign tags to a process via the tag button on its box on the
              canvas. Merging a tag or a group retags its processes; deleting untags them.
            </p>
          </div>
          <button className="sheet-x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="sheet-body tagman-body">
          {groups.length === 0 ? (
            <div className="tagman-empty">No tag groups yet — create one below.</div>
          ) : null}
          {groups.map((g, i) => (
            <Fragment key={g.name}>
              {/* Where the open model's groups end and the rest of the workspace begins. */}
              {!g.used && i > 0 && groups[i - 1].used ? (
                <div className="tagman-others">Other groups in this workspace</div>
              ) : null}
              <div className="tagman-group">
                <div className="tagman-head">
                  <span className="tagman-dot" style={{ background: g.color }} />
                  <span className="tagman-name">
                    {g.name}
                    {g.used ? (
                      <span className="tag-used-chip" title="This model carries tags of this group">
                        used in this model
                      </span>
                    ) : null}
                  </span>
                  <button
                    className="btn sm tagman-group-btn"
                    disabled={g.values.length === 0}
                    title={
                      g.values.length === 0
                        ? 'Add a tag to this group first'
                        : 'Draw one group box on the canvas per tag of this group'
                    }
                    onClick={() => onGroupByTags(g.name)}
                  >
                    Group on canvas
                  </button>
                  {groups.length > 1 ? (
                    merging?.kind === 'group' && merging.group === g.name ? (
                      <select
                        className="search-sel tagman-merge-sel"
                        autoFocus
                        defaultValue=""
                        aria-label={`Merge group ${g.name} into`}
                        onBlur={() => setMerging(null)}
                        onChange={(e) => {
                          const into = e.target.value
                          setMerging(null)
                          if (!into) return
                          confirm({
                            title: 'Merge tag groups',
                            message: `Merge "${g.name}" into "${into}"? Its tags move to "${into}" (values are added there as needed) and "${g.name}" disappears. Undoable.`,
                            confirmLabel: 'Merge',
                            onConfirm: () => onMergeGroup(g.name, into)
                          })
                        }}
                      >
                        <option value="">Merge into…</option>
                        {groups
                          .filter((o) => o.name !== g.name)
                          .map((o) => (
                            <option key={o.name} value={o.name}>
                              {o.name}
                            </option>
                          ))}
                      </select>
                    ) : (
                      <button
                        className="btn sm tagman-group-btn"
                        title="Fold this group into another one: its tags move, nothing is untagged"
                        onClick={() => setMerging({ kind: 'group', group: g.name })}
                      >
                        Merge into…
                      </button>
                    )
                  ) : null}
                  <button
                    className="tagman-del"
                    title="Delete this group (untags every process)"
                    onClick={() =>
                      confirm({
                        title: 'Delete tag group',
                        message: `Delete the group "${g.name}" and remove its tags from all processes?`,
                        confirmLabel: 'Delete',
                        danger: true,
                        onConfirm: () => onDeleteGroup(g.name)
                      })
                    }
                  >
                    ✕
                  </button>
                </div>
                <div className="tagman-values">
                  {g.values.map((v) => (
                    <span key={v} className="tagman-chip">
                      {v}
                      {g.values.length > 1 ? (
                        merging?.kind === 'value' && merging.group === g.name && merging.value === v ? (
                          <select
                            className="search-sel tagman-merge-sel"
                            autoFocus
                            defaultValue=""
                            aria-label={`Merge tag ${v} into`}
                            onBlur={() => setMerging(null)}
                            onChange={(e) => {
                              const into = e.target.value
                              setMerging(null)
                              if (!into) return
                              confirm({
                                title: 'Merge tags',
                                message: `Merge "${v}" into "${into}" in "${g.name}"? Every process tagged "${v}" is retagged "${into}"; "${v}" disappears from the group. Undoable.`,
                                confirmLabel: 'Merge',
                                onConfirm: () => onMergeValue(g.name, v, into)
                              })
                            }}
                          >
                            <option value="">into…</option>
                            {g.values
                              .filter((o) => o !== v)
                              .map((o) => (
                                <option key={o} value={o}>
                                  {o}
                                </option>
                              ))}
                          </select>
                        ) : (
                          <button
                            className="tagman-chip-x"
                            title="Merge this tag into another one of the group (retags its processes)"
                            aria-label={`Merge tag ${v}`}
                            onClick={() => setMerging({ kind: 'value', group: g.name, value: v })}
                          >
                            ⇢
                          </button>
                        )
                      ) : null}
                      <button
                        className="tagman-chip-x"
                        title="Remove this tag (untags every process carrying it)"
                        onClick={() =>
                          confirm({
                            title: 'Remove tag',
                            message: `Remove "${v}" from "${g.name}" and untag all processes carrying it?`,
                            confirmLabel: 'Remove',
                            danger: true,
                            onConfirm: () => onRemoveValue(g.name, v)
                          })
                        }
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  <span className="tagman-addvalue">
                    <input
                      placeholder="New tag…"
                      value={newValue[g.name] ?? ''}
                      onChange={(e) => setNewValue((m) => ({ ...m, [g.name]: e.target.value }))}
                      onKeyDown={(e) => e.key === 'Enter' && addValue(g.name)}
                    />
                    <button
                      className="btn sm"
                      disabled={!(newValue[g.name] ?? '').trim()}
                      onClick={() => addValue(g.name)}
                    >
                      Add a tag
                    </button>
                  </span>
                </div>
              </div>
            </Fragment>
          ))}
          <div className="tagman-addgroup">
            <input
              placeholder="New group name (e.g. Life-cycle phase)"
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addGroup()}
            />
            <button className="btn sm primary" disabled={!newGroup.trim()} onClick={addGroup}>
              Add group
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
