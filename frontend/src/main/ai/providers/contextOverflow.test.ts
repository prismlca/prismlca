/**
 * The one test of "too long for the context window": the providers' own phrasings say yes, and the
 * messages that merely name a length or a token say no — a yes makes the agent compact and resend.
 */
import { describe, expect, it } from 'vitest'
import { contextOverflow } from './contextOverflow'

describe('a context overflow', () => {
  it.each([
    // OpenAI, Responses API and the classic message.
    'context_length_exceeded Your input exceeds the context window of this model.',
    "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens. Please reduce the length of the messages.",
    // OpenRouter, for an endpoint behind it.
    "This endpoint's maximum context length is 1048576 tokens. However, you requested about 1100000 tokens.",
    // Anthropic.
    'prompt is too long: 1200000 tokens > 1000000 maximum',
    'input length and `max_tokens` exceed context limit: 190000 + 50000 > 200000',
    // Gemini.
    'The input token count (1234567) exceeds the maximum number of tokens allowed (1048576).',
    // Endpoints behind OpenRouter.
    'Input is too long for requested model.',
    'Too many input tokens for this model'
  ])('is recognised in: %s', (text) => {
    expect(contextOverflow(text)).toBe(true)
  })

  it.each([
    'max_tokens: Input should be less than or equal to 128000',
    "Invalid 'tools[3].function.parameters': maxLength must be a positive integer",
    "string_above_max_length: Invalid 'input[2].content': string too long.",
    "Invalid 'user': string too long. Expected a string with maximum length 64.",
    'Invalid value for reasoning.effort: token budget not supported',
    'Unsupported parameter: temperature'
  ])('is not read into: %s', (text) => {
    expect(contextOverflow(text)).toBe(false)
  })
})
