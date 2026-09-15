/** Deterministic Team projection and durable-event replay. */

import type { AttemptId, ControlOperationId, FileLeaseId, TaskId, TeamEventId, TeamId, VerificationId } from './ids.ts'
import { YuqiDomainError } from './errors.ts'
import type { YuqiDomainErrorCode, YuqiDomainErrorDetails } from './errors.ts'
import { TEAM_EVENT_SCHEMA_VERSION, teamEventSchema } from './events.ts'
import type { TeamEvent } from './events.ts'
import type { TeamTaskContract } from './task-contract.ts'
import { taskOutcomeAllowsCompletion, type TaskOutcomeEvidence } from './task-outcome.ts'
import { fileScopeSetsConflict } from './file-scope.ts'
import { workspaceProofMatches, type FileLease, type ResolutionWorkspaceProof, type TeamWorkspace } from './workspace.ts'
import { MAX_TEAM_TASKS } from './task-contract.ts'
import { taskRevisionIssue, taskRevisionBatchIssue, taskRevisionDependenciesIssue } from './task-revision.ts'
import type { TeamContinuation, TeamFollowupOperation } from './team-continuation.ts'
import { transitionAttempt, transitionTask, transitionTeam, transitionVerification } from './states.ts'
import type { AttemptStatus, TaskStatus, TeamStatus, VerificationStatus } from './states.ts'
import { assessEvidenceRecord, isEvidenceRequirementRequired, parseStructuredEvidence } from './evidence-verdict.ts'
import type { EvidenceCollectionStatus, EvidenceReason, EvidenceRequirement, StructuredEvidence } from './evidence-verdict.ts'
import { assessTokenReservation } from './budget.ts'
import type { BudgetPolicyView, BudgetReservationView } from './budget.ts'
import { DEFAULT_DIRECT_WRITE_STRATEGY, type DirectWriteStrategy } from './execution-policy.ts'
import {
  DEFAULT_MAX_REWORK_ROUNDS,
  DEFAULT_MAX_TEAM_AUTOMATIC_REWORKS,
  MAX_REWORK_ROUNDS,
  reviewFindingFingerprint,
  type ReviewAutomaticReworkBudget,
  type ReviewCheckpointAnchor,
  type ReviewCheckpointPhase,
  type ReviewCheckpointSubject,
  type ReviewFinding,
  type ReviewPolicy,
  type ReviewTrigger,
  type ReviewUserDecision,
} from './review-policy.ts'
import type { ModelCatalogFact, ModelRouteTaskTier, ModelRoutingPolicy, ProviderModelRef } from './model-route.ts'
import { DEFAULT_TEAM_LOCALE, type TeamLocale } from './locale.ts'
import { isHumanOwned, manualTakeoverIssue, type ManualOwnership, type ManualOwnershipOperation } from './manual-ownership.ts'

/** Read model for the Team itself. */
export interface TeamView {
  readonly continuedFrom?: TeamContinuation
  readonly manualOwnership?: ManualOwnership
  readonly manualOwnershipOperations?: Readonly<Record<string, ManualOwnershipOperation>>
  /** Team identity. */
  readonly id: TeamId
  /** Durable timestamp from the first draft→running transition. */
  readonly startedAt?: string
  /** Durable timestamp from the first terminal Team transition. */
  readonly endedAt?: string
  /** User-facing Team title. */
  readonly title: string
  /** Original Team objective. */
  readonly objective: string
  /** Host-authored user-visible language; legacy Teams replay as Chinese. */
  readonly locale: TeamLocale
  /** Current lifecycle state. */
  readonly status: TeamStatus
  /** Durable route needed to rehydrate the hidden controller after a Host restart. */
  readonly controllerModel?: { readonly provider: string; readonly model?: string; readonly maxTokens?: number }
  /** Durable writer-admission policy snapshotted when the Team starts. */
  readonly directWriteStrategy: DirectWriteStrategy
  /** Immutable reviewer policy; absent only for legacy logs. */
  readonly reviewPolicy?: ReviewPolicy
  /** Immutable structured route policy; absent on legacy logs. */
  readonly modelRouting?: ModelRoutingPolicy
  /** Immutable initial plan gate; undefined only for legacy logs. */
  readonly planConfirmationRequired?: boolean
  readonly maxConcurrency?: number
}

/** Read model for one task. */
export interface TaskView {
  /** Current task contract revision. */
  readonly contract: TeamTaskContract
  /** Current task lifecycle state. */
  readonly status: TaskStatus
  /** Attempts in creation order. */
  readonly attemptIds: readonly AttemptId[]
  /** Verification runs in creation order. */
  readonly verificationIds: readonly VerificationId[]
  /** Lowest attempt ordinal eligible for verification after the latest retry. */
  readonly verificationAttemptFloor: number
}

/** Read model for one execution attempt. */
export interface AttemptView {
  readonly taskOutcomeVersion?: 1
  /** Attempt identity. */
  readonly id: AttemptId
  /** Durable timestamp from dispatching→running. */
  readonly startedAt?: string
  /** Durable child settlement timestamp, or terminal transition time without evidence. */
  readonly endedAt?: string
  /** Owning task. */
  readonly taskId: TaskId
  /** One-based attempt number within the task. */
  readonly ordinal: number
  /** Fixed model selected for this attempt. */
  readonly modelId: string
  /** Fixed LLM provider route selected for this attempt. */
  readonly modelProvider: string
  /** Structured route retained exactly for new attempts; absent on legacy events. */
  readonly route?: ProviderModelRef
  /** Provenance for the durable route selected before admission. */
  readonly routeBasis?: 'task-exact' | 'team-fixed' | 'automatic' | 'controller-inherit' | 'user-fixed'
  readonly requestedTier?: ModelRouteTaskTier
  readonly fallbackReason?: 'automatic-candidates-exhausted' | 'task-default-controller-inherit' | 'team-inherit-controller'
  /** Metadata/routability facts used for this decision; never credential evidence. */
  readonly catalogEvidence?: readonly ModelCatalogFact[]
  /** Harness child Session identity, present only after admission. */
  readonly agentSessionId?: string
  /** Durable, non-user-derived identity used only for cold child lookup. */
  readonly recoveryToken?: string
  /** Accepted initial inbox message identity, present only after admission. */
  readonly messageId?: string
  /** Current attempt lifecycle state. */
  readonly status: AttemptStatus
  /** Latest cumulative provider usage observed before terminal settlement. */
  readonly observedUsage?: ChildUsageView
  /** Minimal settlement evidence; child Session retains the actual model output. */
  readonly evidence?: AttemptEvidenceView
  /** Explicit negative accounting that closed a cold-recovery attempt without terminal child evidence. */
  readonly resolutionProofOperationId?: ControlOperationId
}

export interface ChildUsageView {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** Non-secret reference proving how a child attempt settled. */
export interface AttemptEvidenceView {
  readonly taskOutcome?: TaskOutcomeEvidence
  /** Harness lifecycle run identity. */
  readonly runId: string
  /** Harness child Session identity. */
  readonly agentSessionId: string
  /** Harness provider recorded for this run. */
  readonly provider: string
  /** Extensible Harness stop reason. */
  readonly stopReason: string
  /** Whether the child reported final assistant content, without duplicating it. */
  readonly hasAssistantOutput: boolean
  /** Child-reported paths for presentation; the Git workspace remains the aggregate authority. */
  readonly reportedChangedFiles?: readonly string[]
  /** Provider-reported usage; absent means the host could not prove it. */
  readonly usage?: {
    readonly uncachedInputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
  }
  /** ISO timestamp supplied by the Team event. */
  readonly settledAt: string
}

/** Read model for one verification run. */
export interface VerificationView {
  /** Verification identity. */
  readonly id: VerificationId
  /** Task being verified. */
  readonly taskId: TaskId
  /** Attempt whose evidence is verified. */
  readonly attemptId: AttemptId
  /** Harness verifier Session identity. */
  readonly verifierSessionId: string
  /** Current verification lifecycle state. */
  readonly status: VerificationStatus
  /** Latest host-structured acceptance verdict, when one has been recorded. */
  readonly verdict?: VerificationVerdictView
}

/** Durable result of one host-structured verification decision. */
export interface VerificationVerdictView {
  readonly operationId: ControlOperationId
  readonly disposition: 'passed' | 'failed' | 'inconclusive'
  readonly requirements: readonly EvidenceRequirement[]
  readonly evidence: readonly StructuredEvidence[]
  readonly reasons: readonly EvidenceReason[]
  readonly collectionStatus?: EvidenceCollectionStatus
  readonly reworkBudget?: {
    readonly currentAttempt: number
    readonly maxAttempts: number
  }
  readonly rework?: {
    readonly action: 'retry' | 'stop'
    readonly currentAttempt: number
    readonly maxAttempts: number
    readonly nextAttempt?: number | undefined
    readonly instructions: readonly string[]
  }
}

/** Durable idempotency record for a Team-level control command. */
export type TeamControlOperationView =
  | { readonly id: ControlOperationId; readonly action: 'pause' | 'resume' | 'cancel' }
  | { readonly id: ControlOperationId; readonly action: 'stop-task'; readonly taskId: TaskId; readonly attemptId: AttemptId }

/** Durable idempotency record for retrying one task without replacing history. */
export interface TaskRetryOperationView {
  readonly id: ControlOperationId
  readonly taskId: TaskId
}

/** One fail-closed runtime observation made while recovering after restart. */
export interface AttemptRuntimeObservationView {
  readonly taskId: TaskId
  readonly attemptId: AttemptId
  readonly childSessionId?: string
  readonly state: 'live' | 'durable' | 'missing' | 'diagnostic' | 'unavailable' | 'not-admitted'
  readonly reason?: string
}

/** Durable batch of runtime observations keyed by one idempotent operation. */
export interface ReconciliationOperationView {
  readonly id: ControlOperationId
  readonly observations: readonly AttemptRuntimeObservationView[]
}

/** Explicit, non-success manual conclusion for one previously reconciled attempt. */
export interface AttemptResolutionOperationView {
  readonly id: ControlOperationId
  readonly observationOperationId: ControlOperationId
  readonly taskId: TaskId
  readonly attemptId: AttemptId
  readonly decision: 'failed' | 'cancelled'
  readonly proofOperationId?: ControlOperationId
}

/** Host-derived proof persisted before a negative manual resolution. */
export interface AttemptResolutionProofView {
  readonly id: ControlOperationId
  readonly observationOperationId: ControlOperationId
  readonly taskId: TaskId
  readonly attemptId: AttemptId
  readonly decision: 'failed' | 'cancelled'
  readonly principal: { readonly kind: 'controller-session'; readonly sessionId: string }
  readonly observationState: 'durable' | 'missing' | 'not-admitted'
  readonly childQuiescent: true
  readonly localInFlight: false
  readonly gitVerified: true
  readonly workspace?: ResolutionWorkspaceProof
  readonly leaseIds: readonly FileLeaseId[]
}

/** Durable proof that a reconciliation gate was cleared safely. */
export interface RecoveryClearOperationView {
  readonly id: ControlOperationId
  readonly target: 'paused' | 'running'
  readonly principal: { readonly kind: 'controller-session'; readonly sessionId: string }
  readonly basis?: 'durable-journal'
}

/** One durable reviewer cycle against an exact completion candidate. */
export interface ReviewView {
  readonly id: string
  readonly trigger: ReviewTrigger
  readonly candidateEventId: TeamEventId
  readonly round: number
  /** Legacy reviews are projected as team-completion checkpoints. */
  readonly checkpointSubject: ReviewCheckpointSubject
  /** Stable across candidate changes caused by automatic rework. */
  readonly checkpointAnchor: ReviewCheckpointAnchor
  /** Durable controller-facing checkpoint lifecycle. */
  readonly phase: ReviewCheckpointPhase
  readonly automaticReworkBudget: ReviewAutomaticReworkBudget
  readonly independentReviewerRequired: boolean
  /** Criteria supplied for this durable review request only. */
  readonly additionalCriteria?: string
  readonly reviewerIndependent?: boolean
  readonly reviewerIndependence?: 'model-diverse' | 'context-only'
  readonly findingFingerprints: readonly string[]
  readonly status: 'requested' | 'completed' | 'awaiting_user'
  readonly result?: {
    readonly reviewerSessionId: string
    readonly decision: 'pass' | 'changes_required' | 'inconclusive'
    readonly findings: readonly ReviewFinding[]
    readonly unverified: readonly string[]
  }
  readonly userDecision?: ReviewUserDecisionView
}

export interface ReviewUserDecisionView {
  readonly operationId: ControlOperationId
  readonly reviewId: string
  readonly candidateEventId: TeamEventId
  readonly round: number
  readonly decision: ReviewUserDecision
  readonly reason?: string
}

/** Complete projection rebuilt from the Team event stream. */
export interface TeamProjection {
  readonly followupOperations?: Readonly<Record<string, TeamFollowupOperation>>
  /** Event format projected into this view. */
  readonly schemaVersion: typeof TEAM_EVENT_SCHEMA_VERSION
  /** Team summary. */
  readonly team: TeamView
  /** Tasks keyed by opaque task id. */
  readonly tasks: Readonly<Record<string, TaskView>>
  /** Tasks in durable creation order. */
  readonly taskIds: readonly TaskId[]
  /** Attempts keyed by opaque attempt id. */
  readonly attempts: Readonly<Record<string, AttemptView>>
  /** Verification runs keyed by opaque verification id. */
  readonly verifications: Readonly<Record<string, VerificationView>>
  /** Reviewer cycles keyed by durable review id. */
  readonly reviews: Readonly<Record<string, ReviewView>>
  /** Reviewer cycles in request order. */
  readonly reviewIds: readonly string[]
  /** Idempotent human resolutions keyed by the caller operation identity. */
  readonly reviewUserDecisionOperations: Readonly<Record<string, ReviewUserDecisionView>>
  /** Latest task-completion event defining the candidate under review. */
  readonly completionCandidateEventId?: TeamEventId
  /** One managed Team worktree, once provisioning has started. */
  readonly workspace?: TeamWorkspace
  /** File leases keyed by durable lease id. */
  readonly fileLeases: Readonly<Record<string, FileLease>>
  /** File leases in durable acquisition order. */
  readonly fileLeaseIds: readonly FileLeaseId[]
  /** Applied control operations keyed by caller-supplied idempotency id. */
  readonly controlOperations: Readonly<Record<string, TeamControlOperationView>>
  /** Latest Team-level pause/resume/cancel intent in durable event order. */
  readonly latestTeamControlOperationId?: ControlOperationId
  /** Applied task retry operations keyed by caller-supplied idempotency id. */
  readonly taskRetryOperations: Readonly<Record<string, TaskRetryOperationView>>
  /** Applied recovery scans keyed by caller-supplied idempotency id. */
  readonly reconciliationOperations: Readonly<Record<string, ReconciliationOperationView>>
  /** Latest recovery scan that observed each unresolved attempt. */
  readonly latestReconciliationOperationIds: Readonly<Record<string, ControlOperationId>>
  /** Applied explicit attempt-resolution commands keyed by caller-supplied idempotency id. */
  readonly attemptResolutionOperations: Readonly<Record<string, AttemptResolutionOperationView>>
  /** Host-derived proofs that authorize a negative attempt resolution. */
  readonly attemptResolutionProofs: Readonly<Record<string, AttemptResolutionProofView>>
  /** Durable idempotency records for clearing the reconciliation gate. */
  readonly recoveryClearOperations: Readonly<Record<string, RecoveryClearOperationView>>
  /** Applied verification verdict operations keyed by caller-supplied idempotency id. */
  readonly verificationVerdictOperations: Readonly<Record<string, VerificationVerdictView & {
    readonly verificationId: VerificationId
    readonly taskId: TaskId
    readonly attemptId: AttemptId
  }>>
  /** Latest durable token budget policy, if one has been configured. */
  readonly budgetPolicy?: BudgetPolicyView
  /** Every policy operation applied to this Controller, for replay-safe idempotency. */
  readonly budgetPolicyOperations: Readonly<Record<string, BudgetPolicyView>>
  /** Attempt-scoped token reservations keyed by stable reservation id. */
  readonly budgetReservations: Readonly<Record<string, BudgetReservationView>>
  /** Reservations in acquisition order. */
  readonly budgetReservationIds: readonly string[]
  /** Event fingerprints keyed by id, used to distinguish redelivery from id collision. */
  readonly appliedEventFingerprints: Readonly<Record<string, string>>
  /** Timestamp carried by the last newly applied event. */
  readonly lastEventAt: string
  /** Opaque id of the last newly applied event; disambiguates equal timestamps. */
  readonly lastEventId: TeamEventId
}

/**
 * Every durable operation id shares one namespace.  A reducer excludes only
 * its own namespace so an identical redelivery can still reach that
 * namespace's idempotency check.
 */
export type OperationNamespace =
  | 'control'
  | 'task-retry'
  | 'reconciliation'
  | 'attempt-resolution'
  | 'attempt-resolution-proof'
  | 'recovery-clear'
  | 'verification-verdict'
  | 'budget-policy'
  | 'review-user-decision'

export function operationIdUsed(
  projection: TeamProjection,
  operationId: string,
  excluding?: OperationNamespace,
): boolean {
  return (excluding !== 'control' && projection.controlOperations[operationId] !== undefined)
    || projection.followupOperations?.[operationId] !== undefined
    || projection.taskIds.some(id => projection.tasks[id]!.contract.userRevision?.operationId === operationId)
    || (excluding !== 'task-retry' && projection.taskRetryOperations[operationId] !== undefined)
    || (excluding !== 'reconciliation' && projection.reconciliationOperations[operationId] !== undefined)
    || (excluding !== 'attempt-resolution' && excluding !== 'attempt-resolution-proof' && projection.attemptResolutionOperations[operationId] !== undefined)
    || (excluding !== 'attempt-resolution' && excluding !== 'attempt-resolution-proof' && projection.attemptResolutionProofs[operationId] !== undefined)
    || (excluding !== 'recovery-clear' && projection.recoveryClearOperations[operationId] !== undefined)
    || (excluding !== 'verification-verdict' && projection.verificationVerdictOperations[operationId] !== undefined)
    || (excluding !== 'budget-policy' && projection.budgetPolicyOperations[operationId] !== undefined)
    || (excluding !== 'review-user-decision' && projection.reviewUserDecisionOperations[operationId] !== undefined)
}

function domainError(code: YuqiDomainErrorCode, message: string, eventIndex: number, entity: NonNullable<YuqiDomainErrorDetails['entity']>, entityId?: string): YuqiDomainError {
  const details: YuqiDomainErrorDetails = entityId === undefined
    ? { eventIndex, entity }
    : { eventIndex, entity, entityId }
  return new YuqiDomainError(code, message, details)
}

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.hasOwn(record, key)
}

function emptyDictionary<Value>(): Record<string, Value> {
  return Object.create(null) as Record<string, Value>
}

function withEntry<Value>(record: Readonly<Record<string, Value>>, key: string, value: Value): Readonly<Record<string, Value>> {
  const next = Object.assign(emptyDictionary<Value>(), record)
  next[key] = value
  return next
}

function requireTask(state: TeamProjection, taskId: TaskId, eventIndex: number): TaskView {
  if (!hasOwn(state.tasks, taskId)) throw domainError('ENTITY_NOT_FOUND', `task ${taskId} does not exist`, eventIndex, 'task', taskId)
  return state.tasks[taskId]!
}

function requireAttempt(state: TeamProjection, attemptId: AttemptId, eventIndex: number): AttemptView {
  if (!hasOwn(state.attempts, attemptId)) throw domainError('ENTITY_NOT_FOUND', `attempt ${attemptId} does not exist`, eventIndex, 'attempt', attemptId)
  return state.attempts[attemptId]!
}

function requireVerification(state: TeamProjection, verificationId: VerificationId, eventIndex: number): VerificationView {
  if (!hasOwn(state.verifications, verificationId)) throw domainError('ENTITY_NOT_FOUND', `verification ${verificationId} does not exist`, eventIndex, 'verification', verificationId)
  return state.verifications[verificationId]!
}

function requireWorkspace(state: TeamProjection, workspaceId: string, eventIndex: number): TeamWorkspace {
  const workspace = state.workspace
  if (workspace === undefined) throw domainError('ENTITY_NOT_FOUND', `workspace ${workspaceId} does not exist`, eventIndex, 'workspace', workspaceId)
  if (workspace.workspaceId !== workspaceId) throw domainError('REFERENCE_MISMATCH', `workspace ${workspaceId} does not match ${workspace.workspaceId}`, eventIndex, 'workspace', workspaceId)
  return workspace
}

function requireFileLease(state: TeamProjection, leaseId: FileLeaseId, eventIndex: number): FileLease {
  if (!hasOwn(state.fileLeases, leaseId)) throw domainError('ENTITY_NOT_FOUND', `file lease ${leaseId} does not exist`, eventIndex, 'file-lease', leaseId)
  return state.fileLeases[leaseId]!
}

function workspaceIdentityMatches(left: TeamWorkspace, right: TeamWorkspace): boolean {
  return left.workspaceId === right.workspaceId
    && left.project.projectRoot === right.project.projectRoot
    && left.project.repositoryRoot === right.project.repositoryRoot
    && left.project.gitCommonDirectory === right.project.gitCommonDirectory
    && left.project.baselineRef === right.project.baselineRef
    && left.project.volumeRoot === right.project.volumeRoot
    && sameStrings(left.project.protectedRoots, right.project.protectedRoots)
    && left.worktreePath === right.worktreePath
    && left.branchName === right.branchName
}

/** A worker-owned blocker must not be cleared as if it were only a dependency wait. */
export function taskHasSemanticBlock(state: TeamProjection, task: TaskView): boolean {
  if (task.status !== 'blocked') return false
  const attempt = state.attempts[task.attemptIds.at(-1) ?? '']
  return attempt?.evidence !== undefined && attempt.ordinal >= task.verificationAttemptFloor
    && !taskOutcomeAllowsCompletion(attempt.taskOutcomeVersion, attempt.evidence.taskOutcome)
}

/** Completion requires the exact latest settled attempt and its passed verdict. */
function assertTaskCompletionReady(state: TeamProjection, task: TaskView, eventIndex: number): void {
  const activeVerification = Object.values(state.verifications).find(verification =>
    verification.taskId === task.contract.taskId && (verification.status === 'pending' || verification.status === 'running'))
  if (activeVerification !== undefined) {
    throw domainError('INVALID_TRANSITION', `task ${task.contract.taskId} cannot complete while verification ${activeVerification.id} is ${activeVerification.status}`, eventIndex, 'verification', activeVerification.id)
  }
  const attemptId = task.attemptIds.at(-1)
  if (attemptId === undefined) {
    throw domainError('INVALID_TRANSITION', `task ${task.contract.taskId} cannot complete without an attempt`, eventIndex, 'task', task.contract.taskId)
  }
  const attempt = requireAttempt(state, attemptId, eventIndex)
  if (attempt.status !== 'completed' || attempt.evidence?.stopReason !== 'completed') {
    throw domainError('INVALID_TRANSITION', `task ${task.contract.taskId} cannot complete before its latest attempt has a completed settlement`, eventIndex, 'task', task.contract.taskId)
  }
  const verificationId = task.verificationIds.at(-1)
  if (verificationId === undefined) {
    throw domainError('INVALID_TRANSITION', `task ${task.contract.taskId} cannot complete without a verification`, eventIndex, 'task', task.contract.taskId)
  }
  const verification = requireVerification(state, verificationId, eventIndex)
  if (verification.attemptId !== attempt.id || verification.status !== 'passed' || verification.verdict?.disposition !== 'passed') {
    throw domainError('INVALID_TRANSITION', `task ${task.contract.taskId} cannot complete without a passed verdict for its latest attempt`, eventIndex, 'task', task.contract.taskId)
  }
}

/** Narrow exception for a Host that still owns every exact live cold-scan child. */
function isColdOwnerRecoveryTransition(state: TeamProjection, reason: string): boolean {
  if (!reason.startsWith('cold-owner-recovery operation ')) return false
  const latestControl = state.latestTeamControlOperationId
  if (latestControl !== undefined && ['pause', 'cancel'].includes(state.controlOperations[latestControl]?.action ?? '')) return false
  if (state.team.manualOwnership?.state === 'human-owned' || state.workspace?.status === 'needs_reconciliation'
    || Object.values(state.reviews).some(review => review.status === 'requested')) return false
  return Object.values(state.attempts).every(attempt => {
    if (attempt.status === 'unknown') return false
    if (attempt.status !== 'running') return true
    const operationId = state.latestReconciliationOperationIds[attempt.id]
    const observation = operationId === undefined
      ? undefined
      : state.reconciliationOperations[operationId]?.observations.find(item => item.attemptId === attempt.id)
    return attempt.agentSessionId !== undefined && attempt.messageId !== undefined
      && observation?.state === 'live' && observation.childSessionId === attempt.agentSessionId
  })
}

/** Team completion is a domain fact, not a caller assertion. */
function assertTeamCompletionReady(state: TeamProjection, eventIndex: number): void {
  if (teamCompletionReady(state)) return
  if (projectionHasReconciliationGap(state)) {
    throw domainError('INVALID_TRANSITION', 'Team cannot complete while durable child facts require reconciliation', eventIndex, 'team', state.team.id)
  }
  const unresolvedAttempt = Object.values(state.attempts).find(attempt =>
    attempt.status === 'dispatching' || attempt.status === 'running' || attempt.status === 'unknown')
  if (unresolvedAttempt !== undefined) {
    throw domainError('INVALID_TRANSITION', `Team cannot complete while attempt ${unresolvedAttempt.id} is ${unresolvedAttempt.status}`, eventIndex, 'attempt', unresolvedAttempt.id)
  }
  const activeVerification = Object.values(state.verifications).find(verification =>
    verification.status === 'pending' || verification.status === 'running')
  if (activeVerification !== undefined) {
    throw domainError('INVALID_TRANSITION', `Team cannot complete while verification ${activeVerification.id} is ${activeVerification.status}`, eventIndex, 'verification', activeVerification.id)
  }
  const activeLease = Object.values(state.fileLeases).find(lease => lease.status === 'active')
  if (activeLease !== undefined) {
    throw domainError('INVALID_TRANSITION', `Team cannot complete while file lease ${activeLease.leaseId} is active`, eventIndex, 'file-lease', activeLease.leaseId)
  }
  // Workspace v1 has no separate "final proof" event.  Do not infer one:
  // a present workspace must at least have reached the durable ready state.
  if (state.workspace !== undefined && state.workspace.status !== 'ready') {
    throw domainError('INVALID_TRANSITION', `Team cannot complete while workspace ${state.workspace.workspaceId} is ${state.workspace.status}`, eventIndex, 'workspace', state.workspace.workspaceId)
  }
  if (state.team.status === 'needs_reconciliation' || state.workspace?.status === 'needs_reconciliation') {
    throw domainError('INVALID_TRANSITION', 'Team cannot complete while reconciliation is required', eventIndex, 'team', state.team.id)
  }
  const incompleteTask = state.taskIds.find(taskId => state.tasks[taskId]!.status !== 'completed')
  if (incompleteTask !== undefined) {
    throw domainError('INVALID_TRANSITION', `Team cannot complete while task ${incompleteTask} is not completed`, eventIndex, 'team', state.team.id)
  }
  if (!reviewCompletionSatisfied(state)) {
    throw domainError('INVALID_TRANSITION', 'Team cannot complete before its reviewer quality gate is satisfied', eventIndex, 'team', state.team.id)
  }
}

/** Shared gate-aware predicate for writers that may atomically close a completed graph. */
export function teamCompletionReady(projection: TeamProjection): boolean {
  return !projectionHasReconciliationGap(projection)
    && !Object.values(projection.attempts).some(attempt =>
      attempt.status === 'dispatching' || attempt.status === 'running' || attempt.status === 'unknown')
    && !Object.values(projection.verifications).some(verification =>
      verification.status === 'pending' || verification.status === 'running')
    && !Object.values(projection.fileLeases).some(lease => lease.status === 'active')
    && (projection.workspace === undefined || projection.workspace.status === 'ready')
    && projection.team.status !== 'needs_reconciliation'
    && projection.taskIds.every(taskId => projection.tasks[taskId]!.status === 'completed')
    && reviewCompletionSatisfied(projection)
}

/** The sole reviewer clause used by the Team completion predicate. */
export function reviewCompletionSatisfied(projection: TeamProjection): boolean {
  const policy = projection.team.reviewPolicy
  if (policy === undefined || policy.mode === 'off') return true
  const latestId = projection.reviewIds.at(-1)
  if (latestId === undefined) return policy.mode === 'manual'
  const latest = projection.reviews[latestId]
  if (latest?.userDecision?.decision === 'waive'
    && latest.userDecision.candidateEventId === projection.completionCandidateEventId) return true
  return latest?.status === 'completed'
    && latest.result?.decision === 'pass'
    && latest.candidateEventId === projection.completionCandidateEventId
}

/** Shared domain reconciliation-gap predicate used by scheduling and completion. */
export function projectionHasReconciliationGap(projection: TeamProjection): boolean {
  for (const reservation of Object.values(projection.budgetReservations)) {
    if (reservation.status === 'unknown') return true
    if (reservation.status === 'active') {
      const attempt = projection.attempts[reservation.attemptId]
      if (attempt === undefined || attempt.taskId !== reservation.taskId
        || (attempt.status !== 'dispatching' && attempt.status !== 'running')) return true
    }
  }
  for (const attempt of Object.values(projection.attempts)) {
    if (attempt.status === 'unknown') return true
    if ((attempt.status === 'dispatching' || attempt.status === 'running')
      && projection.tasks[attempt.taskId]?.status !== 'running') return true
    const hasNegativeResolution = Object.values(projection.attemptResolutionOperations)
      .some(operation => operation.attemptId === attempt.id && operation.proofOperationId !== undefined)
    if (attempt.agentSessionId !== undefined && attempt.evidence === undefined
      && !hasNegativeResolution
      && (!['dispatching', 'running'].includes(attempt.status)
        || (projection.budgetPolicy !== undefined && !Object.values(projection.budgetReservations).some(reservation =>
          reservation.attemptId === attempt.id && reservation.taskId === attempt.taskId && reservation.status === 'active')))) return true
    // A settled historical attempt can coexist with a running retry. Only the
    // latest attempt's completion contradicts the task's running state.
    const task = projection.tasks[attempt.taskId]
    if (attempt.evidence?.stopReason === 'completed' && task?.status === 'running'
      && task.attemptIds.at(-1) === attempt.id) return true
  }
  return false
}

/** Current token ledger view. Unknown usage is never represented as zero. */
export function budgetTokenLedger(projection: TeamProjection): {
  readonly usageKnown: boolean
  readonly usedTokens: number
  readonly activeReservedTokens: number
} {
  let usedTokens = 0
  let usageKnown = true
  for (const reservation of Object.values(projection.budgetReservations)) {
    if (reservation.status === 'unknown') usageKnown = false
    if (reservation.status === 'active') {
      const attempt = projection.attempts[reservation.attemptId]
      if (attempt !== undefined && attempt.taskId !== reservation.taskId) usageKnown = false
      continue
    }
    if (reservation.status === 'known') {
      const attempt = projection.attempts[reservation.attemptId]
      if (attempt?.evidence?.usage !== undefined) {
        const usage = attempt.evidence.usage.uncachedInputTokens
          + attempt.evidence.usage.outputTokens
          + attempt.evidence.usage.cacheReadTokens
          + attempt.evidence.usage.cacheWriteTokens
        if (reservation.usage?.totalTokens !== usage) usageKnown = false
      } else if (reservation.usage !== undefined) {
        usedTokens += reservation.usage.totalTokens
      } else {
        usageKnown = false
      }
    }
  }
  if (projection.budgetPolicy !== undefined) {
    for (const attempt of Object.values(projection.attempts)) {
      if (attempt.evidence?.usage === undefined) {
        // In-flight usage is covered by its reservation, not counted as zero
        // and not confused with a missing terminal usage report.
        const reservedInFlight = ['dispatching', 'running'].includes(attempt.status)
          && attempt.evidence === undefined
          && Object.values(projection.budgetReservations).some(reservation => reservation.status === 'active'
            && reservation.attemptId === attempt.id && reservation.taskId === attempt.taskId)
        if (attempt.agentSessionId !== undefined && !reservedInFlight) usageKnown = false
        continue
      }
      usedTokens += attempt.evidence.usage.uncachedInputTokens
        + attempt.evidence.usage.outputTokens
        + attempt.evidence.usage.cacheReadTokens
        + attempt.evidence.usage.cacheWriteTokens
    }
  }
  const activeReservedTokens = Object.values(projection.budgetReservations)
    .filter(reservation => reservation.status === 'active')
    .reduce((total, reservation) => total + reservation.tokenReserve, 0)
  return { usageKnown, usedTokens, activeReservedTokens }
}

/** Domain admission gate for one new durable token reservation. */
export function budgetReservationDecision(projection: TeamProjection, tokenReserve: number): 'allow' | 'usage-unknown' | 'hard-limit' {
  const policy = projection.budgetPolicy
  if (policy === undefined) return 'allow'
  const ledger = budgetTokenLedger(projection)
  return assessTokenReservation({
    tokenLimit: policy.tokenLimit,
    usageKnown: ledger.usageKnown,
    usedTokens: ledger.usedTokens,
    activeReservedTokens: ledger.activeReservedTokens,
    requestedTokens: tokenReserve,
  })
}

function reservationsForAttempt(projection: TeamProjection, taskId: string, attemptId: string): readonly BudgetReservationView[] {
  return Object.values(projection.budgetReservations).filter(reservation => reservation.taskId === taskId && reservation.attemptId === attemptId)
}

function assertBudgetSettled(projection: TeamProjection, taskId: string, attemptId: string, eventIndex: number): void {
  const reservation = reservationsForAttempt(projection, taskId, attemptId)[0]
  const hasNegativeProof = Object.values(projection.attemptResolutionProofs).some(proof => proof.taskId === taskId
    && proof.attemptId === attemptId && proof.observationState !== 'not-admitted')
  if (reservation !== undefined && (reservation.status === 'active' || reservation.status === 'unknown') && !hasNegativeProof) {
    throw domainError('INVALID_TRANSITION', `attempt ${attemptId} requires a durable budget settlement before resolution`, eventIndex, 'budget-reservation', reservation.reservationId)
  }
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameOptionalUsage(left: BudgetReservationView['usage'], right: BudgetReservationView['usage']): boolean {
  return left?.totalTokens === right?.totalTokens
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function validateContract(state: TeamProjection, contract: TeamTaskContract, eventIndex: number): void {
  const dependencies = new Set<string>()
  for (const dependency of contract.dependencies) {
    if (dependency === contract.taskId || dependencies.has(dependency)) {
      throw domainError('INVALID_TASK_CONTRACT', `task ${contract.taskId} has an invalid dependency ${dependency}`, eventIndex, 'task', contract.taskId)
    }
    dependencies.add(dependency)
    if (!hasOwn(state.tasks, dependency)) {
      throw domainError('ENTITY_NOT_FOUND', `dependency ${dependency} does not exist`, eventIndex, 'task', dependency)
    }
  }
}

function validateReviewReworkTask(state: TeamProjection, contract: TeamTaskContract, eventIndex: number): void {
  const provenance = contract.reviewRework!
  const source = state.reviews[provenance.sourceReviewId]
  const authorizedFinalRound = source?.userDecision?.decision === 'authorize_final_rework'
    && source.status === 'awaiting_user'
    && provenance.round === source.round + 1
    && provenance.round <= MAX_REWORK_ROUNDS
  if (source?.result?.decision !== 'changes_required' || (source.status !== 'completed' && !authorizedFinalRound)) {
    throw domainError('REFERENCE_MISMATCH', `review-rework task ${contract.taskId} requires a non-exhausted changes_required review`, eventIndex, 'task', contract.taskId)
  }
  if (contract.authorityMode === 'full-access') {
    throw domainError('INVALID_TASK_CONTRACT', `review-rework task ${contract.taskId} cannot exceed write-authorized authority`, eventIndex, 'task', contract.taskId)
  }
  const maxRounds = state.team.reviewPolicy?.maxReworkRounds ?? DEFAULT_MAX_REWORK_ROUNDS
  if (provenance.round !== source.round + 1 || (provenance.round > maxRounds && !authorizedFinalRound)) {
    throw domainError('INVALID_TASK_CONTRACT', `review-rework task ${contract.taskId} has invalid round ${provenance.round}`, eventIndex, 'task', contract.taskId)
  }
  const duplicate = state.taskIds.map(taskId => state.tasks[taskId]!).find(task =>
    task.contract.kind === 'review-rework' && task.contract.reviewRework?.sourceReviewId === provenance.sourceReviewId)
  if (duplicate !== undefined) {
    throw domainError('ENTITY_ALREADY_EXISTS', `review ${provenance.sourceReviewId} already created rework task ${duplicate.contract.taskId}`, eventIndex, 'task', contract.taskId)
  }
  if (!authorizedFinalRound && reviewAutomaticReworkBudgetExhausted(state, source)) {
    throw domainError('INVALID_TASK_CONTRACT', `review-rework task ${contract.taskId} exceeds its automatic correction budget`, eventIndex, 'task', contract.taskId)
  }
}

function validateAcyclicGraph(state: TeamProjection, candidate: TeamTaskContract, eventIndex: number): void {
  const taskIds = hasOwn(state.tasks, candidate.taskId) ? state.taskIds : [...state.taskIds, candidate.taskId]
  const visiting = new Set<TaskId>()
  const visited = new Set<TaskId>()
  const contractFor = (taskId: TaskId): TeamTaskContract => taskId === candidate.taskId
    ? candidate
    : requireTask(state, taskId, eventIndex).contract

  const visit = (taskId: TaskId): void => {
    if (visiting.has(taskId)) throw domainError('INVALID_TASK_CONTRACT', `task dependency graph contains a cycle at ${taskId}`, eventIndex, 'task', taskId)
    if (visited.has(taskId)) return
    visiting.add(taskId)
    for (const dependency of contractFor(taskId).dependencies) visit(dependency)
    visiting.delete(taskId)
    visited.add(taskId)
  }
  for (const taskId of taskIds) visit(taskId)
}

function fingerprint(event: TeamEvent): string {
  if (event.type === 'yuqi/verification-verdict-recorded') {
    return JSON.stringify({ ...event, evidence: event.evidence.map(parseStructuredEvidence) })
  }
  return JSON.stringify(event)
}

function markApplied(state: TeamProjection, event: TeamEvent): TeamProjection {
  return {
    ...state,
    appliedEventFingerprints: withEntry(state.appliedEventFingerprints, event.eventId, fingerprint(event)),
    lastEventAt: event.occurredAt,
    lastEventId: event.eventId,
  }
}

function assertTeam(state: TeamProjection | undefined, event: TeamEvent, eventIndex: number): TeamProjection {
  if (state === undefined) throw domainError('TEAM_NOT_CREATED', 'the first Team event must create the Team', eventIndex, 'team', event.teamId)
  if (state.team.id !== event.teamId) throw domainError('TEAM_ID_MISMATCH', `event Team ${event.teamId} does not match ${state.team.id}`, eventIndex, 'team', event.teamId)
  return state
}

/**
 * Parse one unknown durable value into a supported Team event.
 * @param input - Value read from persistence or another process.
 * @param eventIndex - Zero-based stream position for diagnostics.
 * @returns A schema-v1 Team event.
 */
export function parseTeamEvent(input: unknown, eventIndex = -1): TeamEvent {
  if (typeof input !== 'object' || input === null) {
    throw domainError('INVALID_EVENT', 'Team event must be an object', eventIndex, 'event')
  }
  const version = Reflect.get(input, 'schemaVersion')
  if (version !== TEAM_EVENT_SCHEMA_VERSION) {
    throw domainError('UNSUPPORTED_SCHEMA_VERSION', `unsupported Team event schema version ${String(version)}`, eventIndex, 'event')
  }
  const parsed = teamEventSchema.safeParse(input)
  if (!parsed.success) throw domainError('INVALID_EVENT', `invalid Team event: ${parsed.error.issues.map(issue => issue.message).join('; ')}`, eventIndex, 'event')
  if (parsed.data.type === 'yuqi/verification-verdict-recorded') {
    return { ...parsed.data, evidence: parsed.data.evidence.map(parseStructuredEvidence) }
  }
  return parsed.data
}

/**
 * Fold one already-parsed event into a Team projection.
 * @param current - Existing projection, or undefined before Team creation.
 * @param event - Supported Team event.
 * @param eventIndex - Zero-based stream position for diagnostics.
 * @returns The new projection, or the same projection for duplicate delivery.
 */
export function applyTeamEvent(current: TeamProjection | undefined, event: TeamEvent, eventIndex = -1): TeamProjection {
  if (event.schemaVersion !== TEAM_EVENT_SCHEMA_VERSION) {
    throw domainError('UNSUPPORTED_SCHEMA_VERSION', `unsupported Team event schema version ${String(event.schemaVersion)}`, eventIndex, 'event', event.eventId)
  }
  if (current !== undefined) {
    if (hasOwn(current.appliedEventFingerprints, event.eventId)) {
      const previousFingerprint = current.appliedEventFingerprints[event.eventId]!
      if (previousFingerprint === fingerprint(event)) return current
      throw domainError('EVENT_ID_COLLISION', `event id ${event.eventId} was reused for different content`, eventIndex, 'event', event.eventId)
    }
  }

  if (event.type === 'yuqi/team-created') {
    if (current !== undefined) throw domainError('TEAM_ALREADY_CREATED', 'Team can only be created once', eventIndex, 'team', event.teamId)
    return {
      schemaVersion: TEAM_EVENT_SCHEMA_VERSION,
      team: {
        ...(event.continuedFrom === undefined ? {} : { continuedFrom: event.continuedFrom }),
        id: event.teamId,
        title: event.title,
        objective: event.objective,
        locale: event.locale ?? DEFAULT_TEAM_LOCALE,
        status: 'draft',
        directWriteStrategy: event.directWriteStrategy ?? DEFAULT_DIRECT_WRITE_STRATEGY,
        ...(event.reviewPolicy === undefined ? {} : { reviewPolicy: event.reviewPolicy }),
        ...(event.modelRouting === undefined ? {} : { modelRouting: event.modelRouting }),
        ...(event.planConfirmationRequired === undefined ? {} : { planConfirmationRequired: event.planConfirmationRequired }),
        ...(event.maxConcurrency === undefined ? {} : { maxConcurrency: event.maxConcurrency }),
        ...(event.controllerModel === undefined ? {} : {
          controllerModel: {
            provider: event.controllerModel.provider,
            ...(event.controllerModel.model === undefined ? {} : { model: event.controllerModel.model }),
            ...(event.controllerModel.maxTokens === undefined ? {} : { maxTokens: event.controllerModel.maxTokens }),
          },
        }),
      },
      tasks: emptyDictionary<TaskView>(),
      taskIds: [],
      attempts: emptyDictionary<AttemptView>(),
      verifications: emptyDictionary<VerificationView>(),
      reviews: emptyDictionary<ReviewView>(),
      reviewIds: [],
      reviewUserDecisionOperations: emptyDictionary<ReviewUserDecisionView>(),
      fileLeases: emptyDictionary<FileLease>(),
      fileLeaseIds: [],
      controlOperations: emptyDictionary<TeamControlOperationView>(),
      taskRetryOperations: emptyDictionary<TaskRetryOperationView>(),
      reconciliationOperations: emptyDictionary<ReconciliationOperationView>(),
      latestReconciliationOperationIds: emptyDictionary<ControlOperationId>(),
      attemptResolutionOperations: emptyDictionary<AttemptResolutionOperationView>(),
      attemptResolutionProofs: emptyDictionary<AttemptResolutionProofView>(),
      recoveryClearOperations: emptyDictionary<RecoveryClearOperationView>(),
      verificationVerdictOperations: emptyDictionary<VerificationVerdictView & { readonly verificationId: VerificationId; readonly taskId: TaskId; readonly attemptId: AttemptId }>(),
      budgetReservations: emptyDictionary<BudgetReservationView>(),
      budgetReservationIds: [],
      budgetPolicyOperations: emptyDictionary<BudgetPolicyView>(),
      appliedEventFingerprints: withEntry(emptyDictionary<string>(), event.eventId, fingerprint(event)),
      lastEventAt: event.occurredAt,
      lastEventId: event.eventId,
    }
  }

  const state = assertTeam(current, event, eventIndex)
  if ('operationId' in event && state.followupOperations?.[event.operationId] !== undefined
    && event.type !== 'yuqi/team-followup-created') {
    throw domainError('ENTITY_ALREADY_EXISTS', 'Operation belongs to a follow-up Team', eventIndex, 'control-operation', event.operationId)
  }
  if ('operationId' in event && state.taskIds.some(id => state.tasks[id]!.contract.userRevision?.operationId === event.operationId)) {
    throw domainError('ENTITY_ALREADY_EXISTS', 'Operation belongs to a user revision', eventIndex, 'control-operation', event.operationId)
  }
  if ('operationId' in event && state.team.manualOwnershipOperations?.[event.operationId] !== undefined
    && event.type !== 'yuqi/task-manual-acquired' && event.type !== 'yuqi/task-manual-returned') {
    throw domainError('ENTITY_ALREADY_EXISTS', 'Operation belongs to manual ownership', eventIndex, 'control-operation', event.operationId)
  }
  if (isHumanOwned(state) && (
    (event.type === 'yuqi/team-control-requested' && event.action === 'resume')
    || (event.type === 'yuqi/team-status-changed' && event.to === 'running')
    || (event.type === 'yuqi/team-recovery-cleared' && event.target === 'running')
    || event.type === 'yuqi/task-retry-requested' || event.type === 'yuqi/task-revised'
    || event.type === 'yuqi/attempt-created' || event.type === 'yuqi/attempt-admitted'
    || event.type === 'yuqi/attempt-child-recovered' || event.type === 'yuqi/verification-created'
    || event.type === 'yuqi/review-requested' || event.type === 'yuqi/file-lease-acquired'
    || (event.type === 'yuqi/task-status-changed' && ['running', 'verifying', 'completed'].includes(event.to))
  )) throw domainError('INVALID_TRANSITION', 'Return manual ownership before resuming, retrying or admitting work', eventIndex, 'team', state.team.id)
  let next: TeamProjection

  switch (event.type) {
    case 'yuqi/task-manual-acquired':
    case 'yuqi/task-manual-returned': {
      if (event.type === 'yuqi/task-manual-acquired' && event.workspacePath !== state.workspace?.worktreePath) {
        throw domainError('REFERENCE_MISMATCH', 'Manual workspace differs from Team workspace', eventIndex, 'task', event.taskId)
      }
      const acquire = event.type === 'yuqi/task-manual-acquired'
      const operation: ManualOwnershipOperation = acquire
        ? { action: 'acquire', taskId: event.taskId, acquisitionId: event.operationId }
        : { action: 'return', taskId: event.taskId, acquisitionId: event.acquisitionId, summary: event.summary }
      const previous = state.team.manualOwnershipOperations?.[event.operationId]
      if (previous !== undefined) {
        if (JSON.stringify(previous) !== JSON.stringify(operation)) throw domainError('ENTITY_ALREADY_EXISTS', 'Manual operation identity conflict', eventIndex, 'control-operation', event.operationId)
        next = state
        break
      }
      if (operationIdUsed(state, event.operationId)) throw domainError('ENTITY_ALREADY_EXISTS', 'Operation identity already used', eventIndex, 'control-operation', event.operationId)
      let ownership: ManualOwnership
      if (event.type === 'yuqi/task-manual-acquired') {
        const issue = manualTakeoverIssue(state, event.taskId)
        if (issue !== undefined) throw domainError('INVALID_TRANSITION', issue, eventIndex, 'task', event.taskId)
        if (event.workspacePath !== state.workspace!.worktreePath) throw domainError('REFERENCE_MISMATCH', 'Manual workspace differs from Team workspace', eventIndex, 'task', event.taskId)
        ownership = { state: 'human-owned', taskId: event.taskId, acquisitionId: event.operationId, workspacePath: event.workspacePath, acquiredAt: event.occurredAt }
      } else {
        const held = state.team.manualOwnership
        if (held?.state !== 'human-owned' || held.taskId !== event.taskId || held.acquisitionId !== event.acquisitionId) throw domainError('INVALID_TRANSITION', 'Manual ownership has changed; refresh before returning', eventIndex, 'task', event.taskId)
        if (state.team.status !== 'paused' && state.team.status !== 'cancelled') throw domainError('INVALID_TRANSITION', 'Return requires paused or cancelled Team', eventIndex, 'team', state.team.id)
        ownership = { ...held, state: 'returned', returnedAt: event.occurredAt, summary: event.summary }
      }
      next = { ...state, team: { ...state.team, manualOwnership: ownership,
        manualOwnershipOperations: { ...state.team.manualOwnershipOperations, [event.operationId]: operation } } }
      break
    }
    case 'yuqi/team-control-requested': {
      if (state.reconciliationOperations[event.operationId] !== undefined || state.attemptResolutionOperations[event.operationId] !== undefined || state.attemptResolutionProofs[event.operationId] !== undefined || state.recoveryClearOperations[event.operationId] !== undefined || state.verificationVerdictOperations[event.operationId] !== undefined || state.budgetPolicyOperations[event.operationId] !== undefined) {
        throw domainError('ENTITY_ALREADY_EXISTS', `operation ${event.operationId} was already used for reconciliation`, eventIndex, 'control-operation', event.operationId)
      }
      if (state.taskRetryOperations[event.operationId] !== undefined) {
        throw domainError('ENTITY_ALREADY_EXISTS', `operation ${event.operationId} was already used for a task retry`, eventIndex, 'control-operation', event.operationId)
      }
      const existing = state.controlOperations[event.operationId]
      if (existing !== undefined) {
        if (existing.action !== event.action) {
          throw domainError('ENTITY_ALREADY_EXISTS', `control operation ${event.operationId} was already used for ${existing.action}`, eventIndex, 'control-operation', event.operationId)
        }
        next = state
        break
      }
      next = {
        ...state,
        controlOperations: withEntry(state.controlOperations, event.operationId, { id: event.operationId, action: event.action }),
        latestTeamControlOperationId: event.operationId,
      }
      break
    }
    case 'yuqi/team-status-changed': {
      if (state.team.status !== event.from) throw domainError('INVALID_TRANSITION', `Team is ${state.team.status}, not ${event.from}`, eventIndex, 'team', event.teamId)
      if (event.from === 'needs_reconciliation' && event.to === 'paused') {
        throw domainError('INVALID_TRANSITION', 'Reconciliation must be cleared by a durable recovery proof', eventIndex, 'team', event.teamId)
      }
      if (event.from === 'needs_reconciliation' && event.to === 'running' && !isColdOwnerRecoveryTransition(state, event.reason ?? '')) {
        throw domainError('INVALID_TRANSITION', 'Reconciliation must be cleared by a durable recovery proof', eventIndex, 'team', event.teamId)
      }
      if (event.to === 'completed') assertTeamCompletionReady(state, eventIndex)
      next = {
        ...state,
        team: {
          ...state.team,
          status: transitionTeam(event.from, event.to),
          ...(state.team.startedAt === undefined && event.to === 'running' ? { startedAt: event.occurredAt } : {}),
          ...(state.team.endedAt === undefined && isTerminalTeamStatus(event.to) ? { endedAt: event.occurredAt } : {}),
        },
      }
      break
    }
    case 'yuqi/team-recovery-cleared': {
      if (operationIdUsed(state, event.operationId, 'recovery-clear')) {
        throw domainError('ENTITY_ALREADY_EXISTS', `operation ${event.operationId} was already used for another command`, eventIndex, 'control-operation', event.operationId)
      }
      const existing = state.recoveryClearOperations[event.operationId]
      if (existing !== undefined) {
        if (existing.target !== event.target || existing.principal.sessionId !== event.proof.principal.sessionId) {
          throw domainError('ENTITY_ALREADY_EXISTS', `recovery clear operation ${event.operationId} was reused with different content`, eventIndex, 'control-operation', event.operationId)
        }
        next = state
        break
      }
      if (state.team.status !== 'needs_reconciliation') {
        throw domainError('INVALID_TRANSITION', `Team cannot clear recovery while ${state.team.status}`, eventIndex, 'team', event.teamId)
      }
      if (state.latestTeamControlOperationId !== undefined
        && state.controlOperations[state.latestTeamControlOperationId]?.action === 'cancel') {
        throw domainError('INVALID_TRANSITION', 'Team cannot clear an active cancellation intent', eventIndex, 'team', event.teamId)
      }
      const activeAttempt = Object.values(state.attempts).find(attempt => ['dispatching', 'running', 'unknown'].includes(attempt.status))
      if (activeAttempt !== undefined) throw domainError('INVALID_TRANSITION', `attempt ${activeAttempt.id} is still active`, eventIndex, 'attempt', activeAttempt.id)
      const activeVerification = Object.values(state.verifications).find(verification => verification.status === 'pending' || verification.status === 'running')
      if (activeVerification !== undefined) throw domainError('INVALID_TRANSITION', `verification ${activeVerification.id} is still active`, eventIndex, 'verification', activeVerification.id)
      const activeLease = Object.values(state.fileLeases).find(lease => lease.status === 'active')
      if (activeLease !== undefined) throw domainError('INVALID_TRANSITION', `file lease ${activeLease.leaseId} is still active`, eventIndex, 'file-lease', activeLease.leaseId)
      const activeReservation = Object.values(state.budgetReservations).find(reservation => reservation.status === 'active' || reservation.status === 'unknown')
      if (activeReservation !== undefined) throw domainError('INVALID_TRANSITION', `budget reservation ${activeReservation.reservationId} is unresolved`, eventIndex, 'budget-reservation', activeReservation.reservationId)
      if (projectionHasReconciliationGap(state)) {
        throw domainError('INVALID_TRANSITION', 'Team still has a durable reconciliation gap', eventIndex, 'team', event.teamId)
      }
      const workspace = state.workspace
      if (workspace === undefined || workspace.status !== 'ready') {
        throw domainError('INVALID_TRANSITION', 'Team workspace is not durably ready', eventIndex, 'workspace', workspace?.workspaceId)
      }
      if (!workspaceProofMatches(event.proof.workspace, workspace)) {
        throw domainError('REFERENCE_MISMATCH', 'recovery proof does not match the durable Team workspace', eventIndex, 'workspace', workspace.workspaceId)
      }
      next = {
        ...state,
        team: { ...state.team, status: transitionTeam(state.team.status, event.target) },
        recoveryClearOperations: withEntry(state.recoveryClearOperations, event.operationId, {
          id: event.operationId, target: event.target, principal: event.proof.principal,
        }),
      }
      break
    }
    case 'yuqi/team-recovery-cleared-from-journal': {
      if (operationIdUsed(state, event.operationId, 'recovery-clear')) {
        throw domainError('ENTITY_ALREADY_EXISTS', `operation ${event.operationId} was already used for another command`, eventIndex, 'control-operation', event.operationId)
      }
      const existing = state.recoveryClearOperations[event.operationId]
      if (existing !== undefined) {
        if (existing.target !== 'paused' || existing.principal.sessionId !== event.controllerSessionId
          || existing.basis !== 'durable-journal') {
          throw domainError('ENTITY_ALREADY_EXISTS', `recovery clear operation ${event.operationId} was reused with different content`, eventIndex, 'control-operation', event.operationId)
        }
        next = state
        break
      }
      if (state.team.status !== 'needs_reconciliation') {
        throw domainError('INVALID_TRANSITION', `Team cannot clear recovery while ${state.team.status}`, eventIndex, 'team', event.teamId)
      }
      if (state.latestTeamControlOperationId !== undefined
        && state.controlOperations[state.latestTeamControlOperationId]?.action === 'cancel') {
        throw domainError('INVALID_TRANSITION', 'Team cannot clear an active cancellation intent', eventIndex, 'team', event.teamId)
      }
      const activeAttempt = Object.values(state.attempts).find(attempt => ['dispatching', 'running', 'unknown'].includes(attempt.status))
      if (activeAttempt !== undefined) throw domainError('INVALID_TRANSITION', `attempt ${activeAttempt.id} is still active`, eventIndex, 'attempt', activeAttempt.id)
      const activeVerification = Object.values(state.verifications).find(verification => verification.status === 'pending' || verification.status === 'running')
      if (activeVerification !== undefined) throw domainError('INVALID_TRANSITION', `verification ${activeVerification.id} is still active`, eventIndex, 'verification', activeVerification.id)
      const activeLease = Object.values(state.fileLeases).find(lease => lease.status === 'active')
      if (activeLease !== undefined) throw domainError('INVALID_TRANSITION', `file lease ${activeLease.leaseId} is still active`, eventIndex, 'file-lease', activeLease.leaseId)
      const activeReservation = Object.values(state.budgetReservations).find(reservation => reservation.status === 'active' || reservation.status === 'unknown')
      if (activeReservation !== undefined) throw domainError('INVALID_TRANSITION', `budget reservation ${activeReservation.reservationId} is unresolved`, eventIndex, 'budget-reservation', activeReservation.reservationId)
      if (projectionHasReconciliationGap(state)) {
        throw domainError('INVALID_TRANSITION', 'Team still has a durable reconciliation gap', eventIndex, 'team', event.teamId)
      }
      const workspace = state.workspace
      if (workspace === undefined || workspace.status !== 'ready') {
        throw domainError('INVALID_TRANSITION', 'Team workspace is not durably ready', eventIndex, 'workspace', workspace?.workspaceId)
      }
      if (!workspaceProofMatches(event.workspace, workspace)) {
        throw domainError('REFERENCE_MISMATCH', 'journal recovery identity does not match the durable Team workspace', eventIndex, 'workspace', workspace.workspaceId)
      }
      next = {
        ...state,
        team: { ...state.team, status: transitionTeam(state.team.status, 'paused') },
        recoveryClearOperations: withEntry(state.recoveryClearOperations, event.operationId, {
          id: event.operationId,
          target: 'paused',
          principal: { kind: 'controller-session', sessionId: event.controllerSessionId },
          basis: 'durable-journal',
        }),
      }
      break
    }
    case 'yuqi/team-followup-requested': {
      if (!isTerminalTeamStatus(state.team.status) || isHumanOwned(state) || projectionHasReconciliationGap(state)
        || state.fileLeaseIds.some(id => state.fileLeases[id]!.status === 'active')
        || Object.values(state.attempts).some(attempt => !['completed', 'failed', 'cancelled'].includes(attempt.status))
        || Object.values(state.verifications).some(verification => verification.status === 'pending' || verification.status === 'running')
        || state.reviewIds.some(id => state.reviews[id]!.status === 'requested')) {
        throw domainError('INVALID_TRANSITION', 'Follow-up requires a terminal, quiescent source Team with no active ownership', eventIndex, 'team', state.team.id)
      }
      if (operationIdUsed(state, event.operationId) || state.team.manualOwnershipOperations?.[event.operationId] !== undefined) {
        throw domainError('ENTITY_ALREADY_EXISTS', 'Follow-up operation identity already used', eventIndex, 'control-operation', event.operationId)
      }
      if (Object.values(state.followupOperations ?? {}).some(operation => operation.targetTeamId === undefined)) {
        throw domainError('INVALID_TRANSITION', 'An earlier follow-up creation still requires reconciliation', eventIndex, 'team', state.team.id)
      }
      next = { ...state, followupOperations: { ...state.followupOperations, [event.operationId]: {
        requestDigest: event.requestDigest, parentSessionId: event.parentSessionId,
      } } }
      break
    }
    case 'yuqi/team-followup-created': {
      const intent = state.followupOperations?.[event.operationId]
      if (intent === undefined || intent.targetTeamId !== undefined || event.targetTeamId === state.team.id) {
        throw domainError('INVALID_TRANSITION', 'Follow-up result must close one exact pending creation intent', eventIndex, 'team', state.team.id)
      }
      next = { ...state, followupOperations: { ...state.followupOperations, [event.operationId]: {
        ...intent, targetTeamId: event.targetTeamId, targetControllerSessionId: event.targetControllerSessionId,
      } } }
      break
    }
    case 'yuqi/task-created': {
      const taskId = event.contract.taskId
      if (isTerminalTeamStatus(state.team.status)) throw domainError('INVALID_TRANSITION', `terminal Team ${state.team.id} cannot create task ${taskId}`, eventIndex, 'team', state.team.id)
      if (hasOwn(state.tasks, taskId)) throw domainError('ENTITY_ALREADY_EXISTS', `task ${taskId} already exists`, eventIndex, 'task', taskId)
      if (state.taskIds.length >= MAX_TEAM_TASKS) throw domainError('INVALID_TASK_CONTRACT', `Team cannot contain more than ${MAX_TEAM_TASKS} tasks`, eventIndex, 'task', taskId)
      if (event.contract.revision !== 1) throw domainError('INVALID_TASK_REVISION', `new task ${taskId} must start at revision 1`, eventIndex, 'task', taskId)
      if (event.contract.kind === 'review-rework') validateReviewReworkTask(state, event.contract, eventIndex)
      if (event.contract.kind === 'user-revision') {
        const operationId = event.contract.userRevision!.operationId
        const existingGroup = state.taskIds.some(id => state.tasks[id]!.contract.userRevision?.operationId === operationId)
        if ((!existingGroup && operationIdUsed(state, operationId)) || state.team.manualOwnershipOperations?.[operationId] !== undefined) {
          throw domainError('ENTITY_ALREADY_EXISTS', 'Revision operation identity already used', eventIndex, 'control-operation', operationId)
        }
        const issue = taskRevisionIssue(state, event.contract, projectionHasReconciliationGap(state))
        if (issue !== undefined) throw domainError('INVALID_TASK_CONTRACT', issue, eventIndex, 'task', taskId)
      }
      validateContract(state, event.contract, eventIndex)
      validateAcyclicGraph(state, event.contract, eventIndex)
      next = {
        ...state,
        tasks: withEntry(state.tasks, taskId, { contract: event.contract, status: 'pending', attemptIds: [], verificationIds: [], verificationAttemptFloor: 1 }),
        taskIds: [...state.taskIds, taskId],
      }
      break
    }
    case 'yuqi/review-requested': {
      if (state.team.status !== 'running') throw domainError('INVALID_TRANSITION', `Team cannot request review while ${state.team.status}`, eventIndex, 'team', state.team.id)
      if (state.team.reviewPolicy?.mode === 'off') throw domainError('INVALID_TRANSITION', 'Team reviewer policy is off', eventIndex, 'team', state.team.id)
      if (event.trigger === 'quality-gate' && state.team.reviewPolicy?.mode !== 'quality-gate') {
        throw domainError('INVALID_TRANSITION', 'quality-gate review requires a quality-gate policy snapshot', eventIndex, 'team', state.team.id)
      }
      if (hasOwn(state.reviews, event.reviewId)) throw domainError('ENTITY_ALREADY_EXISTS', `review ${event.reviewId} already exists`, eventIndex, 'event', event.reviewId)
      const checkpointSubject = event.checkpointSubject ?? 'team-completion'
      const checkpointAnchor: ReviewCheckpointAnchor = event.checkpointAnchor ?? { eventId: event.candidateEventId }
      validateReviewCheckpointAnchor(
        state, checkpointSubject, checkpointAnchor, event.candidateEventId,
        event.checkpointAnchor !== undefined, eventIndex, event.reviewId,
      )
      validateReviewRequestRound(state, event.trigger, event.round, eventIndex, event.reviewId)
      const active = state.reviewIds.map(reviewId => state.reviews[reviewId]!).find(review => review.status === 'requested')
      if (active !== undefined) throw domainError('INVALID_TRANSITION', `review ${active.id} is still pending`, eventIndex, 'event', active.id)
      const latestReviewId = state.reviewIds.at(-1)
      const latestReview = latestReviewId === undefined ? undefined : state.reviews[latestReviewId]
      if (latestReview?.candidateEventId === event.candidateEventId) {
        const retryAuthorized = latestReview.status === 'awaiting_user'
          && latestReview.userDecision?.decision === 'retry_review'
          && latestReview.round === event.round
        if ((latestReview.status === 'awaiting_user' || latestReview.result?.decision === 'changes_required') && !retryAuthorized) {
          throw domainError('INVALID_TRANSITION', `review cycle ${latestReview.id} requires user resolution or rework before another review`, eventIndex, 'event', latestReview.id)
        }
        if (latestReview.result?.decision === 'pass' && event.trigger !== 'user-request') {
          throw domainError('INVALID_TRANSITION', `completion candidate already passed review ${latestReview.id}`, eventIndex, 'event', latestReview.id)
        }
      }
      next = {
        ...state,
        reviews: withEntry(state.reviews, event.reviewId, {
          id: event.reviewId, trigger: event.trigger, candidateEventId: event.candidateEventId,
          round: event.round,
          checkpointSubject,
          checkpointAnchor,
          phase: 'reviewing',
          automaticReworkBudget: event.automaticReworkBudget ?? {
            checkpointLimit: state.team.reviewPolicy?.maxReworkRounds ?? DEFAULT_MAX_REWORK_ROUNDS,
            teamLimit: DEFAULT_MAX_TEAM_AUTOMATIC_REWORKS,
          },
          independentReviewerRequired: event.independentReviewerRequired ?? false,
          ...(event.additionalCriteria === undefined ? {} : { additionalCriteria: event.additionalCriteria }),
          findingFingerprints: [],
          status: 'requested',
        }),
        reviewIds: [...state.reviewIds, event.reviewId],
      }
      break
    }
    case 'yuqi/review-result-recorded': {
      const review = state.reviews[event.reviewId]
      if (review === undefined) throw domainError('ENTITY_NOT_FOUND', `review ${event.reviewId} does not exist`, eventIndex, 'event', event.reviewId)
      if (review.status !== 'requested') throw domainError('ENTITY_ALREADY_EXISTS', `review ${event.reviewId} already has a result`, eventIndex, 'event', event.reviewId)
      if (review.candidateEventId !== event.candidateEventId
        || (review.checkpointSubject === 'team-completion' && state.completionCandidateEventId !== event.candidateEventId)) {
        throw domainError('REFERENCE_MISMATCH', `review ${event.reviewId} result targets a stale completion candidate`, eventIndex, 'event', event.reviewId)
      }
      const reviewerIndependent = event.reviewerIndependent ?? !review.independentReviewerRequired
      if (review.independentReviewerRequired
        && (!reviewerIndependent || reviewerSessionConflicts(state, event.reviewerSessionId))) {
        throw domainError('INVALID_EVENT', `review ${event.reviewId} did not use an independent reviewer session`, eventIndex, 'event', event.reviewId)
      }
      const findings = event.findings
      const computedFingerprints = findings.map(reviewFindingFingerprint)
      if (event.findingFingerprints !== undefined
        && (event.findingFingerprints.length !== computedFingerprints.length
          || event.findingFingerprints.some((value, index) => value !== computedFingerprints[index]))) {
        throw domainError('INVALID_EVENT', `review ${event.reviewId} contains invalid finding fingerprints`, eventIndex, 'event', event.reviewId)
      }
      const findingFingerprints = event.findingFingerprints ?? computedFingerprints
      const duplicateFinding = event.decision === 'changes_required'
        && repeatedCheckpointFinding(state, review, findingFingerprints)
      const budgetExhausted = event.decision === 'changes_required'
        && reviewAutomaticReworkBudgetExhausted(state, review)
      const awaitingUser = event.decision === 'inconclusive'
        || duplicateFinding
        || budgetExhausted
      next = {
        ...state,
        reviews: withEntry(state.reviews, event.reviewId, {
          ...review,
          status: awaitingUser ? 'awaiting_user' : 'completed',
          phase: awaitingUser
            ? 'awaiting-controller'
            : event.decision === 'pass' ? 'satisfied' : 'reworking',
          reviewerIndependent,
          ...(event.reviewerIndependence === undefined ? {} : { reviewerIndependence: event.reviewerIndependence }),
          findingFingerprints,
          result: {
            reviewerSessionId: event.reviewerSessionId,
            decision: event.decision,
            findings,
            unverified: event.unverified,
          },
        }),
      }
      break
    }
    case 'yuqi/review-user-decision-recorded': {
      if (operationIdUsed(state, event.operationId, 'review-user-decision')) {
        throw domainError('ENTITY_ALREADY_EXISTS', `operation ${event.operationId} was already used`, eventIndex, 'control-operation', event.operationId)
      }
      const existing = state.reviewUserDecisionOperations[event.operationId]
      if (existing !== undefined) {
        const same = existing.reviewId === event.reviewId
          && existing.candidateEventId === event.candidateEventId
          && existing.round === event.round
          && existing.decision === event.decision
          && existing.reason === event.reason
        if (!same) throw domainError('ENTITY_ALREADY_EXISTS', `review decision operation ${event.operationId} was reused with different facts`, eventIndex, 'control-operation', event.operationId)
        next = state
        break
      }
      if (state.team.status !== 'running' && state.team.status !== 'paused') {
        throw domainError('INVALID_TRANSITION', `Team cannot resolve review while ${state.team.status}`, eventIndex, 'team', state.team.id)
      }
      const review = state.reviews[event.reviewId]
      if (review === undefined || review.status !== 'awaiting_user') {
        throw domainError('INVALID_TRANSITION', `review ${event.reviewId} is not awaiting user resolution`, eventIndex, 'event', event.reviewId)
      }
      if (review.candidateEventId !== event.candidateEventId || state.completionCandidateEventId !== event.candidateEventId || review.round !== event.round) {
        throw domainError('REFERENCE_MISMATCH', `review ${event.reviewId} user decision targets a stale cycle`, eventIndex, 'event', event.reviewId)
      }
      if (review.userDecision !== undefined) throw domainError('INVALID_TRANSITION', `review ${event.reviewId} already has a user resolution`, eventIndex, 'event', event.reviewId)
      if (event.decision === 'authorize_final_rework') {
        if (review.result?.decision !== 'changes_required' || review.round >= MAX_REWORK_ROUNDS) {
          throw domainError('INVALID_TRANSITION', `review ${event.reviewId} cannot authorize another rework round`, eventIndex, 'event', event.reviewId)
        }
      }
      const decision: ReviewUserDecisionView = {
        operationId: event.operationId, reviewId: event.reviewId, candidateEventId: event.candidateEventId,
        round: event.round, decision: event.decision, ...(event.reason === undefined ? {} : { reason: event.reason }),
      }
      next = {
        ...state,
        reviews: withEntry(state.reviews, event.reviewId, { ...review, userDecision: decision }),
        reviewUserDecisionOperations: withEntry(state.reviewUserDecisionOperations, event.operationId, decision),
      }
      break
    }
    case 'yuqi/task-revised': {
      const taskId = event.contract.taskId
      const task = requireTask(state, taskId, eventIndex)
      if (JSON.stringify(event.contract.userRevision) !== JSON.stringify(task.contract.userRevision)) {
        throw domainError('INVALID_TASK_CONTRACT', 'User revision provenance is immutable', eventIndex, 'task', taskId)
      }
      const revisionDependencyIssue = taskRevisionDependenciesIssue(task.contract, event.contract)
      if (revisionDependencyIssue !== undefined) throw domainError('INVALID_TASK_CONTRACT', revisionDependencyIssue, eventIndex, 'task', taskId)
      if (task.status !== 'pending' && task.status !== 'ready') {
        throw domainError('INVALID_TRANSITION', `task ${taskId} cannot be revised while ${task.status}`, eventIndex, 'task', taskId)
      }
      if (event.contract.revision !== task.contract.revision + 1) throw domainError('INVALID_TASK_REVISION', `task ${taskId} revision must advance by one`, eventIndex, 'task', taskId)
      validateContract(state, event.contract, eventIndex)
      validateAcyclicGraph(state, event.contract, eventIndex)
      next = { ...state, tasks: withEntry(state.tasks, taskId, { ...task, contract: event.contract }) }
      break
    }
    case 'yuqi/task-retry-requested': {
      if (state.reconciliationOperations[event.operationId] !== undefined || state.attemptResolutionOperations[event.operationId] !== undefined || state.attemptResolutionProofs[event.operationId] !== undefined || state.recoveryClearOperations[event.operationId] !== undefined || state.verificationVerdictOperations[event.operationId] !== undefined || state.budgetPolicyOperations[event.operationId] !== undefined) {
        throw domainError('ENTITY_ALREADY_EXISTS', `operation ${event.operationId} was already used for reconciliation`, eventIndex, 'control-operation', event.operationId)
      }
      if (state.controlOperations[event.operationId] !== undefined) {
        throw domainError('ENTITY_ALREADY_EXISTS', `operation ${event.operationId} was already used for Team control`, eventIndex, 'control-operation', event.operationId)
      }
      const existing = state.taskRetryOperations[event.operationId]
      if (existing !== undefined) {
        if (existing.taskId !== event.taskId) {
          throw domainError('ENTITY_ALREADY_EXISTS', `retry operation ${event.operationId} was already used for task ${existing.taskId}`, eventIndex, 'control-operation', event.operationId)
        }
        next = state
        break
      }
      const task = requireTask(state, event.taskId, eventIndex)
      if (task.status !== 'failed' && task.status !== 'cancelled' && task.status !== 'verifying' && task.status !== 'blocked') {
        throw domainError('INVALID_TRANSITION', `task ${event.taskId} cannot retry while ${task.status}`, eventIndex, 'task', event.taskId)
      }
      if (task.attemptIds.some(attemptId => {
        const status = requireAttempt(state, attemptId, eventIndex).status
        return status === 'dispatching' || status === 'running' || status === 'unknown'
      })) throw domainError('INVALID_TRANSITION', `task ${event.taskId} cannot retry with an active attempt`, eventIndex, 'task', event.taskId)
      if (task.verificationIds.some(verificationId => {
        const status = requireVerification(state, verificationId, eventIndex).status
        return status === 'pending' || status === 'running'
      })) throw domainError('INVALID_TRANSITION', `task ${event.taskId} cannot retry with an active verification`, eventIndex, 'task', event.taskId)
      if (state.fileLeaseIds.some(leaseId => {
        const lease = state.fileLeases[leaseId]!
        return lease.taskId === event.taskId && lease.status === 'active'
      })) throw domainError('INVALID_TRANSITION', `task ${event.taskId} cannot retry while it owns an active file lease`, eventIndex, 'task', event.taskId)
      if (Object.values(state.budgetReservations).some(reservation => reservation.taskId === event.taskId
        && (reservation.status === 'active' || reservation.status === 'unknown'))) {
        throw domainError('INVALID_TRANSITION', `task ${event.taskId} cannot retry while its token budget reservation is unresolved`, eventIndex, 'task', event.taskId)
      }
      next = {
        ...state,
        tasks: withEntry(state.tasks, event.taskId, {
          ...task,
          status: 'ready',
          verificationAttemptFloor: task.attemptIds.length + 1,
        }),
        taskRetryOperations: withEntry(state.taskRetryOperations, event.operationId, { id: event.operationId, taskId: event.taskId }),
      }
      break
    }
    case 'yuqi/task-stop-requested': {
      if (operationIdUsed(state, event.operationId, 'control')) {
        throw domainError('ENTITY_ALREADY_EXISTS', `operation ${event.operationId} was already used for another command`, eventIndex, 'control-operation', event.operationId)
      }
      const existing = state.controlOperations[event.operationId]
      if (existing !== undefined) {
        if (existing.action !== 'stop-task' || existing.taskId !== event.taskId || existing.attemptId !== event.attemptId) {
          throw domainError('ENTITY_ALREADY_EXISTS', `stop operation ${event.operationId} was reused for another target`, eventIndex, 'control-operation', event.operationId)
        }
        next = state
        break
      }
      const task = requireTask(state, event.taskId, eventIndex)
      const attempt = requireAttempt(state, event.attemptId, eventIndex)
      if (state.team.status !== 'running') {
        throw domainError('INVALID_TRANSITION', `task ${event.taskId} cannot stop while Team is ${state.team.status}`, eventIndex, 'task', event.taskId)
      }
      if (task.status !== 'running' || attempt.taskId !== event.taskId
        || (attempt.status !== 'dispatching' && attempt.status !== 'running')) {
        throw domainError('INVALID_TRANSITION', `task ${event.taskId} has no matching active attempt to stop`, eventIndex, 'task', event.taskId)
      }
      next = {
        ...state,
        controlOperations: withEntry(state.controlOperations, event.operationId, {
          id: event.operationId, action: 'stop-task', taskId: event.taskId, attemptId: event.attemptId,
        }),
      }
      break
    }
    case 'yuqi/reconciliation-observed': {
      if (state.controlOperations[event.operationId] !== undefined || state.taskRetryOperations[event.operationId] !== undefined || state.attemptResolutionOperations[event.operationId] !== undefined || state.attemptResolutionProofs[event.operationId] !== undefined || state.recoveryClearOperations[event.operationId] !== undefined || state.verificationVerdictOperations[event.operationId] !== undefined || state.budgetPolicyOperations[event.operationId] !== undefined) {
        throw domainError('ENTITY_ALREADY_EXISTS', `operation ${event.operationId} was already used for another command`, eventIndex, 'control-operation', event.operationId)
      }
      const existing = state.reconciliationOperations[event.operationId]
      if (existing !== undefined) {
        if (!sameRuntimeObservations(existing.observations, event.observations)) {
          throw domainError('ENTITY_ALREADY_EXISTS', `reconciliation operation ${event.operationId} was reused for different observations`, eventIndex, 'control-operation', event.operationId)
        }
        next = state
        break
      }
      let attempts = state.attempts
      let latestReconciliationOperationIds = state.latestReconciliationOperationIds
      const seen = new Set<string>()
      for (const observation of event.observations) {
        if (seen.has(observation.attemptId)) throw domainError('INVALID_EVENT', `reconciliation operation repeats attempt ${observation.attemptId}`, eventIndex, 'attempt', observation.attemptId)
        seen.add(observation.attemptId)
        const attempt = requireAttempt(state, observation.attemptId, eventIndex)
        if (attempt.taskId !== observation.taskId) throw domainError('REFERENCE_MISMATCH', `attempt ${observation.attemptId} does not belong to task ${observation.taskId}`, eventIndex, 'attempt', observation.attemptId)
        if (attempt.status !== 'dispatching' && attempt.status !== 'running' && attempt.status !== 'unknown') {
          throw domainError('INVALID_TRANSITION', `attempt ${observation.attemptId} cannot reconcile while ${attempt.status}`, eventIndex, 'attempt', observation.attemptId)
        }
        if (attempt.agentSessionId !== undefined && observation.state === 'not-admitted') {
          throw domainError('REFERENCE_MISMATCH', `admitted attempt ${observation.attemptId} cannot have a not-admitted observation`, eventIndex, 'attempt', observation.attemptId)
        }
        if (attempt.agentSessionId !== observation.childSessionId) {
          throw domainError('REFERENCE_MISMATCH', `runtime observation does not match attempt ${observation.attemptId} child identity`, eventIndex, 'attempt', observation.attemptId)
        }
        if (attempt.agentSessionId === undefined
          && observation.state !== 'not-admitted'
          && observation.state !== 'diagnostic'
          && observation.state !== 'unavailable') {
          throw domainError('REFERENCE_MISMATCH', `unadmitted attempt ${observation.attemptId} requires a not-admitted observation or no-child diagnostic/unavailable observation`, eventIndex, 'attempt', observation.attemptId)
        }
        attempts = withEntry(attempts, observation.attemptId, { ...attempt, status: 'unknown' })
        latestReconciliationOperationIds = withEntry(latestReconciliationOperationIds, observation.attemptId, event.operationId)
      }
      next = {
        ...state,
        attempts,
        latestReconciliationOperationIds,
        reconciliationOperations: withEntry(state.reconciliationOperations, event.operationId, {
          id: event.operationId,
          observations: event.observations.map(observation => ({
            taskId: observation.taskId,
            attemptId: observation.attemptId,
            state: observation.state,
            ...(observation.childSessionId === undefined ? {} : { childSessionId: observation.childSessionId }),
            ...(observation.reason === undefined ? {} : { reason: observation.reason }),
          })),
        }),
      }
      break
    }
    case 'yuqi/attempt-resolution-proof-recorded': {
      if (state.controlOperations[event.operationId] !== undefined
        || state.taskRetryOperations[event.operationId] !== undefined
        || state.reconciliationOperations[event.operationId] !== undefined
        || state.recoveryClearOperations[event.operationId] !== undefined
        || state.verificationVerdictOperations[event.operationId] !== undefined
        || state.budgetPolicyOperations[event.operationId] !== undefined
        || state.attemptResolutionOperations[event.operationId] !== undefined) {
        throw domainError('ENTITY_ALREADY_EXISTS', `operation ${event.operationId} was already used for another command`, eventIndex, 'control-operation', event.operationId)
      }
      const existing = state.attemptResolutionProofs[event.operationId]
      const attempt = requireAttempt(state, event.attemptId, eventIndex)
      const task = requireTask(state, event.taskId, eventIndex)
      if (attempt.taskId !== event.taskId) throw domainError('REFERENCE_MISMATCH', `attempt ${event.attemptId} does not belong to task ${event.taskId}`, eventIndex, 'attempt', event.attemptId)
      if (state.team.status !== 'needs_reconciliation' || attempt.status !== 'unknown' || task.status !== 'running') {
        throw domainError('INVALID_TRANSITION', `attempt ${event.attemptId} is not in a resolvable reconciliation state`, eventIndex, 'attempt', event.attemptId)
      }
      if (state.latestReconciliationOperationIds[event.attemptId] !== event.observationOperationId) {
        throw domainError('REFERENCE_MISMATCH', `attempt ${event.attemptId} was not resolved against its latest reconciliation observation`, eventIndex, 'attempt', event.attemptId)
      }
      const observation = state.reconciliationOperations[event.observationOperationId]?.observations
        .find(candidate => candidate.attemptId === event.attemptId)
      if (observation === undefined || observation.state !== event.proof.observationState) {
        throw domainError('REFERENCE_MISMATCH', `resolution proof does not match the latest observation for attempt ${event.attemptId}`, eventIndex, 'attempt', event.attemptId)
      }
      const activeLeases = Object.values(state.fileLeases).filter(lease => lease.status === 'active' && lease.taskId === event.taskId)
      if (activeLeases.some(lease => lease.attemptId !== event.attemptId)) {
        throw domainError('INVALID_TRANSITION', `attempt ${event.attemptId} has an unprovable or foreign active lease`, eventIndex, 'file-lease', event.attemptId)
      }
      const activeLeaseIds = activeLeases.map(lease => lease.leaseId)
      if (!sameStrings(activeLeaseIds, event.proof.leaseIds)) {
        throw domainError('REFERENCE_MISMATCH', `resolution proof does not name the exact releasable leases for attempt ${event.attemptId}`, eventIndex, 'file-lease', event.attemptId)
      }
      if (event.proof.workspace !== undefined) {
        const workspace = state.workspace
        if (workspace === undefined || workspace.status !== 'ready'
          || !workspaceProofMatches(event.proof.workspace, workspace)) {
          throw domainError('REFERENCE_MISMATCH', `resolution proof workspace is not the durable Team workspace`, eventIndex, 'workspace', event.proof.workspace.workspaceId)
        }
      }
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify({
          id: event.operationId, observationOperationId: event.observationOperationId,
          taskId: event.taskId, attemptId: event.attemptId, decision: event.decision,
          principal: event.proof.principal, observationState: event.proof.observationState,
          childQuiescent: true, localInFlight: false, gitVerified: true,
          ...(event.proof.workspace === undefined ? {} : { workspace: event.proof.workspace }),
          leaseIds: event.proof.leaseIds,
        })) {
          throw domainError('ENTITY_ALREADY_EXISTS', `resolution proof operation ${event.operationId} was reused with different content`, eventIndex, 'control-operation', event.operationId)
        }
        next = state
        break
      }
      next = {
        ...state,
        attemptResolutionProofs: withEntry(state.attemptResolutionProofs, event.operationId, {
          id: event.operationId, observationOperationId: event.observationOperationId,
          taskId: event.taskId, attemptId: event.attemptId, decision: event.decision,
          principal: event.proof.principal,
          observationState: event.proof.observationState,
          childQuiescent: true, localInFlight: false, gitVerified: true,
          ...(event.proof.workspace === undefined ? {} : { workspace: event.proof.workspace }),
          leaseIds: [...event.proof.leaseIds],
        }),
      }
      break
    }
    case 'yuqi/attempt-resolution-requested': {
      if (state.controlOperations[event.operationId] !== undefined || state.taskRetryOperations[event.operationId] !== undefined || state.reconciliationOperations[event.operationId] !== undefined || state.recoveryClearOperations[event.operationId] !== undefined || state.verificationVerdictOperations[event.operationId] !== undefined || state.budgetPolicyOperations[event.operationId] !== undefined) {
        throw domainError('ENTITY_ALREADY_EXISTS', `operation ${event.operationId} was already used for another command`, eventIndex, 'control-operation', event.operationId)
      }
      const existing = state.attemptResolutionOperations[event.operationId]
      if (existing !== undefined) {
        if (existing.observationOperationId !== event.observationOperationId || existing.taskId !== event.taskId
          || existing.attemptId !== event.attemptId || existing.decision !== event.decision) {
          throw domainError('ENTITY_ALREADY_EXISTS', `attempt resolution operation ${event.operationId} was reused with different content`, eventIndex, 'control-operation', event.operationId)
        }
        next = state
        break
      }
      if (state.team.status !== 'needs_reconciliation') {
        throw domainError('INVALID_TRANSITION', `Team cannot resolve an attempt while ${state.team.status}`, eventIndex, 'team', event.teamId)
      }
      const task = requireTask(state, event.taskId, eventIndex)
      const attempt = requireAttempt(state, event.attemptId, eventIndex)
      if (attempt.taskId !== event.taskId) throw domainError('REFERENCE_MISMATCH', `attempt ${event.attemptId} does not belong to task ${event.taskId}`, eventIndex, 'attempt', event.attemptId)
      if (attempt.status !== 'unknown' || task.status !== 'running') {
        throw domainError('INVALID_TRANSITION', `attempt ${event.attemptId} and task ${event.taskId} are not safely resolvable`, eventIndex, 'attempt', event.attemptId)
      }
      if (state.latestReconciliationOperationIds[event.attemptId] !== event.observationOperationId) {
        throw domainError('REFERENCE_MISMATCH', `attempt ${event.attemptId} was not resolved against its latest reconciliation observation`, eventIndex, 'attempt', event.attemptId)
      }
      // latestReconciliationOperationIds is written from this exact observation in the same reducer.
      const observation = state.reconciliationOperations[event.observationOperationId]!.observations
        .find(candidate => candidate.attemptId === event.attemptId)!
      if (observation.state !== 'durable' && observation.state !== 'missing' && observation.state !== 'not-admitted') {
        throw domainError('INVALID_TRANSITION', `attempt ${event.attemptId} cannot resolve from a ${observation.state} observation`, eventIndex, 'attempt', event.attemptId)
      }
      const proof = event.proofOperationId === undefined ? undefined : state.attemptResolutionProofs[event.proofOperationId]
      if (event.proofOperationId !== undefined) {
        if (proof === undefined || proof.taskId !== event.taskId || proof.attemptId !== event.attemptId
          || proof.observationOperationId !== event.observationOperationId || proof.decision !== event.decision) {
          throw domainError('REFERENCE_MISMATCH', `resolution ${event.operationId} does not reference its durable proof`, eventIndex, 'attempt', event.attemptId)
        }
      }
      assertBudgetSettled(state, event.taskId, event.attemptId, eventIndex)
      next = {
        ...state,
        attempts: withEntry(state.attempts, event.attemptId, {
          ...attempt, status: event.decision,
          ...(event.proofOperationId === undefined ? {} : { resolutionProofOperationId: event.proofOperationId }),
        }),
        tasks: withEntry(state.tasks, event.taskId, { ...task, status: event.decision }),
        attemptResolutionOperations: withEntry(state.attemptResolutionOperations, event.operationId, {
          id: event.operationId, observationOperationId: event.observationOperationId,
          taskId: event.taskId, attemptId: event.attemptId, decision: event.decision,
          ...(event.proofOperationId === undefined ? {} : { proofOperationId: event.proofOperationId }),
        }),
      }
      break
    }
    case 'yuqi/task-status-changed': {
      const task = requireTask(state, event.taskId, eventIndex)
      if (task.status !== event.from) throw domainError('INVALID_TRANSITION', `task ${event.taskId} is ${task.status}, not ${event.from}`, eventIndex, 'task', event.taskId)
      const latestAttempt = state.attempts[task.attemptIds.at(-1) ?? '']
      if ((event.to === 'completed' || event.to === 'verifying') && latestAttempt !== undefined
        && !taskOutcomeAllowsCompletion(latestAttempt.taskOutcomeVersion, latestAttempt.evidence?.taskOutcome)) {
        throw domainError('INVALID_TRANSITION', `task ${event.taskId} has no valid completed task outcome`, eventIndex, 'task', event.taskId)
      }
      if (event.from === 'blocked' && (event.to === 'pending' || event.to === 'ready') && taskHasSemanticBlock(state, task)) {
        throw domainError('INVALID_TRANSITION', `task ${event.taskId} requires an explicit retry after its blocked outcome`, eventIndex, 'task', event.taskId)
      }
      if (event.from === 'verifying' && event.to === 'completed') assertTaskCompletionReady(state, task, eventIndex)
      next = {
        ...state,
        tasks: withEntry(state.tasks, event.taskId, { ...task, status: transitionTask(event.from, event.to) }),
        ...(event.to === 'completed' ? { completionCandidateEventId: event.eventId } : {}),
      }
      break
    }
    case 'yuqi/attempt-created': {
      const task = requireTask(state, event.taskId, eventIndex)
      if (hasOwn(state.attempts, event.attemptId)) throw domainError('ENTITY_ALREADY_EXISTS', `attempt ${event.attemptId} already exists`, eventIndex, 'attempt', event.attemptId)
      if (task.status !== 'running') throw domainError('INVALID_TRANSITION', `task ${event.taskId} cannot create an attempt while ${task.status}`, eventIndex, 'task', event.taskId)
      if (event.ordinal !== task.attemptIds.length + 1) throw domainError('INVALID_ATTEMPT_ORDINAL', `attempt ${event.attemptId} must use ordinal ${task.attemptIds.length + 1}`, eventIndex, 'attempt', event.attemptId)
      if (state.budgetPolicy !== undefined && !reservationsForAttempt(state, event.taskId, event.attemptId).some(reservation => reservation.status === 'active')) {
        throw domainError('INVALID_TRANSITION', `attempt ${event.attemptId} requires an active token budget reservation`, eventIndex, 'attempt', event.attemptId)
      }
      const modelProvider = event.route?.modelProvider ?? event.modelProvider!
      const modelId = event.route?.modelId ?? event.modelId!
      const attempt: AttemptView = {
        id: event.attemptId, taskId: event.taskId, ordinal: event.ordinal,
        modelProvider, modelId, status: 'dispatching',
        ...(event.taskOutcomeVersion === undefined ? {} : { taskOutcomeVersion: event.taskOutcomeVersion }),
        ...(event.route === undefined ? {} : { route: event.route }),
        ...(event.routeBasis === undefined ? {} : { routeBasis: event.routeBasis }),
        ...(event.requestedTier === undefined ? {} : { requestedTier: event.requestedTier }),
        ...(event.fallbackReason === undefined ? {} : { fallbackReason: event.fallbackReason }),
        ...(event.catalogEvidence === undefined ? {} : { catalogEvidence: event.catalogEvidence }),
        ...(event.recoveryToken === undefined ? {} : { recoveryToken: event.recoveryToken }),
      }
      next = {
        ...state,
        tasks: withEntry(state.tasks, event.taskId, { ...task, attemptIds: [...task.attemptIds, event.attemptId] }),
        attempts: withEntry(state.attempts, event.attemptId, attempt),
      }
      break
    }
    case 'yuqi/attempt-admitted': {
      const attempt = requireAttempt(state, event.attemptId, eventIndex)
      if (attempt.taskId !== event.taskId) throw domainError('REFERENCE_MISMATCH', `attempt ${event.attemptId} does not belong to task ${event.taskId}`, eventIndex, 'attempt', event.attemptId)
      if (attempt.agentSessionId !== undefined || attempt.messageId !== undefined) throw domainError('ENTITY_ALREADY_EXISTS', `attempt ${event.attemptId} was already admitted`, eventIndex, 'attempt', event.attemptId)
      if (attempt.status !== 'dispatching') throw domainError('INVALID_TRANSITION', `attempt ${event.attemptId} cannot be admitted from ${attempt.status}`, eventIndex, 'attempt', event.attemptId)
      assertChildSessionUnbound(state, event.attemptId, event.agentSessionId, eventIndex)
      next = { ...state, attempts: withEntry(state.attempts, event.attemptId, { ...attempt, agentSessionId: event.agentSessionId, messageId: event.messageId }) }
      break
    }
    case 'yuqi/attempt-child-recovered': {
      const attempt = requireAttempt(state, event.attemptId, eventIndex)
      if (attempt.taskId !== event.taskId) throw domainError('REFERENCE_MISMATCH', `attempt ${event.attemptId} does not belong to task ${event.taskId}`, eventIndex, 'attempt', event.attemptId)
      if (attempt.status !== 'dispatching' && attempt.status !== 'running' && attempt.status !== 'unknown') {
        throw domainError('INVALID_TRANSITION', `attempt ${event.attemptId} cannot recover a child from ${attempt.status}`, eventIndex, 'attempt', event.attemptId)
      }
      if (attempt.recoveryToken !== event.recoveryToken) throw domainError('REFERENCE_MISMATCH', `attempt ${event.attemptId} recovery token does not match`, eventIndex, 'attempt', event.attemptId)
      if (attempt.agentSessionId !== undefined) {
        if (attempt.agentSessionId !== event.childSessionId) throw domainError('ENTITY_ALREADY_EXISTS', `attempt ${event.attemptId} is already bound to another child`, eventIndex, 'attempt', event.attemptId)
        next = state
        break
      }
      assertChildSessionUnbound(state, event.attemptId, event.childSessionId, eventIndex)
      next = { ...state, attempts: withEntry(state.attempts, event.attemptId, { ...attempt, agentSessionId: event.childSessionId }) }
      break
    }
    case 'yuqi/attempt-status-changed': {
      const attempt = requireAttempt(state, event.attemptId, eventIndex)
      if (attempt.taskId !== event.taskId) throw domainError('REFERENCE_MISMATCH', `attempt ${event.attemptId} does not belong to task ${event.taskId}`, eventIndex, 'attempt', event.attemptId)
      if (attempt.status !== event.from) throw domainError('INVALID_TRANSITION', `attempt ${event.attemptId} is ${attempt.status}, not ${event.from}`, eventIndex, 'attempt', event.attemptId)
      if (event.to === 'running' && (attempt.agentSessionId === undefined || attempt.messageId === undefined)) {
        throw domainError('INVALID_TRANSITION', `attempt ${event.attemptId} cannot run before admission`, eventIndex, 'attempt', event.attemptId)
      }
      if (event.from === 'unknown' && event.to === 'running') {
        const observationOperationId = state.latestReconciliationOperationIds[event.attemptId]
        const observation = observationOperationId === undefined
          ? undefined
          : state.reconciliationOperations[observationOperationId]?.observations.find(item => item.attemptId === event.attemptId)
        if (state.team.status !== 'needs_reconciliation' || observation?.state !== 'live'
          || observation.childSessionId !== attempt.agentSessionId) {
          throw domainError('INVALID_TRANSITION', `attempt ${event.attemptId} cannot resume without its latest live reconciliation observation`, eventIndex, 'attempt', event.attemptId)
        }
      }
      if (event.to === 'completed' && !taskOutcomeAllowsCompletion(attempt.taskOutcomeVersion, attempt.evidence?.taskOutcome)) {
        throw domainError('INVALID_TRANSITION', `attempt ${event.attemptId} has no valid completed task outcome`, eventIndex, 'attempt', event.attemptId)
      }
      next = {
        ...state,
        attempts: withEntry(state.attempts, event.attemptId, {
          ...attempt,
          status: transitionAttempt(event.from, event.to),
          ...(attempt.startedAt === undefined && event.to === 'running' ? { startedAt: event.occurredAt } : {}),
          ...(attempt.endedAt === undefined && isAttemptEndStatus(event.to) ? { endedAt: event.occurredAt } : {}),
        }),
      }
      break
    }
    case 'yuqi/attempt-usage-observed': {
      const attempt = requireAttempt(state, event.attemptId, eventIndex)
      if (attempt.taskId !== event.taskId) throw domainError('REFERENCE_MISMATCH', `attempt ${event.attemptId} does not belong to task ${event.taskId}`, eventIndex, 'attempt', event.attemptId)
      if (attempt.agentSessionId !== event.agentSessionId) throw domainError('REFERENCE_MISMATCH', `usage child ${event.agentSessionId} does not match attempt ${event.attemptId}`, eventIndex, 'attempt', event.attemptId)
      if (attempt.status !== 'running') throw domainError('INVALID_TRANSITION', `attempt ${event.attemptId} cannot observe usage while ${attempt.status}`, eventIndex, 'attempt', event.attemptId)
      if (attempt.observedUsage !== undefined && !usageIsMonotonic(attempt.observedUsage, event.usage)) {
        throw domainError('INVALID_EVENT', `attempt ${event.attemptId} usage moved backwards`, eventIndex, 'attempt', event.attemptId)
      }
      next = { ...state, attempts: withEntry(state.attempts, event.attemptId, { ...attempt, observedUsage: { ...event.usage } }) }
      break
    }
    case 'yuqi/attempt-evidence-recorded': {
      const attempt = requireAttempt(state, event.attemptId, eventIndex)
      if (attempt.taskId !== event.taskId) throw domainError('REFERENCE_MISMATCH', `attempt ${event.attemptId} does not belong to task ${event.taskId}`, eventIndex, 'attempt', event.attemptId)
      if (attempt.agentSessionId !== event.agentSessionId) throw domainError('REFERENCE_MISMATCH', `evidence child ${event.agentSessionId} does not match attempt ${event.attemptId}`, eventIndex, 'attempt', event.attemptId)
      if (attempt.evidence !== undefined) throw domainError('ENTITY_ALREADY_EXISTS', `attempt ${event.attemptId} already has settlement evidence`, eventIndex, 'attempt', event.attemptId)
      if (!['settled', 'failed', 'cancelled'].includes(attempt.status)) throw domainError('INVALID_TRANSITION', `attempt ${event.attemptId} cannot record evidence while ${attempt.status}`, eventIndex, 'attempt', event.attemptId)
      const expectedStatus = event.stopReason === 'completed' ? 'settled' : event.stopReason === 'aborted' ? 'cancelled' : 'failed'
      if (attempt.status !== expectedStatus) throw domainError('INVALID_TRANSITION', `attempt ${event.attemptId} status ${attempt.status} does not match stop reason ${event.stopReason}`, eventIndex, 'attempt', event.attemptId)
      if (attempt.observedUsage !== undefined && event.usage !== undefined && !usageIsMonotonic(attempt.observedUsage, event.usage)) {
        throw domainError('INVALID_EVENT', `attempt ${event.attemptId} final usage is lower than its observed usage`, eventIndex, 'attempt', event.attemptId)
      }
      const evidence: AttemptEvidenceView = {
        runId: event.runId,
        agentSessionId: event.agentSessionId,
        provider: event.provider,
        stopReason: event.stopReason,
        hasAssistantOutput: event.hasAssistantOutput,
        ...(event.taskOutcome === undefined ? {} : { taskOutcome: event.taskOutcome }),
        ...(event.reportedChangedFiles === undefined ? {} : { reportedChangedFiles: [...event.reportedChangedFiles] }),
        ...(event.usage === undefined ? {} : { usage: { ...event.usage } }),
        settledAt: event.settledAt,
      }
      next = { ...state, attempts: withEntry(state.attempts, event.attemptId, { ...attempt, endedAt: event.settledAt, evidence }) }
      break
    }
    case 'yuqi/verification-created': {
      const task = requireTask(state, event.taskId, eventIndex)
      const attempt = requireAttempt(state, event.attemptId, eventIndex)
      if (attempt.taskId !== event.taskId) throw domainError('REFERENCE_MISMATCH', `attempt ${event.attemptId} does not belong to task ${event.taskId}`, eventIndex, 'attempt', event.attemptId)
      if (task.status !== 'verifying') throw domainError('INVALID_TRANSITION', `task ${event.taskId} cannot start verification while ${task.status}`, eventIndex, 'task', event.taskId)
      if (task.attemptIds.at(-1) !== event.attemptId || attempt.ordinal < task.verificationAttemptFloor
        || attempt.status !== 'settled' || attempt.evidence === undefined || attempt.evidence.stopReason !== 'completed') {
        throw domainError('INVALID_TRANSITION', `attempt ${event.attemptId} is not the current settled attempt for task ${event.taskId}`, eventIndex, 'attempt', event.attemptId)
      }
      if (hasOwn(state.verifications, event.verificationId)) throw domainError('ENTITY_ALREADY_EXISTS', `verification ${event.verificationId} already exists`, eventIndex, 'verification', event.verificationId)
      const verification: VerificationView = { id: event.verificationId, taskId: event.taskId, attemptId: event.attemptId, verifierSessionId: event.verifierSessionId, status: 'pending' }
      next = {
        ...state,
        tasks: withEntry(state.tasks, event.taskId, { ...task, verificationIds: [...task.verificationIds, event.verificationId] }),
        verifications: withEntry(state.verifications, event.verificationId, verification),
      }
      break
    }
    case 'yuqi/verification-status-changed': {
      const verification = requireVerification(state, event.verificationId, eventIndex)
      if (verification.taskId !== event.taskId || verification.attemptId !== event.attemptId) throw domainError('REFERENCE_MISMATCH', `verification ${event.verificationId} references another task or attempt`, eventIndex, 'verification', event.verificationId)
      if (verification.status !== event.from) throw domainError('INVALID_TRANSITION', `verification ${event.verificationId} is ${verification.status}, not ${event.from}`, eventIndex, 'verification', event.verificationId)
      next = { ...state, verifications: withEntry(state.verifications, event.verificationId, { ...verification, status: transitionVerification(event.from, event.to) }) }
      break
    }
    case 'yuqi/verification-verdict-recorded': {
      if (state.controlOperations[event.operationId] !== undefined
        || state.taskRetryOperations[event.operationId] !== undefined
        || state.reconciliationOperations[event.operationId] !== undefined
        || state.attemptResolutionOperations[event.operationId] !== undefined
        || state.attemptResolutionProofs[event.operationId] !== undefined
        || state.recoveryClearOperations[event.operationId] !== undefined
        || state.budgetPolicyOperations[event.operationId] !== undefined) {
        throw domainError('ENTITY_ALREADY_EXISTS', `verification verdict operation ${event.operationId} was already used for another command`, eventIndex, 'control-operation', event.operationId)
      }
      const existing = state.verificationVerdictOperations[event.operationId]
      const normalizedEvidence = event.evidence.map(parseStructuredEvidence)
      const existingComparable = existing === undefined ? undefined : verdictComparable(existing)
      const incomingComparable = verdictComparable({
        operationId: event.operationId,
        verificationId: event.verificationId,
        taskId: event.taskId,
        attemptId: event.attemptId,
        disposition: event.disposition,
        requirements: event.requirements,
        evidence: normalizedEvidence,
        reasons: event.reasons,
        ...(event.collectionStatus === undefined ? {} : { collectionStatus: event.collectionStatus }),
        ...(event.reworkBudget === undefined ? {} : { reworkBudget: event.reworkBudget }),
        ...(event.rework === undefined ? {} : { rework: event.rework }),
      })
      if (existing !== undefined) {
        if (existingComparable !== incomingComparable) {
          throw domainError('ENTITY_ALREADY_EXISTS', `verification verdict operation ${event.operationId} was reused for different content`, eventIndex, 'control-operation', event.operationId)
        }
        next = state
        break
      }
      const task = requireTask(state, event.taskId, eventIndex)
      const attempt = requireAttempt(state, event.attemptId, eventIndex)
      const verification = requireVerification(state, event.verificationId, eventIndex)
      if (verification.taskId !== event.taskId || verification.attemptId !== event.attemptId) {
        throw domainError('REFERENCE_MISMATCH', `verification ${event.verificationId} references another task or attempt`, eventIndex, 'verification', event.verificationId)
      }
      if (task.status !== 'verifying' || verification.status !== 'running') {
        throw domainError('INVALID_TRANSITION', `verification ${event.verificationId} is not actively verifying task ${event.taskId}`, eventIndex, 'verification', event.verificationId)
      }
      if (task.attemptIds.at(-1) !== event.attemptId || attempt.ordinal < task.verificationAttemptFloor) {
        throw domainError('REFERENCE_MISMATCH', `verification ${event.verificationId} does not target the current attempt`, eventIndex, 'verification', event.verificationId)
      }
      const collectionStatus = event.collectionStatus ?? 'collected'
      if (collectionStatus !== 'collected' && normalizedEvidence.length > 0) {
        throw domainError('INVALID_EVENT', `verification ${event.verificationId} cannot carry evidence when collection status is ${collectionStatus}`, eventIndex, 'verification', event.verificationId)
      }
      const expected = expectedVerdict(event.requirements, normalizedEvidence, collectionStatus)
      if (expected.disposition !== event.disposition || !sameReasons(expected.reasons, event.reasons)) {
        throw domainError('INVALID_EVENT', `verification ${event.verificationId} contains a verdict not derived from its structured evidence`, eventIndex, 'verification', event.verificationId)
      }
      validateRework(event.disposition, event.rework, eventIndex, event.verificationId)
      validateReworkBudget(event.reworkBudget, event.disposition, eventIndex, event.verificationId)
      const verdict: VerificationVerdictView = {
        operationId: event.operationId,
        disposition: event.disposition,
        requirements: event.requirements,
        evidence: normalizedEvidence,
        reasons: event.reasons,
        ...(event.collectionStatus === undefined ? {} : { collectionStatus: event.collectionStatus }),
        ...(event.reworkBudget === undefined ? {} : { reworkBudget: event.reworkBudget }),
        ...(event.rework === undefined ? {} : { rework: event.rework }),
      }
      const operation = { ...verdict, verificationId: event.verificationId, taskId: event.taskId, attemptId: event.attemptId }
      const status = event.disposition === 'passed'
        ? transitionVerification(verification.status, 'passed')
        : event.disposition === 'failed'
          ? transitionVerification(verification.status, 'failed')
          : verification.status
      next = {
        ...state,
        verifications: withEntry(state.verifications, event.verificationId, { ...verification, status, verdict }),
        verificationVerdictOperations: withEntry(state.verificationVerdictOperations, event.operationId, operation),
      }
      break
    }
    case 'yuqi/budget-policy-set': {
      if (operationIdUsed(state, event.operationId, 'budget-policy')) {
        throw domainError('ENTITY_ALREADY_EXISTS', `budget policy operation ${event.operationId} was already used for another command`, eventIndex, 'control-operation', event.operationId)
      }
      const previousOperation = state.budgetPolicyOperations[event.operationId]
      if (previousOperation !== undefined) {
        if (previousOperation.revision === event.revision
          && previousOperation.tokenLimit === event.tokenLimit
          && sameNumbers(previousOperation.alerts, event.alerts)
          && previousOperation.stopBehavior === event.stopBehavior) {
          next = state
          break
        }
        throw domainError('ENTITY_ALREADY_EXISTS', `budget policy operation ${event.operationId} was reused with different content`, eventIndex, 'control-operation', event.operationId)
      }
      const current = state.budgetPolicy
      if (current !== undefined) {
        if (event.revision !== current.revision + 1) {
          throw domainError('INVALID_EVENT', `budget policy revision ${event.revision} is not the next revision`, eventIndex, 'team', event.teamId)
        }
      } else if (event.revision !== 1) {
        throw domainError('INVALID_EVENT', `budget policy must start at revision 1, received ${event.revision}`, eventIndex, 'team', event.teamId)
      }
      next = {
        ...state,
        budgetPolicy: {
          revision: event.revision,
          operationId: event.operationId,
          tokenLimit: event.tokenLimit,
          alerts: [...event.alerts],
          stopBehavior: event.stopBehavior,
        },
        budgetPolicyOperations: withEntry(state.budgetPolicyOperations, event.operationId, {
          revision: event.revision,
          operationId: event.operationId,
          tokenLimit: event.tokenLimit,
          alerts: [...event.alerts],
          stopBehavior: event.stopBehavior,
        }),
      }
      break
    }
    case 'yuqi/budget-reservation-acquired': {
      if (state.budgetPolicy === undefined) {
        throw domainError('INVALID_TRANSITION', 'A token reservation requires a configured budget policy', eventIndex, 'team', event.teamId)
      }
      if (hasOwn(state.attempts, event.attemptId)) {
        throw domainError('INVALID_TRANSITION', `budget reservation ${event.reservationId} must be acquired before attempt ${event.attemptId} is created`, eventIndex, 'budget-reservation', event.reservationId)
      }
      const existing = state.budgetReservations[event.reservationId]
      if (existing !== undefined) {
        if (existing.taskId === event.taskId && existing.attemptId === event.attemptId && existing.tokenReserve === event.tokenReserve) {
          next = state
          break
        }
        throw domainError('ENTITY_ALREADY_EXISTS', `budget reservation ${event.reservationId} was reused with different content`, eventIndex, 'budget-reservation', event.reservationId)
      }
      if (reservationsForAttempt(state, event.taskId, event.attemptId).length > 0) {
        throw domainError('ENTITY_ALREADY_EXISTS', `attempt ${event.attemptId} already has a token budget reservation`, eventIndex, 'attempt', event.attemptId)
      }
      const decision = budgetReservationDecision(state, event.tokenReserve)
      if (decision !== 'allow') {
        throw domainError('INVALID_TRANSITION', `budget reservation ${event.reservationId} is blocked by ${decision}`, eventIndex, 'budget-reservation', event.reservationId)
      }
      requireTask(state, event.taskId, eventIndex)
      next = {
        ...state,
        budgetReservations: withEntry(state.budgetReservations, event.reservationId, {
          reservationId: event.reservationId,
          taskId: event.taskId,
          attemptId: event.attemptId,
          tokenReserve: event.tokenReserve,
          status: 'active',
        }),
        budgetReservationIds: [...state.budgetReservationIds, event.reservationId],
      }
      break
    }
    case 'yuqi/budget-reservation-settled': {
      const reservation = state.budgetReservations[event.reservationId]
      if (reservation === undefined) throw domainError('ENTITY_NOT_FOUND', `budget reservation ${event.reservationId} does not exist`, eventIndex, 'budget-reservation', event.reservationId)
      if (reservation.taskId !== event.taskId || reservation.attemptId !== event.attemptId) {
        throw domainError('REFERENCE_MISMATCH', `budget reservation ${event.reservationId} does not match its attempt`, eventIndex, 'budget-reservation', event.reservationId)
      }
      if (event.status === 'known' && event.usage === undefined) throw domainError('INVALID_EVENT', `known budget settlement ${event.reservationId} requires usage`, eventIndex, 'budget-reservation', event.reservationId)
      if (event.status !== 'known' && event.usage !== undefined) throw domainError('INVALID_EVENT', `budget settlement ${event.reservationId} cannot carry usage for ${event.status}`, eventIndex, 'budget-reservation', event.reservationId)
      if (reservation.status !== 'active') {
        if (reservation.status === event.status && sameOptionalUsage(reservation.usage, event.usage) && reservation.reason === event.reason) {
          next = state
          break
        }
        throw domainError('ENTITY_ALREADY_EXISTS', `budget reservation ${event.reservationId} was already settled`, eventIndex, 'budget-reservation', event.reservationId)
      }
      const attempt = requireAttempt(state, event.attemptId, eventIndex)
      if (attempt.taskId !== event.taskId) {
        throw domainError('REFERENCE_MISMATCH', `budget reservation ${event.reservationId} does not match attempt ${event.attemptId}`, eventIndex, 'budget-reservation', event.reservationId)
      }
      if (event.status === 'not-admitted') {
        if (attempt.agentSessionId !== undefined || (attempt.status !== 'dispatching' && attempt.status !== 'unknown')) {
          throw domainError('INVALID_TRANSITION', `budget reservation ${event.reservationId} can be released as not-admitted only before child admission`, eventIndex, 'budget-reservation', event.reservationId)
        }
      } else if (event.status === 'unknown') {
        const proof = Object.values(state.attemptResolutionProofs).find(candidate => candidate.taskId === event.taskId
          && candidate.attemptId === event.attemptId && candidate.observationState !== 'not-admitted')
        const normalTerminal = attempt.agentSessionId !== undefined
          && ['settled', 'failed', 'cancelled'].includes(attempt.status)
          && attempt.evidence !== undefined
        if (proof === undefined && !normalTerminal) {
          throw domainError('INVALID_TRANSITION', `unknown budget settlement ${event.reservationId} requires terminal attempt evidence or a host-derived resolution proof`, eventIndex, 'budget-reservation', event.reservationId)
        }
      } else {
        if (attempt.agentSessionId === undefined || !['settled', 'failed', 'cancelled'].includes(attempt.status) || attempt.evidence === undefined) {
          throw domainError('INVALID_TRANSITION', `budget reservation ${event.reservationId} requires terminal attempt evidence before settlement`, eventIndex, 'budget-reservation', event.reservationId)
        }
        if (event.status === 'known') {
          if (attempt.evidence.usage === undefined) {
            throw domainError('INVALID_EVENT', `known budget settlement ${event.reservationId} requires usage in terminal attempt evidence`, eventIndex, 'budget-reservation', event.reservationId)
          }
          if (totalAttemptTokens(attempt.evidence.usage) !== event.usage!.totalTokens) {
            throw domainError('INVALID_EVENT', `known budget settlement ${event.reservationId} does not match attempt usage`, eventIndex, 'budget-reservation', event.reservationId)
          }
        }
      }
      next = {
        ...state,
        budgetReservations: withEntry(state.budgetReservations, event.reservationId, {
          ...reservation,
          status: event.status,
          ...(event.usage === undefined ? {} : { usage: { ...event.usage } }),
          ...(event.reason === undefined ? {} : { reason: event.reason }),
        }),
      }
      break
    }
    case 'yuqi/workspace-provisioning-started': {
      if (state.workspace !== undefined) throw domainError('ENTITY_ALREADY_EXISTS', 'Team workspace provisioning can only start once', eventIndex, 'workspace', event.workspace.workspaceId)
      next = { ...state, workspace: event.workspace }
      break
    }
    case 'yuqi/workspace-provisioned': {
      const workspace = requireWorkspace(state, event.workspaceId, eventIndex)
      if (workspace.status !== 'provisioning') throw domainError('INVALID_TRANSITION', `workspace ${event.workspaceId} cannot become ready from ${workspace.status}`, eventIndex, 'workspace', event.workspaceId)
      next = { ...state, workspace: { ...workspace, status: 'ready' } }
      break
    }
    case 'yuqi/workspace-reconciliation-required': {
      const workspace = requireWorkspace(state, event.workspaceId, eventIndex)
      if (workspace.status === 'needs_reconciliation') throw domainError('INVALID_TRANSITION', `workspace ${event.workspaceId} already requires reconciliation`, eventIndex, 'workspace', event.workspaceId)
      next = { ...state, workspace: { ...workspace, status: 'needs_reconciliation' } }
      break
    }
    case 'yuqi/workspace-recovery-verified': {
      const workspace = requireWorkspace(state, event.workspace.workspaceId, eventIndex)
      if (workspace.status !== 'needs_reconciliation') {
        throw domainError('INVALID_TRANSITION', `workspace ${workspace.workspaceId} does not require recovery verification`, eventIndex, 'workspace', workspace.workspaceId)
      }
      if (!workspaceIdentityMatches(workspace, event.workspace)) {
        throw domainError('REFERENCE_MISMATCH', `workspace recovery verification does not match durable identity`, eventIndex, 'workspace', workspace.workspaceId)
      }
      next = { ...state, workspace: event.workspace }
      break
    }
    case 'yuqi/file-lease-acquired': {
      const workspace = state.workspace
      if (workspace?.status !== 'ready') throw domainError('INVALID_TRANSITION', 'file leases require a ready Team workspace', eventIndex, 'workspace', workspace?.workspaceId)
      const lease = event.lease
      if (hasOwn(state.fileLeases, lease.leaseId)) throw domainError('ENTITY_ALREADY_EXISTS', `file lease ${lease.leaseId} already exists`, eventIndex, 'file-lease', lease.leaseId)
      const task = requireTask(state, lease.taskId, eventIndex)
      if (lease.attemptId !== undefined) {
        if (Object.values(state.fileLeases).some(existing => existing.status === 'active' && existing.attemptId === lease.attemptId)) {
          throw domainError('ENTITY_ALREADY_EXISTS', `attempt ${lease.attemptId} already has an active file lease`, eventIndex, 'file-lease', lease.leaseId)
        }
      }
      const expectedMode = task.contract.authorityMode === 'read-only' ? 'read' : 'write'
      if (lease.mode !== expectedMode || !sameStrings(lease.fileScope, task.contract.fileScope)) {
        throw domainError('REFERENCE_MISMATCH', `file lease ${lease.leaseId} does not match task ${lease.taskId}`, eventIndex, 'file-lease', lease.leaseId)
      }
      const conflict = state.fileLeaseIds.some((leaseId) => {
        const active = state.fileLeases[leaseId]!
        return active.status === 'active'
          && !(active.mode === 'read' && lease.mode === 'read')
          && fileScopeSetsConflict(active.fileScope, lease.fileScope)
      })
      if (conflict) throw domainError('INVALID_TRANSITION', `file lease ${lease.leaseId} conflicts with active ownership`, eventIndex, 'file-lease', lease.leaseId)
      next = {
        ...state,
        fileLeases: withEntry(state.fileLeases, lease.leaseId, lease),
        fileLeaseIds: [...state.fileLeaseIds, lease.leaseId],
      }
      break
    }
    case 'yuqi/file-lease-released': {
      const lease = requireFileLease(state, event.leaseId, eventIndex)
      if (lease.taskId !== event.taskId) throw domainError('REFERENCE_MISMATCH', `file lease ${event.leaseId} belongs to another task`, eventIndex, 'file-lease', event.leaseId)
      if (lease.attemptId !== event.attemptId) throw domainError('REFERENCE_MISMATCH', `file lease ${event.leaseId} is not bound to the supplied attempt`, eventIndex, 'file-lease', event.leaseId)
      if (lease.status !== 'active') throw domainError('INVALID_TRANSITION', `file lease ${event.leaseId} is already released`, eventIndex, 'file-lease', event.leaseId)
      next = { ...state, fileLeases: withEntry(state.fileLeases, event.leaseId, { ...lease, status: 'released' }) }
      break
    }
  }

  return markApplied(next, event)
}

function validateReviewRequestRound(
  state: TeamProjection,
  trigger: ReviewTrigger,
  round: number,
  eventIndex: number,
  reviewId: string,
): void {
  const maxRounds = state.team.reviewPolicy?.maxReworkRounds ?? DEFAULT_MAX_REWORK_ROUNDS
  if (round > maxRounds) {
    throw domainError('INVALID_EVENT', `review ${reviewId} exceeds the Team rework budget`, eventIndex, 'event', reviewId)
  }
  if (trigger !== 'rework-verification') {
    if (round !== 0) throw domainError('INVALID_EVENT', `initial review ${reviewId} must use round 0`, eventIndex, 'event', reviewId)
    return
  }
  if (round === 0) throw domainError('INVALID_EVENT', `rework verification ${reviewId} requires a positive round`, eventIndex, 'event', reviewId)
  const completedRework = state.taskIds.map(taskId => state.tasks[taskId]!).find(task =>
    task.contract.kind === 'review-rework' && task.contract.reviewRework?.round === round && task.status === 'completed')
  if (completedRework === undefined) {
    throw domainError('REFERENCE_MISMATCH', `rework verification ${reviewId} has no completed round ${round} task`, eventIndex, 'event', reviewId)
  }
}

function validateReviewCheckpointAnchor(
  state: TeamProjection,
  subject: ReviewCheckpointSubject,
  anchor: ReviewCheckpointAnchor,
  candidateEventId: TeamEventId,
  explicitAnchor: boolean,
  eventIndex: number,
  reviewId: string,
): void {
  if (explicitAnchor
    && (!hasOwn(state.appliedEventFingerprints, anchor.eventId) || !hasOwn(state.appliedEventFingerprints, candidateEventId))) {
    throw domainError('REFERENCE_MISMATCH', `review ${reviewId} checkpoint anchor is not durable`, eventIndex, 'event', reviewId)
  }
  if (subject === 'team-completion') {
    if (state.taskIds.some(taskId => state.tasks[taskId]?.status !== 'completed')) {
      throw domainError('INVALID_TRANSITION', 'team-completion review requires a fully completed task graph', eventIndex, 'team', state.team.id)
    }
    if (state.completionCandidateEventId === undefined || candidateEventId !== state.completionCandidateEventId) {
      throw domainError('REFERENCE_MISMATCH', `review ${reviewId} targets a stale completion candidate`, eventIndex, 'event', reviewId)
    }
    return
  }
  if (subject === 'team-plan') {
    if (state.taskIds.length === 0 || Object.keys(state.attempts).length > 0) {
      throw domainError('INVALID_TRANSITION', `review ${reviewId} team-plan checkpoint is outside the planning phase`, eventIndex, 'event', reviewId)
    }
    return
  }
  if (anchor.taskId === undefined || anchor.attemptId === undefined) {
    throw domainError('REFERENCE_MISMATCH', `review ${reviewId} ${subject} checkpoint requires task and attempt anchors`, eventIndex, 'event', reviewId)
  }
  const task = state.tasks[anchor.taskId]
  const attempt = state.attempts[anchor.attemptId]
  if (task === undefined || attempt?.taskId !== task.contract.taskId || !task.attemptIds.includes(attempt.id)) {
    throw domainError('REFERENCE_MISMATCH', `review ${reviewId} checkpoint does not match its task attempt`, eventIndex, 'event', reviewId)
  }
  if (subject === 'failure-escalation' && consecutiveTaskVerificationFailures(state, anchor.taskId) < 2) {
    throw domainError('INVALID_TRANSITION', `review ${reviewId} failure escalation requires two consecutive failures for one task`, eventIndex, 'event', reviewId)
  }
}

function reviewerSessionConflicts(state: TeamProjection, reviewerSessionId: string): boolean {
  return Object.values(state.attempts).some(attempt => attempt.agentSessionId === reviewerSessionId)
    || Object.values(state.verifications).some(verification => verification.verifierSessionId === reviewerSessionId)
}

function sameCheckpoint(left: ReviewView, right: ReviewView): boolean {
  return left.checkpointSubject === right.checkpointSubject
    && left.checkpointAnchor.eventId === right.checkpointAnchor.eventId
    && left.checkpointAnchor.taskId === right.checkpointAnchor.taskId
    && left.checkpointAnchor.attemptId === right.checkpointAnchor.attemptId
}

function repeatedCheckpointFinding(
  state: TeamProjection,
  current: ReviewView,
  fingerprints: readonly string[],
): boolean {
  const previous = new Set(state.reviewIds
    .map(reviewId => state.reviews[reviewId]!)
    .filter(review => review.id !== current.id && sameCheckpoint(review, current))
    .flatMap(review => review.findingFingerprints.length > 0
      ? review.findingFingerprints
      : review.result?.findings.map(reviewFindingFingerprint) ?? []))
  return fingerprints.some(fingerprintValue => previous.has(fingerprintValue))
}

/** Automatic corrections already consumed across verification retries and reviewer rework. */
export function teamAutomaticReworkCount(projection: TeamProjection): number {
  const reviewReworks = projection.taskIds.map(taskId => projection.tasks[taskId]!).filter(task => {
    if (task.contract.kind !== 'review-rework' || task.contract.reviewRework === undefined) return false
    return projection.reviews[task.contract.reviewRework.sourceReviewId]?.userDecision?.decision !== 'authorize_final_rework'
  }).length
  const verificationRetries = Object.keys(projection.taskRetryOperations)
    .filter(operationId => operationId.startsWith('automatic-retry:')).length
  return reviewReworks + verificationRetries
}

export function checkpointAutomaticReworkCount(projection: TeamProjection, checkpoint: ReviewView): number {
  const reviewReworks = projection.taskIds.map(taskId => projection.tasks[taskId]!).filter(task => {
    const sourceReviewId = task.contract.reviewRework?.sourceReviewId
    if (task.contract.kind !== 'review-rework' || sourceReviewId === undefined) return false
    const source = projection.reviews[sourceReviewId]
    return source !== undefined && sameCheckpoint(source, checkpoint)
      && source.userDecision?.decision !== 'authorize_final_rework'
  }).length
  if (checkpoint.checkpointSubject !== 'task-attempt' && checkpoint.checkpointSubject !== 'failure-escalation') return reviewReworks
  const taskId = checkpoint.checkpointAnchor.taskId
  const verificationRetries = Object.entries(projection.taskRetryOperations)
    .filter(([operationId, retry]) => operationId.startsWith('automatic-retry:') && retry.taskId === taskId).length
  return reviewReworks + verificationRetries
}

/** Legacy review requests predate durable automatic-rework budget snapshots. */
export function reviewAutomaticReworkBudget(
  projection: TeamProjection,
  checkpoint: ReviewView,
): ReviewAutomaticReworkBudget {
  return checkpoint.automaticReworkBudget ?? {
    checkpointLimit: projection.team.reviewPolicy?.maxReworkRounds ?? DEFAULT_MAX_REWORK_ROUNDS,
    teamLimit: DEFAULT_MAX_TEAM_AUTOMATIC_REWORKS,
  }
}

export function reviewAutomaticReworkBudgetExhausted(projection: TeamProjection, checkpoint: ReviewView): boolean {
  const budget = reviewAutomaticReworkBudget(projection, checkpoint)
  return checkpoint.round >= budget.checkpointLimit
    || checkpointAutomaticReworkCount(projection, checkpoint) >= budget.checkpointLimit
    || teamAutomaticReworkCount(projection) >= budget.teamLimit
}

/** Current trailing failed-verdict streak for one task; other tasks never contribute. */
export function consecutiveTaskVerificationFailures(projection: TeamProjection, taskId: string): number {
  const verdicts = Object.values(projection.verificationVerdictOperations).filter(verdict => String(verdict.taskId) === taskId)
  let count = 0
  for (let index = verdicts.length - 1; index >= 0; index -= 1) {
    if (verdicts[index]!.disposition !== 'failed') break
    count += 1
  }
  return count
}

function totalAttemptTokens(usage: NonNullable<AttemptEvidenceView['usage']>): number {
  return usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

function usageIsMonotonic(previous: ChildUsageView, next: ChildUsageView): boolean {
  return next.uncachedInputTokens >= previous.uncachedInputTokens
    && next.outputTokens >= previous.outputTokens
    && next.cacheReadTokens >= previous.cacheReadTokens
    && next.cacheWriteTokens >= previous.cacheWriteTokens
}

function isTerminalTeamStatus(status: TeamStatus): boolean {
  return status === 'cancelled' || status === 'completed' || status === 'failed'
}

function isAttemptEndStatus(status: AttemptStatus): boolean {
  return status === 'settled' || status === 'failed' || status === 'cancelled'
}

function assertChildSessionUnbound(state: TeamProjection, attemptId: AttemptId, childSessionId: string, eventIndex: number): void {
  if (Object.values(state.attempts).some(other => other.id !== attemptId && other.agentSessionId === childSessionId)) {
    throw domainError('ENTITY_ALREADY_EXISTS', `child ${childSessionId} is already bound to another attempt`, eventIndex, 'attempt', attemptId)
  }
}

type VerdictRecord = VerificationVerdictView & {
  readonly verificationId?: VerificationId
  readonly taskId?: TaskId
  readonly attemptId?: AttemptId
}

function verdictComparable(value: VerdictRecord): string {
  return JSON.stringify({
    operationId: value.operationId,
    verificationId: value.verificationId,
    taskId: value.taskId,
    attemptId: value.attemptId,
    disposition: value.disposition,
    requirements: value.requirements,
    evidence: value.evidence,
    reasons: value.reasons,
    collectionStatus: value.collectionStatus,
    reworkBudget: value.reworkBudget,
    rework: value.rework,
  })
}

function expectedVerdict(
  requirements: readonly EvidenceRequirement[],
  evidence: readonly StructuredEvidence[],
  collectionStatus: EvidenceCollectionStatus = 'collected',
): { readonly disposition: 'passed' | 'failed' | 'inconclusive'; readonly reasons: readonly EvidenceReason[] } {
  const checks = collectionStatus === 'collected' ? requirements.map(requirement => {
    const matches = evidence.filter(candidate => candidate.checkId === requirement.checkId)
    if (matches.length === 0) return { outcome: 'inconclusive' as const, reasons: [{ checkId: requirement.checkId, code: 'missing-evidence' as const, detail: 'No structured host evidence was supplied' }] }
    if (matches.length > 1) return { outcome: 'inconclusive' as const, reasons: [{ checkId: requirement.checkId, code: 'invalid-evidence' as const, detail: 'More than one evidence record was supplied for the same check' }] }
    const assessment = assessEvidenceRecord(requirement, matches[0]!)
    return { outcome: assessment.outcome, reasons: assessment.reasons }
  }) : requirements.map(requirement => ({
    outcome: 'inconclusive' as const,
    reasons: [{ checkId: requirement.checkId, code: collectionReasonCode(collectionStatus), detail: `Host evidence collector status: ${collectionStatus}` }],
  }))
  const required = collectionStatus === 'collected'
    ? checks.filter((_, index) => isEvidenceRequirementRequired(requirements[index]!, evidence))
    : checks
  const disposition = required.some(check => check.outcome === 'failed')
    ? 'failed'
    : required.some(check => check.outcome === 'inconclusive')
      ? 'inconclusive'
      : 'passed'
  return { disposition, reasons: checks.flatMap(check => check.reasons) }
}

function collectionReasonCode(status: Exclude<EvidenceCollectionStatus, 'collected'>): 'collector-unavailable' | 'collector-failed' | 'collector-aborted' {
  return status === 'unavailable' ? 'collector-unavailable' : status === 'failed' ? 'collector-failed' : 'collector-aborted'
}

function sameReasons(left: readonly EvidenceReason[], right: readonly EvidenceReason[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validateRework(
  disposition: 'passed' | 'failed' | 'inconclusive',
  rework: { readonly action: 'retry' | 'stop'; readonly currentAttempt: number; readonly maxAttempts: number; readonly nextAttempt?: number | undefined } | undefined,
  eventIndex: number,
  verificationId: VerificationId,
): void {
  if (rework === undefined) {
    if (disposition === 'failed') throw domainError('INVALID_EVENT', `failed verification ${verificationId} must carry bounded rework facts`, eventIndex, 'verification', verificationId)
    return
  }
  if (disposition !== 'failed' || rework.currentAttempt > rework.maxAttempts || rework.maxAttempts > 5
    || (rework.action === 'retry' && rework.nextAttempt !== rework.currentAttempt + 1)
    || (rework.action === 'stop' && rework.nextAttempt !== undefined)) {
    throw domainError('INVALID_EVENT', `verification ${verificationId} carries invalid rework facts`, eventIndex, 'verification', verificationId)
  }
}

function validateReworkBudget(
  budget: { readonly currentAttempt: number; readonly maxAttempts: number } | undefined,
  disposition: 'passed' | 'failed' | 'inconclusive',
  eventIndex: number,
  verificationId: VerificationId,
): void {
  if (budget === undefined) return
  if (budget.currentAttempt > budget.maxAttempts || budget.maxAttempts > 5 || disposition === 'failed' && budget.currentAttempt < 1) {
    throw domainError('INVALID_EVENT', `verification ${verificationId} carries invalid rework budget`, eventIndex, 'verification', verificationId)
  }
}

function sameRuntimeObservations(
  left: readonly RuntimeObservationComparable[],
  right: readonly RuntimeObservationComparable[],
): boolean {
  return left.length === right.length && left.every((observation, index) => {
    const candidate = right[index]
    return candidate !== undefined
      && observation.taskId === candidate.taskId
      && observation.attemptId === candidate.attemptId
      && observation.childSessionId === candidate.childSessionId
      && observation.state === candidate.state
      && observation.reason === candidate.reason
  })
}

interface RuntimeObservationComparable {
  readonly taskId: TaskId
  readonly attemptId: AttemptId
  readonly childSessionId?: string | undefined
  readonly state: AttemptRuntimeObservationView['state']
  readonly reason?: string | undefined
}

/**
 * Parse and replay a complete durable event sequence.
 * @param inputs - Unknown values in persistence order.
 * @returns The rebuilt projection.
 */
export function replayTeamEvents(inputs: readonly unknown[]): TeamProjection {
  let state: TeamProjection | undefined
  for (let index = 0; index < inputs.length; index += 1) {
    state = applyTeamEvent(state, parseTeamEvent(inputs[index], index), index)
  }
  if (state === undefined) throw domainError('TEAM_NOT_CREATED', 'Team event stream is empty', -1, 'team')
  const revisionBatchIssue = taskRevisionBatchIssue(state)
  if (revisionBatchIssue !== undefined) throw domainError('INVALID_TASK_CONTRACT', revisionBatchIssue, inputs.length - 1, 'team', state.team.id)
  return state
}
