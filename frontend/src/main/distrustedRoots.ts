/**
 * Root certificates PrismLCA does not trust, although the runtimes inside Electron still ship them.
 *
 * emSign ECC Root CA - G3 (eMudhra): eight intermediate CAs under it had their private keys compromised and
 * were revoked (GHSA-6q48-6c7w-9gw2). Whoever holds one of those keys can issue a valid-looking certificate
 * for any host and, on the network path, read or alter HTTPS traffic. certifi removed the root, and the
 * Python backend uses certifi. Electron 44.9.2 still trusted it in two places:
 *
 * - Node's store, used by every `fetch` of the main process — the AI providers with the user's keys,
 *   routing, statistics and the news feed. Narrowed with `tls.setDefaultCACertificates`, starting from the
 *   current defaults so that system or `NODE_EXTRA_CA_CERTS` certificates (company proxies) stay.
 * - Chromium's verifier, used by the windows and the update check. Every chain that runs through the root
 *   is refused; all others keep Chromium's own verdict. The verifier hook belongs to a session, and the
 *   update check runs in electron-updater's own one, so the updater hooks that session too (`distrustIn`).
 *
 * Applied once at start-up, before the first request.
 */
import { session, type Session } from 'electron'
import { X509Certificate } from 'node:crypto'
import tls from 'node:tls'

/** Subject common names of the distrusted roots. */
export const DISTRUSTED_ROOT_NAMES = ['emSign ECC Root CA - G3']

const isDistrusted = (name: string): boolean =>
  DISTRUSTED_ROOT_NAMES.some(
    (cn) => name.split(/[\n,]/).some((part) => part.trim() === `CN=${cn}`) || name === cn
  )

/** The PEM certificates of `roots` minus the distrusted ones. */
export function withoutDistrusted(roots: readonly string[]): string[] {
  return roots.filter((pem) => {
    try {
      return !isDistrusted(new X509Certificate(pem).subject)
    } catch {
      return true // not ours to judge; Node rejects a broken certificate itself
    }
  })
}

/** The part of Electron's Certificate a chain walk needs. */
export interface ChainLink {
  subjectName: string
  issuerName: string
  issuerCert?: ChainLink | null
}

/** True when any certificate in the chain was issued by, or is, a distrusted root. */
export function chainUsesDistrustedRoot(cert: ChainLink | null | undefined): boolean {
  for (let link = cert, depth = 0; link && depth < 16; link = link.issuerCert, depth++) {
    if (isDistrusted(link.subjectName) || isDistrusted(link.issuerName)) return true
  }
  return false
}

/** Hook Chromium's verifier of one session. */
export function distrustIn(ses: Session): void {
  // -2: fail the verification; -3: use the result Chromium already reached. The chain Chromium VALIDATED
  // is the one that counts: a server may send only its leaf, and Chromium then completes the chain itself —
  // through the distrusted root, which the server-sent chain would not name.
  ses.setCertificateVerifyProc((request, callback) =>
    callback(
      chainUsesDistrustedRoot(request.validatedCertificate) || chainUsesDistrustedRoot(request.certificate)
        ? -2
        : -3
    )
  )
}

/** Narrow Node's default CA list and hook the windows' session. Returns how many roots Node dropped. */
export function applyRootDistrust(): number {
  const current = tls.getCACertificates('default')
  const kept = withoutDistrusted(current)
  if (kept.length !== current.length) tls.setDefaultCACertificates(kept)
  distrustIn(session.defaultSession)
  return current.length - kept.length
}
