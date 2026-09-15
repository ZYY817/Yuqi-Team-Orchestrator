/** Versioned child declarations, separate from runtime termination and Host verification. */
import { z } from 'zod'

export const taskOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('completed'), summary: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('blocked'), summary: z.string().trim().min(1).max(2000), nextAction: z.string().trim().min(1).max(1000), question: z.string().trim().min(1).max(1000).optional() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('failed'), summary: z.string().trim().min(1).max(2000), nextAction: z.string().trim().min(1).max(1000).optional() }).strict(),
])

export const taskOutcomeEvidenceSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('reported'), outcome: taskOutcomeSchema }).strict(),
  z.object({ status: z.literal('missing') }).strict(),
  z.object({ status: z.literal('invalid') }).strict(),
])
export type TaskOutcomeEvidence = z.infer<typeof taskOutcomeEvidenceSchema>

/** Parse only the final assistant report supplied by the Host, never arbitrary history. */
export function parseTaskOutcomeReport(text: string): TaskOutcomeEvidence {
  const lines = text.split(/\r?\n/u).filter(line => line.trimStart().startsWith('YUQI_TASK_OUTCOME:'))
  if (lines.length === 0) return { status: 'missing' }
  if (lines.length !== 1 || lines[0]!.length > 5000) return { status: 'invalid' }
  try {
    const parsed = taskOutcomeSchema.safeParse(JSON.parse(lines[0]!.trimStart().slice('YUQI_TASK_OUTCOME:'.length)))
    return parsed.success ? { status: 'reported', outcome: parsed.data } : { status: 'invalid' }
  } catch { return { status: 'invalid' } }
}

/** A new attempt cannot succeed without an explicit valid completion declaration. */
export function taskOutcomeAllowsCompletion(version: 1 | undefined, evidence: TaskOutcomeEvidence | undefined): boolean {
  if (evidence?.status === 'reported') return evidence.outcome.kind === 'completed'
  return version === undefined && (evidence === undefined || evidence.status === 'missing')
}
