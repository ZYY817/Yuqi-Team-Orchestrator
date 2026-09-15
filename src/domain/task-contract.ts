/** The minimum durable task specification accepted by the Team controller. */

import { z } from 'zod'
import { TaskId } from './ids.ts'
import { MAX_VERDICT_REWORK_ROUNDS } from './evidence-verdict.ts'
import { TEAM_AUTHORITY_MODES } from './team-settings-contract.ts'
import { MAX_REWORK_ROUNDS } from './review-policy.ts'
import { taskModelRequestSchema, type TaskModelRequest } from './model-route.ts'

/** Whether a task may produce project writes. */
export const TASK_AUTHORITY_MODES = TEAM_AUTHORITY_MODES
/** Model role selected for a task. */
export const TASK_MODEL_ROLES = ['controller', 'worker', 'verifier'] as const
export const TASK_KINDS = ['work', 'review-rework', 'user-revision'] as const
/** One Team can enqueue enough independent tasks to use the 100-worker cap. */
export const MAX_TEAM_TASKS = 100

const taskIdSchema = z.string().min(1).transform(TaskId)

/** Verification commands are selected by the Host from this durable reference. */
export const VERIFICATION_CHECK_KINDS = ['build', 'test', 'interface', 'screenshot'] as const
export const MAX_VERIFICATION_CHECKS = 4
export const MAX_VERIFICATION_REF_LENGTH = 128
export const MAX_VERIFICATION_TIMEOUT_MS = 300_000
export const MAX_VERIFICATION_OUTPUT_BYTES = 1_048_576

const verificationRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_VERIFICATION_REF_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)

const verificationCommonSchema = {
  checkId: verificationRefSchema,
  timeoutMs: z.number().int().positive().max(MAX_VERIFICATION_TIMEOUT_MS),
  stdoutMaxBytes: z.number().int().positive().max(MAX_VERIFICATION_OUTPUT_BYTES),
  stderrMaxBytes: z.number().int().positive().max(MAX_VERIFICATION_OUTPUT_BYTES),
} as const

/** Host-owned, machine-executable verification configuration. */
export const verificationCheckSchema = z.discriminatedUnion('kind', [
  z.object({ ...verificationCommonSchema, kind: z.literal('build'), commandRef: verificationRefSchema }).strict(),
  z.object({ ...verificationCommonSchema, kind: z.literal('test'), commandRef: verificationRefSchema }).strict(),
  z.object({
    ...verificationCommonSchema,
    kind: z.literal('interface'),
    commandRef: z.literal('pnpm-interface-probe'),
    method: z.string().regex(/^[A-Z]+$/u),
    path: z.string().regex(/^\/(?!\/)[^\s]*$/u).max(MAX_VERIFICATION_REF_LENGTH),
    expectedStatusCodes: z.array(z.number().int().min(100).max(599)).optional(),
  }).strict(),
  z.object({
    ...verificationCommonSchema,
    kind: z.literal('screenshot'),
    commandRef: z.literal('pnpm-screenshot-probe'),
    path: z.string().regex(/^\/(?!\/)[^\s]*$/u).max(MAX_VERIFICATION_REF_LENGTH),
    viewport: z.object({ width: z.number().int().positive().max(4096), height: z.number().int().positive().max(4096) }).strict(),
    format: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    referenceDigest: z.string().trim().min(1).max(MAX_VERIFICATION_REF_LENGTH),
  }).strict(),
])

export const verificationChecksSchema = z
  .array(verificationCheckSchema)
  .min(1)
  .max(MAX_VERIFICATION_CHECKS)
  .superRefine((checks, context) => {
    const seen = new Map<string, number>()
    for (const [index, check] of checks.entries()) {
      const previousIndex = seen.get(check.checkId)
      if (previousIndex !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'checkId'],
          message: `duplicate checkId; first declared at index ${previousIndex}`,
        })
      } else {
        seen.set(check.checkId, index)
      }
    }
  })

/** Runtime schema for a versioned task contract crossing the durable log boundary. */
export const teamTaskContractSchema = z.object({
  taskId: taskIdSchema,
  revision: z.number().int().positive(),
  goal: z.string().trim().min(1),
  scope: z.array(z.string().trim().min(1)),
  nonGoals: z.array(z.string().trim().min(1)),
  dependencies: z.array(taskIdSchema),
  fileScope: z.array(z.string().trim().min(1)),
  modelRole: z.enum(TASK_MODEL_ROLES),
  /** Structured model intent for new contracts. Absent only on legacy contracts. */
  modelRequest: taskModelRequestSchema.optional(),
  /** Provider-less legacy model selection retained only for replay compatibility. */
  modelId: z.string().trim().min(1).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  authorityMode: z.enum(TASK_AUTHORITY_MODES),
  inputDigest: z.string().trim().min(1),
  /** Git baseline is required only for the explicit Git worktree mode. */
  baselineRef: z.string().trim().min(1).optional(),
  verificationChecks: verificationChecksSchema.optional(),
  maxAttempts: z.number().int().positive().max(MAX_VERDICT_REWORK_ROUNDS).optional(),
  /** Absent means a legacy/ordinary work task. */
  kind: z.enum(TASK_KINDS).optional(),
  /** Immutable source result; a revision never reopens the source task. */
  userRevision: z.object({
    operationId: z.string().trim().min(1).max(160),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceTaskId: taskIdSchema,
    sourceRevision: z.number().int().positive(),
    sourceAttemptId: z.string().trim().min(1),
    revalidation: z.object({
      rootSourceTaskId: taskIdSchema,
      taskMapping: z.array(z.object({
        sourceTaskId: taskIdSchema,
        taskId: taskIdSchema,
      }).strict()).min(2).max(MAX_TEAM_TASKS),
    }).strict().optional(),
  }).strict().optional(),
  /** Immutable provenance for a first-class reviewer rework task. */
  reviewRework: z.object({
    sourceReviewId: z.string().trim().min(1).max(160),
    round: z.number().int().positive().max(MAX_REWORK_ROUNDS),
  }).strict().optional(),
}).strict().superRefine((contract, context) => {
  if ((contract.kind === 'user-revision') !== (contract.userRevision !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['userRevision'], message: 'user-revision tasks require exclusive revision provenance' })
  }
  if (contract.modelRequest === undefined && contract.modelId === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['modelRequest'], message: 'modelRequest is required for new contracts; legacy contracts require modelId' })
  }
  if (contract.modelRequest !== undefined && contract.modelId !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['modelRequest'], message: 'modelRequest and legacy modelId are mutually exclusive' })
  }
  if (contract.kind === 'review-rework' && contract.reviewRework === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['reviewRework'], message: 'review-rework tasks require review provenance' })
  }
  if (contract.kind !== 'review-rework' && contract.reviewRework !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['reviewRework'], message: 'only review-rework tasks may carry review provenance' })
  }
})

/** Versioned task intent stored in Team events. */
export type TeamTaskContract = Readonly<z.output<typeof teamTaskContractSchema>>

/** Read old durable contracts without inventing provider provenance. */
export function modelRequestForTask(contract: TeamTaskContract): TaskModelRequest {
  if (contract.modelRequest !== undefined) return contract.modelRequest
  return { kind: 'legacy', modelId: contract.modelId! }
}

export type VerificationCheck = Readonly<z.output<typeof verificationCheckSchema>>
