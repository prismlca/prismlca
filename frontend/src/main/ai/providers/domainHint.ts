/**
 * The research legs' allow list as words in the instructions, for the transports whose own filter does not
 * hold it alone. Google Search on the Interactions API takes no domain filter, so there the words are the
 * whole restriction. Anthropic's search takes `allowed_domains`, yet mixes in pages from other hosts
 * (scholarly articles and patents) when the listed sites hold little for a query; a query that names its
 * site keeps most of them out, and the second sentence covers the ones that still come.
 */

/** The instruction for these hosts (bare, normalised by the caller); undefined without an allow list. */
export function domainHint(domains: string[] | undefined): string | undefined {
  if (!domains?.length) return undefined
  return (
    `Search only on these sites (use site: in your queries) and cite pages from them: ${domains.join(', ')}. ` +
    'If they do not hold the answer, say so instead of citing another site.'
  )
}

/** The system prompt with the hint after it; unchanged without an allow list. */
export function withDomainHint(
  system: string | undefined,
  domains: string[] | undefined
): string | undefined {
  const hint = domainHint(domains)
  if (!hint) return system
  return system ? `${system}\n\n${hint}` : hint
}
