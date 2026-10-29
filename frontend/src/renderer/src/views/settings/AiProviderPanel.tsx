import { setAS, useAppSettings } from '../../lib/appSettings'
import { LAB_LOGOS } from '../../lib/labLogos'
import openrouterLogo from '../../assets/logos/openrouter.svg'
import { ProviderKeyBlock, type ProviderChoice } from './ProviderKeyBlock'

/** AI → Provider: who answers — OpenRouter or OpenAI direct — and that provider’s key. */
export function AiProviderPanel(): JSX.Element {
  const provider = (useAppSettings().provider ?? 'openrouter') as ProviderChoice
  const pickProvider = (p: ProviderChoice): void => setAS({ provider: p })

  return (
    <>
      <h4>AI provider</h4>
      {/* Cards, not a dropdown: the provider is the one decision on this page,
          and a select hides the alternative. Two tiles — logo, name, five words — say what the
          choice is at a glance; the selected one is marked, the click writes through. */}
      <div className="provider-cards" role="radiogroup" aria-label="Provider">
        {(
          [
            { id: 'openrouter', logo: openrouterLogo, name: 'OpenRouter', blurb: 'One key, many labs' },
            { id: 'openai', logo: LAB_LOGOS.openai, name: 'OpenAI', blurb: 'Direct — OpenAI models only' }
          ] as const
        ).map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={provider === c.id}
            className={`provider-card${provider === c.id ? ' on' : ''}`}
            onClick={() => pickProvider(c.id)}
          >
            <img className="provider-card-logo" src={c.logo} alt="" />
            <span className="provider-card-name">{c.name}</span>
            <span className="provider-card-blurb">{c.blurb}</span>
          </button>
        ))}
      </div>
      <p className="settings-hint">
        Where every model request goes. OpenRouter offers models from many labs behind one key and can be told
        to route only to zero-retention endpoints; OpenAI direct talks straight to api.openai.com with an
        OpenAI key and offers OpenAI&rsquo;s models only. Model choices (under Models) and the key of the
        inactive provider stay stored — switching back restores them.
      </p>
      <ProviderKeyBlock provider={provider} />
    </>
  )
}
