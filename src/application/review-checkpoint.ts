/** Pure decision source for durable review checkpoints and bounded autonomous correction. */

import type { TeamEventId, TaskId } from '../domain/ids.ts'
import {
  DEFAULT_MAX_REWORK_ROUNDS,
  DEFAULT_MAX_TEAM_AUTOMATIC_REWORKS,
  type ReviewAutomaticReworkBudget,
  type ReviewCheckpointAnchor,
  type ReviewCheckpointSubject,
  type ReviewFinding,
  type ReviewTrigger,
} from '../domain/review-policy.ts'
import {
  reviewAutomaticReworkBudget,
  reviewAutomaticReworkBudgetExhausted,
  type ReviewView,
  type TeamProjection,
} from '../domain/projection.ts'
import { MAX_TEAM_TASKS } from '../domain/task-contract.ts'

export interface ReviewCheckpointTarget {
  readonly subject: ReviewCheckpointSubject
  readonly anchor: ReviewCheckpointAnchor
  readonly candidateEventId: TeamEventId
  readonly trigger?: ReviewTrigger
  readonly round?: number
  readonly automaticReworkBudget?: ReviewAutomaticReworkBudget
  readonly independentReviewerRequired?: boolean
}

export type ReviewCheckpointDecision =
  | { readonly kind: 'complete'; readonly subject: ReviewCheckpointSubject; readonly reason: string }
  | {
    readonly kind: 'review'
    readonly trigger: ReviewTrigger
    readonly candidateEventId: TeamEventId
    readonly round: number
    readonly checkpointSubject: ReviewCheckpointSubject
    readonly checkpointAnchor: ReviewCheckpointAnchor
    readonly automaticReworkBudget: ReviewAutomaticReworkBudget
    readonly independentReviewerRequired: boolean
    /** Durable user-decision identity that forces an explicit retry to use a fresh review cycle. */
    readonly retryKey?: string
    readonly reason: string
  }
  | {
    readonly kind: 'create-rework'
    readonly sourceReviewId: string
    readonly round: number
    readonly findings: readonly ReviewFinding[]
    /** Callers may choose read-only, but automatic correction can never request full-access. */
    readonly authorityMode: 'write-authorized'
    readonly reason: string
  }
  | { readonly kind: 'verify'; readonly taskIds: readonly TaskId[]; readonly reason: string }
  | { readonly kind: 'awaiting-controller'; readonly reviewId?: string; readonly reason: string }

/**
 * The sole projection-to-action decision for review checkpoints. It performs
 * no journal, Host, reconciliation, model, or runtime IO.
 */
export function decideReviewCheckpoint(
  projection: TeamProjection,
  target?: ReviewCheckpointTarget,
): ReviewCheckpointDecision {
  const subject = target?.subject ?? 'team-completion'
  if (projection.team.status === 'completed') {
    return { kind: 'complete', subject, reason: 'Team is already terminal; legacy Teams are never backfilled with a checkpoint' }
  }
  if (projection.team.status !== 'running') {
    return { kind: 'awaiting-controller', reason: `Team cannot advance a review checkpoint while ${projection.team.status}` }
  }

  if (subject === 'team-completion') {
    const incompleteTaskIds = projection.taskIds.filter(taskId => projection.tasks[taskId]?.status !== 'completed')
    if (incompleteTaskIds.length > 0) {
      return { kind: 'verify', taskIds: incompleteTaskIds, reason: 'Task graph must finish execution and verification before review' }
    }
  }

  const candidateEventId = target?.candidateEventId ?? projection.completionCandidateEventId
  if (candidateEventId === undefined) {
    return { kind: 'awaiting-controller', reason: 'Review checkpoint has no durable candidate anchor' }
  }
  const anchor = target?.anchor ?? { eventId: candidateEventId }
  const policy = projection.team.reviewPolicy
  if (target?.automaticReworkBudget !== undefined
    && target.automaticReworkBudget.checkpointLimit > target.automaticReworkBudget.teamLimit) {
    return { kind: 'awaiting-controller', reason: 'Checkpoint rework limit exceeds the Team rework limit' }
  }
  if ((target?.round ?? 0) > 0 && target?.trigger !== 'rework-verification') {
    return { kind: 'awaiting-controller', reason: 'Initial review must use round zero' }
  }
  // A rework budget limits writes, not read-only review. Even a zero-budget
  // checkpoint needs its first review, and the last permitted rework needs
  // verification. Enforce exhaustion only when creating more rework below.
  const latest = target === undefined
    ? latestSubjectReview(projection, subject)
    : latestCheckpointReview(projection, subject, anchor)
  if (policy === undefined || policy.mode === 'off') {
    return { kind: 'complete', subject, reason: policy === undefined ? 'Legacy Team has no reviewer policy snapshot' : 'Reviewer policy is off' }
  }
  if (latest === undefined) {
    if (target === undefined && policy.mode === 'manual') {
      return { kind: 'complete', subject, reason: 'Manual reviewer policy has no outstanding request' }
    }
    return reviewDecision(
      target?.trigger ?? triggerFor(subject),
      candidateEventId,
      target?.round ?? 0,
      subject,
      anchor,
      target?.automaticReworkBudget ?? {
        checkpointLimit: policy.maxReworkRounds ?? DEFAULT_MAX_REWORK_ROUNDS,
        teamLimit: DEFAULT_MAX_TEAM_AUTOMATIC_REWORKS,
      },
      target?.independentReviewerRequired ?? true,
      subject === 'team-completion'
        ? 'Quality gate requires review for every completion candidate'
        : `Durable ${subject} checkpoint requires independent review`,
    )
  }
  const latestAutomaticReworkBudget = reviewAutomaticReworkBudget(projection, latest)
  const latestIndependentReviewerRequired = latest.independentReviewerRequired ?? false

  if (latest.candidateEventId !== candidateEventId) {
    if (latest.result?.decision === 'changes_required') {
      const rework = reworkTaskFor(projection, latest.id)
      if (rework?.status === 'completed') {
        return reviewDecision(
          'rework-verification', candidateEventId, latest.round + 1,
          latest.checkpointSubject, latest.checkpointAnchor, latestAutomaticReworkBudget,
          latestIndependentReviewerRequired,
          'Completed rework produced a new candidate requiring independent verification review',
        )
      }
    }
    return { kind: 'awaiting-controller', reviewId: latest.id, reason: 'Reviewer candidate is stale; fail-closed instead of accepting or replacing it' }
  }

  if (latest.status === 'requested') {
    return reviewDecision(
      latest.trigger === 'user-request' ? 'user-request' : latest.trigger,
      candidateEventId, latest.round, latest.checkpointSubject, latest.checkpointAnchor,
      latestAutomaticReworkBudget, latestIndependentReviewerRequired,
      'Durable review request has no result',
    )
  }
  if (latest.userDecision?.decision === 'waive') {
    return { kind: 'complete', subject, reason: `Controller waived review ${latest.id}: ${latest.userDecision.reason}` }
  }
  if (latest.userDecision?.decision === 'retry_review') {
    return reviewDecision(
      latest.round === 0 ? 'user-request' : 'rework-verification', candidateEventId, latest.round,
      latest.checkpointSubject, latest.checkpointAnchor, latestAutomaticReworkBudget,
      latestIndependentReviewerRequired, 'Controller requested another read-only review of the same candidate cycle',
      String(latest.userDecision.operationId),
    )
  }
  if (latest.userDecision?.decision === 'authorize_final_rework') {
    const rework = reworkTaskFor(projection, latest.id)
    if (rework === undefined) return createReworkDecision(latest, 'Controller authorized one final bounded rework round')
    return rework.status === 'completed'
      ? reviewDecision(
          'rework-verification', candidateEventId, latest.round + 1,
          latest.checkpointSubject, latest.checkpointAnchor, latestAutomaticReworkBudget,
          latestIndependentReviewerRequired, 'Authorized final rework requires independent re-review',
        )
      : { kind: 'verify', taskIds: [rework.contract.taskId], reason: 'Authorized final rework has not completed Host verification' }
  }
  if (latest.userDecision?.decision === 'fail' || latest.userDecision?.decision === 'cancel') {
    return { kind: 'awaiting-controller', reviewId: latest.id, reason: `Controller decision ${latest.userDecision.decision} is awaiting its terminal Team transition` }
  }
  if (latest.phase === 'awaiting-controller' || latest.status === 'awaiting_user' || latest.result?.decision === 'inconclusive') {
    return { kind: 'awaiting-controller', reviewId: latest.id, reason: 'Checkpoint requires controller resolution because review was inconclusive, repeated, or exhausted' }
  }
  if (latest.result?.decision === 'pass') {
    return { kind: 'complete', subject, reason: 'Current checkpoint candidate passed independent review' }
  }
  if (latest.result?.decision === 'changes_required') {
    const rework = reworkTaskFor(projection, latest.id)
    if (rework === undefined) {
      if (reviewAutomaticReworkBudgetExhausted(projection, latest)) {
        return { kind: 'awaiting-controller', reviewId: latest.id, reason: 'Checkpoint or Team automatic correction budget is exhausted' }
      }
      if (projection.taskIds.length >= MAX_TEAM_TASKS) {
        return { kind: 'awaiting-controller', reviewId: latest.id, reason: 'Team task limit prevents creation of a review rework task' }
      }
      return createReworkDecision(latest, 'Reviewer findings require a bounded first-class rework task')
    }
    return rework.status === 'completed'
      ? reviewDecision(
          'rework-verification', candidateEventId, latest.round + 1,
          latest.checkpointSubject, latest.checkpointAnchor, latestAutomaticReworkBudget,
          latestIndependentReviewerRequired, 'Rework must be independently verified',
        )
      : { kind: 'verify', taskIds: [rework.contract.taskId], reason: 'Review rework task has not completed verification' }
  }
  return { kind: 'awaiting-controller', reviewId: latest.id, reason: 'Review checkpoint has no usable durable result' }
}

function reviewDecision(
  trigger: ReviewTrigger,
  candidateEventId: TeamEventId,
  round: number,
  checkpointSubject: ReviewCheckpointSubject,
  checkpointAnchor: ReviewCheckpointAnchor,
  automaticReworkBudget: ReviewAutomaticReworkBudget,
  independentReviewerRequired: boolean,
  reason: string,
  retryKey?: string,
): Extract<ReviewCheckpointDecision, { readonly kind: 'review' }> {
  return {
    kind: 'review', trigger, candidateEventId, round, checkpointSubject, checkpointAnchor,
    automaticReworkBudget, independentReviewerRequired, ...(retryKey === undefined ? {} : { retryKey }), reason,
  }
}

function createReworkDecision(
  review: ReviewView,
  reason: string,
): Extract<ReviewCheckpointDecision, { readonly kind: 'create-rework' }> {
  return {
    kind: 'create-rework', sourceReviewId: review.id, round: review.round + 1,
    findings: review.result?.findings ?? [], authorityMode: 'write-authorized', reason,
  }
}

function triggerFor(subject: ReviewCheckpointSubject): ReviewTrigger {
  if (subject === 'team-plan') return 'plan-confirmation'
  if (subject === 'failure-escalation') return 'consecutive-failure'
  if (subject === 'team-completion') return 'quality-gate'
  return 'quality-gate'
}

function latestSubjectReview(
  projection: TeamProjection,
  subject: ReviewCheckpointSubject,
): ReviewView | undefined {
  for (let index = projection.reviewIds.length - 1; index >= 0; index -= 1) {
    const review = projection.reviews[projection.reviewIds[index]!]!
    if (review.checkpointSubject === subject) return review
  }
  return undefined
}

function latestCheckpointReview(
  projection: TeamProjection,
  subject: ReviewCheckpointSubject,
  anchor: ReviewCheckpointAnchor,
): ReviewView | undefined {
  for (let index = projection.reviewIds.length - 1; index >= 0; index -= 1) {
    const review = projection.reviews[projection.reviewIds[index]!]!
    if (review.checkpointSubject === subject
      && review.checkpointAnchor.eventId === anchor.eventId
      && review.checkpointAnchor.taskId === anchor.taskId
      && review.checkpointAnchor.attemptId === anchor.attemptId) return review
  }
  return undefined
}

function reworkTaskFor(projection: TeamProjection, sourceReviewId: string) {
  return projection.taskIds.map(taskId => projection.tasks[taskId]!).find(task =>
    task.contract.kind === 'review-rework' && task.contract.reviewRework?.sourceReviewId === sourceReviewId)
}
