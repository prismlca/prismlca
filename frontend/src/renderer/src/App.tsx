import { useEffect, useState } from 'react'
import Workbench from './Workbench'
import WelcomeTour from './welcome/WelcomeTour'
import BridgeBanner from './components/BridgeBanner'
import { initAppSettings } from './lib/appSettings'
import { saveViewsNow } from './lib/modelView'

type Status =
  | { state: 'starting' }
  | { state: 'ready' }
  | { state: 'version-mismatch'; detail: string }
  | { state: 'error'; detail: string }

const LABEL: Record<Status['state'], string> = {
  starting: 'Starting backend…',
  ready: 'Connected',
  'version-mismatch': 'Version mismatch',
  error: 'Backend error'
}

export default function App(): JSX.Element {
  const [status, setStatus] = useState<Status>({ state: 'starting' })

  useEffect(() => {
    // Hand main the settings that used to live in this store, then read them from there. Main
    // mirrors the privacy/provider/throughput/spellcheck copies itself on seed and on every write.
    void initAppSettings()
  }, [])

  // Before an update stops the backend, main asks for everything unsaved (main/updater.ts).
  useEffect(() => window.prism.updates?.onSaveRequest?.(saveViewsNow), [])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      const s = (await window.prism.status()) as Status
      setStatus(s)
      if (s.state === 'starting') timer = setTimeout(poll, 500)
    }
    void poll()
    return () => clearTimeout(timer)
  }, [])

  // The tour sits BESIDE the Workbench, not inside it: on a fresh install the Workbench stops at
  // its setup gate, and a tour mounted below that would never render on the one run it exists for.
  // Only once the backend is up, though — nothing useful can be started from a card while the
  // engine is still booting.
  if (status.state === 'ready')
    return (
      <>
        <Workbench />
        <WelcomeTour />
        <BridgeBanner />
      </>
    )

  const tone = status.state === 'starting' ? 'wait' : 'bad'
  return (
    <main className="gate">
      <BridgeBanner />
      <div className="card">
        <div className={`status ${tone}`}>
          <span className="dot" />
          {LABEL[status.state]}
        </div>
        {'detail' in status && status.detail ? <p className="detail">{status.detail}</p> : null}
        <p className="hint">PrismLCA is starting its local engine…</p>
      </div>
    </main>
  )
}
