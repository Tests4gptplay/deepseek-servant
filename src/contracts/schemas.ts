import { z } from 'zod'

// Keep identity checks local; model APIs support different regular-expression dialects.
export const Id = z.string().min(1).refine(value => /^(?!__proto__$|prototype$|constructor$)[^\0\r\n]+$/u.test(value), 'Invalid record identity.')
export const Text = z.string().min(1)
export const ModelRouteSchema = z.strictObject({ provider: z.string().optional(), model: z.string().optional(), reasoningEffort: z.string().optional() })
export const SettingsSchema = z.strictObject({ name: z.string().min(1), userName: z.string().optional(), workspaceId: Id.optional(),
  workspaceDirectory: z.string().trim().min(1).optional(), presetId: Id,
  foreground: ModelRouteSchema, background: ModelRouteSchema,
  showCornerCharacter: z.boolean().optional(), swapPageIllustrations: z.boolean().optional() })
  .refine(settings => settings.workspaceId === undefined || settings.workspaceDirectory === undefined,
    { message: 'Select a registered workspace or a custom directory, not both.' })
export const ArtifactSchema = z.strictObject({ id: Id, path: z.string().min(1), description: Text,
  version: z.string().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(), resultId: Id.optional() })
export const GoalSchema = z.strictObject({ request: Text, objective: Text, constraints: z.array(Text),
  deliverables: z.array(Text).min(1), acceptanceCriteria: z.array(Text).min(1), sourceRef: Text })
export const ChildSchema = z.strictObject({ id: Id, title: z.string().min(1), objective: Text,
  inputArtifacts: z.array(ArtifactSchema), acceptanceCriteria: z.array(Text).min(1),
  dependsOn: z.array(Id), writeScopes: z.array(z.string().min(1)), resources: z.array(Id) })
export const WaitSchema = z.strictObject({ id: Id, kind: z.enum(['user', 'configuration', 'resource', 'job', 'recovery']),
  reason: Text, condition: Text, resume: Text, jobId: Id.optional(), question: Text.optional() })
export const ProposalSchema = z.strictObject({ skillId: Id, expectedVersion: z.int().positive().optional(), title: z.string().min(1), description: Text,
  body: Text, applicability: Text, resultId: Id, explanation: Text, artifactRefs: z.array(Id), activate: z.boolean().optional() })
export const BacklogSchema = z.strictObject({ id: Id, objective: Text, reason: Text, dependsOn: z.array(Id), trigger: Text,
  required: z.boolean(), status: z.enum(['pending', 'done', 'cancelled']) })
export const MemorySchema = z.strictObject({ frontier: Text.optional(), evidence: z.array(Text).optional(), failedApproaches: z.array(Text).optional(), changedAssumptions: z.array(Text).optional(),
  planNote: z.strictObject({ expectedRevision: z.int().nonnegative(), body: Text, frontier: Text, changeSummary: Text, backlog: z.array(BacklogSchema).optional() }).optional(),
  noteUse: z.strictObject({ revision: z.int().positive(), summary: Text, frontier: Text }).optional() })
export const CheckpointSchema = z.strictObject({ completed: z.array(Text),
  failedApproaches: z.array(z.strictObject({ approach: Text, outcome: Text, evidence: z.array(Text) })),
  remaining: z.array(Text), nextAction: Text, nextReads: z.array(Text) })
export const ReportSchema = z.strictObject({ resultId: Id, assignmentVersion: z.int().positive(),
  outcome: z.enum(['progress', 'continue', 'handoff', 'complete', 'wait', 'failed']), summary: Text,
  artifacts: z.array(ArtifactSchema), evidence: z.array(Text), frontier: Text, wait: WaitSchema.optional(), checkpoint: CheckpointSchema.optional() })
export const DecisionSchema = z.strictObject({ childId: Id, resultId: Id, outcome: z.enum(['accept', 'rework', 'continue']), reason: Text, revisedChild: ChildSchema.optional() })

export function toolParameters(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7' })
  const { $schema: _schema, ...parameters } = json
  return parameters
}
