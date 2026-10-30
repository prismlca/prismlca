"""Generate the website's privacy page: the website's own notice, then the app's notice word for word.

Run from ``backend/``::

    uv run python scripts/website_privacy.py          # write Website2/privacy.html
    uv run python scripts/website_privacy.py --check  # exit 1 if the page is stale

Sources:

* the website part — written below in ``WEBSITE``; it describes what the server, Cloudflare, the
  statistics, the contact form and the mailbox do. Change it here when the setup changes (and note the
  change in ``Website2/DEPLOY.md``).
* the app part — ``PRIVACY.md``, which the app ships as ``assets/privacy-notice.md`` (a frontend test keeps
  the two equal). It is rendered unchanged; only its headings move one level down.
* ``Website2/index.html`` — navigation and footer, via ``website_licences.chrome()``.

Output: ``privacy.html`` in the site
folder (``Website2/``, ``--site`` or ``$PRISM_SITE_DIR``), deterministic.
"""

from __future__ import annotations

import argparse
import importlib.util
import re
import sys
from pathlib import Path

from markdown_it import MarkdownIt

SCRIPTS = Path(__file__).resolve().parent
REPO = SCRIPTS.parent.parent
APP_NOTICE = REPO / "PRIVACY.md"

_spec = importlib.util.spec_from_file_location("website_licences", SCRIPTS / "website_licences.py")
assert _spec and _spec.loader
wl = importlib.util.module_from_spec(_spec)
sys.modules.setdefault("website_licences", wl)
_spec.loader.exec_module(wl)

VERSION = "12 October 2026"

# The website's notice. Plain HTML inside the page's legal layout; every claim here must match what the
# server is configured to do (Website2/DEPLOY.md). Hosting details are named as far as the law requires
# (who receives data, where, on what basis) and no further.
WEBSITE = """
    <section class="legal-block">
      <h2>Who is responsible</h2>
      <p>Jonas Harth, c/o IP-Management #12404, Ludwig-Erhard-Straße 18, 20459 Hamburg, Germany ·
        <a href="mailto:contact@prismlca.com">contact@prismlca.com</a>.</p>
    </section>

    <section class="legal-block">
      <h2>The short version</h2>
      <p>{SHORT_STORAGE} Only Cloudflare, which delivers the website, may set short-lived security cookies (see
        below). Fonts, images, videos and
        scripts come from our own website address; there are no social-media widgets. The one exception is our
        videos, on the videos page and in the product tour on the start page: they come from YouTube and load only
        when you confirm one, and YouTube can then store data in your browser (see below). Hosting and delivery involve Hetzner and Cloudflare, as described below. {SHORT_STATS} We do
        not sell visitor data or use it for advertising.</p>
    </section>

    <section class="legal-block">
      <h2>Visiting the website</h2>
      <p>The website is hosted by Hetzner Online GmbH, Industriestraße 25, 91710 Gunzenhausen, Germany, on servers
        in Helsinki, Finland. Hetzner processes data on our behalf under a data processing agreement (Art. 28 GDPR).</p>
      <p>When you open a page, your browser sends what every web request carries: your IP address, the date and
        time, the page requested, the page you came from (referrer) and your browser's user agent. The server needs
        this to deliver the page and to protect itself against attacks. Our web server keeps no access log; technical
        logs on our server that can contain such data are deleted after seven days at the latest. This limit applies
        to logs under our control; what Cloudflare does is described in the next section.</p>
      <p>On the handbook's installation page, a script in your browser guesses your operating system from the
        browser's own identification, so that the matching instructions open first. The guess stays in your browser;
        it is neither stored nor sent to us.</p>
      <p><i>Legal basis:</i> Art. 6(1)(f) GDPR — our legitimate interest in delivering the website securely.</p>
    </section>

    <section class="legal-block">
      <h2>Delivery through Cloudflare</h2>
      <p>The website reaches you through the network of Cloudflare, Inc., 101 Townsend St., San Francisco, CA 94107,
        USA, which protects it against attacks and overload. Cloudflare therefore handles every request to this
        website, including the contents of messages you submit through the contact form, and processes your IP address
        and the request data described above on our behalf, under a data processing agreement. Cloudflare keeps such
        data for as long as its security functions need it, as set out in its privacy policy. Data can be processed in the USA; Cloudflare
        is certified under the EU–US Data Privacy Framework, for which an adequacy decision of the European Commission
        applies (Art. 45 GDPR), and the agreement includes the EU standard contractual clauses as a fallback. Details: <a href="https://www.cloudflare.com/privacypolicy/" rel="noopener">Cloudflare's
        privacy policy</a>.</p>
      <p>To tell people from automated traffic, Cloudflare can set security cookies: <code>__cf_bm</code>, which
        expires after 30 minutes without activity, and <code>cf_clearance</code>, which remembers a completed security
        check for as long as Cloudflare's check setting allows (by default 30 minutes). These cookies can contain a
        pseudonymous browser or session identifier. They serve only to protect access to the website you asked for,
        which is why they are set without consent (§ 25(2) no. 2 TDDDG); they are not used for anything else.</p>
      <p><i>Legal basis:</i> Art. 6(1)(f) GDPR — our legitimate interest in a website that stays available and safe.</p>
    </section>

    <section class="legal-block" id="statistics">
      <h2>Visitor statistics</h2>
{STATS}
    </section>

    <section class="legal-block" id="videos">
      <h2>Videos from YouTube</h2>
      <p>The <a href="videos.html">videos page</a> and the product tour on the <a href="index.html#tour">start page</a>
        show our videos with preview images from our own server. As long as you only look at these pages, nothing is
        loaded from YouTube and no data reaches it. A click on a video first
        opens a notice; only when you then choose “Load video” does your browser load the YouTube player, from
        www.youtube-nocookie.com (YouTube's privacy-enhanced mode).
        YouTube is a service of Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Ireland.</p>
      <p>From that moment on, Google receives your IP address, the address of our website, your browser's technical
        data and which video you watch. The player stores information in your browser (in its local storage and a
        browser database, and depending on your browser's settings also cookies) and can recognise your browser on
        other websites; if you are signed in to a
        Google account, YouTube can link the visit to it. Google decides on its own how it uses these data, including
        for statistics and advertising, and can process them in the USA; Google LLC is certified under the EU–US Data
        Privacy Framework, for which an adequacy decision of the European Commission applies (Art. 45 GDPR). Details:
        <a href="https://policies.google.com/privacy" rel="noopener">Google's privacy policy</a>.</p>
      <p><i>Legal basis:</i> your consent, which you give with “Load video” (§ 25(1) TDDDG, Art. 6(1)(a) GDPR). It
        covers that one video and is not remembered: the next video asks again. Closing the player removes
        it from the page, and nothing more is loaded from YouTube until you click again; what YouTube has already
        stored in your browser you can delete in your browser's settings.</p>
    </section>

    <section class="legal-block">
      <h2>Contact form</h2>
      <p>If you use the contact form on the <a href="imprint.html">imprint page</a>, your name, email address, subject
        and message are sent encrypted to our server, together with technical anti-abuse data: the time taken to fill
        in the form and an automated spam check. The server sends accepted messages on as one email to our mailbox
        contact@prismlca.com (see the next section); it keeps no database of messages and writes neither the message
        nor your IP address to a file or a log. To cap the number of emails per day, it records only the times of
        send attempts, without any link to you. To prevent abuse, it keeps your IP address (for IPv6, the network
        prefix) and the times of your submissions in working memory only, to count how many messages come from one
        connection; one hour after your last submission attempt, the next cleanup run removes them, normally within
        about a minute. Name, email address and message are needed to answer you; the subject is optional.</p>
      <p><i>Legal basis:</i> Art. 6(1)(f) GDPR — our legitimate interest in answering enquiries and in keeping the
        form free of abuse; where your message concerns a contract, Art. 6(1)(b) GDPR.</p>
    </section>

    <section class="legal-block">
      <h2>Email</h2>
      <p>Emails to contact@prismlca.com, including messages from the contact form, are stored in a mailbox provided by
        DomainFactory GmbH, c/o WeWork, Neuturmstrasse 5, 80331 Munich, Germany, which processes them on our behalf
        under a data processing agreement (Art. 28 GDPR), on servers in the EU. DomainFactory runs the mailbox software
        with Titan Solution Ltd SEZC, based in the Cayman Islands, as its subprocessor; insofar as data can be
        accessed from outside the EU, this is safeguarded by the EU standard contractual clauses in DomainFactory's
        agreement (Art. 46(2)(c) GDPR). You can ask us for a copy of these safeguards at the address above.</p>
      <p>We use your address and message only to answer you. We delete the correspondence when the enquiry is closed
        and no further follow-up is to be expected. Where a message is needed to establish, exercise or defend legal
        claims, we keep it only until the applicable limitation period has run or the proceedings have ended.</p>
      <p><i>Legal basis:</i> Art. 6(1)(f) GDPR — our legitimate interest in answering you; where your message concerns
        a contract, Art. 6(1)(b) GDPR.</p>
    </section>

    <section class="legal-block">
      <h2>Links to other websites</h2>
      <p>Links to GitHub, YouTube, Substack and LinkedIn are plain links. Nothing is loaded from these services and no
        data reaches them until you click. Once you do, the website you open applies its own privacy rules. The same
        holds for downloads: the installers are hosted on GitHub, Inc. (USA).</p>
    </section>

    <section class="legal-block">
      <h2>Your rights</h2>
      <p>You have the right of access, rectification, erasure, restriction of processing and data portability
        (Art. 15–20 GDPR). Write to <a href="mailto:contact@prismlca.com">contact@prismlca.com</a>. You can also lodge
        a complaint with a supervisory authority, in particular the one where you live or work. The authority
        responsible for us is the Landesbeauftragte für den Datenschutz und die Informationsfreiheit
        Baden-Württemberg, Germany
        (<a href="https://www.baden-wuerttemberg.datenschutz.de" rel="noopener">www.baden-wuerttemberg.datenschutz.de</a>).</p>
      <p>You are not obliged to give us any data; without the details named above we simply cannot answer a message.
        We make no automated decisions about anyone and do not profile anyone.</p>
    </section>

    <section class="legal-block right-to-object" id="object">
      <h2>Right to object</h2>
      <p><b>Where we process your data on the basis of our legitimate interests (Art. 6(1)(f) GDPR), you have the right
        to object at any time, on grounds relating to your particular situation (Art. 21 GDPR).</b> We then stop,
        unless we can show compelling legitimate grounds that override your interests, or the processing serves to
        establish, exercise or defend legal claims. Write to <a href="mailto:contact@prismlca.com">contact@prismlca.com</a>.</p>
    </section>

    <section class="legal-block">
      <h2>Changes</h2>
      <p>A changed notice carries a new date at the top of this page.</p>
    </section>
"""


# The statistics paragraphs in two states. Which one prints follows assets/consent.js: an empty websiteId there
# means no statistics run (and no consent bar appears), so the notice must not describe any.
STATS_OFF = {
    "SHORT_STORAGE": "This website itself sets no cookies and stores nothing in your browser.",
    "SHORT_STATS": "The website currently counts no visits.",
    "STATS": """      <p>This website currently uses no visitor statistics. Before that changes, this notice will describe what is
        counted, on what legal basis, and how you can decline it.</p>
      <div id="privacy-settings"><p>No visitor statistics run, so there is nothing to choose.</p></div>""",
}
STATS_ON = {
    "SHORT_STORAGE": ("This website itself sets no cookies; it stores only your answer to the statistics question in "
                      "your browser, if you give one."),
    "SHORT_STATS": "It counts visits with a statistics tool on our own server, and only if you allow it.",
    "STATS": """      <p>If you allow it, we count visits with a statistics tool that runs on our own server at stats.prismlca.com;
        no analytics data goes to another company (the requests reach our server through Cloudflare like every other
        request to this website). Until you decide, nothing of it loads. With your consent, a script reads your screen
        size and browser language and records the page you opened (its address without any query or fragment), its
        title and the referring website; from the
        request, our server derives browser, operating system, device type and an approximate location (country,
        region, city). Your IP address is used only for that location and for a pseudonymous visit identifier
        computed from it with a secret that changes regularly; the IP address itself is not stored. Visit-level data
        are deleted after seven days; what remains are daily page counts without a visitor identifier, kept for up to
        twelve months. The tool sets no cookies. If your browser
        sends “Do Not Track”, your visit is not counted even with consent.</p>
      <p>We remember your answer — allowed or declined, with its date and nothing else — in your browser's local
        storage for twelve months, so that we do not ask on every page. If your browser sends Global Privacy
        Control, we treat that as a refusal and do not ask.</p>
      <p><i>Legal basis:</i> your consent, § 25(1) TDDDG and Art. 6(1)(a) GDPR. You can withdraw it at any time with
        effect for the future, right here or through “Privacy settings” at the foot of every page.</p>
      <div id="privacy-settings"><noscript><p>Statistics need JavaScript, and without it none run.</p></noscript></div>""",
}


def stats_live() -> bool:
    """True when the site's assets/consent.js names a Umami website ID, i.e. the statistics (and the consent bar)
    are on. Read from the site folder in use (``--site``), like every other input of the page."""
    consent = wl.SITE / "assets" / "consent.js"
    m = re.search(r"websiteId:\s*'([^']*)'", consent.read_text(encoding="utf-8"))
    if not m:
        raise SystemExit(f"website_privacy: could not find websiteId in {consent}")
    return bool(m.group(1).strip())


def website_part() -> str:
    text = WEBSITE
    for key, value in (STATS_ON if stats_live() else STATS_OFF).items():
        text = text.replace("{" + key + "}", value)
    return text


def app_notice_html() -> str:
    """PRIVACY.md as HTML, unchanged except that its title is dropped and every heading moves one level down."""
    md = APP_NOTICE.read_text(encoding="utf-8")
    body = MarkdownIt("commonmark").render(md)
    body = re.sub(r"<h1>.*?</h1>\n?", "", body, count=1)
    body = re.sub(r"<(/?)h([1-5])>", lambda m: f"<{m.group(1)}h{int(m.group(2)) + 1}>", body)
    body = body.replace('<a href="http', '<a rel="noopener" href="http')
    return body


def build() -> dict[Path, str]:
    nav, foot = wl.chrome()
    foot = foot.replace('<a href="licenses.html" aria-current="page">Licences</a>', '<a href="licenses.html">Licences</a>')
    foot = foot.replace('<a href="privacy.html">Privacy</a>', '<a href="privacy.html" aria-current="page">Privacy</a>')
    page = f"""<!doctype html>
<html lang="en" class="no-js">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PrismLCA Privacy</title>
  <meta name="description" content="How the PrismLCA website and the PrismLCA app handle personal data: no own cookies, no third-party tracking, statistics on our own server." />
  <link rel="icon" href="assets/img/favicon.png" type="image/png" />
  <link rel="stylesheet" href="assets/prism-theme.css" />
  <link rel="stylesheet" href="assets/site.css" />
  <link rel="stylesheet" href="assets/legal.css" />
</head>
<body>
<!-- GENERATED by backend/scripts/website_privacy.py: the website part is written in that script, the app part
     is PRIVACY.md. Do not edit by hand. The test backend/tests/test_website_privacy.py fails when this page is
     stale. -->
{nav}

<main id="top" class="legal privacy">
  <div class="wrap">
    <p class="eyebrow">Legal</p>
    <h1>Privacy</h1>
    <p class="legal-lede">Version of {VERSION}. This page has two parts: <a href="#website">the website</a> you are
      reading, and <a href="#app">the PrismLCA app</a>, whose notice is reproduced here word for word as it ships
      with the app.</p>

    <h2 class="privacy-part" id="website">The website prismlca.com</h2>
{website_part()}
    <h2 class="privacy-part" id="app">The PrismLCA app</h2>
    <div class="app-notice">
{app_notice_html()}    </div>
  </div>
</main>

{foot}

<script src="assets/site.js" defer></script>
</body>
</html>
"""
    return {wl.SITE / "privacy.html": page}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--check", action="store_true", help="do not write; exit 1 if the page is stale")
    parser.add_argument("--site", type=Path, help="the site folder (default: Website2/ or $PRISM_SITE_DIR)")
    args = parser.parse_args(argv)
    if args.site:
        wl.use_site(args.site.resolve())
    status = 0
    for path, text in build().items():
        if args.check:
            current = path.read_text(encoding="utf-8") if path.exists() else ""
            if current != text:
                print(f"STALE {path}\nRegenerate: cd backend && uv run python scripts/website_privacy.py", file=sys.stderr)
                status = 1
        else:
            path.write_text(text, encoding="utf-8", newline="\n")
            print(f"wrote {path} ({len(text.encode('utf-8'))} bytes)")
    return status


if __name__ == "__main__":
    sys.exit(main())
