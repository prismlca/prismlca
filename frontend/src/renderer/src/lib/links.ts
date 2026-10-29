/**
 * Every address in PrismLCA that leads out of PrismLCA, in one place.
 *
 * Why a file rather than string literals in the views: an address that appears twice in two views
 * drifts apart the first time one of them is touched. The website's canonical address is
 * www.prismlca.com (prismlca.com redirects there); its sources are Website2/ in this repo.
 *
 * Opening goes through `openExternal` (main/coreIpc.ts), never a plain `<a href>`: an anchor
 * inside Electron navigates the app window away from PrismLCA and there is no way back.
 */

/** The project website's front page — Settings → About links to it by name. */
export const WEBSITE_URL = 'https://www.prismlca.com/'

/** The user manual: built from Website2/content/handbook by Website2/tools/build_handbook.py. The old
 *  website/handbook.html is an archive and is no longer maintained. */
export const HANDBOOK_URL = 'https://www.prismlca.com/handbook/'

/** The news section of the project website — the start page's "Open in browser". The news card
 *  itself reads the project's RSS feed (shared/news.ts), in main and only when the user allowed it;
 *  no page PrismLCA does not control ever runs in this window. */
export const NEWS_URL = 'https://www.prismlca.com/news.html'

/** The source repository. */
export const GITHUB_URL = 'https://github.com/prismlca/prismlca'

/** The lead developer's LinkedIn profile — the name in the overview's footer and in Settings → About links to it. */
export const LINKEDIN_URL = 'https://www.linkedin.com/in/jonas-harth-529278a4/'

/** PrismLCA's own LinkedIn page — the one the website's footer links to under "Social". */
export const LINKEDIN_COMPANY_URL = 'https://www.linkedin.com/company/145220782'

/** The newsletter. A Substack *profile*, not a publication: there is no `?email=` to prefill with,
 *  so the overview links out instead of pretending to take an address (checked 11.09.2026). */
export const SUBSTACK_URL = 'https://substack.com/@prismlca'

/** Hand a URL to the real browser. Anything that is not http(s) is refused in the main process. */
export function openLink(url: string): void {
  void window.prism.openExternal(url)
}

/** Where BAFU:20XY is downloaded: openLCA Nexus, free of charge after a free Nexus sign-in and the
 *  terms of use (openlca.org release note for BAFU:2026 v1, checked 13.10.2026). PrismLCA never
 *  downloads it itself; the import sheet only hands this page to the browser. */
export const BAFU_DOWNLOAD_URL = 'https://nexus.openlca.org/database/BAFU'

/** ecoQuery's file page for the release PrismLCA is built on (3.12 cut-off). Licence holders find both
 *  archives the ecoinvent import needs there: the ecoSpold02 datasets and, under "Supporting documents",
 *  the LCIA implementation. */
export const ECOINVENT_FILES_URL = 'https://ecoquery.ecoinvent.org/3.12/cutoff/files'
