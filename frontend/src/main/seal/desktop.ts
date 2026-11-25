/**
 * The desktop half of a sealed instance: nothing is handed to another program and no native dialog opens.
 * Web links, files to open and items to show in a folder are written to the seal's log and reported as
 * done; file, folder and message dialogs are written down and answered as cancelled, the way Esc would
 * answer them.
 *
 * Replaced on Electron's own `shell` and `dialog` objects rather than at our call sites, so every caller is
 * covered, the ones added later and the libraries' too. The choosers of `<input type="file">` and
 * `<input type="color">` never pass through `dialog`: Chromium shows them itself (choosers.ts).
 */
import type { Dialog, MessageBoxOptions, MessageBoxSyncOptions, Shell } from 'electron'
import type { SealLog } from './log'

type DialogOptions = { title?: string; message?: string; properties?: string[]; buttonLabel?: string }

/** The options of a dialog call — the last argument, after the optional parent window. */
function optionsOf<T>(args: unknown[]): T | undefined {
  const last = args[args.length - 1]
  return last && typeof last === 'object' ? (last as T) : undefined
}

function describeDialog(kind: string, args: unknown[]): string {
  const o = optionsOf<DialogOptions>(args) ?? {}
  const what = o.title ?? o.message ?? o.buttonLabel ?? ''
  const props = o.properties?.length ? ` [${o.properties.join(', ')}]` : ''
  return `${kind}${what ? ` "${what}"` : ''}${props}`
}

/** The answer Esc gives: `cancelId`, else the first button labelled Cancel or No, else the first. */
export function cancelAnswer(options: MessageBoxOptions | MessageBoxSyncOptions | undefined): number {
  if (typeof options?.cancelId === 'number') return options.cancelId
  const i = (options?.buttons ?? []).findIndex((b) => /^(cancel|no)$/i.test(b.replace(/&/g, '').trim()))
  return i >= 0 ? i : 0
}

export function sealShell(shell: Shell, log: SealLog): void {
  shell.openExternal = async (url: string) => {
    log.write('link', String(url), 'shell.openExternal')
  }
  shell.openPath = async (path: string) => {
    log.write('open', String(path), 'shell.openPath')
    return ''
  }
  shell.showItemInFolder = (path: string) => {
    log.write('reveal', String(path), 'shell.showItemInFolder')
  }
}

export function sealDialogs(dialog: Dialog, log: SealLog): void {
  const cancelled = (via: string, args: unknown[], kind: string): void =>
    log.write('dialog', describeDialog(kind, args), `dialog.${via}`, 'cancelled')
  // Each signature takes an optional parent window first; the replacements read the options from the end.
  Object.assign(dialog, {
    showOpenDialog: async (...args: unknown[]) => {
      cancelled('showOpenDialog', args, 'open')
      return { canceled: true, filePaths: [] }
    },
    showOpenDialogSync: (...args: unknown[]) => {
      cancelled('showOpenDialogSync', args, 'open')
      return undefined
    },
    showSaveDialog: async (...args: unknown[]) => {
      cancelled('showSaveDialog', args, 'save')
      return { canceled: true, filePath: '' }
    },
    showSaveDialogSync: (...args: unknown[]) => {
      cancelled('showSaveDialogSync', args, 'save')
      return ''
    },
    showMessageBox: async (...args: unknown[]) => {
      cancelled('showMessageBox', args, 'message')
      return { response: cancelAnswer(optionsOf(args)), checkboxChecked: false }
    },
    showMessageBoxSync: (...args: unknown[]) => {
      cancelled('showMessageBoxSync', args, 'message')
      return cancelAnswer(optionsOf(args))
    },
    showErrorBox: (title: string, content: string) => {
      log.write('dialog', `error "${title}": ${content}`, 'dialog.showErrorBox', 'cancelled')
    },
    showCertificateTrustDialog: async (...args: unknown[]) => {
      cancelled('showCertificateTrustDialog', args, 'certificate')
    }
  })
}
