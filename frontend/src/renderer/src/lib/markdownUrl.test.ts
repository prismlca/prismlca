import { describe, expect, it } from 'vitest'
import { namesHostWithoutScheme, safeMarkdownUrl } from './markdownUrl'

/** The packaged page is a file:// document. */
const PAGE = 'file:///opt/PrismLCA/resources/app.asar/out/renderer/index.html'

describe('safeMarkdownUrl', () => {
  it('drops a URL that starts with two separators, in every spelling', () => {
    for (const url of [
      '//server/img/x.png',
      '\\\\server\\img\\x.png',
      '/\\server/img/x.png',
      '\\/server/img/x.png',
      '///server/img/x.png',
      '////server/img/x.png',
      ' //server/img/x.png',
      '\u0001//server/img/x.png',
      '/\t/server/img/x.png',
      '\n//server/img/x.png',
      '/%5C%5Cserver/img/x.png',
      '/%2f/server/img/x.png',
      '%5c%5cserver%5cimg%5cx.png'
    ]) {
      expect(namesHostWithoutScheme(url), JSON.stringify(url)).toBe(true)
      expect(safeMarkdownUrl(url), JSON.stringify(url)).toBe('')
    }
  })

  it('covers the spellings a URL parser reads as a host', () => {
    for (const url of ['//server/x.png', '\\\\server\\x.png', '/\\server/x.png', ' //server/x.png']) {
      expect(new URL(url, PAGE).host).toBe('server')
      expect(safeMarkdownUrl(url)).toBe('')
    }
  })

  it('keeps what loads or opens today: local paths, web links, anchors', () => {
    for (const url of [
      'chart.png',
      './images/chart.png',
      '../chart.png',
      '/home/user/chart.png',
      '/C:/Users/user/chart.png',
      'https://example.org/x.png',
      'http://example.org/',
      'mailto:someone@example.org',
      '#user-content-fn-1',
      '?q=1'
    ]) {
      expect(safeMarkdownUrl(url), url).toBe(url)
      if (!url.includes(':')) expect(new URL(url, PAGE).host, url).toBe('')
    }
  })

  it('still drops what react-markdown dropped before', () => {
    for (const url of ['javascript:alert(1)', 'file://server/img/x.png', 'file:///etc/passwd', 'data:x'])
      expect(safeMarkdownUrl(url), url).toBe('')
  })
})
