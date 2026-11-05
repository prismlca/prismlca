/**
 * Markdown we did not write (chat answers, skill files) is untrusted: URLs that name a host without a
 * scheme are dropped; everything else goes through react-markdown's filter.
 */
import { defaultUrlTransform } from 'react-markdown'

/** One path separator at the start of a URL: a slash or a backslash, plain or percent-encoded. */
const SEPARATOR = /^(?:[/\\]|%2f|%5c)/i

/** Whether a URL starts with two or more separators, ignoring what a URL parser ignores (leading spaces
 *  and control characters, tabs and line breaks anywhere). */
export function namesHostWithoutScheme(url: string): boolean {
  let u = url.replace(/[\t\n\r]/g, '')
  let i = 0
  while (i < u.length && u.charCodeAt(i) <= 0x20) i++
  u = u.slice(i)
  let separators = 0
  for (let m = SEPARATOR.exec(u); m && separators < 2; m = SEPARATOR.exec(u)) {
    separators++
    u = u.slice(m[0].length)
  }
  return separators >= 2
}

/** react-markdown's `urlTransform`: '' for a host without a scheme, react-markdown's filter otherwise. */
export function safeMarkdownUrl(url: string): string {
  return namesHostWithoutScheme(url) ? '' : defaultUrlTransform(url)
}
