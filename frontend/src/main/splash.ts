import { BrowserWindow } from 'electron'
import icon from '../../resources/icon.png?asset'
import { LICENCE_LABEL, NOTICES_LABEL, openLicence, openNotices } from './licence'
import { SPLASH_BG_DATA_URL } from './splash-bg'

const LICENCE_HREF = 'prismlca://licence'
const NOTICES_HREF = 'prismlca://notices'

/**
 * Frameless splash card shown while the Python/Brightway backend boots (up to ~60 s on first
 * start). Pure inline HTML/CSS in the house palette — no renderer bundle, no preload — loaded via
 * a data URL so it appears instantly. The card's backdrop is a photograph (see splash-bg.ts) over
 * the house gradient as a fallback; it carries the prism facets itself, which is why there is no
 * drawn ray layer here any more. The main process drives the status line + progress bar through
 * window.__setStatus (executeJavaScript), and closes it when the main window shows.
 */

export interface Splash {
  win: BrowserWindow
  setStatus: (text: string, pct: number) => void
  close: () => void
}

function splashHtml(versionLabel: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; background: transparent; overflow: hidden;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    -webkit-user-select: none; user-select: none; cursor: default; }
  .card { position: relative; height: 100%; border-radius: 20px; overflow: hidden;
    background: url(${SPLASH_BG_DATA_URL}) center/cover no-repeat,
      linear-gradient(160deg, #fefefe 0%, #f6f8f3 100%);
    border: 1px solid rgba(47,78,102,.14);
    display: flex; flex-direction: column; }
  .body { flex: 1; padding: 34px 38px 0; position: relative; }
  .head { display: flex; align-items: center; gap: 18px; }
  .prism { width: 58px; height: 58px; border-radius: 15px; flex: none;
    background: conic-gradient(from 210deg, #93c120, #2f4e66, #9f5987, #93c120);
    box-shadow: 0 6px 18px rgba(47,78,102,.25); }
  /* The wordmark as the app sets it everywhere else (.brand, .ov-hero h1): "Prism" regular,
     "LCA" bold — not the whole name in one heavy weight. */
  h1 { font-size: 33px; letter-spacing: -.02em; color: #26313a; font-weight: 400; }
  h1 b { font-weight: 700; }
  .tagline { margin-top: 3px; font-size: 14.5px; color: #626b71; }
  .tagline b { color: #769a1a; font-weight: 600; }
  .meta { margin-top: 26px; display: flex; flex-direction: column; gap: 10px; }
  .meta-row { display: flex; align-items: center; gap: 10px; font-size: 13.5px; color: #626b71; }
  .meta-row svg { flex: none; color: #8a949c; }
  /* The licence name reads like the rows beneath it — same colour, no underline.
     It still opens the licence text; the pointer and the tooltip say so. */
  .meta-row a { color: inherit; text-decoration: none; cursor: pointer; }
  .meta-row a:hover { color: #26313a; }
  .foot { border-top: 1px solid rgba(47,78,102,.12); padding: 14px 38px 18px;
    background: rgba(242,244,240,.55); }
  .status { display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: #626b71; }
  .spin { width: 14px; height: 14px; flex: none; border-radius: 50%;
    border: 2px solid rgba(147,193,32,.25); border-top-color: #93c120;
    animation: rot .9s linear infinite; }
  @keyframes rot { to { transform: rotate(360deg); } }
  .track { margin-top: 9px; height: 6px; border-radius: 999px; background: #e6e9e2; overflow: hidden; }
  /* The gradient spans the full track (background-size = track width), so the fill reveals it
     instead of squeezing the whole gradient into the current percentage. */
  .fill { height: 100%; width: 4%; border-radius: 999px;
    background: linear-gradient(90deg, #9f5987, #2f4e66, #93c120) left/444px 100% no-repeat;
    transition: width .5s ease; }
</style></head>
<body>
  <div class="card">
    <div class="body">
      <div class="head">
        <div class="prism"></div>
        <div>
          <h1>Prism<b>LCA</b></h1>
          <div class="tagline">Life Cycle Assessment, <b>Simplified.</b></div>
        </div>
      </div>
      <div class="meta">
        <div class="meta-row">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          <span>Licence: <a href="${LICENCE_HREF}" title="Open the licence text">${LICENCE_LABEL}</a> · <a href="${NOTICES_HREF}" title="Open the third-party notices">${NOTICES_LABEL}</a></span>
        </div>
        <div class="meta-row">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
          <span>Version: ${versionLabel}</span>
        </div>
        <div class="meta-row">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <span>Lead developer: Jonas Harth</span>
        </div>
      </div>
    </div>
    <div class="foot">
      <div class="status"><span class="spin"></span><span id="st">Starting…</span></div>
      <div class="track"><div class="fill" id="bar"></div></div>
    </div>
  </div>
  <script>
    window.__setStatus = (text, pct) => {
      document.getElementById('st').textContent = text
      document.getElementById('bar').style.width = Math.max(2, Math.min(100, pct)) + '%'
    }
  </script>
</body></html>`
}

export async function createSplash(appVersion: string): Promise<Splash> {
  const [major, minor] = appVersion.split('.')
  const versionLabel = `beta ${major}.${minor}` // 0.9.0 → "beta 0.9" (public beta)

  const win = new BrowserWindow({
    width: 520,
    height: 330,
    frame: false,
    transparent: true, // real rounded corners — the page background stays transparent
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    alwaysOnTop: false,
    // The splash is the app's first window, so it is the taskbar entry until the main window shows.
    // Without its own icon the desktop shows a generic one wherever no .desktop entry claims the
    // window (dev start, an AppImage run without desktop integration).
    icon,
    webPreferences: { sandbox: true, spellcheck: false }
  })
  win.setMenu(null)
  // The licence links: the splash has no preload, so the click arrives as a navigation to a made-up
  // scheme, which is cancelled and turned into "open the bundled file" (licence.ts).
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault()
    if (url === LICENCE_HREF) void openLicence()
    else if (url === NOTICES_HREF) void openNotices()
  })
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml(versionLabel))}`)
  win.show()

  let closed = false
  win.on('closed', () => {
    closed = true
  })
  return {
    win,
    setStatus: (text, pct) => {
      if (closed) return
      void win.webContents
        .executeJavaScript(`window.__setStatus(${JSON.stringify(text)}, ${pct})`)
        .catch(() => {})
    },
    close: () => {
      if (!closed) win.close()
    }
  }
}
