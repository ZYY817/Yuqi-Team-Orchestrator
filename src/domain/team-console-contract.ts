/** Browser-safe wire contract for the Yuqi Team console projection. */

import type { AttemptView, TeamProjection, VerificationView } from './projection.ts'
import type { ManualOwnership } from './manual-ownership.ts'
import type { TeamAuthorityMode } from './team-settings-contract.ts'
import type { ModelCatalogFact, ModelRouteTaskTier, TaskModelRequest } from './model-route.ts'
import type { ReviewCheckpointPhase, ReviewCheckpointSubject, ReviewPolicy, ReviewTrigger } from './review-policy.ts'
import type { TaskOutcomeEvidence } from './task-outcome.ts'

export interface TeamConsoleSummary {
  /** Stable identity of the controller that owns the durable Team journal. */
  readonly controllerSessionId?: string | undefined
  readonly team: {
    readonly id: string
    readonly title: string
    readonly objective: string
    readonly status: TeamProjection['team']['status']
    /** Physical execution location selected when this Team was created. */
    readonly workspaceMode?: 'direct' | 'git-worktree' | undefined
    readonly continuedFrom?: { readonly sourceTeamId: string; readonly sourceControllerSessionId: string } | undefined
    readonly completedTaskCount: number
    readonly runningTaskCount: number
    readonly waitingTaskCount: number
    readonly attentionTaskCount: number
    /** Decisions only a human may safely make. Drives the global reminder. */
    readonly userDecisionCount: number
    /** Recoverable work retained by the controller/scheduler, not a user interruption. */
    readonly controllerActionCount: number
    /** Host-authoritative Continue eligibility for this exact durable cut. */
    readonly resumeDisposition?: 'runnable' | 'completion-ready' | 'decision-required' | 'requires-reconciliation' | 'inactive' | undefined
    /** This exact pause was created by the optional pre-dispatch plan review gate. */
    readonly planConfirmationPending?: boolean | undefined
    /** A durable stop intent remains authoritative even during reconciliation. */
    readonly cancellationRequested?: boolean | undefined
    /** Durable review policy snapshotted at Team start. */
    readonly reviewPolicy?: ReviewPolicy | undefined
    /** Wall-clock duration from durable Team start to end/current projection. */
    readonly duration: TeamConsoleDuration
  }
  readonly tasks: readonly TeamConsoleTask[]
  readonly attention: readonly TeamConsoleAttention[]
  /** Attempt-scoped usage only; unknown and in-flight values are never presented as zero. */
  readonly usage: TeamConsoleUsage
  /** Short project-local index; the full transcript is intentionally excluded. */
  readonly projectSummary?: TeamConsoleProjectSummary | undefined
  /** Latest bounded structured review result; absent before a review is recorded. */
  readonly review?: TeamConsoleReview | undefined
  /** Current durable checkpoint, including reviewer/rework ownership before a result exists. */
  readonly reviewCheckpoint?: TeamConsoleReviewCheckpoint | undefined
  /** Real durable attempt timestamps, not estimated model steps or elapsed UI time. */
  readonly timeline?: readonly TeamConsoleTimelineEntry[] | undefined
}

export interface TeamConsoleTimelineEntry {
  readonly id: string
  readonly taskId: string
  readonly attemptId: string
  readonly at: string
  readonly kind: 'attempt-started' | 'attempt-ended'
  readonly status: string
  readonly model: string
}

export interface TeamConsoleAttention {
  readonly taskOutcome?: TaskOutcomeEvidence | undefined
  readonly owner: 'user' | 'controller'
  readonly code: 'attempt-outcome-unknown' | 'verification-inconclusive' | 'task-failed' | 'task-blocked' | 'dependency-blocked'
  readonly taskId: string
  readonly message: string
}

export interface TeamConsoleProjectSummaryItem {
  readonly id: string
  readonly text: string
  readonly links: readonly string[]
}

export interface TeamConsoleProjectSummary {
  readonly schemaVersion: 1
  readonly overallProgress: string
  readonly architectureDecisions: readonly TeamConsoleProjectSummaryItem[]
  readonly pitfalls: readonly TeamConsoleProjectSummaryItem[]
  readonly conventions: readonly TeamConsoleProjectSummaryItem[]
  readonly documentLinks: readonly string[]
  readonly updatedAt: string
}

export type TeamConsoleReviewDecision = 'pass' | 'changes_required' | 'inconclusive'

export interface TeamConsoleReviewCheckpoint {
  readonly reviewId: string
  readonly trigger: ReviewTrigger
  readonly subject: ReviewCheckpointSubject
  readonly phase: ReviewCheckpointPhase
  readonly candidateEventId: string
  readonly round: number
  readonly independence: 'model-diverse' | 'context-only'
  readonly nextOwner: 'reviewer' | 'controller' | 'user' | 'none'
  readonly automaticRework: {
    readonly checkpointUsed: number
    readonly checkpointLimit: number
    readonly checkpointRemaining: number
    readonly teamUsed: number
    readonly teamLimit: number
    readonly teamRemaining: number
    readonly history: readonly {
      readonly taskId: string
      readonly sourceReviewId: string
      readonly round: number
      readonly status: TeamProjection['tasks'][string]['status']
    }[]
  }
}

export interface TeamConsoleReviewFinding {
  readonly severity: 'low' | 'medium' | 'high' | 'critical'
  readonly evidence: readonly string[]
  readonly impact: string
  readonly recommendation: string
}

export interface TeamConsoleReview {
  readonly reviewId: string
  readonly trigger: string
  readonly reviewerSessionId: string
  readonly decision: TeamConsoleReviewDecision
  readonly findings: readonly TeamConsoleReviewFinding[]
  readonly unverified: readonly string[]
  readonly candidateEventId?: string | undefined
  readonly round?: number | undefined
  readonly status?: 'requested' | 'completed' | 'awaiting_user' | undefined
  readonly userDecision?: 'retry_review' | 'authorize_final_rework' | 'waive' | 'fail' | 'cancel' | undefined
  readonly waiveReason?: string | undefined
}

export type TeamConsoleUsage =
  | { readonly state: 'pending'; readonly scope: '受管子 Agent'; readonly label: '用量：暂无数据' }
  | { readonly state: 'unavailable'; readonly scope: '受管子 Agent'; readonly label: '用量：提供方未上报' }
  | TeamConsoleKnownUsage
  | (Omit<TeamConsoleKnownUsage, 'state'> & {
      readonly state: 'partial'
      readonly missingAttemptCount: number
      readonly activeAttemptCount: number
    })

export interface TeamConsoleKnownUsage {
  readonly state: 'known'
  readonly scope: '受管子 Agent'
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens: number
  readonly label: string
}

/**
 * Replay-safe duration state. A Team duration is the sum of real worker
 * attempts, never the time that its panel happens to remain open. Running
 * Teams carry every active attempt start so concurrent work can be counted
 * accurately by the client clock.
 */
export type TeamConsoleDuration =
  | {
      readonly state: 'running'
      /** Earliest active start retained for older consumers. */
      readonly startedAt: string
      /** Total duration of completed attempts. */
      readonly elapsedMs?: number | undefined
      /** All active attempt starts; omitted for a single task duration. */
      readonly activeStartedAts?: readonly string[] | undefined
    }
  | { readonly state: 'known'; readonly elapsedMs: number }
  | { readonly state: 'unavailable' }

/** Usage reported for the latest attempt of one task; no historical attempt is folded in. */
export type TeamConsoleTaskUsage =
  | { readonly state: 'pending'; readonly label: 'Token：暂无数据' }
  | { readonly state: 'unavailable'; readonly label: 'Token：提供方未上报' }
  | {
      readonly state: 'live'
      readonly uncachedInputTokens: number
      readonly outputTokens: number
      readonly cacheReadTokens: number
      readonly cacheWriteTokens: number
      readonly totalTokens: number
      readonly label: string
    }
  | {
      readonly state: 'known'
      readonly uncachedInputTokens: number
      readonly outputTokens: number
      readonly cacheReadTokens: number
      readonly cacheWriteTokens: number
      readonly totalTokens: number
      readonly label: string
    }

export interface TeamConsoleTask {
  readonly revisionSource?: { readonly taskId: string; readonly rootTaskId?: string | undefined; readonly operationId: string } | undefined
  readonly manualControl?: {
    readonly teamStatus: TeamProjection['team']['status']
    readonly canAcquire: boolean
    readonly workspacePath?: string | undefined
    readonly ownership?: ManualOwnership | undefined
  } | undefined
  readonly taskOutcome?: TaskOutcomeEvidence | undefined
  readonly taskId: string
  readonly goal: string
  readonly status: TeamProjection['tasks'][string]['status']
  readonly modelRole: string
  readonly model: string
  readonly modelRequest?: TaskModelRequest | undefined
  readonly route?: {
    readonly providerId: string
    readonly modelId: string
    readonly basis?: AttemptView['routeBasis'] | undefined
    readonly requestedTier?: ModelRouteTaskTier | undefined
    readonly fallbackReason?: AttemptView['fallbackReason'] | undefined
    readonly catalogEvidence?: readonly ModelCatalogFact[] | undefined
  } | undefined
  /** Every durable attempt route, retained so a model switch is visible as a new attempt. */
  readonly routeHistory?: readonly {
    readonly attemptId: string
    readonly attemptOrdinal: number
    readonly providerId: string
    readonly modelId: string
    readonly basis?: AttemptView['routeBasis'] | undefined
    readonly requestedTier?: ModelRouteTaskTier | undefined
    readonly fallbackReason?: AttemptView['fallbackReason'] | undefined
    readonly unavailableCandidates?: readonly string[] | undefined
  }[] | undefined
  readonly authorityMode: TeamAuthorityMode
  readonly dependencyCount: number
  /** Human-readable prerequisite tasks. Optional for older Host projections. */
  readonly dependencies?: readonly {
    readonly taskId: string
    readonly goal: string
    readonly index?: number | undefined
  }[] | undefined
  readonly fileScope: readonly string[]
  /** Files named by the child in its final controller report. */
  readonly reportedChangedFiles?: readonly string[] | undefined
  readonly attemptCount: number
  readonly attemptId?: string | undefined
  readonly attemptOrdinal?: number | undefined
  readonly attemptStatus?: AttemptView['status'] | undefined
  readonly childSessionId?: string | undefined
  readonly evidenceRecorded: boolean
  /** Live provider observation or final evidence for the latest attempt; missing data is never represented as zero. */
  readonly usage: TeamConsoleTaskUsage
  /** Duration of the latest attempt, derived from durable projection timestamps. */
  readonly duration: TeamConsoleDuration
  readonly verificationStatus?: VerificationView['status'] | undefined
  /**
   * True when a blocked task is held back by a failed/cancelled/blocked
   * dependency — resume alone cannot recover it. Absent for pause-interrupted
   * and worker-reported blocks, which recover through their own paths.
   */
  readonly durablyBlocked?: boolean | undefined
  readonly nextAction: string
}
