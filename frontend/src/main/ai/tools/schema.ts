/** The tiny JSON-Schema DSL every tool spec is written in. */

export function obj(props: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties: props, required }
}
export const str = (description: string) => ({ type: 'string', description })
export const num = (description: string) => ({ type: 'number', description })
export const bool = (description: string) => ({ type: 'boolean', description })
export const strArr = (description: string) => ({ type: 'array', items: { type: 'string' }, description })
export const objArr = (description: string, props: Record<string, unknown>) => ({
  type: 'array',
  items: { type: 'object', properties: props },
  description
})
