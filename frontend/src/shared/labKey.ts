/**
 * The AI-lab key for a model id — the one rule, shared, because two places must agree on it: the
 * settings table draws a logo from it (renderer) and the catalogue is ORDERED by it (main). Two
 * copies of this line would eventually disagree, and the symptom would be a table whose logo column
 * stops reading as blocks for exactly one vendor.
 *
 * OpenRouter ids carry their vendor as the prefix before the "/"; a BARE id (no slash) belongs to one
 * of the vendors PrismLCA talks to directly — none of their APIs uses vendor prefixes. Anthropic's ids
 * start with `claude-`, Google's with their family name (`gemini-…`, `gemma-…`); everything else bare is
 * OpenAI's.
 */
export function labKey(modelId: string): string {
  if (modelId.includes('/')) return modelId.split('/')[0]
  return bareVendor(modelId)
}

/** The direct vendor of a bare id. The lab keys match OpenRouter's prefixes, so one logo serves both. */
const bareVendor = (id: string): 'anthropic' | 'google' | 'openai' =>
  /^claude-/.test(id) ? 'anthropic' : /^(gemini|gemma)-/.test(id) ? 'google' : 'openai'

/**
 * Which provider BILLED a ledger row, from its model id alone — the ledger keys rows by id and was
 * never given a provider column. A vendor prefix means OpenRouter (`openai/whisper-large-v3` included,
 * `google/gemini-3.8-flash` too); a bare id is the direct vendor `labKey` names.
 */
export function billedBy(modelId: string): 'openrouter' | 'anthropic' | 'google' | 'openai' {
  if (modelId.includes('/')) return 'openrouter'
  return bareVendor(modelId)
}
