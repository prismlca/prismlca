/**
 * What a spawned bridge last said on its log (stderr), for the sentence a failed connection test shows:
 * "Connection closed" alone says that the bridge went, its own last lines say why.
 */
import type { Stream } from 'node:stream'

/** Keeps the end of `stream` as it arrives — reading it also keeps the bridge from blocking on a full
 *  pipe — and returns the last `maxLines` non-empty lines, joined, on demand. */
export function stderrTail(stream: Stream | null, maxLines = 3, maxChars = 4000): () => string {
  let kept = ''
  stream?.on('data', (chunk: Buffer | string) => {
    kept = (kept + chunk.toString()).slice(-maxChars)
  })
  // The stream's own failure is not the bridge's message, and must not become an uncaught error.
  stream?.on('error', () => {})
  return () =>
    kept
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-maxLines)
      .join(' | ')
}
