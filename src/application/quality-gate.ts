/** Backward-compatible quality-gate facade over the unified checkpoint decision source. */

import type { TeamEventId, TaskId } from '../domain/ids.ts'
import type { ReviewFinding, ReviewTrigger } from '../domain/review-policy.ts'
import type { TeamProjection } from '../domain/projection.ts'
import { decideReviewCheckpoint } from './review-checkpoint.ts'

export type QualityGateDecision =
  | { readonly kind: 'complete'; readonly reason: string }
  | {
    readonly kind: 'review'
    readonly trigger: Extract<ReviewTrigger, 'quality-gate' | 'rework-verification' | 'user-request'>
    readonly candidateEventId: TeamEventId
    readonly round: number
    readonly retryKey?: string
    readonly reason: string
  }
  | {
    readonly kind: 'create-rework'
    readonly sourceReviewId: string
    readonly round: number
    readonly findings: readonly ReviewFinding[]
    readonly reason: string
  }
  | { readonly kind: 'verify'; readonly taskIds: readonly TaskId[]; readonly reason: string }
  | { readonly kind: 'await-user'; readonly reviewId?: string; readonly reason: string }

/** Legacy API retained for existing consumers; all branching lives in decideReviewCheckpoint. */
export function decideQualityGate(projection: TeamProjection): QualityGateDecision {
  const decision = decideReviewCheckpoint(projection)
  if (decision.kind === 'complete') return { kind: 'complete', reason: legacyReason(decision.reason) }
  if (decision.kind === 'verify') return decision
  if (decision.kind === 'awaiting-controller') {
    return {
      kind: 'await-user',
      ...(decision.reviewId === undefined ? {} : { reviewId: decision.reviewId }),
      reason: legacyReason(decision.reason),
    }
  }
  if (decision.kind === 'create-rework') {
    return {
      kind: 'create-rework', sourceReviewId: decision.sourceReviewId, round: decision.round,
      findings: decision.findings, reason: legacyReason(decision.reason),
    }
  }
  const trigger = decision.trigger === 'user-request' || decision.trigger === 'rework-verification'
    ? decision.trigger
    : 'quality-gate'
  return {
    kind: 'review', trigger, candidateEventId: decision.candidateEventId,
    round: decision.round, ...(decision.retryKey === undefined ? {} : { retryKey: decision.retryKey }), reason: legacyReason(decision.reason),
  }
}

function legacyReason(reason: string): string {
  if (reason === 'Team is already terminal; legacy Teams are never backfilled with a checkpoint') {
    return 'Team is already terminal; legacy Teams are never backfilled with a gate'
  }
  if (reason === 'Completed rework produced a new candidate requiring independent verification review') {
    return 'Completed rework produced a new candidate requiring verification review'
  }
  if (reason === 'Checkpoint requires controller resolution because review was inconclusive, repeated, or exhausted') {
    return 'Review is inconclusive or its rework budget is exhausted'
  }
  if (reason === 'Reviewer findings require a bounded first-class rework task') {
    return 'Reviewer findings require a new first-class rework task'
  }
  return reason
}
