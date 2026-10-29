import tls from 'node:tls'
import { X509Certificate } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ session: { defaultSession: { setCertificateVerifyProc: vi.fn() } } }))

import { session } from 'electron'
import { applyRootDistrust, chainUsesDistrustedRoot, withoutDistrusted } from './distrustedRoots'

const cn = (pem: string): string => new X509Certificate(pem).subject

describe('distrusted roots', () => {
  it('drops exactly emSign ECC Root CA - G3 from the bundled store and keeps the other emSign roots', () => {
    const bundled = tls.getCACertificates('bundled')
    const kept = withoutDistrusted(bundled)
    const names = kept.map(cn)
    expect(names.some((n) => n.includes('CN=emSign ECC Root CA - G3'))).toBe(false)
    expect(bundled.length - kept.length).toBe(
      bundled.map(cn).filter((n) => n.includes('CN=emSign ECC Root CA - G3')).length
    )
    expect(names.some((n) => n.includes('CN=emSign Root CA - G1'))).toBe(
      bundled.map(cn).some((n) => n.includes('CN=emSign Root CA - G1'))
    )
  })

  it('refuses a chain that runs through the root and lets every other chain through', () => {
    const root = { subjectName: 'emSign ECC Root CA - G3', issuerName: 'emSign ECC Root CA - G3' }
    const intermediate = {
      subjectName: 'emSign ECC CA - G3',
      issuerName: 'emSign ECC Root CA - G3',
      issuerCert: root
    }
    const leaf = { subjectName: 'huggingface.co', issuerName: 'emSign ECC CA - G3', issuerCert: intermediate }
    expect(chainUsesDistrustedRoot(leaf)).toBe(true)
    const other = {
      subjectName: 'openrouter.ai',
      issuerName: 'R11',
      issuerCert: { subjectName: 'R11', issuerName: 'ISRG Root X1' }
    }
    expect(chainUsesDistrustedRoot(other)).toBe(false)
    expect(chainUsesDistrustedRoot(null)).toBe(false)
  })

  it('judges the chain Chromium validated, not only the one the server sent', () => {
    applyRootDistrust()
    const proc = vi.mocked(session.defaultSession.setCertificateVerifyProc).mock.calls.at(-1)![0]!
    const leafOnly = { subjectName: 'huggingface.co', issuerName: 'emSign ECC CA - G3' }
    const validated = {
      ...leafOnly,
      issuerCert: {
        subjectName: 'emSign ECC CA - G3',
        issuerName: 'emSign ECC Root CA - G3',
        issuerCert: { subjectName: 'emSign ECC Root CA - G3', issuerName: 'emSign ECC Root CA - G3' }
      }
    }
    const verdicts: number[] = []
    proc({ certificate: leafOnly, validatedCertificate: validated } as never, (v) => verdicts.push(v))
    proc({ certificate: leafOnly, validatedCertificate: leafOnly } as never, (v) => verdicts.push(v))
    expect(verdicts).toEqual([-2, -3])
  })
})
