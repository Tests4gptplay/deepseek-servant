import { z } from 'zod'

export const ModelRouteSchema = z.strictObject({ provider: z.string().optional(), model: z.string().optional(), reasoningEffort: z.string().optional() })

export function toolParameters(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7' })
  const { $schema: _schema, ...parameters } = json
  return parameters
}
