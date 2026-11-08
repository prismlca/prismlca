/**
 * Does a provider's error text say the request was too long for the model's context window? One list for
 * every transport, because the answer has a consequence: a 'context' error makes the agent compact the
 * conversation hard and send the round again (agent.ts). A false yes costs a summarising call and a
 * second request, and then shows "too long" in place of the provider's own message — a schema's
 * `maxLength`, a bad `max_tokens` value or an invalid parameter once matched a bare /context|token|length/.
 * A false no only skips that recovery, and the provider's message is shown as it is.
 *
 * The phrases are the providers' own (OpenAI and OpenRouter: "maximum context length",
 * `context_length_exceeded`; Anthropic: "prompt is too long"; Gemini: "token count … exceeds the maximum
 * number of tokens"), plus the forms the endpoints behind OpenRouter use. The exclusions are two messages
 * that name a length and are not about the context at all.
 */
const SAYS_TOO_LONG: RegExp[] = [
  /context[_ ]length[_ ]exceeded/i,
  /maximum context length/i,
  /\bcontext (window|limit|length|size)\b/i,
  /\b(prompt|input|request) (is )?too (long|large)\b/i,
  /too many (input )?tokens/i,
  /exceeds? (the )?(maximum|max|available|allowed) (number of )?(input )?(tokens|context)/i,
  /token count\b.{0,60}\bexceeds?\b/i,
  /reduce the length of the (messages|prompt|input)/i,
  /input length and `?max_tokens`? exceed/i
]

const NOT_CONTEXT: RegExp[] = [
  // A string field longer than its schema allows (OpenAI's code for it).
  /string_above_max_length/i,
  // The `user` parameter being too long — a request field, not the conversation.
  /\buser\b[^.]{0,40}\btoo long\b/i
]

export function contextOverflow(text: string): boolean {
  return SAYS_TOO_LONG.some((re) => re.test(text)) && !NOT_CONTEXT.some((re) => re.test(text))
}
