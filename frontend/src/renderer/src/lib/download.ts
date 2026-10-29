/**
 * The ONE way this app hands a file to the browser's downloads.
 *
 * Thirteen views used to build their own `<a download>` + object-URL block — and twelve of them
 * could not honour V157 ("never claim 'Saved' before the download's own verdict arrives", see
 * preload onDownload): only the report pane subscribed. The hand-over lives here now, and a view
 * that wants to SAY something about the outcome subscribes through {@link onDelivery} — the
 * filtered wrapper around the preload event — instead of announcing success the moment `click()`
 * returns.
 */

/** Decode a backend `base64` payload into bytes (the export endpoints' common answer shape). */
export function bytesFromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

/** The XLSX content type, spelled out once (four export endpoints answer with it). */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Offer a Blob to the browser's downloads under `filename`. The revoke is delayed, not immediate:
 *  the click only *starts* the download, and pulling the URL out from under a slow disk or a
 *  pending save dialog is a way to deliver zero bytes. */
export function deliverBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5_000)
}

export function deliverBytes(bytes: Uint8Array | ArrayBuffer, filename: string, mime?: string): void {
  deliverBlob(new Blob([bytes as BlobPart], mime ? { type: mime } : undefined), filename)
}

/** Offer a backend base64 payload as a download. */
export function deliverBase64(base64: string, filename: string, mime?: string): void {
  deliverBytes(bytesFromBase64(base64), filename, mime)
}

/** Offer an already-rendered data URL (chart PNGs) as a download. */
export function deliverDataUrl(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
}

/** What became of one delivery, as the download itself reports it (V157). */
export interface Delivery {
  filename: string
  /** The real path on disk — empty unless `state` is 'completed'. */
  path: string
  bytes: number
  state: 'completed' | 'cancelled' | 'interrupted' | string
}

/**
 * The download's verdict for OUR filename — subscribe BEFORE delivering, unsubscribe with the
 * returned function. Filtered by filename so an Excel export elsewhere cannot rewrite what this
 * view says about its own hand-over.
 */
export function onDelivery(filename: string, cb: (d: Delivery) => void): () => void {
  return window.prism.onDownload((d) => {
    if (d.filename === filename) cb(d)
  })
}
