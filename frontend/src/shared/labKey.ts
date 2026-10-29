/**
 * The AI-lab key for a model id — the one rule, shared, because two places must agree on it: the
 * settings table draws a logo from it (renderer) and the catalogue is ORDERED by it (main). Two
 * copies of this line would eventually disagree, and the symptom would be a table whose logo column
 * stops reading as blocks for exactly one vendor.
 *
 * OpenRouter ids carry their vendor as the prefix before the "/"; a BARE id (no slash) is a
 * direct-OpenAI catalogue id by construction — OpenAI's own API has no vendor prefixes, and it is
 * the only direct provider PrismLCA talks to.
 */
export function labKey(modelId: string): string {
  return modelId.includes('/') ? modelId.split('/')[0] : 'openai'
}
