import { useState } from 'react'
import type { ConfirmSpec } from '../views/ConfirmDialog'
import type { TagGroup } from '../lib/server/routes'
import EscapeCloser from './EscapeCloser'
import TagAdoptRow from './TagAdoptRow'

/**
 * Tag-group management window (toolbar "Tag" button): create/delete the open model's groups and their
 * tags. Assigning tags to processes stays on the node tag buttons (TagMenu) — deliberately
 * not possible here. Group/value deletion cascades (untags every process of the model), hence the
 * confirms — except for a tag no process carries, which goes without a question: nothing is untagged.
 * Every confirm also says what the step touches besides the tags: the saved breakdowns and reports.
 *
 * The one action here that is not taxonomy is **Group on canvas**: it draws one group box per tag of
 * that group. It belongs here rather than on the canvas because the *tag group* is what you point at —
 * on the canvas there would be nothing to click. Whether it can be done at all is the caller's
 * question (a process carrying two tags of one group has no single box), so this only asks.
 */
export default function TagManager({
  groups,
  otherModels,
  onAdopt,
  onClose,
  onGroupByTags,
  onCreateGroup,
  onDeleteGroup,
  onAddValue,
  onRemoveValue,
  onMergeValue,
  onMergeGroup,
  describeChange,
  confirm
}: {
  groups: TagGroup[]
  /** The other models of the workspace, to take tag groups over from. */
  otherModels: string[]
  onAdopt: (source: string) => void
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
  /** What a merge into `into` or a delete (`into` null) touches besides the tags — of a value `value`, of a
   *  group `null` — as one sentence for its confirm, '' when nothing. Read before the confirm opens, so it
   *  can be weighed. */
  describeChange: (group: string, value: string | null, into: string | null) => Promise<string>
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
              This model’s tag groups and their tags. Assign tags to a process via the tag button on its box
              on the canvas. Merging a tag or a group retags its processes; deleting untags them.
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
          {groups.map((g) => (
            <div className="tagman-group" key={g.name}>
              <div className="tagman-head">
                <span className="tagman-dot" style={{ background: g.color }} />
                <span className="tagman-name">{g.name}</span>
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
                        void describeChange(g.name, null, into).then((also) =>
                          confirm({
                            title: 'Merge tag groups',
                            message: `Merge "${g.name}" into "${into}"? Its tags move to "${into}" (values are added there as needed) and "${g.name}" disappears.${also ? ` ${also}` : ''} Undoable.`,
                            confirmLabel: 'Merge',
                            onConfirm: () => onMergeGroup(g.name, into)
                          })
                        )
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
                    void describeChange(g.name, null, null).then((also) =>
                      confirm({
                        title: 'Delete tag group',
                        message: `Delete the group "${g.name}" and remove its tags from all processes?${also ? ` ${also}` : ''}`,
                        confirmLabel: 'Delete',
                        danger: true,
                        onConfirm: () => onDeleteGroup(g.name)
                      })
                    )
                  }
                >
                  ✕
                </button>
              </div>
              <div className="tagman-values">
                {g.values.map((v) => (
                  <span
                    key={v}
                    className={`tagman-chip${g.unused?.includes(v) ? ' unused' : ''}`}
                    title={g.unused?.includes(v) ? 'No process of this model carries this tag' : undefined}
                  >
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
                            void describeChange(g.name, v, into).then((also) =>
                              confirm({
                                title: 'Merge tags',
                                message: `Merge "${v}" into "${into}" in "${g.name}"? Every process tagged "${v}" is retagged "${into}"; "${v}" disappears from the group.${also ? ` ${also}` : ''} Undoable.`,
                                confirmLabel: 'Merge',
                                onConfirm: () => onMergeValue(g.name, v, into)
                              })
                            )
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
                      title={
                        g.unused?.includes(v)
                          ? 'Remove this tag (no process carries it)'
                          : 'Remove this tag (untags every process carrying it)'
                      }
                      aria-label={`Remove tag ${v}`}
                      onClick={() =>
                        g.unused?.includes(v)
                          ? onRemoveValue(g.name, v)
                          : void describeChange(g.name, v, null).then((also) =>
                              confirm({
                                title: 'Remove tag',
                                message: `Remove "${v}" from "${g.name}" and untag all processes carrying it?${also ? ` ${also}` : ''}`,
                                confirmLabel: 'Remove',
                                danger: true,
                                onConfirm: () => onRemoveValue(g.name, v)
                              })
                            )
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
          <TagAdoptRow models={otherModels} onAdopt={onAdopt} />
        </div>
      </div>
    </div>
  )
}
