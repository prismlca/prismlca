/**
 * The ecoinvent import's release step: which release the chosen folder and workbook hold, read by the
 * backend from the files (GET /setup/ecoinvent-release). The version names the database and the report's
 * citation, and it is in no dataset — so where neither the workbook's Read me sheet nor the folder name
 * gives it, the step asks for it instead of guessing.
 */
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { errMsg } from '../lib/errors'
import { SetupStep } from './SetupParts'

export interface ReleaseInfo {
  /** False for a folder that is not an extracted release — the import itself then says why. */
  release: boolean
  version: string | null
  system_model: string | null
  database: string | null
  source: 'workbook' | 'folder' | 'typed' | null
}

const MODEL_LABELS: Record<string, string> = {
  cutoff: 'cut-off',
  apos: 'APOS',
  consequential: 'consequential',
  en15804: 'cut-off, EN15804'
}

export interface EcoinventRelease {
  info: ReleaseInfo | null
  /** The backend's refusal, e.g. a workbook from another release. */
  error: string | null
  /** What the user typed — asked for only when the files name no version. */
  typed: string
  setTyped: (value: string) => void
  /** The version to send with the import: the typed one where the files name none, else nothing. */
  versionToSend: string | null
  /** Whether the import can start as far as the release is concerned. */
  ready: boolean
}

/** Reads the release whenever folder or workbook change; `dir` null (BAFU, nothing chosen) reads nothing. */
export function useEcoinventRelease(dir: string | null, lcia: string | null): EcoinventRelease {
  const [info, setInfo] = useState<ReleaseInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')

  useEffect(() => {
    setInfo(null)
    setError(null)
    if (!dir) return
    let live = true
    const query = new URLSearchParams({ path: dir })
    if (lcia) query.set('lcia_xlsx', lcia)
    api<ReleaseInfo>('GET', `/api/v1/setup/ecoinvent-release?${query.toString()}`)
      .then((r) => live && setInfo(r))
      .catch((e) => live && setError(errMsg(e)))
    return () => {
      live = false
    }
  }, [dir, lcia])

  const asks = !!info?.release && !info.version
  return {
    info,
    error,
    typed,
    setTyped,
    versionToSend: asks && typed.trim() ? typed.trim() : null,
    ready: !error && (!asks || !!typed.trim())
  }
}

export function ReleaseStep({
  release,
  disabled
}: {
  release: EcoinventRelease
  disabled: boolean
}): JSX.Element | null {
  const { info, error } = release
  if (error) {
    return (
      <SetupStep label="Release">
        <span className="setup-status error">{error}</span>
      </SetupStep>
    )
  }
  if (!info?.release) return null
  if (info.version) {
    const model = info.system_model ? (MODEL_LABELS[info.system_model] ?? info.system_model) : ''
    return (
      <SetupStep
        label="Release"
        hint={`Read from the ${info.source === 'workbook' ? 'workbook' : 'folder name'}; it names the database and the citation.`}
      >
        <span className="setup-path">
          ecoinvent {info.version} {model}
        </span>
      </SetupStep>
    )
  }
  return (
    <SetupStep
      label="Version"
      hint="Neither the folder name nor a workbook says which release this is. Type it as on the archive; it names the database and the citation."
    >
      <input
        value={release.typed}
        onChange={(e) => release.setTyped(e.target.value)}
        disabled={disabled}
        placeholder="e.g. 3.13"
        aria-label="ecoinvent version"
        spellCheck={false}
      />
    </SetupStep>
  )
}
