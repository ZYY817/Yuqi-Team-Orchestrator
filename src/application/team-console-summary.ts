/** Read-only, UI-ready summary derived solely from the durable Team projection. */

import { checkpointAutomaticReworkCount, teamAutomaticReworkCount, taskHasSemanticBlock, type AttemptView, type TeamProjection } from '../domain/projection.ts'
import type { TeamConsoleDuration, TeamConsoleSummary, TeamConsoleTask, TeamConsoleTaskUsage, TeamConsoleUsage, TeamConsoleTimelineEntry } from '../domain/team-console-contract.ts'
import type { ProjectSummary } from './project-summary.ts'
import { projectSummarySchema } from './project-summary.ts'
import type { ReviewResult } from './reviewer.ts'
import { reviewResultSchema } from './reviewer.ts'
import { z } from 'zod'
import { TEAM_AUTHORITY_MODES } from '../domain/team-settings-contract.ts'
import { reviewPolicySchema } from '../domain/review-policy.ts'
import { modelRequestForTask } from '../domain/task-contract.ts'
import { modelCatalogFactSchema, taskModelRequestSchema, type TaskModelRequest } from '../domain/model-route.ts'
import { taskOutcomeEvidenceSchema } from '../domain/task-outcome.ts'
import { manualOwnershipSchema, manualTakeoverIssue } from '../domain/manual-ownership.ts'
import { classifyTeamResume } from './schedule-team.ts'

export type { TeamConsoleDuration, TeamConsoleKnownUsage, TeamConsoleSummary, TeamConsoleTask, TeamConsoleTaskUsage, TeamConsoleUsage } from '../domain/team-console-contract.ts'

export interface TeamConsoleExtras {
  readonly controllerSessionId?: string
  readonly projectSummary?: ProjectSummary
  readonly review?: ReviewResult
}

const taskStatusSchema = z.enum(['pending', 'ready', 'running', 'verifying', 'blocked', 'completed', 'failed', 'cancelled'])
const attemptStatusSchema = z.enum(['dispatching', 'running', 'settled', 'verification_failed', 'completed', 'failed', 'cancelled', 'unknown'])
const teamStatusSchema = z.enum(['draft', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'completed', 'failed', 'needs_reconciliation'])
const durationSchema: z.ZodType<TeamConsoleDuration> = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('running'),
    startedAt: z.string().min(1),
    elapsedMs: z.number().int().nonnegative().optional(),
    activeStartedAts: z.array(z.string().min(1)).min(1).optional(),
  }).strict(),
  z.object({ state: z.literal('known'), elapsedMs: z.number().int().nonnegative() }).strict(),
  z.object({ state: z.literal('unavailable') }).strict(),
])

/** Wire validation for the Host→Client Team summary projection. */
export const teamConsoleSummarySchema: z.ZodType<TeamConsoleSummary> = z.object({
  controllerSessionId: z.string().min(1).optional(),
  team: z.object({
    id: z.string().min(1),
    title: z.string(),
    objective: z.string(),
    status: teamStatusSchema,
    workspaceMode: z.enum(['direct', 'git-worktree']).optional(),
    continuedFrom: z.object({ sourceTeamId: z.string().min(1), sourceControllerSessionId: z.string().min(1) }).strict().optional(),
    completedTaskCount: z.number().int().nonnegative(),
    runningTaskCount: z.number().int().nonnegative(),
    waitingTaskCount: z.number().int().nonnegative(),
    attentionTaskCount: z.number().int().nonnegative(),
    userDecisionCount: z.number().int().nonnegative(),
    controllerActionCount: z.number().int().nonnegative(),
    resumeDisposition: z.enum(['runnable', 'completion-ready', 'decision-required', 'requires-reconciliation', 'inactive']).optional(),
    planConfirmationPending: z.boolean().optional(),
    cancellationRequested: z.boolean().optional(),
    reviewPolicy: reviewPolicySchema.optional(),
    duration: durationSchema,
  }).strict(),
  tasks: z.array(z.object({
    manualControl: z.object({
      teamStatus: z.enum(['draft', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'completed', 'failed', 'needs_reconciliation']),
      canAcquire: z.boolean(), workspacePath: z.string().optional(), ownership: manualOwnershipSchema.optional(),
    }).strict().optional(),
    taskOutcome: taskOutcomeEvidenceSchema.optional(),
    taskId: z.string(),
    revisionSource: z.object({ taskId: z.string().min(1), rootTaskId: z.string().min(1).optional(), operationId: z.string().min(1) }).strict().optional(),
    goal: z.string(),
    status: taskStatusSchema,
    modelRole: z.string(),
    model: z.string(),
    modelRequest: taskModelRequestSchema.optional(),
    route: z.object({
      providerId: z.string().min(1),
      modelId: z.string().min(1),
      basis: z.enum(['task-exact', 'team-fixed', 'automatic', 'controller-inherit', 'user-fixed']).optional(),
      requestedTier: z.enum(['quick', 'standard', 'critical']).optional(),
      fallbackReason: z.enum(['automatic-candidates-exhausted', 'task-default-controller-inherit', 'team-inherit-controller']).optional(),
      catalogEvidence: z.array(modelCatalogFactSchema).optional(),
    }).strict().optional(),
    routeHistory: z.array(z.object({
      attemptId: z.string().min(1),
      attemptOrdinal: z.number().int().positive(),
      providerId: z.string().min(1),
      modelId: z.string().min(1),
      basis: z.enum(['task-exact', 'team-fixed', 'automatic', 'controller-inherit', 'user-fixed']).optional(),
      requestedTier: z.enum(['quick', 'standard', 'critical']).optional(),
      fallbackReason: z.enum(['automatic-candidates-exhausted', 'task-default-controller-inherit', 'team-inherit-controller']).optional(),
      unavailableCandidates: z.array(z.string().min(1)).optional(),
    }).strict()).optional(),
    authorityMode: z.enum(TEAM_AUTHORITY_MODES),
    dependencyCount: z.number().int().nonnegative(),
    dependencies: z.array(z.object({ taskId: z.string(), goal: z.string(), index: z.number().int().positive().optional() }).strict()).optional(),
    fileScope: z.array(z.string()),
    reportedChangedFiles: z.array(z.string()).optional(),
    attemptCount: z.number().int().nonnegative(),
    attemptId: z.string().optional(),
    attemptOrdinal: z.number().int().positive().optional(),
    attemptStatus: attemptStatusSchema.optional(),
    childSessionId: z.string().optional(),
    evidenceRecorded: z.boolean(),
    duration: durationSchema,
    usage: z.discriminatedUnion('state', [
      z.object({ state: z.literal('pending'), label: z.literal('Token：暂无数据') }).strict(),
      z.object({ state: z.literal('unavailable'), label: z.literal('Token：提供方未上报') }).strict(),
      z.object({
        state: z.literal('live'), uncachedInputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(), cacheReadTokens: z.number().int().nonnegative(),
        cacheWriteTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative(), label: z.string(),
      }).strict(),
      z.object({
        state: z.literal('known'), uncachedInputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(), cacheReadTokens: z.number().int().nonnegative(),
        cacheWriteTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative(), label: z.string(),
      }).strict(),
    ]),
    verificationStatus: z.enum(['pending', 'running', 'passed', 'failed']).optional(),
    durablyBlocked: z.boolean().optional(),
    nextAction: z.string(),
  }).strict()),
  attention: z.array(z.object({
    taskOutcome: taskOutcomeEvidenceSchema.optional(),
    owner: z.enum(['user', 'controller']),
    code: z.enum(['attempt-outcome-unknown', 'verification-inconclusive', 'task-failed', 'task-blocked', 'dependency-blocked']),
    taskId: z.string().min(1),
    message: z.string().min(1),
  }).strict()),
  usage: z.discriminatedUnion('state', [
    z.object({ state: z.literal('pending'), scope: z.literal('受管子 Agent'), label: z.literal('用量：暂无数据') }).strict(),
    z.object({ state: z.literal('unavailable'), scope: z.literal('受管子 Agent'), label: z.literal('用量：提供方未上报') }).strict(),
    z.object({
      state: z.literal('known'), scope: z.literal('受管子 Agent'), uncachedInputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(), cacheReadTokens: z.number().int().nonnegative(),
      cacheWriteTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative(), label: z.string(),
    }).strict(),
    z.object({
      state: z.literal('partial'), scope: z.literal('受管子 Agent'), uncachedInputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(), cacheReadTokens: z.number().int().nonnegative(),
      cacheWriteTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative(), label: z.string(),
      missingAttemptCount: z.number().int().nonnegative(), activeAttemptCount: z.number().int().nonnegative(),
    }).strict(),
  ]),
  projectSummary: projectSummarySchema.optional(),
  timeline: z.array(z.object({
    id: z.string().min(1), taskId: z.string().min(1), attemptId: z.string().min(1),
    at: z.string().min(1), kind: z.enum(['attempt-started', 'attempt-ended']),
    status: z.string().min(1), model: z.string().min(1),
  }).strict()).optional(),
  review: reviewResultSchema.extend({
    candidateEventId: z.string().optional(), round: z.number().int().nonnegative().optional(),
    status: z.enum(['requested', 'completed', 'awaiting_user']).optional(),
    userDecision: z.enum(['retry_review', 'authorize_final_rework', 'waive', 'fail', 'cancel']).optional(),
    waiveReason: z.string().optional(),
  }).optional(),
  reviewCheckpoint: z.object({
    reviewId: z.string().min(1),
    trigger: z.enum(['plan-confirmation', 'public-contract-change', 'pre-completion', 'consecutive-failure', 'user-request', 'quality-gate', 'rework-verification']),
    subject: z.enum(['team-plan', 'task-attempt', 'team-completion', 'failure-escalation']),
    phase: z.enum(['reviewing', 'reworking', 'awaiting-controller', 'satisfied']),
    candidateEventId: z.string().min(1),
    round: z.number().int().nonnegative(),
    independence: z.enum(['model-diverse', 'context-only']),
    nextOwner: z.enum(['reviewer', 'controller', 'user', 'none']),
    automaticRework: z.object({
      checkpointUsed: z.number().int().nonnegative(), checkpointLimit: z.number().int().nonnegative(), checkpointRemaining: z.number().int().nonnegative(),
      teamUsed: z.number().int().nonnegative(), teamLimit: z.number().int().nonnegative(), teamRemaining: z.number().int().nonnegative(),
      history: z.array(z.object({
        taskId: z.string().min(1), sourceReviewId: z.string().min(1), round: z.number().int().positive(), status: taskStatusSchema,
      }).strict()),
    }).strict(),
  }).strict().optional(),
}).strict()

/**
 * Builds one stable console view without retaining state or inferring runtime facts.
 * The client must refresh from a new Projection after every command confirmation.
 */
export function summarizeTeamForConsole(projection: TeamProjection, extras: TeamConsoleExtras = {}): TeamConsoleSummary {
  const tasks = projection.taskIds.map(taskId => {
    const task = projection.tasks[taskId]!
    const latestAttemptId = task.attemptIds.at(-1)
    const latestAttempt = latestAttemptId === undefined ? undefined : projection.attempts[latestAttemptId]
    const latestVerificationId = task.verificationIds.at(-1)
    const latestVerification = latestVerificationId === undefined ? undefined : projection.verifications[latestVerificationId]
    const latestVerdict = latestVerificationId === undefined ? undefined : Object.values(projection.verificationVerdictOperations)
      .find(verdict => verdict.verificationId === latestVerificationId)
    const routeHistory = task.attemptIds.flatMap(attemptId => {
      const attempt = projection.attempts[attemptId]
      if (attempt === undefined) return []
      const unavailableCandidates = [...new Set((attempt.catalogEvidence ?? [])
        .filter(fact => !fact.metadataResolved || !fact.routable)
        .map(fact => `${fact.model.modelProvider}/${fact.model.modelId}`))]
      return [{
        attemptId: String(attempt.id),
        attemptOrdinal: attempt.ordinal,
        providerId: attempt.modelProvider,
        modelId: attempt.modelId,
        ...(attempt.routeBasis === undefined ? {} : { basis: attempt.routeBasis }),
        ...(attempt.requestedTier === undefined ? {} : { requestedTier: attempt.requestedTier }),
        ...(attempt.fallbackReason === undefined ? {} : { fallbackReason: attempt.fallbackReason }),
        ...(unavailableCandidates.length === 0 ? {} : { unavailableCandidates: Object.freeze(unavailableCandidates) }),
      }]
    }).map(route => Object.freeze(route))
    return Object.freeze({
      taskId,
      ...(task.contract.userRevision === undefined ? {} : { revisionSource: {
        taskId: task.contract.userRevision.sourceTaskId,
        operationId: task.contract.userRevision.operationId,
        ...(task.contract.userRevision.revalidation === undefined ? {} : { rootTaskId: task.contract.userRevision.revalidation.rootSourceTaskId }),
      } }),
      manualControl: {
        teamStatus: projection.team.status,
        canAcquire: manualTakeoverIssue(projection, taskId) === undefined,
        ...(projection.workspace === undefined ? {} : { workspacePath: projection.workspace.worktreePath }),
        ...(projection.team.manualOwnership === undefined ? {} : { ownership: projection.team.manualOwnership }),
      },
      goal: task.contract.goal,
      status: task.status,
      modelRole: task.contract.modelRole,
      model: latestAttempt === undefined || task.status === 'pending' || task.status === 'ready'
        ? describeModelRequest(modelRequestForTask(task.contract))
        : `${latestAttempt.modelProvider}/${latestAttempt.modelId}`,
      modelRequest: modelRequestForTask(task.contract),
      ...(latestAttempt === undefined ? {} : {
        route: {
          providerId: latestAttempt.modelProvider,
          modelId: latestAttempt.modelId,
          ...(latestAttempt.routeBasis === undefined ? {} : { basis: latestAttempt.routeBasis }),
          ...(latestAttempt.requestedTier === undefined ? {} : { requestedTier: latestAttempt.requestedTier }),
          ...(latestAttempt.fallbackReason === undefined ? {} : { fallbackReason: latestAttempt.fallbackReason }),
          ...(latestAttempt.catalogEvidence === undefined ? {} : { catalogEvidence: latestAttempt.catalogEvidence }),
        },
      }),
      ...(routeHistory.length === 0 ? {} : { routeHistory: Object.freeze(routeHistory) }),
      authorityMode: task.contract.authorityMode,
      dependencyCount: task.contract.dependencies.length,
      dependencies: task.contract.dependencies.map(dependencyId => ({
        taskId: String(dependencyId),
        goal: projection.tasks[String(dependencyId)]?.contract.goal ?? String(dependencyId),
        index: projection.taskIds.findIndex(taskId => taskId === dependencyId) + 1,
      })),
      fileScope: task.contract.fileScope,
      ...(task.status === 'blocked' && !taskHasSemanticBlock(projection, task)
        && task.contract.dependencies.some(dependencyId => ['failed', 'cancelled', 'blocked'].includes(projection.tasks[String(dependencyId)]?.status ?? ''))
        ? { durablyBlocked: true } : {}),
      ...(taskHasSemanticBlock(projection, task) ? { taskOutcome: latestAttempt?.evidence?.taskOutcome ?? { status: 'missing' as const } } : {}),
      ...(latestAttempt?.evidence?.reportedChangedFiles === undefined ? {} : { reportedChangedFiles: latestAttempt.evidence.reportedChangedFiles }),
      attemptCount: task.attemptIds.length,
      ...(latestAttempt === undefined ? {} : { attemptId: latestAttempt.id, attemptOrdinal: latestAttempt.ordinal }),
      ...(latestAttempt === undefined ? {} : { attemptStatus: latestAttempt.status }),
      ...(latestAttempt?.agentSessionId === undefined ? {} : { childSessionId: latestAttempt.agentSessionId }),
      evidenceRecorded: latestAttempt?.evidence !== undefined,
      usage: summarizeTaskUsage(latestAttempt),
      duration: summarizeAttemptDuration(latestAttempt),
      ...(latestVerification === undefined ? {} : { verificationStatus: latestVerification.status }),
      nextAction: taskHasSemanticBlock(projection, task)
        ? blockedOutcomeMessage(latestAttempt, projection.team.locale === 'en', projection.team.status)
        : nextAction(task.status, latestAttempt?.status, latestVerdict?.disposition === 'inconclusive', projection.team.status,
            task.contract.dependencies.some(dependencyId => ['failed', 'cancelled', 'blocked'].includes(projection.tasks[String(dependencyId)]?.status ?? ''))),
    } satisfies TeamConsoleTask)
  })
  const completedTaskCount = tasks.filter(task => task.status === 'completed').length
  const runningTaskCount = tasks.filter(task => task.status === 'running' || task.status === 'verifying').length
  const waitingTaskCount = tasks.filter(task => task.status === 'pending' || task.status === 'ready').length
  const latestReviewId = projection.reviewIds.at(-1)
  const latestReview = latestReviewId === undefined ? undefined : projection.reviews[latestReviewId]
  const teamReworkUsed = teamAutomaticReworkCount(projection)
  const checkpointReworkUsed = latestReview === undefined ? 0 : checkpointAutomaticReworkCount(projection, latestReview)
  const reworkHistory = projection.taskIds.flatMap(taskId => {
    const task = projection.tasks[taskId]!
    const source = task.contract.reviewRework
    return task.contract.kind !== 'review-rework' || source === undefined ? [] : [{
      taskId: String(taskId), sourceReviewId: source.sourceReviewId, round: source.round, status: task.status,
    }]
  })
  const terminal = ['completed', 'failed', 'cancelled'].includes(projection.team.status)
  const reviewAttention = latestReview?.status === 'awaiting_user' && latestReview.userDecision === undefined
    ? [{ owner: 'user' as const, code: 'verification-inconclusive' as const, taskId: String(projection.team.id), message: projection.team.locale === 'en'
        ? 'The review needs a decision in the main conversation. See the review card for the reason and available actions.'
        : '审查需要你在主对话作出决定。具体原因及可选操作见审查卡片。' }]
    : []
  // Historical failures remain visible in task details, not as live user work.
  const attention = terminal ? [] : [...tasks.flatMap(task => attentionForTask(task, taskHasSemanticBlock(projection, projection.tasks[task.taskId]!), projection.team.status)), ...reviewAttention]
  const userDecisionCount = attention.filter(item => item.owner === 'user').length
  const controllerActionCount = attention.filter(item => item.owner === 'controller').length
  const attentionTaskCount = new Set(attention.map(item => item.taskId)).size
  const planConfirmationOperation = projection.controlOperations[`plan-review:${projection.team.id}`]
  const planConfirmationPending = projection.team.status === 'paused'
    && planConfirmationOperation?.action === 'pause'
    && projection.latestTeamControlOperationId === planConfirmationOperation.id
    && Object.keys(projection.attempts).length === 0
    && latestReview === undefined
    && Object.keys(projection.recoveryClearOperations).length === 0
  return Object.freeze({
    ...(extras.controllerSessionId === undefined ? {} : { controllerSessionId: extras.controllerSessionId }),
    team: Object.freeze({
      id: projection.team.id,
      ...(projection.team.continuedFrom === undefined ? {} : { continuedFrom: {
        sourceTeamId: projection.team.continuedFrom.sourceTeamId,
        sourceControllerSessionId: projection.team.continuedFrom.sourceControllerSessionId,
      } }),
      title: projection.team.title,
      objective: projection.team.objective,
      status: projection.team.status,
      ...(projection.workspace === undefined ? {} : {
        workspaceMode: isDirectProject(projection.workspace.project) ? 'direct' as const : 'git-worktree' as const,
      }),
      completedTaskCount,
      runningTaskCount,
      waitingTaskCount,
      attentionTaskCount,
      userDecisionCount,
      controllerActionCount,
      resumeDisposition: classifyTeamResume(projection),
      ...(planConfirmationPending ? { planConfirmationPending: true } : {}),
      ...(projection.latestTeamControlOperationId !== undefined
        && projection.controlOperations[projection.latestTeamControlOperationId]?.action === 'cancel'
        && !terminal ? { cancellationRequested: true } : {}),
      ...(projection.team.reviewPolicy === undefined ? {} : { reviewPolicy: projection.team.reviewPolicy }),
      duration: summarizeTeamDuration(projection),
    }),
    tasks: Object.freeze(tasks),
    timeline: summarizeTimeline(projection),
    attention: Object.freeze(attention),
    usage: summarizeUsage(projection),
    ...(extras.projectSummary === undefined ? {} : { projectSummary: extras.projectSummary }),
    ...(latestReview?.result === undefined
      ? (extras.review === undefined ? {} : { review: extras.review })
      : { review: {
          reviewId: latestReview.id, trigger: latestReview.trigger, ...latestReview.result,
          candidateEventId: latestReview.candidateEventId, round: latestReview.round, status: latestReview.status,
          ...(latestReview.userDecision === undefined ? {} : {
            userDecision: latestReview.userDecision.decision,
            ...(latestReview.userDecision.decision === 'waive' && latestReview.userDecision.reason !== undefined
              ? { waiveReason: latestReview.userDecision.reason } : {}),
          }),
        } }),
    ...(latestReview === undefined ? {} : { reviewCheckpoint: {
      reviewId: latestReview.id,
      trigger: latestReview.trigger,
      subject: latestReview.checkpointSubject,
      phase: latestReview.phase,
      candidateEventId: String(latestReview.candidateEventId),
      round: latestReview.round,
      independence: latestReview.reviewerIndependence ?? 'context-only',
      nextOwner: terminal ? 'none' : reviewNextOwner(latestReview),
      automaticRework: {
        checkpointUsed: checkpointReworkUsed,
        checkpointLimit: latestReview.automaticReworkBudget.checkpointLimit,
        checkpointRemaining: Math.max(0, latestReview.automaticReworkBudget.checkpointLimit - checkpointReworkUsed),
        teamUsed: teamReworkUsed,
        teamLimit: latestReview.automaticReworkBudget.teamLimit,
        teamRemaining: Math.max(0, latestReview.automaticReworkBudget.teamLimit - teamReworkUsed),
        history: reworkHistory,
      },
    } }),
  })
}

function summarizeTimeline(projection: TeamProjection): readonly TeamConsoleTimelineEntry[] {
  const entries: TeamConsoleTimelineEntry[] = []
  for (const attempt of Object.values(projection.attempts)) {
    for (const kind of ['attempt-started', 'attempt-ended'] as const) {
      const at = kind === 'attempt-started' ? attempt.startedAt : attempt.endedAt
      if (at === undefined || !Number.isFinite(Date.parse(at))) continue
      entries.push({
        id: `${attempt.id}:${kind}`, taskId: String(attempt.taskId), attemptId: String(attempt.id), at, kind,
        status: kind === 'attempt-started' ? 'running' : attempt.status,
        model: `${attempt.modelProvider}/${attempt.modelId}`,
      })
    }
  }
  return Object.freeze(entries.sort((left, right) => Date.parse(left.at) - Date.parse(right.at)
    || left.id.localeCompare(right.id)).map(entry => Object.freeze(entry)))
}

function reviewNextOwner(review: TeamProjection['reviews'][string]): 'reviewer' | 'controller' | 'user' | 'none' {
  if (review.status === 'awaiting_user' && review.userDecision === undefined) return 'user'
  if (review.phase === 'reviewing') return 'reviewer'
  if (review.phase === 'reworking' || review.phase === 'awaiting-controller') return 'controller'
  return 'none'
}

function describeModelRequest(request: TaskModelRequest): string {
  if (request.kind === 'exact') return `${request.model.modelProvider}/${request.model.modelId}`
  if (request.kind === 'legacy') return request.modelId
  if (request.kind === 'tier') return `tier:${request.tier}`
  return 'default'
}

function summarizeUsage(projection: TeamProjection): TeamConsoleUsage {
  const attempts = Object.values(projection.attempts)
  const evidence = attempts.flatMap(attempt => attempt.evidence === undefined ? [] : [attempt.evidence])
  const activeAttemptCount = attempts.filter(attempt => attempt.status === 'dispatching' || attempt.status === 'running').length
  const reported = attempts.flatMap(attempt => {
    // The public progress observer can win the terminal race before the direct
    // child listener enriches evidence with usage. The last cumulative native
    // assistant usage event is still durable provider data and remains the
    // authoritative fallback for that exact attempt.
    const usage = attempt.evidence?.usage ?? attempt.observedUsage
    return usage === undefined ? [] : [usage]
  })
  if (reported.length === 0) {
    if (evidence.length === 0 || activeAttemptCount > 0) {
      return Object.freeze({ state: 'pending', scope: '受管子 Agent', label: '用量：暂无数据' })
    }
    return Object.freeze({ state: 'unavailable', scope: '受管子 Agent', label: '用量：提供方未上报' })
  }
  const totals = reported.reduce((sum, usage) => ({
    uncachedInputTokens: sum.uncachedInputTokens + usage.uncachedInputTokens,
    outputTokens: sum.outputTokens + usage.outputTokens,
    cacheReadTokens: sum.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: sum.cacheWriteTokens + usage.cacheWriteTokens,
  }), { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  const totalTokens = totals.uncachedInputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  const missingAttemptCount = attempts.filter(attempt => attempt.evidence !== undefined
    && attempt.evidence.usage === undefined && attempt.observedUsage === undefined).length
  if (missingAttemptCount === 0 && activeAttemptCount === 0) {
    return Object.freeze({ state: 'known', scope: '受管子 Agent', ...totals, totalTokens, label: `用量：${totalTokens} tok` })
  }
  return Object.freeze({
    state: 'partial',
    scope: '受管子 Agent',
    ...totals,
    totalTokens,
    missingAttemptCount,
    activeAttemptCount,
    label: `用量：已记录 ${totalTokens} tok（部分）`,
  })
}

function isDirectProject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { readonly mode?: unknown }).mode === 'direct'
}

function blockedOutcomeMessage(attempt: AttemptView | undefined, en: boolean, teamStatus?: string): string {
  const evidence = attempt?.evidence?.taskOutcome
  const outcome = evidence?.status === 'reported' ? evidence.outcome : undefined
  if (outcome === undefined) {
    // 'missing' outcomes resume automatically on Continue; an 'invalid' outcome
    // means the worker settled with an unusable final report — it stays blocked
    // after resume, so it must keep the reconcile wording even while paused.
    if ((teamStatus === 'paused' || teamStatus === 'pausing') && evidence?.status !== 'invalid') {
      return en ? 'Task paused with Team. Execution will resume automatically when continued.' : '任务已随团队暂停。点击「继续任务」后将自动恢复执行。'
    }
    const prefix = en ? 'Task blocked; resolve in the controller before retrying.' : '任务受阻；请在主控处理原因后重试。'
    return `${prefix} ${en ? 'The final task result is missing or invalid.' : '缺少有效的最终任务结果。'}`
  }
  const prefix = en ? 'Task blocked; resolve in the controller before retrying.' : '任务受阻；请在主控处理原因后重试。'
  return `${prefix} ${outcome.summary}${'nextAction' in outcome && outcome.nextAction ? ` ${en ? 'Next:' : '下一步：'} ${outcome.nextAction}` : ''}${'question' in outcome && outcome.question ? ` ${en ? 'Question:' : '问题：'} ${outcome.question}` : ''}`
}

function attentionForTask(task: TeamConsoleTask, semanticBlock: boolean, teamStatus?: string): TeamConsoleSummary['attention'] {
  if (task.attemptStatus === 'unknown') return [{
    owner: 'controller', code: 'attempt-outcome-unknown', taskId: task.taskId,
    message: '子代理上次执行结果待核对；需主控依据现有证据决定后续处理。',
  }]
  if (task.nextAction.startsWith('需人工确认')) return [{
    owner: 'user', code: 'verification-inconclusive', taskId: task.taskId,
    message: 'Host 无法完成所需验证，需要用户确认后续处理。',
  }]
  if (task.status === 'failed') return [{
    owner: 'controller', code: 'task-failed', taskId: task.taskId,
    message: '任务失败；由主控根据重试门禁、预算和历史证据决定后续动作。',
  }]
  if (semanticBlock) {
    // Only 'missing'/absent outcomes are pause interruptions that resume
    // automatically; 'reported' and 'invalid' stay blocked after Continue.
    if ((teamStatus === 'paused' || teamStatus === 'pausing')
      && (task.taskOutcome === undefined || task.taskOutcome.status === 'missing')) {
      return []
    }
    return [{
      owner: 'controller', code: 'task-blocked', taskId: task.taskId, message: task.nextAction, ...(task.taskOutcome === undefined ? {} : { taskOutcome: task.taskOutcome }),
    }]
  }
  if (task.status === 'blocked') {
    if (teamStatus === 'paused' || teamStatus === 'pausing') {
      return []
    }
    return [{
      owner: 'controller', code: 'dependency-blocked', taskId: task.taskId,
      message: '依赖未完成；由主控调度器处理，不要求用户立即决定。',
    }]
  }
  return []
}

function nextAction(taskStatus: TeamConsoleTask['status'], attemptStatus: AttemptView['status'] | undefined, verificationInconclusive: boolean, teamStatus: TeamProjection['team']['status'], hasUnhealthyDependency: boolean): string {
  if (attemptStatus === 'unknown') return '结果尚未确认：现场记录已保留，需主控核对后决定后续处理。'
  if (verificationInconclusive) return '需人工确认：Host 无法完成所需验证；不会重复消耗 Token。'
  if (taskStatus === 'verifying') return '验证中：子代理结束不等于任务完成，正在等待验证证据。'
  if (taskStatus === 'blocked') {
    // A durably dependency-blocked task stays blocked after resume — keep the
    // honest reason even while the Team is paused. Only pause-interrupted work
    // (no failed/cancelled/blocked dependency) recovers through Continue.
    if (hasUnhealthyDependency) return '等待处理：依赖任务未成功完成。'
    if (teamStatus === 'paused' || teamStatus === 'pausing') return '任务已随团队暂停。点击「继续任务」后将自动恢复执行。'
    return '等待处理：依赖任务未成功完成。'
  }
  if (taskStatus === 'failed') return '可在安全门禁通过后重试，历史证据会保留。'
  if (taskStatus === 'cancelled') return '已取消：不会自动重新开始。'
  if (taskStatus === 'completed') return '已完成。'
  if (taskStatus === 'running') return '正在执行。'
  return '等待调度。'
}

function summarizeTaskUsage(attempt: AttemptView | undefined): TeamConsoleTaskUsage {
  const usage = attempt?.evidence?.usage ?? attempt?.observedUsage
  if (usage !== undefined) {
    const totalTokens = usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
    const live = attempt?.status === 'dispatching' || attempt?.status === 'running'
    return Object.freeze(live
      ? { state: 'live', ...usage, totalTokens, label: `Token：${totalTokens} tok（运行中）` }
      : { state: 'known', ...usage, totalTokens, label: `Token：${totalTokens} tok` })
  }
  if (attempt?.evidence !== undefined) {
    return Object.freeze({ state: 'unavailable', label: 'Token：提供方未上报' })
  }
  return Object.freeze({ state: 'pending', label: 'Token：暂无数据' })
}

function summarizeAttemptDuration(attempt: AttemptView | undefined): TeamConsoleDuration {
  if (attempt === undefined || attempt.status === 'unknown') return Object.freeze({ state: 'unavailable' })
  if (attempt.endedAt === undefined && attempt.status !== 'dispatching' && attempt.status !== 'running') {
    return Object.freeze({ state: 'unavailable' })
  }
  return summarizeDuration(attempt.startedAt, attempt.endedAt)
}

function summarizeDuration(startedAt: string | undefined, endedAt: string | undefined): TeamConsoleDuration {
  const startedMs = parseTimestamp(startedAt)
  if (endedAt !== undefined) {
    const endedMs = parseTimestamp(endedAt)
    if (startedMs === undefined || endedMs === undefined || endedMs < startedMs) {
      return Object.freeze({ state: 'unavailable' })
    }
    return Object.freeze({ state: 'known', elapsedMs: endedMs - startedMs })
  }
  if (startedMs === undefined || startedAt === undefined) return Object.freeze({ state: 'unavailable' })
  return Object.freeze({ state: 'running', startedAt })
}

/** Team time is real child execution, not the time the panel stays open. */
function summarizeTeamDuration(projection: TeamProjection): TeamConsoleDuration {
  let settledMs = 0
  const activeStarts: string[] = []
  let hasInvalidTiming = false
  for (const attempt of Object.values(projection.attempts)) {
    const start = parseTimestamp(attempt.startedAt)
    if (start === undefined) {
      if (attempt.endedAt !== undefined || !isUnstartedAttempt(attempt.status)) hasInvalidTiming = true
      continue
    }
    if (attempt.status === 'dispatching' || attempt.status === 'running') {
      if (attempt.startedAt !== undefined) activeStarts.push(attempt.startedAt)
      continue
    }
    const end = parseTimestamp(attempt.endedAt)
    if (end === undefined || end < start) {
      hasInvalidTiming = true
      continue
    }
    settledMs += end - start
  }
  if (hasInvalidTiming) return Object.freeze({ state: 'unavailable' })
  if (activeStarts.length === 0) return Object.freeze({ state: 'known', elapsedMs: settledMs })
  const activeStartedAts = activeStarts.sort((left, right) => Date.parse(left) - Date.parse(right))
  return Object.freeze({
    state: 'running',
    startedAt: activeStartedAts[0]!,
    elapsedMs: settledMs,
    activeStartedAts: Object.freeze(activeStartedAts),
  })
}

function isUnstartedAttempt(status: AttemptView['status']): boolean {
  return status === 'dispatching'
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? milliseconds : undefined
}
