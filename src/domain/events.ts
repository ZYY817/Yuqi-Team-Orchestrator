/** Versioned durable facts for Yuqi Team replay. */

import { z } from 'zod'
import { AttemptId, ControlOperationId, FileLeaseId, TaskId, TeamEventId, TeamId, VerificationId, WorkspaceId } from './ids.ts'
import { teamTaskContractSchema } from './task-contract.ts'
import { fileLeaseSchema, teamWorkspaceStatusSchema } from './workspace.ts'
import { evidenceCollectionStatusSchema, evidenceReasonSchema, evidenceRequirementSchema, structuredEvidenceSchema } from './evidence-verdict.ts'
import { taskOutcomeEvidenceSchema } from './task-outcome.ts'
import { budgetReservationSettlementStatusSchema, budgetTokenUsageSchema } from './budget.ts'
import { directWriteStrategySchema } from './execution-policy.ts'
import {
  MAX_REWORK_ROUNDS,
  reviewAutomaticReworkBudgetSchema,
  reviewCheckpointAnchorSchema,
  reviewCheckpointSubjectSchema,
  reviewPolicySchema,
  reviewTriggerSchema,
  reviewerVerdictSchema,
} from './review-policy.ts'
import { modelCatalogFactSchema, providerModelRefSchema, providerScopeSchema, teamModelPolicySchema } from './model-route.ts'
import { teamLocaleSchema } from './locale.ts'
import { MIN_TEAM_CONCURRENCY, MAX_TEAM_CONCURRENCY } from './team-settings-contract.ts'
import { teamContinuationSchema } from './team-continuation.ts'

/** Current Team-domain event schema version. */
export const TEAM_EVENT_SCHEMA_VERSION = 1 as const

const teamIdSchema = z.string().min(1).transform(TeamId)
const taskIdSchema = z.string().min(1).transform(TaskId)
const attemptIdSchema = z.string().min(1).transform(AttemptId)
const verificationIdSchema = z.string().min(1).transform(VerificationId)
const eventIdSchema = z.string().min(1).transform(TeamEventId)
const workspaceIdSchema = z.string().min(1).transform(WorkspaceId)
const fileLeaseIdSchema = z.string().min(1).transform(FileLeaseId)
const controlOperationIdSchema = z.string().min(1).transform(ControlOperationId)
const recoveryTokenSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).min(1)
const childTokenUsageSchema = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
}).strict()

const eventBase = {
  schemaVersion: z.literal(TEAM_EVENT_SCHEMA_VERSION),
  eventId: eventIdSchema,
  teamId: teamIdSchema,
  occurredAt: z.string().min(1),
}

const reason = z.string().trim().min(1).optional()
const nonEmpty = z.string().trim().min(1)
const controllerModelSchema = z.object({
  provider: nonEmpty,
  model: nonEmpty.optional(),
  maxTokens: z.number().int().positive().optional(),
}).strict()
const attemptRuntimeObservationSchema = z.object({
  taskId: taskIdSchema,
  attemptId: attemptIdSchema,
  childSessionId: z.string().trim().min(1).optional(),
  state: z.enum(['live', 'durable', 'missing', 'diagnostic', 'unavailable', 'not-admitted']),
  reason,
}).strict()
const resolutionPrincipalSchema = z.object({
  kind: z.literal('controller-session'),
  sessionId: nonEmpty,
}).strict()
const gitResolutionWorkspaceProofSchema = z.object({
  mode: z.literal('git').optional(),
  workspaceId: workspaceIdSchema,
  projectRoot: nonEmpty,
  repositoryRoot: nonEmpty,
  gitCommonDirectory: nonEmpty,
  baselineRef: nonEmpty,
  volumeRoot: nonEmpty,
  protectedRoots: z.array(nonEmpty),
  worktreePath: nonEmpty,
  branchName: nonEmpty,
}).strict()
const directResolutionWorkspaceProofSchema = z.object({
  mode: z.literal('direct'),
  workspaceId: workspaceIdSchema,
  projectRoot: nonEmpty,
  volumeRoot: nonEmpty,
  protectedRoots: z.array(nonEmpty),
  worktreePath: nonEmpty,
  branchName: nonEmpty,
}).strict()
const resolutionWorkspaceProofSchema = z.union([
  gitResolutionWorkspaceProofSchema,
  directResolutionWorkspaceProofSchema,
])
const attemptResolutionProofSchema = z.object({
  principal: resolutionPrincipalSchema,
  observationState: z.enum(['durable', 'missing', 'not-admitted']),
  childQuiescent: z.literal(true),
  localInFlight: z.literal(false),
  gitVerified: z.literal(true),
  workspace: resolutionWorkspaceProofSchema.optional(),
  leaseIds: z.array(fileLeaseIdSchema),
}).strict()
const recoveryClearProofSchema = z.object({
  principal: resolutionPrincipalSchema,
  childQuiescent: z.literal(true),
  localInFlight: z.literal(false),
  gitVerified: z.literal(true),
  workspace: resolutionWorkspaceProofSchema,
}).strict()

/** Runtime parser for every schema-v1 Team event. */
export const teamEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...eventBase,
    type: z.literal('yuqi/team-created'),
    continuedFrom: teamContinuationSchema.optional(),
    title: z.string().trim().min(1),
    objective: z.string().trim().min(1),
    /** Host-authored user-visible language. Absent on legacy logs. */
    locale: teamLocaleSchema.optional(),
    controllerModel: controllerModelSchema.optional(),
    directWriteStrategy: directWriteStrategySchema.optional(),
    reviewPolicy: reviewPolicySchema.optional(),
    /** Immutable route policy for this Team. Absent on legacy logs. */
    modelRouting: z.object({ providerScope: providerScopeSchema, teamPolicy: teamModelPolicySchema }).strict().optional(),
    /** Immutable initial plan gate. Absent means a legacy log with unknown policy. */
    planConfirmationRequired: z.boolean().optional(),
    /** Admission snapshot; legacy logs omit it and retain the legacy recovery fallback. */
    maxConcurrency: z.number().int().min(MIN_TEAM_CONCURRENCY).max(MAX_TEAM_CONCURRENCY).optional(),
  }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/team-status-changed'), from: z.enum(['draft', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'completed', 'failed', 'needs_reconciliation']), to: z.enum(['draft', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'completed', 'failed', 'needs_reconciliation']), reason }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/team-control-requested'), operationId: controlOperationIdSchema, action: z.enum(['pause', 'resume', 'cancel']) }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/team-followup-requested'), operationId: controlOperationIdSchema, requestDigest: z.string().regex(/^[a-f0-9]{64}$/u), parentSessionId: nonEmpty }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/team-followup-created'), operationId: controlOperationIdSchema, targetTeamId: nonEmpty, targetControllerSessionId: nonEmpty }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/task-created'), contract: teamTaskContractSchema }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/task-revised'), contract: teamTaskContractSchema }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('yuqi/review-requested'),
    reviewId: nonEmpty.max(160),
    trigger: reviewTriggerSchema,
    candidateEventId: eventIdSchema,
    round: z.number().int().min(0).max(MAX_REWORK_ROUNDS),
    /** Absent fields identify a legacy team-completion checkpoint. */
    checkpointSubject: reviewCheckpointSubjectSchema.optional(),
    checkpointAnchor: reviewCheckpointAnchorSchema.optional(),
    automaticReworkBudget: reviewAutomaticReworkBudgetSchema.optional(),
    independentReviewerRequired: z.boolean().optional(),
    /** One bounded user request for this review only; never a Team setting. */
    additionalCriteria: z.string().trim().min(1).max(4_000).optional(),
  }).strict().superRefine((value, context) => {
    if ((value.checkpointSubject === undefined) !== (value.checkpointAnchor === undefined)) {
      context.addIssue({ code: 'custom', path: ['checkpointAnchor'], message: 'checkpoint subject and anchor must be persisted together' })
    }
  }),
  reviewerVerdictSchema.extend({
    ...eventBase,
    type: z.literal('yuqi/review-result-recorded'),
    reviewId: nonEmpty.max(160),
    candidateEventId: eventIdSchema,
    reviewerSessionId: nonEmpty.max(160),
    /** Optional on legacy results; new writers persist content-derived identities. */
    findingFingerprints: z.array(z.string().trim().min(1).max(80)).max(16).optional(),
    /** Required by new independent checkpoints; absent on legacy results. */
    reviewerIndependent: z.boolean().optional(),
    /** Actual Host-selected route diversity; absent on legacy results. */
    reviewerIndependence: z.enum(['model-diverse', 'context-only']).optional(),
  }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('yuqi/review-user-decision-recorded'),
    operationId: controlOperationIdSchema,
    reviewId: nonEmpty.max(160),
    candidateEventId: eventIdSchema,
    round: z.number().int().min(0).max(MAX_REWORK_ROUNDS),
    decision: z.enum(['retry_review', 'authorize_final_rework', 'waive', 'fail', 'cancel']),
    reason: z.string().trim().min(1).max(2_000).optional(),
  }).strict().superRefine((value, context) => {
    if (value.decision === 'waive' && value.reason === undefined) {
      context.addIssue({ code: 'custom', path: ['reason'], message: 'waive requires a reason' })
    }
  }),
  z.object({ ...eventBase, type: z.literal('yuqi/task-manual-acquired'), operationId: controlOperationIdSchema, taskId: taskIdSchema, workspacePath: nonEmpty }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/task-manual-returned'), operationId: controlOperationIdSchema, taskId: taskIdSchema, acquisitionId: controlOperationIdSchema, summary: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/task-retry-requested'), operationId: controlOperationIdSchema, taskId: taskIdSchema }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/task-stop-requested'), operationId: controlOperationIdSchema, taskId: taskIdSchema, attemptId: attemptIdSchema }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/reconciliation-observed'), operationId: controlOperationIdSchema, observations: z.array(attemptRuntimeObservationSchema).min(1) }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/attempt-resolution-proof-recorded'), operationId: controlOperationIdSchema, observationOperationId: controlOperationIdSchema, taskId: taskIdSchema, attemptId: attemptIdSchema, decision: z.enum(['failed', 'cancelled']), proof: attemptResolutionProofSchema }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/attempt-resolution-requested'), operationId: controlOperationIdSchema, observationOperationId: controlOperationIdSchema, taskId: taskIdSchema, attemptId: attemptIdSchema, decision: z.enum(['failed', 'cancelled']), proofOperationId: controlOperationIdSchema.optional() }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/team-recovery-cleared'), operationId: controlOperationIdSchema, target: z.enum(['paused', 'running']), proof: recoveryClearProofSchema }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/team-recovery-cleared-from-journal'), operationId: controlOperationIdSchema, target: z.literal('paused'), controllerSessionId: nonEmpty, workspace: resolutionWorkspaceProofSchema }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/task-status-changed'), taskId: taskIdSchema, from: z.enum(['pending', 'ready', 'running', 'verifying', 'blocked', 'completed', 'failed', 'cancelled']), to: z.enum(['pending', 'ready', 'running', 'verifying', 'blocked', 'completed', 'failed', 'cancelled']), reason }).strict(),
  z.object({
    ...eventBase,
    type: z.literal('yuqi/attempt-created'),
    taskOutcomeVersion: z.literal(1).optional(),
    taskId: taskIdSchema,
    attemptId: attemptIdSchema,
    ordinal: z.number().int().positive(),
    /** Structured route for new attempts. */
    route: providerModelRefSchema.optional(),
    /** Legacy flat route retained for replay compatibility. */
    modelProvider: z.string().trim().min(1).optional(),
    modelId: z.string().trim().min(1).optional(),
    routeBasis: z.enum(['task-exact', 'team-fixed', 'automatic', 'controller-inherit', 'user-fixed']).optional(),
    requestedTier: z.enum(['quick', 'standard', 'critical']).optional(),
    fallbackReason: z.enum(['automatic-candidates-exhausted', 'task-default-controller-inherit', 'team-inherit-controller']).optional(),
    catalogEvidence: z.array(modelCatalogFactSchema).optional(),
    recoveryToken: recoveryTokenSchema.optional(),
  }).strict().superRefine((event, context) => {
    const hasFlatRoute = event.modelProvider !== undefined || event.modelId !== undefined
    if (event.route === undefined && !hasFlatRoute) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['route'], message: 'attempt route is required' })
    }
    if (hasFlatRoute && (event.modelProvider === undefined || event.modelId === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['modelProvider'], message: 'legacy flat route requires modelProvider and modelId' })
    }
    if (event.route !== undefined && hasFlatRoute) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['route'], message: 'structured and legacy flat attempt routes are mutually exclusive' })
    }
    const hasDecisionEvidence = event.routeBasis !== undefined || event.requestedTier !== undefined
      || event.fallbackReason !== undefined || event.catalogEvidence !== undefined
    if (event.route === undefined && hasDecisionEvidence && event.routeBasis !== 'user-fixed') {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['routeBasis'], message: 'legacy flat routes cannot claim structured routing evidence' })
    }
    if (event.route !== undefined && (event.routeBasis === undefined || event.catalogEvidence === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['routeBasis'], message: 'structured routes require basis and catalogEvidence' })
    }
  }),
  z.object({ ...eventBase, type: z.literal('yuqi/attempt-admitted'), taskId: taskIdSchema, attemptId: attemptIdSchema, agentSessionId: z.string().trim().min(1), messageId: z.string().trim().min(1) }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/attempt-child-recovered'), taskId: taskIdSchema, attemptId: attemptIdSchema, childSessionId: z.string().trim().min(1), recoveryToken: recoveryTokenSchema }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/attempt-status-changed'), taskId: taskIdSchema, attemptId: attemptIdSchema, from: z.enum(['dispatching', 'running', 'settled', 'verification_failed', 'completed', 'failed', 'cancelled', 'unknown']), to: z.enum(['dispatching', 'running', 'settled', 'verification_failed', 'completed', 'failed', 'cancelled', 'unknown']), reason }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/attempt-usage-observed'), taskId: taskIdSchema, attemptId: attemptIdSchema, agentSessionId: z.string().trim().min(1), usage: childTokenUsageSchema }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/attempt-evidence-recorded'), taskId: taskIdSchema, attemptId: attemptIdSchema, runId: z.string().trim().min(1), agentSessionId: z.string().trim().min(1), provider: z.string().trim().min(1), stopReason: z.string().trim().min(1), hasAssistantOutput: z.boolean(), taskOutcome: taskOutcomeEvidenceSchema.optional(), reportedChangedFiles: z.array(z.string().trim().min(1).max(1024)).max(512).optional(), usage: childTokenUsageSchema.optional(), settledAt: z.string().trim().min(1) }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/verification-created'), taskId: taskIdSchema, attemptId: attemptIdSchema, verificationId: verificationIdSchema, verifierSessionId: z.string().trim().min(1) }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/verification-status-changed'), taskId: taskIdSchema, attemptId: attemptIdSchema, verificationId: verificationIdSchema, from: z.enum(['pending', 'running', 'passed', 'failed', 'waived', 'cancelled']), to: z.enum(['pending', 'running', 'passed', 'failed', 'waived', 'cancelled']), reason }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/verification-verdict-recorded'), operationId: controlOperationIdSchema, taskId: taskIdSchema, attemptId: attemptIdSchema, verificationId: verificationIdSchema, disposition: z.enum(['passed', 'failed', 'inconclusive']), requirements: z.array(evidenceRequirementSchema).min(1), evidence: z.array(structuredEvidenceSchema), reasons: z.array(evidenceReasonSchema), collectionStatus: evidenceCollectionStatusSchema.optional(), reworkBudget: z.object({ currentAttempt: z.number().int().positive(), maxAttempts: z.number().int().positive() }).strict().optional(), rework: z.object({ action: z.enum(['retry', 'stop']), currentAttempt: z.number().int().positive(), maxAttempts: z.number().int().positive(), nextAttempt: z.number().int().positive().optional(), instructions: z.array(z.string().trim().min(1)).min(1) }).strict().optional() }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/budget-policy-set'), operationId: controlOperationIdSchema, revision: z.number().int().positive(), tokenLimit: z.number().int().positive(), alerts: z.array(z.number().int().min(1).max(99)).refine(alerts => new Set(alerts).size === alerts.length, 'budget alerts must be unique'), stopBehavior: z.literal('block-new') }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/budget-reservation-acquired'), reservationId: z.string().trim().min(1), taskId: taskIdSchema, attemptId: attemptIdSchema, tokenReserve: z.number().int().positive() }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/budget-reservation-settled'), reservationId: z.string().trim().min(1), taskId: taskIdSchema, attemptId: attemptIdSchema, status: budgetReservationSettlementStatusSchema, usage: budgetTokenUsageSchema.optional(), reason: z.string().trim().min(1).optional() }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/workspace-provisioning-started'), workspace: teamWorkspaceStatusSchema('provisioning') }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/workspace-provisioned'), workspaceId: workspaceIdSchema }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/workspace-reconciliation-required'), workspaceId: workspaceIdSchema, reason: z.string().trim().min(1) }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/workspace-recovery-verified'), workspace: teamWorkspaceStatusSchema('ready') }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/file-lease-acquired'), lease: fileLeaseSchema.extend({ status: z.literal('active') }) }).strict(),
  z.object({ ...eventBase, type: z.literal('yuqi/file-lease-released'), leaseId: fileLeaseIdSchema, taskId: taskIdSchema, attemptId: attemptIdSchema.optional(), reason }).strict(),
])

/** Any durable event understood by this version of the Team domain. */
export type TeamEvent = Readonly<z.output<typeof teamEventSchema>>
