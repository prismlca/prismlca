import { GlobeIcon } from '../../components/icons'
import {
  GITHUB_URL,
  LINKEDIN_COMPANY_URL,
  LINKEDIN_URL,
  SUBSTACK_URL,
  WEBSITE_URL,
  openLink
} from '../../lib/links'
import githubLogo from '../../assets/logos/github.svg'
import linkedinLogo from '../../assets/logos/linkedin.svg'
import substackLogo from '../../assets/logos/substack.svg'

/**
 * Where PrismLCA lives outside the app: the website, and three of the social links its footer carries —
 * the source on GitHub, the newsletter, the LinkedIn page — with the same marks. Buttons, not anchors: an
 * <a href> would navigate the app window away from PrismLCA.
 */
const LINKS: { label: string; url: string; icon: JSX.Element }[] = [
  {
    label: WEBSITE_URL.replace(/^https?:\/\//, '').replace(/\/$/, ''),
    url: WEBSITE_URL,
    icon: <GlobeIcon />
  },
  { label: 'GitHub', url: GITHUB_URL, icon: <img className="about-gh" src={githubLogo} alt="" /> },
  { label: 'Substack', url: SUBSTACK_URL, icon: <img src={substackLogo} alt="" /> },
  { label: 'LinkedIn', url: LINKEDIN_COMPANY_URL, icon: <img src={linkedinLogo} alt="" /> }
]

export function AboutLinks(): JSX.Element {
  return (
    <p className="settings-hint about-links">
      {LINKS.map((l) => (
        <button
          key={l.url}
          className="link-btn about-link"
          onClick={() => openLink(l.url)}
          title={`Open ${l.url}`}
        >
          {l.icon}
          {l.label}
        </button>
      ))}
    </p>
  )
}

/** The lead developer, with the same words and the same link as in the start page's footer. */
export function LeadDeveloper(): JSX.Element {
  return (
    <p className="settings-hint">
      Lead developer:{' '}
      <button
        className="link-btn about-link"
        onClick={() => openLink(LINKEDIN_URL)}
        title="Jonas Harth on LinkedIn"
      >
        Jonas Harth
        <img src={linkedinLogo} alt="" />
      </button>
    </p>
  )
}
