import { useEffect, useState } from 'react'
import PrivacyLink from '../overview/PrivacyLink'
import LicenceLink from '../overview/LicenceLink'
import { AboutLinks, LeadDeveloper } from './AboutLinks'
import { GITHUB_URL, openLink } from '../../lib/links'
import type { UpdateState } from '../../../../shared/updates'
import type { BuildInfo } from '../../../../shared/buildInfo'

/**
 * Who makes PrismLCA and where to find it, the app's version, and the update check. PrismLCA never asks
 * for updates on its own (see PRIVACY.md): the check runs on the button, the download only after a second
 * click, and the update installs on "Restart and install" or the next quit. Main owns the state (main/updater.ts); this page
 * shows it and follows its pushes, so progress keeps moving while the page is open.
 */
/** The block a bug report needs: pasted into an issue, it says
 *  exactly which build ran where. */
export function versionInfoText(b: BuildInfo, backend?: string): string {
  return [
    `PrismLCA ${b.version} (beta, ${b.kind} build, commit ${b.commit})`,
    `Backend ${backend || 'unknown'}`,
    `Electron ${b.electron}`,
    `OS ${b.os}`
  ].join('\n')
}

export function AboutPanel(): JSX.Element {
  const [st, setSt] = useState<UpdateState | null>(null)
  const [build, setBuild] = useState<BuildInfo | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    void window.prism
      .buildInfo()
      .then((b) => {
        if (live) setBuild(b)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  const copyVersionInfo = async (): Promise<void> => {
    if (!build) return
    const info = (await window.prism.info().catch(() => null)) as { app_version?: string } | null
    await navigator.clipboard.writeText(versionInfoText(build, info?.app_version))
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  useEffect(() => {
    let live = true
    void window.prism.updates
      .state()
      .then((s) => {
        if (live) setSt(s)
      })
      .catch(() => undefined)
    const off = window.prism.updates.onEvent((s) => {
      if (live) setSt(s)
    })
    return () => {
      live = false
      off()
    }
  }, [])

  // Main answers every call with the new state and never rejects; the catch is for a dead bridge.
  const run = (call: () => Promise<UpdateState>): void => {
    void call()
      .then(setSt)
      .catch((e: unknown) =>
        setSt((prev) => ({
          phase: 'error',
          current: prev?.current ?? '',
          message: e instanceof Error ? e.message : String(e)
        }))
      )
  }

  const busy = st?.phase === 'checking' || st?.phase === 'downloading' || st?.phase === 'installing'
  const releasePage = (version: string): string => `${GITHUB_URL}/releases/tag/v${version}`
  return (
    <>
      <h4>PrismLCA</h4>
      <AboutLinks />
      <LeadDeveloper />
      <p className="settings-hint">
        Version {build?.version || st?.current || '…'} · Beta
        {build ? (build.kind === 'release' ? ` (${build.commit})` : ` (${build.commit}, ${build.kind})`) : ''}
        {build?.kind === 'release' ? (
          <>
            {' · '}
            <button className="link-btn" onClick={() => openLink(releasePage(build.version))}>
              Release notes
            </button>
          </>
        ) : null}
      </p>
      <div className="settings-field">
        <button type="button" className="btn" disabled={!build} onClick={() => void copyVersionInfo()}>
          {copied ? 'Copied' : 'Copy version info'}
        </button>
      </div>
      <h4>Licence and privacy</h4>
      {/* The same three texts as the start page's footer, at the address where people look for
          them. Each opens in the app; the files behind licence and notices
          stay bundled, as the licences require. */}
      <p className="settings-hint">
        Free software under the GNU Affero General Public License v3.0, with an additional permission under
        section 7 for Intel’s runtime libraries — read the <LicenceLink plain />. Source code:{' '}
        <button className="link-btn" onClick={() => openLink(GITHUB_URL)} title={`Open ${GITHUB_URL}`}>
          {GITHUB_URL.replace(/^https?:\/\//, '')}
        </button>
        .
      </p>
      <p className="settings-hint">
        What PrismLCA sends, to whom and when — and what stays on this computer: the <PrivacyLink plain />.
      </p>
      <h4>Updates</h4>
      <p className="settings-hint">
        PrismLCA never checks for updates on its own. Click to ask github.com for a newer release — the
        request carries your IP address and this version, nothing else. A download starts only when you
        confirm it; the update installs when you restart.
      </p>
      <div className="settings-field">
        <button
          type="button"
          className="btn"
          disabled={
            !st ||
            st.phase === 'unavailable' ||
            busy ||
            st.phase === 'downloaded' ||
            (st.phase === 'error' && !!st.restart)
          }
          onClick={() => run(() => window.prism.updates.check())}
        >
          Check for updates
        </button>
      </div>
      {st?.phase === 'unavailable' ? <p className="settings-hint">{st.reason}</p> : null}
      {st?.phase === 'checking' ? <p className="settings-hint">Checking…</p> : null}
      {st?.phase === 'up-to-date' ? (
        <p className="settings-hint ok">You are on the latest version ({st.current}).</p>
      ) : null}
      {st?.phase === 'available' ? (
        <>
          <p className="settings-hint">Version {st.version} is available.</p>
          {/* The action before the notes: release notes can run long, and a Download button below them
              was not found. The notes stay one click away. */}
          {st.manualOnly ? (
            // A deb installation: updating it needs root, so it is done from the release page.
            <p className="settings-hint">
              This installation is updated from the{' '}
              <button className="link-btn" onClick={() => openLink(releasePage(st.version))}>
                release page
              </button>
              .
            </p>
          ) : (
            <div className="settings-field">
              <button
                type="button"
                className="btn"
                onClick={() => run(() => window.prism.updates.download())}
              >
                Download
              </button>
            </div>
          )}
          {st.notes ? (
            <details className="settings-hint update-notes">
              <summary>What is new in {st.version}</summary>
              <p style={{ whiteSpace: 'pre-wrap' }}>{st.notes}</p>
            </details>
          ) : null}
        </>
      ) : null}
      {st?.phase === 'downloading' ? <p className="settings-hint">Downloading… {st.percent} %</p> : null}
      {st?.phase === 'downloaded' ? (
        <>
          <p className="settings-hint ok">Version {st.version} is ready to install.</p>
          {st.note ? <p className="settings-hint bad">{st.note}</p> : null}
          <div className="settings-field">
            <button type="button" className="btn" onClick={() => run(() => window.prism.updates.install())}>
              Restart and install
            </button>{' '}
            <button type="button" className="btn" onClick={() => run(() => window.prism.updates.discard())}>
              Discard download
            </button>
          </div>
        </>
      ) : null}
      {st?.phase === 'installing' ? (
        <p className="settings-hint">Closing PrismLCA&apos;s background service and starting the update…</p>
      ) : null}
      {st?.phase === 'incomplete' ? (
        <>
          <p className="settings-hint bad">
            The update to version {st.version} did not complete — this is still version {st.current}. Check
            for updates to try again, or install it from the{' '}
            <button className="link-btn" onClick={() => openLink(releasePage(st.version))}>
              release page
            </button>
            .
          </p>
          <div className="settings-field">
            <button type="button" className="btn" onClick={() => run(() => window.prism.updates.discard())}>
              Dismiss
            </button>
          </div>
        </>
      ) : null}
      {st?.phase === 'error' ? (
        <>
          <p className="settings-hint bad">{st.message}</p>
          {/* After a failed download the next step stays on the page: try again, or take it by hand. */}
          {st.version && !st.restart ? (
            <p className="settings-hint">
              Check for updates to try again, or install version {st.version} from the{' '}
              <button className="link-btn" onClick={() => openLink(releasePage(st.version!))}>
                release page
              </button>
              .
            </p>
          ) : null}
          {st.restart ? (
            <div className="settings-field">
              <button
                type="button"
                className="btn"
                onClick={() => run(() => window.prism.updates.relaunch())}
              >
                Restart PrismLCA
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  )
}
