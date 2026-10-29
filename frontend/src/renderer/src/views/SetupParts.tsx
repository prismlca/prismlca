/**
 * The import wizard's building blocks: a numbered step (the order is real — where the data goes, what it
 * is, which methods) and the background knowledge folded under questions. Every import needs the steps;
 * the explanations only the first time, so they stay closed until asked for.
 */
import type { ReactNode } from 'react'
import { BAFU_DOWNLOAD_URL, ECOINVENT_FILES_URL, openLink } from '../lib/links'
import type { BackgroundSource } from './Setup'

export function SetupStep({
  label,
  hint,
  children
}: {
  label: string
  /** One line under the control: what to pick. */
  hint?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <li className="setup-step">
      <div className="setup-step-body">
        <div className="setup-step-row">
          <span className="setup-step-label">{label}</span>
          {children}
        </div>
        {hint ? <div className="setup-step-hint">{hint}</div> : null}
      </div>
    </li>
  )
}

export function SetupHelp({ source }: { source: BackgroundSource }): JSX.Element {
  return source === 'bafu' ? (
    <div className="setup-help">
      <details>
        <summary>Where do I get it?</summary>
        <p>
          Free on openLCA Nexus. Sign in with a free Nexus account, accept BAFU&apos;s terms of use, download
          and unzip.{' '}
          <button className="link-btn" onClick={() => openLink(BAFU_DOWNLOAD_URL)}>
            Open openLCA Nexus
          </button>
        </p>
      </details>
      <details>
        <summary>What happens to its elementary flows?</summary>
        <p>
          They are mapped onto the workspace&apos;s flow list — ecoinvent&apos;s if it is installed, otherwise
          the flow list and impact methods Brightway ships (ecoinvent 3.9); importing ecoinvent later rewrites
          everything onto it. Flows without a counterpart are added as new, uncharacterised flows and counted
          in the report.
        </p>
      </details>
    </div>
  ) : (
    <div className="setup-help">
      <details>
        <summary>Where do I get these files?</summary>
        <p>
          With an ecoinvent licence, on ecoQuery under <b>Files</b>. Download{' '}
          <code>ecoinvent 3.12_cutoff_ecoSpold02.7z</code> and, under <b>Supporting documents</b> on the same
          page, <code>ecoinvent 3.12_LCIA_implementation.7z</code>; extract both. They must come from the same
          release: that is what lets every characterisation factor link to a flow.{' '}
          <button className="link-btn" onClick={() => openLink(ECOINVENT_FILES_URL)}>
            Open ecoQuery files
          </button>
        </p>
      </details>
    </div>
  )
}
