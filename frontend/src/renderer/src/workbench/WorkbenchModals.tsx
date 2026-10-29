/**
 * The Workbench's small creation/edit dialogs, keyed by one ModalState.
 *
 * Extracted from Workbench.tsx (wave 4.1): the modal switch was an IIFE inside a 3400-line
 * component, and the "New model" fields existed TWICE — once here, once hand-copied into the setup
 * gate. One component now serves both places, which also fixes a gate-only defect: the gate used to
 * render only the New-model dialog, so its own "new project" button opened nothing until a model
 * existed.
 */
import { useEffect } from 'react'
import Modal from '../components/Modal'
import type { DatabaseInfo } from '../lib/api'
import { useLocationSuggestions } from '../lib/useLocationSuggestions'
import type { ExchangeFacts } from './exchangeFacts'

export type ModalState =
  | null
  | { kind: 'newModel' }
  | { kind: 'newProject' }
  | { kind: 'restoreAs'; path: string }
  | { kind: 'duplicateModel'; source: string }
  | { kind: 'newActivity'; pos?: { x: number; y: number } } // pos = canvas spot from the pane context menu
  | { kind: 'connect'; source: string; target: string; exchange: ExchangeFacts }
  | { kind: 'editAmount'; target: string; uid: string; amount: number; exchange: ExchangeFacts }

export interface WorkbenchModalsProps {
  modal: ModalState
  databases: DatabaseInfo[]
  folders: { id: string; name: string }[]
  unitVocab: string[]
  /** From Settings → Modelling: whether the unit field is restricted to the known vocabulary. */
  restrictUnits: boolean
  onClose: () => void
  onSubmit: (values: Record<string, string>) => void | Promise<unknown>
}

export default function WorkbenchModals({
  modal,
  databases,
  folders,
  unitVocab,
  restrictUnits,
  onClose,
  onSubmit
}: WorkbenchModalsProps): JSX.Element | null {
  if (!modal) return null
  if (modal.kind === 'newModel')
    return (
      <Modal
        title="New model"
        submitLabel="Create"
        note="Everything else about the model — functional unit, boundaries, allocation — can be filled in later under Model info."
        onClose={onClose}
        onSubmit={onSubmit}
        fields={[
          { key: 'name', label: 'Model name (e.g. pet-bottle-2025)', value: '' },
          {
            key: 'duplicateFrom',
            label: 'Duplicate from (optional)',
            value: '',
            options: [
              { value: '', label: '— empty model —' },
              ...databases
                .filter((d) => !d.read_only && d.kind === 'foreground')
                .map((d) => ({ value: d.name, label: d.name }))
            ]
          },
          {
            key: 'folder',
            label: 'Folder (optional)',
            value: '',
            options: [
              { value: '', label: '— not in a folder —' },
              ...folders.map((f) => ({ value: f.id, label: f.name }))
            ]
          },
          {
            key: 'goal',
            label: 'Goal (optional — the AI assistant reads this as its brief)',
            type: 'textarea',
            value: ''
          },
          { key: 'scope', label: 'Scope (optional)', type: 'textarea', value: '' }
        ]}
      />
    )
  if (modal.kind === 'newProject')
    return (
      <Modal
        title="New workspace"
        submitLabel="Create"
        onClose={onClose}
        onSubmit={onSubmit}
        fields={[
          { key: 'name', label: 'Workspace name (e.g. ecoinvent-3.11 for a second release)', value: '' }
        ]}
      />
    )
  if (modal.kind === 'restoreAs')
    return (
      <Modal
        title="Restore under another name"
        submitLabel="Restore"
        onClose={onClose}
        onSubmit={onSubmit}
        fields={[
          {
            key: 'name',
            label: 'A workspace with the name in this backup exists already. Restore it as:',
            value: ''
          }
        ]}
      />
    )
  if (modal.kind === 'duplicateModel')
    return (
      <Modal
        title={`Duplicate “${modal.source}”`}
        submitLabel="Duplicate"
        onClose={onClose}
        onSubmit={onSubmit}
        fields={[{ key: 'name', label: 'Name of the copy', value: `${modal.source} (copy)` }]}
      />
    )
  if (modal.kind === 'newActivity')
    return (
      <NewActivityModal
        unitVocab={unitVocab}
        restrictUnits={restrictUnits}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    )
  if (modal.kind === 'connect')
    return (
      <Modal
        title="Add exchange"
        submitLabel="Add"
        facts={modal.exchange.facts}
        onClose={onClose}
        onSubmit={onSubmit}
        fields={[{ key: 'amount', label: 'Amount', type: 'number', value: '1', unit: modal.exchange.unit }]}
      />
    )
  return (
    <Modal
      title="Edit exchange amount"
      submitLabel="Save"
      facts={modal.exchange.facts}
      onClose={onClose}
      onSubmit={onSubmit}
      fields={[
        {
          key: 'amount',
          label: 'Amount',
          type: 'number',
          value: String(modal.amount),
          unit: modal.exchange.unit
        }
      ]}
    />
  )
}

/**
 * What a process is at its birth: name, reference product, unit and location — the four things that
 * identify it; its description and flows follow in the inspector, which opens on it. Its own component
 * so the location list loads when the dialog opens, fresh each time.
 */
function NewActivityModal({
  unitVocab,
  restrictUnits,
  onClose,
  onSubmit
}: Pick<WorkbenchModalsProps, 'unitVocab' | 'restrictUnits' | 'onClose' | 'onSubmit'>): JSX.Element {
  const locations = useLocationSuggestions()
  const { load } = locations
  useEffect(load, [load])
  return (
    <Modal
      title="New process"
      submitLabel="Create"
      onClose={onClose}
      onSubmit={onSubmit}
      fields={[
        // The two examples side by side are what tells a process from the product it makes.
        { key: 'name', label: 'Name', value: '', placeholder: 'e.g. bottle blowing' },
        { key: 'product', label: 'Reference product', value: '', placeholder: 'e.g. PET bottle (optional)' },
        {
          key: 'unit',
          label: 'Unit',
          value: 'unit',
          suggestions: unitVocab,
          restrict: restrictUnits
        },
        {
          key: 'location',
          label: 'Location',
          value: 'GLO',
          suggestions: locations.codes,
          describe: locations.describe
        }
      ]}
    />
  )
}
