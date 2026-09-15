/** Host-neutral ports used by the single-child application use case. */

import type { TeamEvent } from '../domain/events.ts'
import type { TaskOutcomeEvidence } from '../domain/task-outcome.ts'
import type { StructuredEvidence } from '../domain/evidence-verdict.ts'
import type { ResolutionWorkspaceProof, TeamWorkspace } from '../domain/workspace.ts'

/** Accepted identities returned by a continuable child runtime. */
export interface ChildAdmission {
  readonly childSessionId: string
  readonly messageId: string
}

/** Observe-only terminal fact emitted by a child runtime. */
export interface ChildEnd {
  readonly runId: string
  readonly provider: string
  readonly childSessionId: string
  readonly stopReason: string
  readonly hasAssistantOutput: boolean
  readonly taskOutcome?: TaskOutcomeEvidence
  /** Repository-relative files explicitly reported by the child in its final controller report. */
  readonly reportedChangedFiles?: readonly string[]
  /** Provider-reported, disjoint Token buckets; absent means unknown, never zero. */
  readonly usage?: ChildTokenUsage
}

/** Cumulative provider-reported usage observed while one child is still live. */
export interface ChildUsage {
  readonly childSessionId: string
  readonly usage: ChildTokenUsage
}

/** Host-normalized Token accounting for one complete child Session. */
export interface ChildTokenUsage {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** Host-neutral child start request. */
export interface ChildStartRequest<Prompt> {
  readonly subagentProvider: string
  readonly label: string
  readonly prompt: Prompt
  readonly modelProvider: string
  readonly modelId: string
  readonly maxDepth: number
  /** Optional Host-enforced child tool visibility/execution boundary. */
  readonly toolFilter?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }
  readonly signal: AbortSignal
  readonly executionBoundary?: ChildExecutionBoundary
}

/** Host-verifiable workspace and sandbox facts fixed before child admission. */
export interface ChildExecutionBoundary {
  readonly cwd: string
  readonly sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly workspace: TeamWorkspace
  readonly allowedDirtyScopes: readonly string[]
  /** fileScope coordinates planned admission; it is not a child filesystem sandbox. */
  readonly fileScopeSemantics?: 'planned-contract-only'
  /** This Host has no child-scoped audit that could prove actual changed-file ownership. */
  readonly actualWriteAttribution?: 'unavailable'
}

/** Runtime boundary for starting and observing one controller's direct children. */
export interface ContinuableChildPort<Prompt> {
  start(request: ChildStartRequest<Prompt>): Promise<ChildAdmission>
  onEnd(listener: (event: ChildEnd) => void): () => void
  /** Optional live accounting stream; terminal evidence remains authoritative. */
  onUsage?(listener: (event: ChildUsage) => void): () => void
}

/** Narrow runtime control seam; the host adapter retains parent authority. */
export interface ChildControlPort {
  interrupt(childSessionId: string): void
  /**
   * Cancel one exact admitted child. Unlike interrupt(), this must release the
   * child's unconsumed inbox through the Host's native lifecycle. Older Host
   * adapters may omit it; callers then retain the legacy interrupt-only path.
   */
  cancel?(childSessionId: string): Promise<void>
}

export interface AttemptRuntimeRef {
  readonly taskId: string
  readonly attemptId: string
  readonly childSessionId?: string
  readonly recoveryToken?: string
}

export interface AttemptRuntimeObservation extends AttemptRuntimeRef {
  readonly state: 'live' | 'durable' | 'missing' | 'diagnostic' | 'unavailable' | 'not-admitted'
  readonly reason?: string
  /** True only when a pre-admission attempt found one exact recovery-token label. */
  readonly recoveredChild?: boolean
}

/** Read-only host seam used to classify unresolved attempts after restart. */
export interface AttemptRuntimeObservationPort {
  observe(request: {
    readonly parentSessionId: string
    readonly attempts: readonly AttemptRuntimeRef[]
    readonly signal?: AbortSignal
  }): Promise<readonly AttemptRuntimeObservation[]>
}

export interface ResolutionPrincipal {
  readonly kind: 'controller-session'
  readonly sessionId: string
}

export interface AttemptResolutionProof {
  readonly principal: ResolutionPrincipal
  readonly observationState: 'durable' | 'missing' | 'not-admitted'
  readonly childQuiescent: true
  readonly localInFlight: false
  readonly gitVerified: true
  readonly workspace?: ResolutionWorkspaceProof
  readonly leaseIds: readonly string[]
}

export interface RecoveryClearProof {
  readonly principal: ResolutionPrincipal
  readonly childQuiescent: true
  readonly localInFlight: false
  readonly gitVerified: true
  readonly workspace: ResolutionWorkspaceProof
}

/** Host proof required immediately before an operator closes an unknown attempt. */
export interface AttemptResolutionSafetyPort {
  assertQuiescent(request: {
    readonly journalKey: string
    readonly teamId: string
    readonly taskId: string
    readonly attemptId: string
    readonly childSessionId?: string
    readonly observation: AttemptRuntimeObservation
    readonly workspace?: TeamWorkspace
    readonly leaseIds?: readonly string[]
    readonly signal?: AbortSignal
  }): Promise<AttemptResolutionProof | void>
}

export interface RecoveryClearSafetyPort {
  assertRecoveryClear(request: {
    readonly journalKey: string
    readonly teamId: string
    readonly workspace: TeamWorkspace
    readonly attemptIds: readonly string[]
    /** Durable attempt-to-child bindings, when available to the Host adapter. */
    readonly attempts?: readonly { readonly attemptId: string; readonly childSessionId?: string }[]
    /** A paused recovery may retain dirty files while proving workspace identity. */
    readonly retainDirtyWorkspace?: boolean
    readonly signal?: AbortSignal
  }): Promise<RecoveryClearProof>
}

/** Append-only Team-event journal backed by one controller Session. */
export interface TeamEventJournal {
  readonly key: string
  read(): readonly unknown[]
  /** Append one transaction of Team facts and cross the host durability barrier. */
  commit(events: readonly TeamEvent[]): Promise<void>
}

/** Deterministic wall-clock seam. */
export interface Clock {
  nowIso(): string
}

/** Unique event-id seam. */
export interface EventIdSource {
  next(): string
}

/** Exact identity supplied to a host-owned evidence collector. */
export interface HostEvidenceCollectionRequest {
  readonly teamId: string
  readonly taskId: string
  readonly attemptId: string
  readonly verificationId: string
  readonly requirementIds: readonly string[]
  readonly signal?: AbortSignal
}

/** A collector may only return evidence it verified itself; unavailable/failed
 * results are deliberately not evidence and therefore cannot produce passed. */
export type HostEvidenceCollectionResult =
  | { readonly kind: 'collected'; readonly evidence: readonly StructuredEvidence[] }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'failed'; readonly code: string; readonly reason: string }
  | { readonly kind: 'aborted'; readonly reason: string }


/** Read-only host seam for collecting machine-checkable acceptance evidence. */
export interface HostEvidenceCollectorPort {
  collect(request: HostEvidenceCollectionRequest): Promise<HostEvidenceCollectionResult>
}
