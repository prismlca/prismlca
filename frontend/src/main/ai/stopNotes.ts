/**
 * The note the chat appends when the provider's safety filter declined to answer (finish reason
 * `content_filter`). Without it a refusal looked like an empty answer: the loop nudged the model with
 * "your last response was empty", sent the round again — refused again, and paid for — and ended by
 * calling it a provider-side failure. A refusal is the provider's decision about the request, so the
 * note says whose decision it was and, where the provider gives one, its reason.
 */
export function refusalNote(detail: string | undefined): string {
  const why = detail?.trim() ? ` (${detail.trim()})` : ''
  return (
    `\n\n_The provider's safety filter declined this request${why}. Nothing more was done in this step — ` +
    'rephrase it, or pick another model under Settings → AI._'
  )
}
