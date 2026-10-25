import { z } from 'zod'

export const Id = z.string().min(1).max(240).regex(/^(?!__proto__$|prototype$|constructor$)[A-Za-z0-9_.:@/-]+$/)
export const Text = z.string().min(1).max(32_000)
export const ModelRouteSchema = z.strictObject({ provider: z.string().max(200).optional(), model: z.string().max(200).optional(), reasoningEffort: z.string().max(100).optional() })
export const SettingsSchema = z.strictObject({ name: z.string().min(1).max(120), workspaceId: Id.optional(),
  workspaceDirectory: z.string().trim().min(1).max(4000).optional(), presetId: Id,
  foreground: ModelRouteSchema, background: ModelRouteSchema })
  .refine(settings => settings.workspaceId === undefined || settings.workspaceDirectory === undefined,
    { message: 'Select a registered workspace or a custom directory, not both.' })
export const ArtifactSchema = z.strictObject({ id: Id, path: z.string().min(1).max(4000), description: Text,
  version: z.string().max(500).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(), resultId: Id.optional() })
export const GoalSchema = z.strictObject({ request: Text, objective: Text, constraints: z.array(Text).max(100),
  deliverables: z.array(Text).min(1).max(100), acceptanceCriteria: z.array(Text).min(1).max(100), sourceRef: Text })
export const ChildSchema = z.strictObject({ id: Id, title: z.string().min(1).max(500), objective: Text,
  inputArtifacts: z.array(ArtifactSchema).max(200), acceptanceCriteria: z.array(Text).min(1).max(100),
  dependsOn: z.array(Id).max(100), writeScopes: z.array(z.string().min(1).max(4000)).max(100), resources: z.array(Id).max(100) })
export const WaitSchema = z.strictObject({ id: Id, kind: z.enum(['user', 'configuration', 'resource', 'job', 'recovery']),
  reason: Text, condition: Text, resume: Text, jobId: Id.optional(), question: Text.optional() })
export const ProposalSchema = z.strictObject({ skillId: Id, expectedVersion: z.int().positive().optional(), title: z.string().min(1).max(500), description: Text,
  body: z.string().min(1).max(64_000), applicability: Text, resultId: Id, explanation: Text, artifactRefs: z.array(Id).max(200), activate: z.boolean().optional() })
export const MemorySchema = z.strictObject({ frontier: Text.optional(), evidence: z.array(Text).max(100).optional(), failedApproaches: z.array(Text).max(100).optional(), changedAssumptions: z.array(Text).max(100).optional(),
  planNote: z.strictObject({ expectedRevision: z.int().nonnegative(), body: Text, frontier: Text, changeSummary: Text }).optional(),
  noteUse: z.strictObject({ revision: z.int().positive(), summary: Text, frontier: Text }).optional() })
export const CheckpointSchema = z.strictObject({ completed: z.array(Text).max(100),
  failedApproaches: z.array(z.strictObject({ approach: Text, outcome: Text, evidence: z.array(Text).max(100) })).max(100),
  remaining: z.array(Text).max(100), nextAction: Text, nextReads: z.array(Text).max(100) })
export const ReportSchema = z.strictObject({ resultId: Id, assignmentVersion: z.int().positive(),
  outcome: z.enum(['progress', 'continue', 'handoff', 'complete', 'wait', 'failed']), summary: Text,
  artifacts: z.array(ArtifactSchema).max(200), evidence: z.array(Text).max(100), frontier: Text, wait: WaitSchema.optional(), checkpoint: CheckpointSchema.optional() })
export const DecisionSchema = z.strictObject({ childId: Id, resultId: Id, outcome: z.enum(['accept', 'rework', 'continue']), reason: Text, revisedChild: ChildSchema.optional() })

export function toolParameters(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7' })
  const { $schema: _schema, ...parameters } = json
  return parameters
}
