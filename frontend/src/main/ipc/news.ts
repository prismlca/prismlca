/**
 * `news:fetch` — the start page's news card asks main for the project feed.
 *
 * Main, not the renderer, because the renderer's CSP admits no remote origin and should not: the
 * page that shows the news is not the one that talks to the internet. The renderer decides WHETHER
 * to ask (the `newsAutoLoad` setting, or a click on the card's button); main only answers. What
 * crosses back is plain text — see main/news/feed.ts.
 */
import { ipcMain } from 'electron'

import { fetchNewsFeed } from '../news/feed'

export function registerNewsIpc(): void {
  ipcMain.handle('news:fetch', () => fetchNewsFeed())
}
