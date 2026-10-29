import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { invalidate } from '../lib/server/useQuery'
import Modal from '../components/Modal'
import ConfirmDialog, { type ConfirmSpec } from './ConfirmDialog'
import { AddIcon, CopyIcon, PencilIcon, TrashIcon } from '../components/icons'
import { mutationRunner } from '../lib/mutation'
import { errMsg } from '../lib/errors'
import EscapeCloser from '../components/EscapeCloser'
import LciaFactorEditor from './LciaFactorEditor'
import type { MethodDetail, Ref } from './lciaFactors'

interface FamMethod {
  method: string[]
  name: string
  unit: string
  num_cfs?: number | null
  editable: boolean
}
interface Family {
  family: string
  description: string
  custom: boolean
  methods: FamMethod[]
}
type Dialog =
  | { kind: 'duplicate' }
  | { kind: 'newMethod' }
  | { kind: 'newFamily' }
  | { kind: 'editFamily'; family: string; description: string }
  | { kind: 'renameMethod'; method: string[]; name: string }
  | null
interface DupSpec {
  src: string[]
  family: string
  name: string
}

/**
 * Manage custom, project-scoped LCIA methods: shipped methods are read-only and can only be
 * duplicated; a duplicate is editable — tweak factors, add/remove flows, and organise indicators
 * into named families with a short description.
 */
export default function LciaMethods({ onMethodsChanged }: { onMethodsChanged?: () => void }): JSX.Element {
  const [families, setFamilies] = useState<Family[]>([])
  const [editing, setEditing] = useState<MethodDetail | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setFamilies((await api<{ families: Family[] }>('GET', '/api/v1/lcia/families')).families)
  }, [])
  useEffect(() => {
    void load().catch((e) => setErr(errMsg(e)))
  }, [load])

  const run = mutationRunner({
    setError: setErr,
    after: async () => {
      await load()
      onMethodsChanged?.()
    }
  })

  const customFamilies = useMemo(() => families.filter((f) => f.custom).map((f) => f.family), [families])
  const ownFamilies = useMemo(() => families.filter((f) => f.custom), [families])

  const submitFamily = (values: Record<string, string>): void => {
    setDialog(null)
    const family = (values.family || '').trim()
    if (!family) return
    run(async () => {
      await api('POST', '/api/v1/lcia/family', { family, description: (values.description || '').trim() })
      invalidate('/api/v1/calc/methods')
    })
  }

  const submitEditFamily = (values: Record<string, string>): void => {
    const d = dialog
    setDialog(null)
    if (d?.kind !== 'editFamily') return
    const name = (values.name || '').trim()
    if (!name) return
    run(async () => {
      await api('POST', '/api/v1/lcia/family/edit', {
        old: d.family,
        name,
        description: (values.description || '').trim()
      })
      invalidate('/api/v1/calc/methods')
    })
  }

  const submitRenameMethod = (values: Record<string, string>): void => {
    const d = dialog
    setDialog(null)
    if (d?.kind !== 'renameMethod') return
    const name = (values.name || '').trim()
    if (!name) return
    run(async () => {
      const detail = await api<MethodDetail>('POST', '/api/v1/lcia/method/rename', { method: d.method, name })
      setEditing(detail)
    })
  }

  const submitNewMethod = (values: Record<string, string>): void => {
    setDialog(null)
    const family = (values.family || '').trim()
    const name = (values.name || '').trim()
    if (!family || !name) return
    run(async () => {
      const detail = await api<MethodDetail>('POST', '/api/v1/lcia/method', {
        family,
        name,
        unit: (values.unit || '').trim(),
        description: (values.description || '').trim() || null
      })
      setEditing(detail) // open the empty method so the user can add flows
    })
  }

  // Duplicate one or more source indicators into a (own) family, each with its own name.
  const runDuplicates = (dupes: DupSpec[]): void => {
    setDialog(null)
    if (!dupes.length) return
    run(async () => {
      let last: MethodDetail | null = null
      for (const d of dupes) {
        last = await api<MethodDetail>('POST', '/api/v1/lcia/duplicate', {
          src: d.src,
          family: d.family,
          name: d.name
        })
      }
      if (dupes.length === 1 && last) setEditing(last) // jump into editing a single copy
    })
  }

  const deleteFamily = (f: Family): void =>
    setConfirm({
      title: 'Delete family',
      message: `Delete the family “${f.family}” and its ${f.methods.length} custom method(s)? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () =>
        run(async () => {
          await api('POST', '/api/v1/lcia/family/delete', { family: f.family })
          invalidate('/api/v1/calc/methods')
          setEditing((e) => (e && e.method[0] === f.family ? null : e))
        })
    })

  const openEditor = (m: string[]): void =>
    void run(async () => {
      setEditing(await api<MethodDetail>('POST', '/api/v1/lcia/method-flows', { method: m }))
    })

  const setFactor = (ref: Ref, cf: number): void => {
    if (!editing) return
    run(async () => {
      const detail = await api<MethodDetail>('POST', '/api/v1/lcia/factor', {
        method: editing.method,
        ref,
        cf
      })
      setEditing(detail)
    })
  }
  const removeFlow = (ref: Ref): void => {
    if (!editing) return
    run(async () => {
      const detail = await api<MethodDetail>('POST', '/api/v1/lcia/flow/remove', {
        method: editing.method,
        ref
      })
      setEditing(detail)
    })
  }
  const deleteMethod = (m: FamMethod): void =>
    setConfirm({
      title: 'Delete method',
      message: `Delete the custom method “${m.name}”? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () =>
        run(async () => {
          await api('POST', '/api/v1/lcia/delete', { method: m.method })
          invalidate('/api/v1/calc/methods')
          setEditing((e) => (e && e.method.join(' · ') === m.method.join(' · ') ? null : e))
        })
    })

  return (
    <div className="lcia-methods">
      {err ? (
        <div className="wb-error" onClick={() => setErr(null)}>
          {err}
        </div>
      ) : null}

      <div className="lcia-mm-cols">
        {/* families + their methods */}
        <div className="lcia-mm-list card-plain">
          <div className="lcia-mm-actions">
            <button className="btn ico-label primary" onClick={() => setDialog({ kind: 'newMethod' })}>
              <AddIcon /> New method
            </button>
            <button
              className="btn ico-label"
              onClick={() => setDialog({ kind: 'duplicate' })}
              disabled={!families.length}
            >
              <CopyIcon /> Duplicate method
            </button>
            <button className="btn ico-label" onClick={() => setDialog({ kind: 'newFamily' })}>
              <AddIcon /> New family
            </button>
          </div>
          {ownFamilies.map((f) => (
            <div key={f.family} className="lcia-fam">
              <div className="lcia-fam-head">
                <span className="lcia-fam-name">{f.family}</span>
                <span className="lcia-fam-count">
                  {f.methods.length} {f.methods.length === 1 ? 'method' : 'methods'}
                </span>
                <span className="lcia-mrow-act">
                  <button
                    className="act-icon"
                    title="Edit family (name & description)"
                    aria-label="Edit family"
                    onClick={() =>
                      setDialog({ kind: 'editFamily', family: f.family, description: f.description })
                    }
                  >
                    <PencilIcon />
                  </button>
                  <button
                    className="act-icon danger"
                    title="Delete family and its methods"
                    aria-label="Delete family"
                    onClick={() => deleteFamily(f)}
                  >
                    <TrashIcon />
                  </button>
                </span>
              </div>
              {f.description ? <div className="lcia-fam-desc">{f.description}</div> : null}
              <div className="lcia-fam-methods">
                {f.methods.map((m) => {
                  const active = editing?.method.join(' · ') === m.method.join(' · ')
                  return (
                    <div
                      key={m.name}
                      className={`lcia-mrow clickable${active ? ' active' : ''}`}
                      onClick={() => openEditor(m.method)}
                      title="Edit this method’s factors"
                    >
                      <span className="lcia-mrow-name">{m.method[m.method.length - 1]}</span>
                      <span className="lcia-mrow-unit">{m.unit}</span>
                      <span className="lcia-mrow-act">
                        <button
                          className="act-icon"
                          title="Rename method"
                          aria-label="Rename method"
                          onClick={(e) => {
                            e.stopPropagation()
                            setDialog({
                              kind: 'renameMethod',
                              method: m.method,
                              name: m.method[m.method.length - 1]
                            })
                          }}
                        >
                          <PencilIcon />
                        </button>
                        <button
                          className="act-icon danger"
                          title="Delete method"
                          aria-label="Delete"
                          onClick={(e) => {
                            e.stopPropagation()
                            deleteMethod(m)
                          }}
                        >
                          <TrashIcon />
                        </button>
                      </span>
                    </div>
                  )
                })}
                {!f.methods.length ? <div className="lcia-fam-empty">No indicators yet.</div> : null}
              </div>
            </div>
          ))}
          {!ownFamilies.length ? (
            <p className="empty" style={{ padding: 0 }}>
              No custom methods yet. Use “Duplicate method” to copy a shipped indicator into your own family.
            </p>
          ) : null}
        </div>

        {/* factor editor */}
        <div className="lcia-mm-editor card-plain">
          {!editing ? (
            <p className="empty" style={{ padding: 0 }}>
              Click a method on the left to edit its factors, or create / duplicate one first.
            </p>
          ) : (
            // Keyed by the method, so another method opens with its own filter and sort.
            <LciaFactorEditor
              key={editing.method.join(' · ')}
              editing={editing}
              onClose={() => setEditing(null)}
              onSetFactor={setFactor}
              onRemoveFlow={removeFlow}
            />
          )}
        </div>
      </div>

      {dialog?.kind === 'duplicate' ? (
        <DuplicateDialog
          families={families}
          ownFamilies={customFamilies}
          onClose={() => setDialog(null)}
          onSubmit={runDuplicates}
        />
      ) : null}
      {dialog?.kind === 'newMethod' ? (
        <Modal
          title="New method"
          submitLabel="Create"
          onClose={() => setDialog(null)}
          onSubmit={submitNewMethod}
          fields={[
            {
              key: 'family',
              label: 'Family (your own — existing or new)',
              value: customFamilies[0] ?? 'My methods'
            },
            { key: 'name', label: 'Indicator name', value: '' },
            { key: 'unit', label: 'Unit (e.g. kg CO2-eq)', value: '' },
            { key: 'description', label: 'Family description (optional)', type: 'textarea', value: '' }
          ]}
        />
      ) : null}
      {dialog?.kind === 'renameMethod' ? (
        <Modal
          title="Rename method"
          submitLabel="Save"
          onClose={() => setDialog(null)}
          onSubmit={submitRenameMethod}
          fields={[{ key: 'name', label: 'Indicator name', value: dialog.name }]}
        />
      ) : null}
      {dialog?.kind === 'editFamily' ? (
        <Modal
          title="Edit family"
          submitLabel="Save"
          onClose={() => setDialog(null)}
          onSubmit={submitEditFamily}
          fields={[
            { key: 'name', label: 'Family name', value: dialog.family },
            { key: 'description', label: 'Short description', type: 'textarea', value: dialog.description }
          ]}
        />
      ) : null}
      {dialog?.kind === 'newFamily' ? (
        <Modal
          title="New family"
          submitLabel="Create"
          onClose={() => setDialog(null)}
          onSubmit={submitFamily}
          fields={[
            { key: 'family', label: 'Family name', value: '' },
            { key: 'description', label: 'Short description (optional)', type: 'textarea', value: '' }
          ]}
        />
      ) : null}
      {confirm ? <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} /> : null}
    </div>
  )
}

/** Duplicate dialog: pick a source family, tick one or more of its indicators, then choose the
 * target (own) family and a name for each copy. */
function DuplicateDialog({
  families,
  ownFamilies,
  onClose,
  onSubmit
}: {
  families: Family[]
  ownFamilies: string[]
  onClose: () => void
  onSubmit: (dupes: DupSpec[]) => void
}): JSX.Element {
  const [srcFamily, setSrcFamily] = useState(families[0]?.family ?? '')
  const [indQuery, setIndQuery] = useState('')
  const [names, setNames] = useState<Record<string, string>>({})
  const [target, setTarget] = useState(ownFamilies[0] ?? 'My methods')

  const srcMethods = useMemo(
    () => families.find((f) => f.family === srcFamily)?.methods ?? [],
    [families, srcFamily]
  )
  const shown = useMemo(() => {
    const q = indQuery.trim().toLowerCase()
    return q ? srcMethods.filter((m) => m.name.toLowerCase().includes(q)) : srcMethods
  }, [srcMethods, indQuery])

  const keyOf = (m: FamMethod): string => m.method.join(' · ')
  const origName = (m: FamMethod): string => m.method[m.method.length - 1]
  const selected = srcMethods.filter((m) => keyOf(m) in names)

  const toggle = (m: FamMethod): void =>
    setNames((prev) => {
      const k = keyOf(m)
      if (k in prev) {
        const { [k]: _drop, ...rest } = prev
        return rest
      }
      return { ...prev, [k]: origName(m) }
    })

  const submit = (): void => {
    const t = target.trim()
    if (!t || !selected.length) return
    onSubmit(
      selected.map((m) => ({
        src: m.method,
        family: t,
        name: (names[keyOf(m)] || origName(m)).trim() || origName(m)
      }))
    )
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={() => onClose()} />
      <div className="modal sheet lcia-dup" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-head-grow">
            <h3>Duplicate indicators</h3>
          </div>
          <button className="sheet-x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="sheet-body">
          <label className="mfield">
            <span>From family</span>
            <select
              value={srcFamily}
              onChange={(e) => {
                setSrcFamily(e.target.value)
                setNames({})
              }}
            >
              {families.map((f) => (
                <option key={f.family} value={f.family}>
                  {f.family}
                </option>
              ))}
            </select>
          </label>
          <input
            className="flowpick-search"
            placeholder="Filter indicators…"
            value={indQuery}
            onChange={(e) => setIndQuery(e.target.value)}
          />
          <div className="lcia-dup-list">
            {shown.map((m) => {
              const k = keyOf(m)
              const on = k in names
              return (
                <label key={k} className={`lcia-dup-row${on ? ' on' : ''}`}>
                  <input type="checkbox" checked={on} onChange={() => toggle(m)} />
                  <span className="lcia-dup-name">{origName(m)}</span>
                  <span className="lcia-mrow-unit">{m.unit}</span>
                </label>
              )
            })}
            {!shown.length ? <div className="lcia-fam-empty">No indicators.</div> : null}
          </div>

          {selected.length ? (
            <>
              <label className="mfield">
                <span>Into family (your own — existing or new)</span>
                <input list="lcia-own-families" value={target} onChange={(e) => setTarget(e.target.value)} />
                <datalist id="lcia-own-families">
                  {ownFamilies.map((f) => (
                    <option key={f} value={f} />
                  ))}
                </datalist>
              </label>
              <div className="lcia-dup-names">
                {selected.map((m) => {
                  const k = keyOf(m)
                  return (
                    <label key={k} className="mfield">
                      <span>Name for “{origName(m)}”</span>
                      <input
                        value={names[k]}
                        onChange={(e) => setNames((prev) => ({ ...prev, [k]: e.target.value }))}
                      />
                    </label>
                  )
                })}
              </div>
            </>
          ) : null}
        </div>

        <div className="sheet-foot">
          <div className="acts">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" onClick={submit} disabled={!selected.length || !target.trim()}>
              Duplicate {selected.length || ''}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
