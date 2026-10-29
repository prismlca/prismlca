/** PrismLCA's licence, as shown in the splash screen and the start page. The
 *  text itself is `LICENSE` in the repo and `resources/LICENSE.txt` in the bundle. Its end carries an additional
 *  permission under section 7 (combining with Intel's runtime libraries); the label is still plain "AGPL-3.0",
 *  because a section 7 permission only adds rights to the AGPL, it does not make it another licence. The
 *  name (tooltips, the website) and the licence sheet say what the permission is. */
export const LICENCE_LABEL = 'AGPL-3.0'
export const LICENCE_NAME =
  'GNU Affero General Public License v3.0, with an additional permission under section 7'
/** A bundled file, not a dialog: the third-party licences require a text the user can read and pass on. */
export const NOTICES_LABEL = 'Third-party notices'

/* The sentences the app's licence and notices sheets open with. The website's licence page is generated
 * from these same strings (backend/scripts/website_licences.py reads them from this file), so app and
 * site say the same thing. Keep each a plain single-quoted literal (no template string, no `+`), which
 * is all the generator's reader understands. */
export const LICENCE_BLURB =
  'PrismLCA is free software: this licence is what lets you use, study, share and change it. At its end it adds one permission under section 7 of the AGPL: PrismLCA may be passed on together with Intel’s runtime libraries, which keep their own licence. The same text ships with every copy as a file.'
export const NOTICES_BLURB =
  'The software, fonts, icons, data and models that ship with PrismLCA, with their licences. The full licence and notice texts are in the notices file, which every copy carries.'
export const NOTICES_PROVENANCE = 'Generated at build time from the packages actually bundled.'
