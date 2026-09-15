/** Cordis service exposing the first runnable Yuqi orchestration slice. */

import { readSessionEvents } from './session-events.ts'
import { sendControllerTaskMessage } from './subagent-message-bridge.ts'
import { deliverTeamInstruction } from './team-instruction-delivery.ts'
import { TEAM_INSTRUCTION_EVENT, type TeamInstruction } from '../../domain/team-instruction.ts'
import { commitYuqiSessionEvent } from './session-journal.ts'
import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { restorePersistedSession } from './session-restore.ts'
import { SidecarRepository, hasSidecarSession } from '../storage/session-sidecar.ts'
import { ownedEventDomainSpec, type OwnedEventTable } from '../storage/owned-event-store.ts'
import { readYuqiSessionEvents } from './session-journal.ts'
import { readLatestTeamParentReportCheckpoint } from './session-journal.ts'
import { JournalProgressWake } from './journal-progress-wake.ts'
import { hasNewRevisionCompletion } from './revision-completion-notice.ts'
import { boundContextSummary, createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { installSettingsSection } from './settings-compatibility.ts'
import { DurableJournalCoordinator } from '../../application/durable-journal.ts'
import { JournalGate } from '../../application/journal-gate.ts'
import type { TeamProjection } from '../../domain/projection.ts'
import { manualTakeoverIssue } from '../../domain/manual-ownership.ts'
import { fileScopePatternSchema, fileScopeSetsConflict } from '../../domain/file-scope.ts'
import { decideChildSettlement } from '../../application/child-settlement.ts'
import { canRetryModelCall, MODEL_CALL_RETRY_PREFIX } from '../../application/model-call-retry.ts'
import { readModelCallFailure } from './model-call-failure.ts'
import { TeamBootstrapCoordinator, validateAndOrderTaskContracts } from '../../application/bootstrap-team.ts'
import type { BootstrapTeamRequest } from '../../application/bootstrap-team.ts'
import { BeginVerificationCoordinator } from '../../application/begin-verification.ts'
import type { BeginVerificationRequest } from '../../application/begin-verification.ts'
import { TeamRunLoopCoordinator, teamRunDisposition } from '../../application/run-team-loop.ts'
import type { RunTeamLoopResult, TeamRunScheduleStateRequest } from '../../application/run-team-loop.ts'
import type { TeamRunProgressRequest } from '../../application/run-team-loop.ts'
import { hasActiveAttempts, hasCurrentCancellationIntent, hasUnresolvedRecoveryFacts, TeamControlCoordinator } from '../../application/control-team.ts'
import type { TeamControlRequest } from '../../application/control-team.ts'
import { TaskRetryCoordinator } from '../../application/retry-task.ts'
import type { TaskRetryRequest } from '../../application/retry-task.ts'
import { AutomaticTaskRetryCoordinator } from '../../application/verification-retry.ts'
import type { AutomaticTaskRetryRequest } from '../../application/verification-retry.ts'
import { TeamReconciliationCoordinator } from '../../application/reconcile-team.ts'
import { ControllerRecoveryCoordinator } from '../../application/controller-recovery.ts'
import { OwnedLiveAttemptRecoveryCoordinator } from '../../application/recover-owned-live-attempts.ts'
import { RecoveryClearCoordinator } from '../../application/clear-recovery.ts'
import type { ClearRecoveryRequest } from '../../application/clear-recovery.ts'
import { AttemptResolutionCoordinator } from '../../application/resolve-attempt.ts'
import type { ResolveAttemptRequest } from '../../application/resolve-attempt.ts'
import type { ReconcileTeamRequest } from '../../application/reconcile-team.ts'
import { VerificationVerdictCoordinator } from '../../application/record-verification-verdict.ts'
import { resolveFixedModelFromPort } from '../../application/fixed-model.ts'
import type { FixedModelPolicy } from '../../application/fixed-model.ts'
import { TeamBatchExecutor } from '../../application/execute-team-batch.ts'
import type { CancellationWaitResult, ExecuteTeamBatchResult } from '../../application/execute-team-batch.ts'
import { YuqiOrchestratorError } from '../../application/errors.ts'
import type { ChildExecutionBoundary, HostEvidenceCollectorPort, TeamEventJournal } from '../../application/ports.ts'
import type { TeamEvent } from '../../domain/events.ts'
import { classifyTeamResume, planTeamSchedule, type TeamSchedulePlan } from '../../application/schedule-team.ts'
import type { EvidenceRequirement } from '../../domain/evidence-verdict.ts'
import type { ReworkBudget } from '../../application/evidence-verdict.ts'
import { HarnessContinuableChildPort, verifyHarnessExecutionBoundary } from './continuable-child.ts'
import { appendYuqiSessionEvent, assertYuqiSessionEventCompatibility, HarnessSessionJournal, parseTeamParentBindingData, parseTeamProjectionBridgeData, readActiveTeamParentBinding, readTeamEventsFromSession, sameBridgeContent, selectActiveTeamProjectionBridge, syncTeamProjectionToParent, TEAM_PARENT_BINDING_EVENT, TEAM_PARENT_PROJECTION_EVENT, type HarnessSessionPersistence, type HarnessSessionStore } from './session-journal.ts'
import { HarnessModelCatalogPort } from './model-catalog.ts'
import type { TeamTaskContract } from '../../domain/task-contract.ts'
import type { TeamAuthorityMode } from '../../domain/team-settings-contract.ts'
import { isSchedulableTaskStatus } from '../../domain/states.ts'
import { parseTeamEvent, projectionHasReconciliationGap, replayTeamEvents, teamCompletionReady as domainTeamCompletionReady } from '../../domain/projection.ts'
import { TeamWorkspaceCoordinator, teamOwnedDirtyScopes } from '../../application/provision-team-workspace.ts'
import { NodeGitWorkspacePort } from '../git/git-workspace.ts'
import { DirectWorkspacePort, WorkspacePortRouter } from '../filesystem/direct-workspace.ts'
import type { FixedModelRef, ProjectIdentity, TeamWorkspace } from '../../domain/workspace.ts'
import { HarnessAttemptResolutionSafetyPort, HarnessAttemptRuntimeObservationPort } from './reconciliation-observer.ts'
import { HarnessEvidenceCollector } from './evidence-collector.ts'
import type { HarnessEvidenceCapability } from './evidence-collector.ts'
import { registerTeamSessionProjection } from './team-projection.ts'
import { HarnessTeamRunnerSupervisor, HarnessTeamRunCyclePort, type HarnessTeamRunnerWakeLease } from './run-cycle.ts'
import { HarnessTeamProgressAdapter, loadInactiveTerminalFact } from './progress-adapter.ts'
import type { HarnessProgressReconciliationRequest, HarnessProgressSettlementRequest } from './progress-adapter.ts'
import { SubprocessEvidenceCollector } from './subprocess-evidence-collector.ts'
import { HarnessStructuredSubprocessPort } from './structured-subprocess-port.ts'
import type { HarnessSubprocessRuntime } from './structured-subprocess-port.ts'
import { findVerificationReadinessIssue } from './verification-readiness.ts'
import { HarnessTeamControllerLauncher, traceControllerResume } from './controller-launcher.ts'
import type { AgentPresetMountPort, TeamControllerLaunch } from './controller-launcher.ts'
import { StartTeamCoordinator, validateStartTeamRequest } from './start-team.ts'
import type { StartTeamRequest, StartedTeam } from './start-team.ts'
import { createTeamEvent, validateTeamEvents } from '../../application/team-events.ts'
import { FileLeaseId, TaskId, AttemptId, ControlOperationId, TeamEventId } from '../../domain/ids.ts'
import { NodeProjectSummaryFile } from '../project-summary-file.ts'
import { validateProjectSummary, type ProjectSummary, type ProjectSummaryPatch } from '../../application/project-summary.ts'
import { decideReviewDispatch, reviewResultSchema, type ReviewFinding, type ReviewOutcome, type ReviewResult, type ReviewTrigger } from '../../application/reviewer.ts'
import { decideQualityGate } from '../../application/quality-gate.ts'
import { decideReviewCheckpoint, type ReviewCheckpointTarget } from '../../application/review-checkpoint.ts'
import { DEFAULT_MAX_TEAM_AUTOMATIC_REWORKS, type ReviewAutomaticReworkBudget, type ReviewCheckpointAnchor, type ReviewCheckpointSubject } from '../../domain/review-policy.ts'
import { ReviewResultCoordinator } from '../../application/record-review-result.ts'
import { TaskRevisionCoordinator, type TaskRevisionRequest } from '../../application/create-task-revision.ts'
import { StartFollowupTeamCoordinator, type FollowupTargetCandidate } from '../../application/start-followup-team.ts'
import type { TeamContinuation } from '../../domain/team-continuation.ts'
import type { RecordReviewUserDecisionRequest } from '../../application/record-review-result.ts'
import { HarnessReviewJournal } from './review-journal.ts'
import { HarnessReviewAgent, REVIEW_STOP_TIMEOUT_MS } from './review-agent.ts'
import { readLastAssistantOutput } from './session-assistant-output.ts'
import { harnessSessionAccess, requireHarnessSessionStore } from './session-store-adapter.ts'
import { workspaceProjectRoot } from '../workspace-project-root.ts'
import {
  assertChildPresetId,
  assertTeamConcurrency,
  DEFAULT_TEAM_SETTINGS,
  TEAM_SETTINGS_NAMESPACE,
  TEAM_SETTINGS_SCHEMA,
  normalizeTeamReviewPolicy,
  type TeamSettings,
} from '../../application/team-settings.ts'
import { modelRequestForTask } from '../../domain/task-contract.ts'
import type { ModelCatalogFact, ModelRouteTaskTier, ProviderModelRef, ProviderScope, TaskModelRequest, TeamModelPolicy } from '../../domain/model-route.ts'
import { automaticTierForTaskRequest, isProviderAllowed, ModelRoutingError, resolveModelRoute, type ModelRouteBasis, type ModelRouteReason } from '../../application/model-routing.ts'
import { installTeamSettingsWebApi } from './team-settings-web-api.ts'
import { installTeamSettingsScopes, TeamSettingsScopes } from './team-settings-scope.ts'
import { installTeamSidecarWebApi, markSidecarReadFailure, type SidecarReadStage } from './team-sidecar-web-api.ts'
import { assertRetainableOrphan } from './sidecar-orphan.ts'
import type { TeamSidecarReader } from '../../domain/team-sidecar-web-contract.ts'
import { DirectWorkspaceOwnershipGuard, type DirectWorkspaceSessionPersistence } from './direct-workspace-ownership.ts'
import { deliverParentReport } from './parent-report-delivery.ts'
import type { TeamLocale } from '../../domain/locale.ts'
import { logHostCompatibilityFailure, logHostCompatibilityReport } from './host-compatibility-diagnostics.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    yuqiTeamOrchestrator: YuqiTeamOrchestratorService
  }
}

export interface HarnessGatedBatchChildRequest {
  readonly taskOutcomeVersion?: 1
  readonly taskId: string
  readonly attemptId: string
  readonly leaseId: string
  readonly modelPolicy: FixedModelPolicy
  readonly route?: HarnessResolvedModelRoute
  readonly label: string
  readonly prompt: ContentBlock[]
  readonly signal: AbortSignal
  /** Conservative token hold required when the Controller has a token policy. */
  readonly tokenReserve?: number
}

export interface HarnessResolvedModelRoute {
  readonly route: ProviderModelRef
  readonly routeBasis: ModelRouteBasis
  readonly requestedTier?: ModelRouteTaskTier
  readonly fallbackReason?: Extract<ModelRouteReason,
    'automatic-candidates-exhausted' | 'task-default-controller-inherit' | 'team-inherit-controller'>
  readonly catalogEvidence: readonly ModelCatalogFact[]
}

export interface HarnessTaskReport {
  readonly taskId: string
  readonly status: string
  readonly agentSessionId?: string
  readonly output?: string
  readonly truncated?: boolean
  /** Durable Harness lifecycle reason for the latest attempt. */
  readonly stopReason?: string
  /** Durable Host verification problems for the latest task verification. */
  readonly verificationReasons?: readonly { readonly checkId: string; readonly code: string; readonly detail: string }[]
  /** True when no bounded child conclusion can be read for an outcome needing attention. */
  readonly reportUnavailable?: boolean
}

export interface HarnessGatedExecuteBatchRequest {
  readonly controller: Agent
  readonly teamId: string
  readonly workspaceId: string
  readonly worktreePath: string
  readonly plan: TeamSchedulePlan
  readonly maxConcurrency: number
  readonly children: readonly HarnessGatedBatchChildRequest[]
}

export interface HarnessResolveFixedModelRequest {
  readonly role: TeamTaskContract['modelRole']
  readonly policy: FixedModelPolicy
  readonly signal?: AbortSignal
}

export interface HarnessProvisionWorkspaceRequest {
  readonly controller: Agent
  readonly teamId: string
  readonly workspaceId: string
  readonly identity: ProjectIdentity
  readonly managedRoot: string
  readonly worktreePath: string
  readonly branchName: string
  readonly signal?: AbortSignal
}

export type HarnessBootstrapTeamRequest = BootstrapTeamRequest & {
  readonly controller: Agent
}

export type HarnessBeginVerificationRequest = BeginVerificationRequest & {
  readonly controller: Agent
}

export interface HarnessRunTeamRequest {
  readonly controller: Agent
  readonly teamId: string
  readonly maxConcurrency: number
  /** Optional compatibility override; otherwise the durable Team snapshot wins. */
  readonly directWriteStrategy?: import('../../domain/execution-policy.ts').DirectWriteStrategy
  readonly maxCycles?: number
  readonly signal?: AbortSignal
  /** Idempotent owner release retained by the service-level supervisor. */
  readonly disposeController?: () => Promise<void>
}

export interface HarnessLaunchTeamControllerRequest {
  readonly workspace: TeamWorkspace
  readonly controllerModel: AgentOptions
  readonly parentSessionId?: string
  readonly childPresetId?: string
  readonly signal?: AbortSignal
}

export type HarnessStartTeamRequest = StartTeamRequest<AgentOptions>
export interface HarnessFollowupSource {
  readonly teamId: string
  readonly controllerSessionId: string
  readonly operationId: string
  /** Canonical model-facing request, before current settings are applied. */
  readonly requestDigest?: string
}
export type HarnessStartedTeam = StartedTeam<Agent, Awaited<ReturnType<TeamBootstrapCoordinator['bootstrap']>>>

export interface HarnessCancelTeamRequest extends TeamControlRequest {
  readonly controller: Agent
  /** Maximum time to wait for durable child terminal facts. Defaults to 30 seconds. */
  readonly timeoutMs?: number
}

/** Host-owned evidence request; callers cannot submit structured evidence. */
export interface HarnessCollectVerificationEvidenceRequest {
  readonly controller: Agent
  readonly teamId: string
  readonly taskId: string
  readonly attemptId: string
  readonly verificationId: string
  readonly operationId: string
  readonly requirements: readonly EvidenceRequirement[]
  readonly rework: ReworkBudget
  readonly signal?: AbortSignal
}

const DEFAULT_CANCEL_TIMEOUT_MS = 30_000
// A running-model switch pauses the whole Team before creating the replacement
// attempt. Sibling agents are allowed to finish their current work naturally,
// which regularly takes longer than the short per-attempt cancellation timeout.
const MODEL_SWITCH_PAUSE_TIMEOUT_MS = 300_000
const MIN_CANCEL_TIMEOUT_MS = 10
const MAX_CANCEL_TIMEOUT_MS = 300_000
const HOST_SHUTDOWN_TIMEOUT_MS = 5_000
const HOST_SHUTDOWN_DISPOSAL_ATTEMPTS = 2
const CONTROL_OPERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/u

// Persistence may cold-load a Session before Cordis finishes constructing the
// service instance. Register at module evaluation (plugin bundle activation).
// Vocabulary is process-scoped: disposing one Context must not make durable
// logs unreadable to another Context created in the same process.
function extractPersistenceHeaders(list: readonly unknown[]): Session['header'][] {
  return list.map(item => {
    if (item !== null && typeof item === 'object' && 'header' in item && (item as { header: unknown }).header !== null && typeof (item as { header: unknown }).header === 'object') {
      return (item as { header: Session['header'] }).header
    }
    return item as Session['header']
  })
}

/** Host service; domain and orchestration logic remain in lower layers. */
export class YuqiTeamOrchestratorService extends Service {
  static provide = 'yuqiTeamOrchestrator'
  static inject = ['subagents', 'sessions', 'sessionPersistence', 'llm', 'sandboxPolicy']

  private readonly transactions = new DurableJournalCoordinator()
  private storageDomain: {
    open(spec: typeof ownedEventDomainSpec): Promise<{ table(name: 'sessions'): OwnedEventTable; close(): Promise<void> }>
  } | undefined
  private readonly journalProgressWake = new JournalProgressWake()
  private readonly progressClock = { nowIso: () => new Date().toISOString() }
  private readonly progressEventIds = { next: () => `yuqi-event-${randomUUID()}` }
  private readonly teamBootstrap = new TeamBootstrapCoordinator(
    { nowIso: () => new Date().toISOString() },
    { next: () => `yuqi-event-${randomUUID()}` },
    this.transactions,
  )
  private readonly verificationStarts = new BeginVerificationCoordinator(
    { nowIso: () => new Date().toISOString() },
    { next: () => `yuqi-event-${randomUUID()}` },
    this.transactions,
  )
  private readonly teamRuns = new TeamRunLoopCoordinator()
  private readonly teamRunnerSupervisor = new HarnessTeamRunnerSupervisor()
  /** One bounded replan is safe after a durable control/retry cut invalidates an in-flight runner plan. */
  private readonly staleScheduleReplans = new Set<string>()
  /** Coalesced wakes observe one supervisor Promise; report each outcome once. */
  private readonly observedBackgroundRunnerOperations = new WeakSet<Promise<RunTeamLoopResult>>()
  private readonly gitWorkspaces = new NodeGitWorkspacePort()
  private readonly directWorkspaces = new DirectWorkspacePort()
  private readonly directWorkspaceOwnership: DirectWorkspaceOwnershipGuard
  private readonly workspacePorts = new WorkspacePortRouter(this.gitWorkspaces, this.directWorkspaces)
  private readonly batchExecutor = new TeamBatchExecutor<ContentBlock[]>(
    { nowIso: () => new Date().toISOString() },
    { next: () => `yuqi-event-${randomUUID()}` },
    this.transactions,
  )
  private readonly workspaceCoordinator = new TeamWorkspaceCoordinator(
    { nowIso: () => new Date().toISOString() },
    { next: () => `yuqi-event-${randomUUID()}` },
    this.gitWorkspaces,
    this.transactions,
  )
  private readonly directWorkspaceCoordinator = new TeamWorkspaceCoordinator(
    { nowIso: () => new Date().toISOString() },
    { next: () => `yuqi-event-${randomUUID()}` },
    this.directWorkspaces,
    this.transactions,
  )
  private readonly teamControls = new TeamControlCoordinator(
    { nowIso: () => new Date().toISOString() },
    { next: () => `yuqi-event-${randomUUID()}` },
    this.transactions,
  )
  private readonly taskRetries = new TaskRetryCoordinator(
    { nowIso: () => new Date().toISOString() },
    { next: () => `yuqi-event-${randomUUID()}` },
    this.transactions,
  )
  private readonly automaticRetries = new AutomaticTaskRetryCoordinator(this.taskRetries)
  private readonly reconciliations = new TeamReconciliationCoordinator(
    { nowIso: () => new Date().toISOString() },
    { next: () => `yuqi-event-${randomUUID()}` },
    this.transactions,
  )
  private readonly controllerRecovery = new ControllerRecoveryCoordinator()
  private readonly ownedLiveAttemptRecovery = new OwnedLiveAttemptRecoveryCoordinator(
    { nowIso: () => new Date().toISOString() },
    { next: () => `yuqi-event-${randomUUID()}` },
    this.transactions,
  )
  private readonly resolutions = new AttemptResolutionCoordinator(
    { nowIso: () => new Date().toISOString() }, { next: () => `yuqi-event-${randomUUID()}` }, this.transactions,
  )
  private readonly recoveryClear = new RecoveryClearCoordinator(
    { nowIso: () => new Date().toISOString() }, { next: () => `yuqi-event-${randomUUID()}` }, this.transactions,
  )
  private readonly verificationVerdicts = new VerificationVerdictCoordinator(
    { nowIso: () => new Date().toISOString() }, { next: () => `yuqi-event-${randomUUID()}` }, this.transactions,
  )
  private readonly reviewResults = new ReviewResultCoordinator(
    { nowIso: () => new Date().toISOString() }, { next: () => `yuqi-event-${randomUUID()}` }, this.transactions,
  )
  private readonly taskRevisions = new TaskRevisionCoordinator(
    { nowIso: () => new Date().toISOString() }, { next: () => `yuqi-event-${randomUUID()}` }, this.transactions,
  )
  private readonly teamStartGate = new JournalGate()
  private readonly teamStartShutdown = new AbortController()
  private readonly evidenceCollector = new HarnessEvidenceCollector()
  private readonly runtimeObservations: HarnessAttemptRuntimeObservationPort
  private readonly childPorts = new WeakMap<Agent, HarnessContinuableChildPort>()
  private readonly recoveredControllers = new Map<string, AgentHandle>()
  private readonly recoveringControllers = new Map<string, Promise<Agent | undefined>>()
  private readonly parentReportRecoveryScans = new Map<string, Promise<void>>()
  private readonly coldRecoveryScans = new Set<string>()
  private readonly coldRecoveryDiscoveries = new Set<string>()
  private readonly terminalConsistencyRepairs = new Set<string>()
  /** Serialization is only an optimization; durable journal cuts remain the retry source. */
  private readonly parentReportDeliveryTails = new Map<string, Promise<{ readonly generation: number; readonly pending: boolean }>>()
  private readonly parentReportDeliveryGenerations = new Map<string, number>()
  private readonly parentReportDeliveryRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly parentReportDeliveryRetryAttempts = new Map<string, number>()
  private readonly parentReportDeliveryDelayTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly parentReportDeliveryDelayResolvers = new Map<string, () => void>()
  /** UI-only recovery syncs through this source cut without waking the parent model. */
  private readonly parentReportSuppressions = new Map<string, { active: number; through: number }>()
  private disposed = false
  private controllerAgents: AgentRegistry | undefined
  private controllerLauncher: HarnessTeamControllerLauncher | undefined
  private readonly modelCatalog: HarnessModelCatalogPort
  private readonly projectSummaryFile = new NodeProjectSummaryFile()
  private readonly reviewer: HarnessReviewAgent
  private readonly reviewCalls = new Map<string, { abort: AbortController; done: Promise<void>; reviewId?: string }>()
  private readonly reviewStopGates = new Map<string, number>()
  private readonly reviewCloseSources = new Map<string, { controller: Agent; teamId: string; reviewId: string }>()
  private readonly reviewCloseTails = new Map<string, Promise<void>>()
  private reviewShutdown: Promise<void> | undefined
  private teamSettingsSource: () => TeamSettings = () => DEFAULT_TEAM_SETTINGS
  private teamSettingsScopes: TeamSettingsScopes | undefined
  private sidecar: SidecarRepository | undefined
  private sidecarReady: Promise<void> | undefined
  private readonly sidecarSessions = new Map<string, Session>()

  private static isSidecarFactConflict(error: unknown): boolean {
    return error instanceof Error && error.message === 'Yuqi Session has conflicting native and sidecar facts'
  }

  /** Only native-session persistence failures with an identified, localizable
   * corruption signature may be isolated to one snapshot row.  Identity,
   * storage, permission and programming failures remain global failures. */
  private static recoverableNativeSessionReadKind(error: unknown, sessionId: string): 'zstd-log' | 'header-isSeeded' | 'unsupported-format' | 'not-found' | undefined {
    if (!(error instanceof Error)) return undefined
    if (error.message.startsWith('corrupt Zstandard session log:')) return 'zstd-log'
    if (error.name === 'SessionFormatUnsupportedError' || error.message.includes('older than the supported version') || error.message.includes('SessionFormatUnsupportedError')) {
      return 'unsupported-format'
    }
    if (error.name === 'SessionPersistenceNotFoundError' || error.message.includes('not found') || error.message.includes('SessionPersistenceNotFoundError')) {
      return 'not-found'
    }
    if (YuqiTeamOrchestratorService.nativeHeaderFailureSessionId(error) === sessionId) return 'header-isSeeded'
    return undefined
  }

  private static nativeHeaderFailureSessionId(error: Error): string | undefined {
    // Native Host errors keep their class name in `name`; older transport
    // wrappers included it in `message`. Accept only the known exact defect.
    const message = error.message.startsWith('SessionPersistenceCorruptionError: ')
      ? error.message.slice('SessionPersistenceCorruptionError: '.length)
      : error.name === 'SessionPersistenceCorruptionError' ? error.message : undefined
    return message === undefined ? undefined
      : /^stored session "([^"]+)" failed validation: Error: session header isSeeded must be a boolean$/u.exec(message)?.[1]
  }

  private bindSidecar(session: Session): void {
    // Preserve legacy facts in place. Switching an existing journal requires an
    // explicit migration, never an empty sidecar shadowing its old history.
    if (readSessionEvents(session).some(event => event.type.startsWith('yuqi/'))) {
      if ((this.sidecar?.readStoredEvents(String(session.id)).length ?? 0) > 0) {
        throw new Error('Yuqi Session has conflicting native and sidecar facts')
      }
      return
    }
    this.sidecar?.bind(session)
    if (this.sidecar !== undefined) this.sidecarSessions.set(String(session.id), session)
  }

  private async ensureSidecarReady(): Promise<void> {
    // Cordis throws if a property is accessed on ctx without declaration in static inject.
    // Use safe reflection lookup from the cordis store to probe optional storageDomain.
    const rootFacility = (this.ctx.reflect?.get?.('storageDomain', false) ?? this.ctx.root?.reflect?.get?.('storageDomain', false)) as {
      open?: unknown
    } | undefined
    const candidate = this.storageDomain ?? rootFacility
    // Keep compatible legacy hosts running when the dependency is a declared
    // placeholder but the storage-domain capability itself is unavailable.
    const facility = (candidate !== null && typeof candidate === 'object' && typeof (candidate as { open?: unknown }).open === 'function'
      ? candidate : undefined) as {
      open(spec: typeof ownedEventDomainSpec): Promise<{ table(name: 'sessions'): OwnedEventTable; close(): Promise<void> }>
    } | undefined
    if (this.sidecarReady !== undefined) {
      const ready = this.sidecarReady
      try { await ready } catch (cause) {
        if (this.sidecarReady === ready) this.sidecarReady = undefined
        throw cause
      }
      if (this.sidecar === undefined) throw new Error('Yuqi sidecar is closed')
      return
    }
    if (facility === undefined) return // Verified legacy Hosts remain supported.
    this.sidecarReady ??= (async () => {
      let domain: Awaited<ReturnType<typeof facility.open>>
      try {
        domain = await facility.open(ownedEventDomainSpec)
      } catch (cause) {
        logHostCompatibilityFailure(this.ctx, 'storage-domain-open', cause)
        throw cause
      }
      const repository = new SidecarRepository(domain.table('sessions'), {
        beforeAppend: session => this.materializeSidecarSession(session),
      })
      this.sidecar = repository
      let closing: Promise<void> | undefined
      let unbindLifecycle: (() => void) | undefined
      const close = () => closing ??= (async () => {
        // Sidecar ownership is local to this domain. Do not drain the Host's
        // reviewer or mark the whole service disposed when sidecar setup fails;
        // Host shutdown owns that lifecycle separately.
        console.error('[yuqi-team] lifecycle phase=sidecar-close owner=sidecar-domain')
        unbindLifecycle?.()
        if (this.sidecar === repository) this.sidecar = undefined
        repository.dispose()
        this.sidecarSessions.clear()
        await domain.close()
      })()
      this.ctx.effect(() => async () => {
        // Real Host teardown must persist review closures before storage closes.
        // Initialization rollback below owns only this domain, not the Host.
        if (this.reviewer !== undefined) await this.drainReviewShutdown()
        await close()
      })
      try {
        const sessions = harnessSessionAccess(this.ctx)
        for (const session of sessions.list?.() ?? []) {
          try {
            this.bindSidecar(session)
          } catch (cause) {
            // Keep a dual-written legacy record read-only and unavailable,
            // rather than failing every unrelated Team on this profile.
            if (!YuqiTeamOrchestratorService.isSidecarFactConflict(cause)) throw cause
            this.ctx.logger?.warn(`[yuqi-team] disabled conflicting legacy Team record ${JSON.stringify(String(session.id))}`)
          }
        }
        unbindLifecycle = this.ctx.on('session/created', session => {
          this.bindSidecar(session)
          // A parent restored after Host startup may be the only live handle
          // for an already-delivered report whose checkpoint was interrupted.
          // Re-scan durable controller identities so its deterministic inbox
          // message can be acknowledged without sending it again.
          this.scheduleParentReportRecovery(session)
        }, { global: true })
        // Bind only live Sessions during startup.  A profile can retain years
        // of historical controllers; eagerly inflating every one here blocks
        // the first client RPC and turns an otherwise healthy Team surface
        // into a timeout.  Cold identities stay durable and are restored only
        // when an explicit snapshot page asks for that session.
        let persistedIds: Set<string> | undefined
        for (const id of repository.listSessionIds()) {
          const session = sessions.get?.(SessionId(id))
          if (session === undefined) {
            // Absence from the live cache does not mean deletion. Consult only
            // native headers, once, without restoring logs or resuming work.
            if (persistedIds === undefined) {
              const persistence = this.ctx.sessionPersistence as HarnessSessionPersistence
              if (typeof persistence.list !== 'function') throw new Error('Native Session enumeration is unavailable')
              const rawHeaders = await persistence.list()
              const headers = extractPersistenceHeaders(rawHeaders)
              const ids = headers.map(header => String(header.id))
              if (ids.some(id => id.length === 0 || id.trim() !== id) || new Set(ids).size !== ids.length) {
                throw new Error('Native Session enumeration contains invalid or duplicate identities')
              }
              persistedIds = new Set(ids)
            }
            if (persistedIds.has(id)) continue
            const stored = repository.readStoredEvents(id)
            if (stored.length === 0) continue
            try {
              const kind = assertRetainableOrphan(stored)
              this.ctx.logger?.warn(`[yuqi-team] retained ${kind} for deleted Session ${JSON.stringify(id)}; no recovery or delivery performed`)
              continue
            } catch (cause) {
              this.ctx.logger?.warn(`[yuqi-team] ignored deleted orphan Session ${JSON.stringify(id)}: ${cause instanceof Error ? cause.message : String(cause)}`)
              continue
            }
          }
          if (String(session.id) !== id) throw new Error('Yuqi sidecar native identity mismatch')
          try {
            this.bindSidecar(session)
          } catch (cause) {
            // A dual-written legacy record is not trustworthy enough for
            // controls, but it must not take every other Team offline.
            if (!YuqiTeamOrchestratorService.isSidecarFactConflict(cause)) throw cause
            this.ctx.logger?.warn(`[yuqi-team] disabled conflicting legacy Team record ${JSON.stringify(id)}`)
          }
        }
        for (const session of this.sidecarSessions.values()) {
          this.scanColdRecoverySession(session)
          if (readTeamEventsFromSession(session).length > 0) this.scheduleParentReportDelivery(String(session.id))
        }
        // A controller can remain cold across a Host restart while its parent
        // conversation is already live. Its final report may have reached the
        // parent just before shutdown, leaving only the controller checkpoint
        // to reconcile. Recover solely the parents named by durable Team
        // bindings; scanning every live conversation would repeatedly walk the
        // whole historical catalog at startup.
        const liveRecoveryParents = new Set<string>()
        for (const controllerSessionId of repository.listSessionIds()) {
          const binding = [...repository.readStoredEvents(controllerSessionId)].reverse()
            .filter(event => event.type === TEAM_PARENT_BINDING_EVENT)
            .map(event => parseTeamParentBindingData(event.data))
            .find(value => value !== undefined)
          if (binding !== undefined && sessions.get?.(SessionId(binding.parentSessionId)) !== undefined) {
            liveRecoveryParents.add(binding.parentSessionId)
          }
        }
        for (const parentSessionId of liveRecoveryParents) {
          const parent = sessions.get?.(SessionId(parentSessionId))
          if (parent !== undefined) this.scheduleParentReportRecovery(parent)
        }
      } catch (cause) {
        logHostCompatibilityFailure(this.ctx, 'sidecar-session-bind', cause)
        await close()
        // A failed initialization must be retryable while the Host remains
        // alive. The rejected promise must not permanently poison later RPCs.
        this.sidecarReady = undefined
        throw cause
      }
    })()
    const ready = this.sidecarReady
    try { await ready } catch (cause) {
      if (this.sidecarReady === ready) this.sidecarReady = undefined
      throw cause
    }
    if (this.sidecar === undefined) throw new Error('Yuqi sidecar is closed')
  }

  private async materializeSidecarSession(session: Session): Promise<void> {
    const persistence = this.ctx.sessionPersistence as unknown as {
      ensureMaterialized?: (session: Session) => Promise<void>
      list?: () => Promise<readonly Session['header'][]>
      create?: (header: Session['header']) => Promise<{ close(): Promise<void> }>
      open?: (id: unknown, access: 'read' | 'write') => Promise<{ close(): Promise<void> }>
    }
    if (typeof persistence?.ensureMaterialized === 'function') {
      try {
        await persistence.ensureMaterialized(session)
        return
      } catch (cause) {
        if (typeof persistence.list !== 'function') throw cause
        const rawHeaders = await persistence.list()
        const headers = extractPersistenceHeaders(rawHeaders)
        if (headers.some(header => String(header.id) === String(session.id)
          && isDeepStrictEqual(header, session.header))) return
        throw cause
      }
    }
    if (typeof persistence?.create === 'function') {
      try {
        const handle = await persistence.create(session.header)
        await handle.close()
        return
      } catch (cause: unknown) {
        if (cause instanceof Error && (cause.name === 'SessionAlreadyExistsError' || cause.message.includes('already exists'))) {
          return
        }
        if (typeof persistence.list === 'function') {
          const rawHeaders = await persistence.list()
          const headers = extractPersistenceHeaders(rawHeaders)
          if (headers.some(header => String(header.id) === String(session.id))) return
        }
        throw cause
      }
    }
    if (typeof persistence?.list === 'function') {
      const rawHeaders = await persistence.list()
      const headers = extractPersistenceHeaders(rawHeaders)
      if (headers.some(header => String(header.id) === String(session.id))) return
    }
    const sessions = this.ctx.sessions as unknown as { flush?(session: Session): Promise<boolean> }
    if (typeof sessions?.flush === 'function') {
      try {
        await sessions.flush(session)
      } catch {}
    }
  }

  private readonly readSidecarSnapshot: TeamSidecarReader = async (selection, options) => {
    let stage: SidecarReadStage = 'initialize'
    try {
    await this.ensureSidecarReady()
    const signal = options?.signal
    signal?.throwIfAborted()
    if (this.sidecar === undefined) return { mode: 'legacy', sessions: [] }
    stage = 'catalog'
    const access = harnessSessionAccess(this.ctx)
    const unscoped = selection === undefined
    // The first panel read is a bounded durable Team catalog.  Cold controller
    // identities are included so a Host restart does not turn real history
    // into an apparently healthy empty list.  Each entry below is inspected
    // without acquiring a resume reservation; no cold controller is run.
    const ids = [...new Set(selection ?? [
      // Binding an empty native Session is deliberately cheap and happens for
      // every visible chat.  It does not make that chat a Team candidate.
      // Only stored Team facts belong in the unscoped, first-paint snapshot.
      ...[...this.sidecarSessions.keys()].filter(id => (this.sidecar?.readStoredEvents(id).length ?? 0) > 0),
      ...this.sidecar.listSessionIds(),
      ...(access.list?.() ?? []).filter(session => readSessionEvents(session).some(event => event.type.startsWith('yuqi/'))).map(session => String(session.id)),
    ])].sort()
    const selectionKey = createHash('sha256').update(JSON.stringify(selection === undefined ? null : [...selection].sort())).digest('hex')
    stage = 'cursor'
    let after: string | undefined
    if (options?.cursor !== undefined) {
      const decoded: unknown = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'))
      if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== selectionKey || typeof decoded[1] !== 'string') {
        throw new Error('Invalid sidecar cursor')
      }
      after = decoded[1]
    }
    const eligible = ids.filter(id => after === undefined || id > after)
    const page = eligible.slice(0, options?.limit ?? 200)
    const records: { sessionId: string; source: 'sidecar' | 'legacy' | 'unavailable'; events: readonly SessionEvent[] }[] = []
    let bytes = 0
    let last: string | undefined
    // A durable catalog can contain many cold controllers.  Inspecting them
    // one at a time made an otherwise healthy first panel read exceed the
    // browser RPC timeout.  These are read-only restores; run them together
    // and preserve the catalog order when constructing the response.
    let persistedHeaders: Promise<ReadonlyMap<string, Session['header']>> | undefined
    const headerForColdSidecar = async (id: string): Promise<Session['header'] | undefined> => {
      persistedHeaders ??= (async () => {
        const persistence = this.ctx.sessionPersistence as HarnessSessionPersistence
        if (typeof persistence.list !== 'function') throw new Error('Native Session enumeration is unavailable')
        const headers = extractPersistenceHeaders(await persistence.list())
        const entries = headers.map(header => [String(header.id), header] as const)
        if (entries.some(([identity]) => identity.length === 0 || identity.trim() !== identity)
          || new Set(entries.map(([identity]) => identity)).size !== entries.length) {
          throw new Error('Native Session enumeration contains invalid or duplicate identities')
        }
        return new Map(entries)
      })()
      return (await persistedHeaders).get(id)
    }
    const inspected = await Promise.all(page.map(async id => {
      stage = 'native-load'
      signal?.throwIfAborted()
      let session: Session | undefined
      try {
        session = access.get?.(SessionId(id))
        // The unscoped first-paint catalog is a sidecar read model. Restoring
        // every indexed native transcript here turns a harmless panel read
        // into concurrent recovery of years of history. Verify a cold record's
        // identity against the lightweight header catalog, then return only
        // its already durable sidecar facts. Explicit selection remains the
        // recovery/read path that may inspect a complete native session.
        const storedSidecarEvents = session === undefined && unscoped ? this.sidecar!.readStoredEvents(id) : undefined
        if (storedSidecarEvents !== undefined && storedSidecarEvents.length > 0) {
          if (await headerForColdSidecar(id) === undefined) {
            return { sessionId: id, source: 'unavailable' as const, events: [] }
          }
          return { sessionId: id, source: 'sidecar' as const, events: storedSidecarEvents }
        }
        session ??= await this.loadPersistedControllerSession(id, signal, true)
      } catch (error) {
        signal?.throwIfAborted()
        // Scope degradation to the Host's explicit corruption diagnostic, not
        // identity mismatches, permissions, transport or repository failures.
        // Never move/delete native logs or invent a healthy legacy projection.
        const kind = YuqiTeamOrchestratorService.recoverableNativeSessionReadKind(error, id)
        if (kind === undefined) throw error
        this.ctx.logger?.warn(`[yuqi-team] isolated unreadable native Session ${JSON.stringify(id)} (${kind}); Team controls disabled for this record`)
        return { sessionId: id, source: 'unavailable' as const, events: [] }
      }
      if (session === undefined) return undefined
      if (String(session.id) !== id) throw new Error('Yuqi sidecar native identity mismatch')
      stage = 'sidecar-bind'
      try {
        this.bindSidecar(session)
      } catch (cause) {
        if (!YuqiTeamOrchestratorService.isSidecarFactConflict(cause)) throw cause
        return { sessionId: id, source: 'unavailable' as const, events: [] }
      }
      stage = 'session-facts'
      const events = hasSidecarSession(session) ? readYuqiSessionEvents(session) : []
      return { sessionId: id, source: hasSidecarSession(session) ? 'sidecar' as const : 'legacy' as const, events }
    }))
    for (let index = 0; index < inspected.length; index += 1) {
      const id = page[index]!
      const record = inspected[index]
      if (record === undefined) {
        // Advance over an absent cold entry.  Otherwise every later cursor
        // repeats it forever and historical Team pages can never complete.
        last = id
        continue
      }
      stage = 'serialization'
      const size = Buffer.byteLength(JSON.stringify(record), 'utf8')
      // Leave overhead for the envelope; split only between complete streams.
      if (bytes + size > 15 * 1024 * 1024 && records.length > 0) break
      records.push(record)
      bytes += size
      last = record.sessionId
    }
    return {
      mode: 'sidecar',
      sessions: records,
      ...(last !== undefined && eligible.some(id => id > last!)
        ? { nextCursor: Buffer.from(JSON.stringify([selectionKey, last])).toString('base64url') } : {}),
    }
    } catch (cause) {
      markSidecarReadFailure(cause, stage)
      throw cause
    }
  }

  constructor(ctx: Context) {
    super(ctx, 'yuqiTeamOrchestrator')
    logHostCompatibilityReport(ctx)
    ctx.inject(['storageDomain' as never], storageCtx => {
      this.storageDomain = (storageCtx as unknown as {
        storageDomain?: { open(spec: typeof ownedEventDomainSpec): Promise<{ table(name: 'sessions'): OwnedEventTable; close(): Promise<void> }> }
      }).storageDomain
      return this.ensureSidecarReady()
    })
    ctx.inject(['connection'] as never, connectionCtx => {
      installTeamSidecarWebApi(connectionCtx, this.readSidecarSnapshot,
        (teamId, controllerSessionId, signal) => this.recoverColdTarget(teamId, controllerSessionId, signal),
        (teamId, controllerSessionId, signal) => this.resolveColdTargetParent(teamId, controllerSessionId, signal))
    })
    registerTeamSessionProjection(ctx)
    this.directWorkspaceOwnership = new DirectWorkspaceOwnershipGuard({
      workspaces: this.directWorkspaces,
      sessions: { list: () => {
        const sessions = new Map(this.sidecarSessions)
        for (const session of harnessSessionAccess(ctx).list?.() ?? []) sessions.set(String(session.id), session)
        return [...sessions.values()]
      } },
      persistence: ctx.sessionPersistence as DirectWorkspaceSessionPersistence,
      // A restarted Host has no surviving child-run process ownership. Normal
      // direct starts therefore check current live Sessions only; replaying
      // archived controller histories can otherwise block startup for minutes.
      scanColdHistory: false,
    })
    // Controller creation/recovery is an optional Host capability. Keeping it
    // behind an injected binding lets headless/test compositions load the
    // service without changing ordinary Harness behavior; Team start/control
    // still fail closed when the capabilities are absent.
    ctx.inject(['agents', 'agentPresets'], (controllerCtx) => {
      const agents = controllerCtx.agents
      const presets = controllerCtx.get('agentPresets' as never) as unknown as AgentPresetMountPort
      const launcher = new HarnessTeamControllerLauncher(agents, presets)
      this.controllerAgents = agents
      this.controllerLauncher = launcher
      const sessions = harnessSessionAccess(controllerCtx)
      for (const session of sessions.list?.() ?? []) {
        this.scanColdRecoverySession(session)
        this.scheduleParentReportRecovery(session)
      }
      controllerCtx.on('agent/created', ({ agent }) => { this.scheduleParentReportRecovery(agent.session) })
      controllerCtx.effect(() => () => {
        if (this.controllerLauncher === launcher) {
          this.controllerLauncher = undefined
          this.controllerAgents = undefined
        }
      }, 'yuqiTeamOrchestrator.controllerCapabilities')
    })
    this.modelCatalog = new HarnessModelCatalogPort(ctx)
    this.reviewer = new HarnessReviewAgent(ctx, this.workspacePorts, this.modelCatalog, id => this.controllerAgents?.get(id),
      (controllerId, reviewId) => {
        void this.closeStoppedReview(controllerId, reviewId).catch(cause => {
          this.ctx.logger.error(`[yuqi-team] confirmed reviewer stop could not be persisted: ${renderErrorChain(cause)}`)
        })
      })
    this.runtimeObservations = new HarnessAttemptRuntimeObservationPort(ctx)
    this.installColdRecoveryScanner(ctx)
    ctx.inject(['settings'], (settingsCtx) => {
      // modelRouting is a discriminated compound value.  It must not be a
      // recursively merged composition base: a user override for `inherit` or
      // `fixed` would otherwise inherit automatic's tierCandidates (or a
      // provider allowlist) before strict schema validation. Legacy scalar
      // defaults still normalize to the same empty automatic policy.
      const { modelRouting: _modelRouting, ...settingsDefaultsWithoutRouting } = DEFAULT_TEAM_SETTINGS
      const settingsBase: TeamSettings = {
        ...settingsDefaultsWithoutRouting,
        reviewPolicy: { ...DEFAULT_TEAM_SETTINGS.reviewPolicy! },
      }
      installSettingsSection(settingsCtx, TEAM_SETTINGS_NAMESPACE, TEAM_SETTINGS_SCHEMA, settingsBase, {
        setSource: source => { this.teamSettingsSource = source },
        onChange: () => undefined,
        validate: settings => {
          assertTeamConcurrency(settings.maxConcurrency)
          assertChildPresetId(settings.childPresetId)
          normalizeTeamReviewPolicy(settings)
        },
      })
      settingsCtx.inject(['apiProxy'], installTeamSettingsWebApi)
      const scopes = new TeamSettingsScopes(settingsCtx)
      this.teamSettingsScopes = scopes
      settingsCtx.effect(() => () => {
        if (this.teamSettingsScopes === scopes) this.teamSettingsScopes = undefined
      }, 'yuqiTeamOrchestrator.settingsScopeSource')
      settingsCtx.inject(['connection'] as never, scopeCtx => {
        installTeamSettingsScopes(scopeCtx, scopes)
      })
    })
    ctx.effect(() => () => this.disposeHost(), 'yuqiTeamOrchestrator.dispose')
  }

  /** Read at Team admission time so a saved setting constrains the next Team only. */
  maxConcurrencyLimit(): number {
    const value = this.teamSettingsSource().maxConcurrency
    assertTeamConcurrency(value)
    return value
  }

  /** Snapshot defaults once at Team admission; running Teams never hot-switch composition. */
  teamDefaults(sessionId?: string): TeamSettings {
    const settings = sessionId === undefined || this.teamSettingsScopes === undefined
      ? this.teamSettingsSource() : this.teamSettingsScopes.resolve(sessionId)
    assertTeamConcurrency(settings.maxConcurrency)
    assertChildPresetId(settings.childPresetId)
    return settings
  }

  /** Execute only after exact workspace, sandbox, model, and file-lease gates pass. */
  async executeGatedBatch(request: HarnessGatedExecuteBatchRequest): Promise<ExecuteTeamBatchResult> {
    await this.ensureSidecarReady()
    const journal = this.journalFor(request.controller)
    let projection = replayTeamEvents(journal.read())
    const scheduleAnchorLength = journal.read().length
    if (projection.team.reviewPolicy?.mode === 'quality-gate') {
      const firstEvent = journal.read()[0]
      const planEventId = firstEvent === undefined ? projection.lastEventId : parseTeamEvent(firstEvent).eventId
      const planReady = await this.coordinateReviewCheckpoint({
        controller: request.controller,
        teamId: request.teamId,
        journal,
        target: {
          subject: 'team-plan', candidateEventId: planEventId, anchor: { eventId: planEventId },
          automaticReworkBudget: reviewBudget(projection), independentReviewerRequired: true,
        },
        signal: combinedSignal(request.children),
      })
      if (!planReady) return skippedBatchResult(request.children)
      projection = replayTeamEvents(journal.read())
      const reviewedDependencies = new Set<string>()
      for (const child of request.children) {
        const task = projection.tasks[child.taskId]
        for (const dependencyId of task?.contract.dependencies ?? []) {
          const dependency = projection.tasks[dependencyId]
          const attemptId = dependency?.attemptIds.at(-1)
          if (dependency?.status !== 'completed' || attemptId === undefined || reviewedDependencies.has(String(attemptId))) continue
          reviewedDependencies.add(String(attemptId))
          const anchorEventId = attemptEvidenceEventId(journal.read(), String(dependencyId), String(attemptId))
          const dependencyReady = await this.coordinateReviewCheckpoint({
            controller: request.controller,
            teamId: request.teamId,
            journal,
            target: {
              subject: 'task-attempt', candidateEventId: anchorEventId,
              anchor: { eventId: anchorEventId, taskId: String(dependencyId), attemptId: String(attemptId) },
              automaticReworkBudget: reviewBudget(projection), independentReviewerRequired: true,
            },
            signal: combinedSignal(request.children),
          })
          if (!dependencyReady) return skippedBatchResult(request.children)
          projection = replayTeamEvents(journal.read())
        }
      }
      // A durable review request/result legitimately advances the projection.
      // The caller's schedule was computed before those events existed, so
      // finish this cycle without admission and let the runner re-plan from
      // the reviewed cut instead of misclassifying it as STALE_SCHEDULE.
      if (journal.read().length !== scheduleAnchorLength) return skippedBatchResult(request.children)
    }
    const tasks = request.children.map(child => {
      const task = projection.tasks[child.taskId]
      if (task === undefined) throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', `Task ${child.taskId} is not in this Team`)
      return task
    })
    const authorityModes = new Set(tasks.map(task => task.contract.authorityMode))
    if (authorityModes.size !== 1) {
      throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'One gated batch cannot mix child permission modes')
    }
    const signal = combinedSignal(request.children)
    const verifiedWorkspace = await this.workspaceCoordinatorFor(projection.workspace).verifyReady({
      teamId: request.teamId,
      workspaceId: request.workspaceId,
      worktreePath: request.worktreePath,
      signal,
    }, journal)
    const authorityMode = tasks[0]!.contract.authorityMode
    const sandboxMode: ChildExecutionBoundary['sandboxMode'] = authorityMode === 'full-access'
      ? 'danger-full-access'
      : authorityMode === 'write-authorized' ? 'workspace-write' : 'read-only'
    // fileScope is a planning/conflict hint, not a filesystem capability.
    // Writable children may touch every necessary file inside the exact Team
    // worktree; the sandbox and durable workspace identity remain the hard
    // boundary. This also lets later batches observe edits discovered at run
    // time instead of rejecting them as external drift.
    const allowedDirtyScopes = authorityMode === 'read-only' ? teamOwnedDirtyScopes(projection) : ['**']
    const executionBoundary: ChildExecutionBoundary = {
      cwd: workspaceProjectRoot(verifiedWorkspace), sandboxMode, workspace: verifiedWorkspace, allowedDirtyScopes,
      fileScopeSemantics: 'planned-contract-only',
      actualWriteAttribution: 'unavailable',
    }
    // Harness continuable children inherit the parent's effective sandbox at
    // admission time. Pin the controller to this homogeneous batch before the
    // boundary proof so read-only work cannot inherit a wider default.
    setSandboxMode(request.controller.session, sandboxMode)
    await verifyHarnessExecutionBoundary(this.ctx, request.controller, executionBoundary)

    const fixedModels = await Promise.all(request.children.map((child, index) => child.route === undefined
      ? resolveFixedModelFromPort(tasks[index]!.contract.modelRole, child.modelPolicy, this.modelCatalog, child.signal)
      : Promise.resolve(routeAsFixedModel(child.route, tasks[index]!.contract.modelRole))))
    return this.batchExecutor.execute({
      teamId: request.teamId,
      plan: request.plan,
      maxConcurrency: request.maxConcurrency,
      execution: { workspaceId: request.workspaceId, worktreePath: request.worktreePath },
      // Model resolution can yield to other local work. Re-prove the exact
      // workspace after durable batch intent but before any child starts.
      // All parallel children share this one proof.
      beforeAdmission: async () => {
        await this.workspaceCoordinatorFor(projection.workspace).verifyReady({
          teamId: request.teamId,
          workspaceId: request.workspaceId,
          worktreePath: request.worktreePath,
          signal,
        }, journal)
      },
      children: request.children.map((child, index) => {
        const fixed = fixedModels[index]!
        return {
          taskId: child.taskId,
          attemptId: child.attemptId,
          ...(child.taskOutcomeVersion === undefined ? {} : { taskOutcomeVersion: child.taskOutcomeVersion }),
          leaseId: child.leaseId,
          fixedModel: fixed,
          subagentProvider: fixed.subagentProvider,
          modelProvider: fixed.modelProvider,
          modelId: fixed.modelId,
          ...(child.route === undefined ? {} : {
            route: child.route.route,
            routeBasis: child.route.routeBasis,
            ...(child.route.requestedTier === undefined ? {} : { requestedTier: child.route.requestedTier }),
            ...(child.route.fallbackReason === undefined ? {} : { fallbackReason: child.route.fallbackReason }),
            catalogEvidence: child.route.catalogEvidence,
          }),
          ...(child.tokenReserve === undefined ? {} : { tokenReserve: child.tokenReserve }),
          label: child.label,
          prompt: child.prompt,
          signal: child.signal,
          executionBoundary,
        }
      }),
    }, journal, this.childPort(request.controller))
  }

  /** Resolve a fresh route for one attempt from durable intent and current catalog metadata. */
  async resolveTaskModelRoute(request: {
    readonly controller: Agent
    readonly teamId: string
    readonly taskId: string
    readonly signal?: AbortSignal
  }): Promise<HarnessResolvedModelRoute | undefined> {
    request.signal?.throwIfAborted()
    const projection = this.projectionForTeam(this.journalFor(request.controller), request.teamId)
    const task = projection.tasks[request.taskId]
    if (task === undefined) throw new YuqiOrchestratorError('INVALID_BATCH', `Task ${request.taskId} does not exist`)
    const policy = projection.team.modelRouting
    // Legacy Team-created events did not snapshot a policy. Continue their
    // old flat route without manufacturing a structured decision basis.
    if (policy === undefined) return undefined
    const controllerModel = durableControllerRoute(projection, request.controller)
    const taskRequest = modelRequestForTask(task.contract)
    const automaticTier = policy.teamPolicy.kind === 'automatic'
      ? automaticTierForTaskRequest(taskRequest)
      : undefined
    const catalogEvidence = automaticTier === undefined || policy.teamPolicy.kind !== 'automatic'
      ? await this.modelCatalog.inspectRoutes(
          routingCandidates(controllerModel, policy.providerScope, policy.teamPolicy, taskRequest), request.signal,
        )
      : await this.modelCatalog.inspectAutomaticRoutes({
          configuredCandidates: policy.teamPolicy.tierCandidates[automaticTier],
          controllerModel,
          providerScope: policy.providerScope,
        }, request.signal)
    try {
      const failedModels = []
      if (automaticTier !== undefined) {
        for (const id of task.attemptIds) {
          const attempt = projection.attempts[id]!
          if (attempt.status !== 'failed' || !attempt.agentSessionId || attempt.evidence?.stopReason !== 'error'
            || attempt.evidence.hasAssistantOutput) continue
          const model = { modelProvider: attempt.modelProvider, modelId: attempt.modelId }
          if (projection.taskRetryOperations[`${MODEL_CALL_RETRY_PREFIX}${id}`]?.taskId === task.contract.taskId
            || await readModelCallFailure(this.ctx, attempt.agentSessionId, String(request.controller.session.id), model)) failedModels.push(model)
        }
      }
      request.signal?.throwIfAborted()
      const resolved = resolveModelRoute({
        controllerModel,
        providerScope: policy.providerScope,
        teamPolicy: policy.teamPolicy,
        taskRequest,
        catalog: catalogEvidence,
        failedModels,
      })
      return Object.freeze({
        route: resolved.model,
        routeBasis: resolved.basis,
        ...(resolved.requestedTier === undefined ? {} : { requestedTier: resolved.requestedTier }),
        ...(isFallbackReason(resolved.reason) ? { fallbackReason: resolved.reason } : {}),
        catalogEvidence,
      })
    } catch (cause) {
      if (cause instanceof ModelRoutingError) {
        throw new YuqiOrchestratorError('FIXED_MODEL_UNAVAILABLE', cause.message, { cause })
      }
      throw cause
    }
  }

  /** Retry only completed, output-free provider failures; never override user control. */
  async retrySafeModelCalls(request: { readonly controller: Agent; readonly teamId: string; readonly signal: AbortSignal }): Promise<void> {
    const journal = this.journalFor(request.controller)
    const snapshot = [...journal.read()]
    const projection = this.projectionForTeam(journal, request.teamId)
    for (const taskId of projection.taskIds) {
      request.signal.throwIfAborted()
      if (!canRetryModelCall(projection, taskId)) continue
      const task = projection.tasks[taskId]!
      const latestId = task.attemptIds.at(-1)!
      const facts = snapshot as readonly TeamEvent[]
      const createdAt = facts.findIndex(event => event.type === 'yuqi/attempt-created' && event.attemptId === latestId)
      if (createdAt < 0 || facts.slice(createdAt + 1).some(event => event.type === 'yuqi/team-control-requested'
        || event.type === 'yuqi/task-revised' || event.type === 'yuqi/task-manual-acquired'
        || event.type === 'yuqi/task-manual-returned')) continue
      const lastStatus = facts.findLast(event => event.type === 'yuqi/team-status-changed')
      if (projection.team.status === 'paused' && (lastStatus?.type !== 'yuqi/team-status-changed'
        || lastStatus.to !== 'paused' || lastStatus.reason !== 'controller decision required for failed, cancelled, or blocked tasks')) continue
      let safe = true
      let failureCode = '', failureStatus = 0
      for (const id of task.attemptIds) {
        const attempt = projection.attempts[id]!
        const failure = await readModelCallFailure(this.ctx, attempt.agentSessionId!, String(request.controller.session.id), {
          modelProvider: attempt.modelProvider, modelId: attempt.modelId,
        })
        if (!failure) { safe = false; break }
        failureCode = failure.code; failureStatus = failure.status
      }
      if (!safe) continue
      let route: HarnessResolvedModelRoute | undefined
      try { route = await this.resolveTaskModelRoute({ ...request, taskId }) } catch (error) {
        request.signal.throwIfAborted()
        if (error instanceof YuqiOrchestratorError && error.code === 'FIXED_MODEL_UNAVAILABLE') continue
        throw error
      }
      if (!route || task.attemptIds.some(id => {
        const attempt = projection.attempts[id]!
        return attempt.modelProvider === route.route.modelProvider && attempt.modelId === route.route.modelId
      })) continue
      const operationId = ControlOperationId(`${MODEL_CALL_RETRY_PREFIX}${latestId}`)
      await this.transactions.run(journal, async transaction => {
        request.signal.throwIfAborted()
        const now = transaction.read()
        // Any concurrent control, policy, usage or settlement change invalidates
        // this preflight. The next runner pass may re-evaluate from fresh facts.
        if (now.length !== snapshot.length || replayTeamEvents(now).lastEventId !== projection.lastEventId) return
        if (!canRetryModelCall(replayTeamEvents(now), taskId)) return
        const diagnostic = `Safe model fallback / 安全模型切换; diagnostic data / 诊断数据: ${JSON.stringify({
          taskId, attemptId: latestId, code: failureCode, status: failureStatus, next: route.route,
        })}`
        const events: TeamEvent[] = [createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
          type: 'yuqi/task-retry-requested', taskId, operationId,
        }), createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
          type: 'yuqi/team-status-changed', from: 'paused', to: 'running', reason: diagnostic,
        })]
        // Existing projection validation owns all attempt/lease/budget gates.
        validateTeamEvents(now, events)
        await transaction.commit(events, 'INTENT_PERSISTENCE_FAILED', 'Could not persist safe model retry')
      })
      return // One decision per fresh cut; no cascading retries on a stale snapshot.
    }
  }

  /** Atomically create the durable Team and its initial task graph. */
  async bootstrapTeam(request: HarnessBootstrapTeamRequest) {
    // Keep the pure bootstrap boundary usable by the start coordinator's
    // contract tests. A real service instance always owns this capability;
    // the guarded form does not weaken the Host path.
    if (typeof this.ensureSidecarReady === 'function') await this.ensureSidecarReady()
    if (typeof this.bindSidecar === 'function') this.bindSidecar(request.controller.session)
    if (hasSidecarSession(request.controller.session)) {
      await this.materializeSidecarSession(request.controller.session)
    }
    this.assertVerificationReadiness(request.tasks)
    assertYuqiSessionEventCompatibility(request.controller.session)
    const bootstrap: BootstrapTeamRequest = 'metadata' in request
      ? { metadata: request.metadata, tasks: request.tasks, ...(request.requirePlanConfirmation === true ? { requirePlanConfirmation: true } : {}) }
      : {
          teamId: request.teamId,
          title: request.title,
          objective: request.objective,
          ...(request.continuedFrom === undefined ? {} : { continuedFrom: request.continuedFrom }),
          ...(request.locale === undefined ? {} : { locale: request.locale }),
          ...(request.maxConcurrency === undefined ? {} : { maxConcurrency: request.maxConcurrency }),
          ...(request.controllerModel === undefined ? {} : { controllerModel: request.controllerModel }),
          ...(request.directWriteStrategy === undefined ? {} : { directWriteStrategy: request.directWriteStrategy }),
          ...(request.reviewPolicy === undefined ? {} : { reviewPolicy: request.reviewPolicy }),
          ...(request.modelRouting === undefined ? {} : { modelRouting: request.modelRouting }),
          ...(request.requirePlanConfirmation === true ? { requirePlanConfirmation: true } : {}),
          tasks: request.tasks,
        }
    return this.teamBootstrap.bootstrap(
      bootstrap,
      this.journalFor(request.controller),
    )
  }

  /** Durably create and start verification for one settled child attempt. */
  beginVerification(request: HarnessBeginVerificationRequest) {
    const { controller, ...verification } = request
    return this.verificationStarts.begin(
      verification,
      this.journalFor(controller),
    )
  }

  /** Continuously dispatch and settle the durable Team until it stops or needs verified input. */
  async runTeam(request: HarnessRunTeamRequest): Promise<RunTeamLoopResult> {
    const journal = this.journalFor(request.controller)
    const projection = replayTeamEvents(journal.read())
    if (projection.team.id !== request.teamId) {
      throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${request.teamId} does not own this controller journal`)
    }
    if (projection.team.status === 'running') this.assertVerificationReadiness(Object.values(projection.tasks).map(task => task.contract))
    const directWriteStrategy = request.directWriteStrategy ?? projection.team.directWriteStrategy
    return this.teamRunnerSupervisor.run({
      journalKey: journal.key,
      teamId: request.teamId,
      controller: request.controller,
      maxConcurrency: request.maxConcurrency,
      directWriteStrategy,
      ...(request.maxCycles === undefined ? {} : { maxCycles: request.maxCycles }),
      ...(request.disposeController === undefined ? {} : { disposeController: request.disposeController }),
      run: signal => this.runTeamPass({ ...request, directWriteStrategy }, journal, signal),
    }, request.signal)
  }

  /**
   * Start a Team under Host-owned runner lifetime and return the current
   * durable projection immediately. The originating model tool must remain
   * usable while children continue in the background.
   */
  launchTeamInBackground(request: Omit<HarnessRunTeamRequest, 'signal'>): RunTeamLoopResult {
    const journal = this.journalFor(request.controller)
    const projection = this.projectionForTeam(journal, request.teamId)
    const operation = this.runTeam(request)
    void operation.then(result => {
      if (result.disposition === 'recoverable' && result.projection.team.status === 'running') {
        void this.markBackgroundRunnerFailure(
          journal,
          request.teamId,
          'initial launch',
          new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', `Runner stopped with ${result.reason}`),
        )
      }
    }, cause => {
      this.ctx.logger.error(`[yuqi-team] background runner failed after initial launch: ${renderErrorChain(cause)}`)
      void this.markBackgroundRunnerFailure(journal, request.teamId, 'initial launch', cause)
    })
    return { projection, reason: 'background-started', disposition: 'started', cycles: 0 }
  }

  private async runTeamPass(
    request: HarnessRunTeamRequest,
    journal: TeamEventJournal,
    signal: AbortSignal,
  ): Promise<RunTeamLoopResult> {
    signal.throwIfAborted()
    // The loop stops immediately on paused, including already-settled passes.
    await this.retrySafeModelCalls({ controller: request.controller, teamId: request.teamId, signal })
    const progress = new HarnessTeamProgressAdapter(this.ctx, {
      controller: request.controller,
      waitForLocalAttempts: (journalKey, attemptIds, signal) => this.batchExecutor.waitForAttempts(journalKey, attemptIds, signal),
      waitForAnyLocalAttempt: (journalKey, attemptIds, signal) => this.batchExecutor.waitForAnyAttempt(journalKey, attemptIds, signal),
      ownsLocalAttempt: (journalKey, attemptId) => this.batchExecutor.hasActiveAttempt(journalKey, attemptId),
      settleAttempt: observed => this.settleObservedAttempt(observed),
      reconcile: observed => this.reconcileProgress(request.controller, observed),
    })
    const driver = new HarnessTeamRunCyclePort(this, {
      controller: request.controller,
      waitForProgress: observed => this.journalProgressWake.wait(journal.key, observed.signal, () => {
        const current = replayTeamEvents(journal.read())
        const plan = planTeamSchedule(current, {
          maxConcurrency: request.maxConcurrency,
          ...(request.directWriteStrategy === undefined ? {} : { directWriteStrategy: request.directWriteStrategy }),
        })
        return plan.status === 'runnable' && plan.dispatchTaskIds.some(id => {
          const task = current.tasks[id]!
          return !Object.values(current.fileLeases).some(lease => lease.status === 'active'
            && (lease.mode === 'write' || task.contract.authorityMode !== 'read-only')
            && fileScopeSetsConflict(lease.fileScope, task.contract.fileScope))
        })
      }, observationSignal => progress.waitForProgress({ ...observed, signal: observationSignal })),
    })
    return this.teamRuns.run({
      teamId: request.teamId,
      journal,
      maxConcurrency: request.maxConcurrency,
      ...(request.directWriteStrategy === undefined ? {} : { directWriteStrategy: request.directWriteStrategy }),
      driver,
      ...(request.maxCycles === undefined ? {} : { maxCycles: request.maxCycles }),
      signal,
    })
  }

  /** Materialize scheduler-derived state through the service's shared durability boundary. */
  async persistScheduleState(request: TeamRunScheduleStateRequest): Promise<void> {
    request.signal.throwIfAborted()
    await this.transactions.run(request.journal, async transaction => {
      request.signal.throwIfAborted()
      const current = replayTeamEvents(transaction.read())
      if (current.team.id !== request.teamId) {
        throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${request.teamId} does not own this controller journal`)
      }
      if (current.lastEventId !== request.plan.sourceLastEventId || current.lastEventAt !== request.plan.sourceLastEventAt) {
        throw new YuqiOrchestratorError('STALE_SCHEDULE', 'Team scheduling state changed before it could be persisted')
      }
      const events: TeamEvent[] = request.taskTransitions.map(transition => {
        const task = current.tasks[transition.taskId]
        if (task === undefined || task.status !== transition.from) {
          throw new YuqiOrchestratorError('STALE_SCHEDULE', `Task ${transition.taskId} changed before its scheduling state could be persisted`)
        }
        return createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
          type: 'yuqi/task-status-changed',
          taskId: TaskId(transition.taskId),
          from: transition.from,
          to: transition.to,
          reason: transition.reason,
        })
      })
      if (request.requiresReconciliation) {
        if (current.team.status !== 'running') {
          throw new YuqiOrchestratorError('STALE_SCHEDULE', 'Team state changed before reconciliation could be persisted')
        }
        events.push(createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
          type: 'yuqi/team-status-changed',
          from: 'running',
          to: 'needs_reconciliation',
          reason: 'scheduler detected an unsafe or inconsistent durable task graph',
        }))
      }
      validateTeamEvents(transaction.read(), events)
      await transaction.commit(
        events,
        'CONTROLLER_REQUIRES_RECONCILIATION',
        'Yuqi could not durably persist scheduler-derived Team state',
      )
      const persisted = replayTeamEvents(transaction.read())
      for (const transition of request.taskTransitions) {
        if (persisted.tasks[transition.taskId]?.status !== transition.to) {
          throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', `Task ${transition.taskId} scheduling state was not durably materialized`)
        }
      }
      if (request.requiresReconciliation && persisted.team.status !== 'needs_reconciliation') {
        throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'Team reconciliation state was not durably materialized')
      }
    })
    for (const transition of request.taskTransitions) {
      this.queueParentTeamUpdate(request.journal.key, request.teamId, transition.taskId)
    }
  }

  /** Wait for the first durable progress among attempts owned by this exact Host process. */
  waitForProgress(request: TeamRunProgressRequest): Promise<void> {
    const projection = replayTeamEvents(request.journal.read())
    const attemptIds = request.activeTaskIds.map((taskId) => {
      const attemptId = projection.tasks[taskId]?.attemptIds.at(-1)
      if (attemptId === undefined) {
        throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', `Task ${taskId} has no durable active attempt`)
      }
      return String(attemptId)
    })
    return this.batchExecutor.waitForAnyAttempt(request.journal.key, attemptIds, request.signal)
  }

  /** Persist a terminal fact recovered from a public child Session or lifecycle edge. */
  private async settleObservedAttempt(request: HarnessProgressSettlementRequest): Promise<void> {
    let committed = false
    await this.transactions.run(request.journal, async transaction => {
      const current = replayTeamEvents(transaction.read())
      const attemptId = AttemptId(request.attemptId)
      const taskId = TaskId(request.taskId)
      const attempt = current.attempts[attemptId]
      const task = current.tasks[taskId]
      if (request.canSettle !== undefined && !request.canSettle()) return
      if (attempt?.evidence !== undefined) return
      if (attempt === undefined || task === undefined || (attempt.status !== 'running' && attempt.status !== 'unknown') || task.status !== 'running') {
        throw new YuqiOrchestratorError('SETTLEMENT_PERSISTENCE_FAILED', `Attempt ${request.attemptId} is no longer eligible for recovered settlement`)
      }
      if (attempt.agentSessionId !== request.end.childSessionId) {
        throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', `Recovered child ${request.end.childSessionId} does not match attempt ${request.attemptId}`)
      }
      const cancelling = current.team.status === 'cancelling'
        || Object.values(current.controlOperations).some(operation => operation.action === 'cancel'
          || (operation.action === 'stop-task' && operation.taskId === taskId && operation.attemptId === attemptId))
      const decision = decideChildSettlement(request.end, cancelling, task.contract.verificationChecks !== undefined, attempt.taskOutcomeVersion)
      const { attemptStatus: terminalAttemptStatus, taskStatus: terminalTaskStatus, completedWithoutVerification } = decision
      const settledAt = request.end.settledAt ?? this.progressClock.nowIso()
      const events: TeamEvent[] = [
        createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
          type: 'yuqi/attempt-status-changed', taskId, attemptId, from: attempt.status, to: terminalAttemptStatus,
          reason: decision.reason,
        }),
        createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
          type: 'yuqi/attempt-evidence-recorded', taskId, attemptId, runId: request.end.runId,
          agentSessionId: request.end.childSessionId, provider: request.end.provider,
          stopReason: request.end.stopReason, hasAssistantOutput: request.end.hasAssistantOutput,
          ...(request.end.taskOutcome === undefined ? {} : { taskOutcome: request.end.taskOutcome }),
          ...(request.end.reportedChangedFiles === undefined ? {} : { reportedChangedFiles: [...request.end.reportedChangedFiles] }),
          ...(request.end.usage === undefined ? {} : { usage: request.end.usage }), settledAt,
        }),
        ...recoveredBudgetSettlementEvents(this.progressClock, this.progressEventIds, request.teamId, current, taskId, attemptId, request.end),
        ...(completedWithoutVerification ? [createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
          type: 'yuqi/attempt-status-changed', taskId, attemptId, from: 'settled', to: 'completed',
          reason: 'task has no verification checks',
        })] : []),
        createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
          type: 'yuqi/task-status-changed', taskId, from: 'running', to: terminalTaskStatus,
          reason: decision.reason,
        }),
      ]
      const lease = Object.values(current.fileLeases).find(candidate => candidate.status === 'active' && candidate.taskId === taskId && candidate.attemptId === attemptId)
      if (decision.releaseLease && lease !== undefined) {
        events.push(createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
          type: 'yuqi/file-lease-released', leaseId: FileLeaseId(String(lease.leaseId)), taskId, attemptId,
          reason: decision.reason,
        }))
      }
      const projected = validateTeamEvents(transaction.read(), events)
      if (!hasActiveAttempts(projected) && projected.team.status === 'pausing') {
        events.push(createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
          type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused', reason: 'all active attempts settled',
        }))
      } else if (!hasActiveAttempts(projected) && projected.team.status === 'cancelling') {
        events.push(createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
          type: 'yuqi/team-status-changed', from: 'cancelling', to: 'cancelled', reason: 'all active attempts settled',
        }))
      } else if (teamCompletionReady(projected)) {
        events.push(createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
          type: 'yuqi/team-status-changed', from: 'running', to: 'completed',
          reason: 'all tasks completed and the reviewer gate is satisfied',
        }))
      } else if (quiescentRetryableGraphReady(projected)) {
        events.push(
          createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
            type: 'yuqi/team-status-changed', from: 'running', to: 'pausing',
            reason: 'task graph settled with retryable terminal tasks',
          }),
          createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
            type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused',
            reason: 'controller decision required for failed, cancelled, or blocked tasks',
          }),
        )
      }
      validateTeamEvents(transaction.read(), events)
      await transaction.commit(events, 'SETTLEMENT_PERSISTENCE_FAILED', 'Child settled, but Yuqi could not durably persist recovered settlement')
      committed = true
    })
    if (committed) this.queueParentTeamUpdate(request.journal.key, request.teamId, request.taskId)
  }

  private async reconcileProgress(controller: Agent, request: HarnessProgressReconciliationRequest): Promise<boolean> {
    const projection = await this.reconciliations.reconcile({
      teamId: request.teamId,
      parentSessionId: String(controller.id),
      operationId: `progress-reconcile:${randomUUID()}`,
      signal: request.signal,
    }, request.journal, this.runtimeObservations)
    if (projection.team.status !== 'needs_reconciliation') return false
    const recovered = await this.recoverAndContinueTeam({
      controller,
      teamId: request.teamId,
      operationId: `auto-recover:${randomUUID()}`,
      signal: request.signal,
    })
    return recovered.team.status !== 'needs_reconciliation'
  }

  /** Create the fresh top-level Yuqi controller after its worktree is proven ready. */
  launchTeamController(request: HarnessLaunchTeamControllerRequest): Promise<TeamControllerLaunch> {
    if (this.controllerLauncher === undefined) {
      throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'Harness Agent creation or Agent Presets are unavailable')
    }
    return this.controllerLauncher.launch(request)
  }

  /** Resolve a live controller, rehydrating its persisted standard-preset session after Host restart. */
  async resolveTeamController(controllerSessionId: string, fallbackModel?: AgentOptions): Promise<Agent | undefined> {
    const id = controllerSessionId.trim()
    if (!/^yuqi-team-[A-Za-z0-9._:-]{1,118}$/u.test(id)) return undefined
    const live = this.controllerAgents?.get(SessionId(id))
    if (live !== undefined) return live
    const owned = this.recoveredControllers.get(id)
    if (owned !== undefined) return owned.agent
    const pending = this.recoveringControllers.get(id)
    if (pending !== undefined) return pending
    const recovery = this.resumeTeamController(id, fallbackModel)
    this.recoveringControllers.set(id, recovery)
    try {
      return await recovery
    } finally {
      this.recoveringControllers.delete(id)
    }
  }

  private async resumeTeamController(controllerSessionId: string, fallbackModel?: AgentOptions): Promise<Agent | undefined> {
    if (this.controllerLauncher === undefined) return undefined
    try {
      const session = await traceControllerResume('native-load', async () => harnessSessionAccess(this.ctx).get?.(SessionId(controllerSessionId))
        ?? await this.loadPersistedControllerSession(controllerSessionId))
      const persistedPreset = session?.header.agentPreset
      const events = session === undefined ? [] : readTeamEventsFromSession(session)
      const persistedModel = events.length === 0 ? undefined : replayTeamEvents(events).team.controllerModel
      const recoveredModel = persistedModel ?? validAgentModel(fallbackModel)
      if (recoveredModel === undefined) {
        throw new YuqiOrchestratorError(
          'CONTROLLER_REQUIRES_RECONCILIATION',
          'Persisted Team controller has no recoverable model provider',
        )
      }
      const launcher = this.controllerLauncher
      const launched = await traceControllerResume('launcher', () => launcher.resume(controllerSessionId, persistedPreset, undefined, recoveredModel))
      this.recoveredControllers.set(controllerSessionId, launched.handle)
      return launched.handle.agent
    } catch (cause) {
      this.ctx.logger.warn(`[yuqi-team] controller ${controllerSessionId} could not be resumed for control: ${renderErrorChain(cause)}`)
      return undefined
    }
  }

  /** Prepare the selected physical workspace and a fresh controller-owned durable Team. */
  async startTeam(request: HarnessStartTeamRequest): Promise<HarnessStartedTeam> {
    request = { ...request, signal: AbortSignal.any([this.teamStartShutdown.signal, ...(request.signal === undefined ? [] : [request.signal])]) }
    return this.teamStartGate.run(request.controllerParentSessionId ?? request.projectCwd, async () => {
      const parent = request.controllerParentSessionId === undefined ? undefined
        : harnessSessionAccess(this.ctx).get?.(SessionId(request.controllerParentSessionId))
      if (parent !== undefined) {
        this.bindSidecar(parent)
        const active = selectActiveTeamProjectionBridge(readYuqiSessionEvents(parent))
        if (active !== undefined && !['completed', 'failed', 'cancelled'].includes(replayTeamEvents(active.events).team.status)) {
          throw new YuqiOrchestratorError('CONTROLLER_BUSY', 'This conversation already has an active Team')
        }
      }
      return this.prepareTeam(request)
    })
  }

  /** Start from a terminal source without reactivating its runner or weakening workspace admission. */
  async startFollowupTeam(request: HarnessStartTeamRequest, source: HarnessFollowupSource) {
    request = { ...request, signal: AbortSignal.any([this.teamStartShutdown.signal, ...(request.signal === undefined ? [] : [request.signal])]) }
    return this.teamStartGate.run(request.controllerParentSessionId ?? request.projectCwd, () => this.prepareFollowupTeam(request, source))
  }

  private async prepareFollowupTeam(request: HarnessStartTeamRequest, source: HarnessFollowupSource) {
    await this.ensureSidecarReady()
    const parentId = request.controllerParentSessionId
    const parent = parentId === undefined ? undefined : harnessSessionAccess(this.ctx).get?.(SessionId(parentId))
    if (parent === undefined || String(parent.id) !== parentId) throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'Follow-up requires the exact live parent conversation')
    this.bindSidecar(parent)
    const session = harnessSessionAccess(this.ctx).get?.(SessionId(source.controllerSessionId))
      ?? await this.loadPersistedControllerSession(source.controllerSessionId)
    if (session !== undefined) this.bindSidecar(session)
    if (session === undefined || String(session.id) !== source.controllerSessionId || readActiveTeamParentBinding(session)?.parentSessionId !== parentId) {
      throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'Source Team does not belong to this parent conversation')
    }
    // Source-only bookkeeping must not publish an old terminal bridge over the new Team.
    const journal = this.journalForSession(session, this.persistenceOnlySessionStore(), false)
    const projection = this.projectionForTeam(journal, source.teamId)
    const { signal: _signal, ...facts } = request
    const requestDigest = source.requestDigest ?? createHash('sha256').update(JSON.stringify(facts)).digest('hex')
    if (!/^[a-f0-9]{64}$/u.test(requestDigest)) throw new YuqiOrchestratorError('INVALID_BATCH', 'Invalid follow-up request digest')
    const coordinator = new StartFollowupTeamCoordinator(this.progressClock, this.progressEventIds, this.transactions)
    const pending = projection.followupOperations?.[source.operationId]
    if (pending !== undefined && pending.targetTeamId === undefined) {
      if (pending.requestDigest !== requestDigest || pending.parentSessionId !== parentId) {
        throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Follow-up operation was reused with a different request or parent')
      }
      const result = await coordinator.reconcile({ teamId: source.teamId, operationId: source.operationId,
        parentSessionId: parentId!, sourceControllerSessionId: source.controllerSessionId }, journal,
      () => this.findPersistedFollowupTargets(source, parentId!, requestDigest, request.signal))
      // Reconciliation establishes identity only. Never acquire/start a target runner.
      return { kind: 'existing' as const, teamId: result.teamId, controllerSessionId: result.controllerSessionId }
    }
    const preflight = async () => {
      request.signal?.throwIfAborted()
      const active = selectActiveTeamProjectionBridge(readYuqiSessionEvents(parent))
      if (active !== undefined && !['completed', 'failed', 'cancelled'].includes(replayTeamEvents(active.events).team.status)) {
        throw new YuqiOrchestratorError('CONTROLLER_BUSY', 'This conversation already has an active Team; finish or cancel it first')
      }
      const workspace = projection.workspace
      // A Git worktree can contain unmerged edits. Do not silently start from a different checkout.
      if (workspace?.status !== 'ready' || (workspace.project as { mode?: string }).mode !== 'direct'
        || (request.workspaceMode ?? 'direct') !== 'direct') {
        throw new YuqiOrchestratorError('WORKSPACE_REQUIRES_RECONCILIATION', 'Follow-up currently requires the original direct workspace; Git results need explicit integration first')
      }
      const [previousRoot, selectedRoot] = await Promise.all([realpath(workspace.worktreePath), realpath(request.projectCwd)])
      const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
      if (normalize(previousRoot) !== normalize(selectedRoot)) throw new YuqiOrchestratorError('WORKSPACE_CONFLICT', 'Follow-up must use the original project directory')
      validateStartTeamRequest({ ...request, workspaceMode: 'direct' })
      this.assertVerificationReadiness(request.tasks)
    }
    let allocated: HarnessStartedTeam | undefined
    const ownsWriterAdmission = projection.followupOperations?.[source.operationId] === undefined
      && request.tasks.some(task => task.authorityMode !== 'read-only')
    try {
      const create = () => coordinator.start({ teamId: source.teamId, operationId: source.operationId, requestDigest, parentSessionId: parentId! }, journal, async () => {
        const summary = projection.taskIds.slice(0, 4).map(id => {
          const task = projection.tasks[id]!
          const attemptId = task.attemptIds.at(-1)
          const outcome = attemptId === undefined ? undefined : projection.attempts[attemptId]?.evidence?.taskOutcome
          return { taskId: String(id).slice(0, 80), status: task.status, goal: task.contract.goal.slice(0, 80), result: outcome?.status === 'reported' ? outcome.outcome.summary.slice(0, 180) : 'unavailable' }
        })
        // The gate may have waited behind other source writes. Read the actual
        // committed intent predecessor inside this callback; never re-enter it.
        const committedEvents = journal.read().map(parseTeamEvent)
        const intentIndex = committedEvents.findIndex(event => event.type === 'yuqi/team-followup-requested' && event.operationId === source.operationId)
        const anchor = committedEvents[intentIndex - 1]
        if (anchor === undefined) throw new Error('Committed follow-up intent has no source anchor')
        const continuedFrom: TeamContinuation = { sourceTeamId: source.teamId, sourceControllerSessionId: source.controllerSessionId, sourceEventId: String(anchor.eventId), operationId: source.operationId, sourceSummary: JSON.stringify(summary).slice(0, 2000) }
        allocated = await this.prepareTeam(request, continuedFrom, ownsWriterAdmission)
        return { ...allocated, controllerSessionId: allocated.sessionId }
      }, preflight)
      // Own the directory before persisting intent: a known competing writer
      // must not leave a stuck creation request. Keep ownership through publication.
      return ownsWriterAdmission
        ? await this.directWorkspaceOwnership.withWriterAdmission({ projectRoot: request.projectCwd, protectedRoots: [], ...(request.signal === undefined ? {} : { signal: request.signal }) }, create)
        : await create()
    } catch (cause) {
      // No worker runner is launched before the source/target link commits.
      // Preserve both journals, but release a controller whose publication failed.
      if (allocated !== undefined) {
        try { await allocated.dispose() } catch (cleanupError) {
          this.ctx.logger.error(`[yuqi-team] follow-up controller cleanup unconfirmed: ${renderErrorChain(cleanupError)}`)
          throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'Follow-up publication and controller cleanup require reconciliation', { cause: new AggregateError([cause, cleanupError]) })
        }
      }
      throw cause
    }
  }

  /** Full native persistence scan, never the paginated UI/cache view. Fail closed on every gap. */
  private async findPersistedFollowupTargets(
    source: HarnessFollowupSource, parentSessionId: string, requestDigest: string, signal?: AbortSignal,
  ): Promise<readonly FollowupTargetCandidate[]> {
    const persistence = this.ctx.sessionPersistence as HarnessSessionPersistence & {
      open?: (id: ReturnType<typeof SessionId>, access: 'read', options?: { signal?: AbortSignal }) => Promise<{
        header: Session['header']
        inheritedEventCount?: number
        read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ events: readonly SessionEvent[] }>
        close(): Promise<void>
      }>
    }
    if (typeof persistence.list !== 'function' || (typeof persistence.load !== 'function' && typeof persistence.open !== 'function')) {
      throw new Error('Complete native Session enumeration is unavailable')
    }
    // The public persistence methods have no AbortSignal parameter. Stop our
    // observation promptly without inventing an overload or cancelling storage.
    const observe = async <T>(read: () => Promise<T>): Promise<T> => {
      signal?.throwIfAborted()
      if (signal === undefined) return read()
      let onAbort!: () => void
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
      })
      try { return await Promise.race([read(), aborted]) }
      finally { signal.removeEventListener('abort', onAbort) }
    }
    const inventory = async () => {
      const rawHeaders = await observe(() => persistence.list())
      signal?.throwIfAborted()
      const headers = extractPersistenceHeaders(rawHeaders)
      const ids = headers.map(header => String(header.id))
      if (ids.some(id => id.trim() !== id || id.length === 0) || new Set(ids).size !== ids.length) {
        throw new Error('Native Session enumeration contains invalid or duplicate identities')
      }
      const sidecarIds = this.sidecar?.listSessionIds() ?? []
      // Even an orphan may hide an unknown target: do not silently omit it.
      if (sidecarIds.some(id => !ids.includes(id))) throw new Error('Sidecar enumeration has an unverified native identity')
      return { headers, fingerprint: JSON.stringify({
        native: headers.map(header => [String(header.id), header.parentSession, header.cwd]).sort(),
        sidecar: [...sidecarIds].sort(),
      }) }
    }
    const before = await inventory()
    const load = async (id: string) => {
      if (typeof persistence.open === 'function') {
        const handle = await observe(() => persistence.open!(SessionId(id), 'read', ...(signal === undefined ? [] : [{ signal }])))
        try {
          const res = await observe(() => handle.read(undefined, undefined, ...(signal === undefined ? [] : [{ signal }])))
          signal?.throwIfAborted()
          const session = restorePersistedSession({
            meta: handle.header,
            events: res.events,
            ...(handle.inheritedEventCount === undefined ? {} : { inheritedEventCount: handle.inheritedEventCount }),
          })
          this.bindSidecar(session)
          return session
        } finally {
          await handle.close().catch(() => {})
        }
      }
      const stored = await observe(() => persistence.load!(SessionId(id)))
      signal?.throwIfAborted()
      if (stored === undefined || String(stored.meta.id) !== id) throw new Error('Native Session load has missing/mismatched identity')
      const session = restorePersistedSession(stored)
      this.bindSidecar(session)
      return session
    }
    if (!before.headers.some(header => String(header.id) === source.controllerSessionId)
      || !before.headers.some(header => String(header.id) === parentSessionId)) throw new Error('Source or parent is absent from native persistence')
    await load(parentSessionId) // Native identity only; parent cwd/lineage is not an execution-directory constraint.
    const sourceSession = await load(source.controllerSessionId)
    if (readActiveTeamParentBinding(sourceSession)?.parentSessionId !== parentSessionId) throw new Error('Persisted source parent identity differs')
    const sourceEvents = readTeamEventsFromSession(sourceSession)
    const sourceProjection = replayTeamEvents(sourceEvents)
    const intent = sourceProjection.followupOperations?.[source.operationId]
    if (String(sourceProjection.team.id) !== source.teamId || intent?.requestDigest !== requestDigest
      || intent.parentSessionId !== parentSessionId) throw new Error('Persisted source intent differs')
    const intentIndex = sourceEvents.findIndex(event => event.type === 'yuqi/team-followup-requested' && event.operationId === source.operationId)
    const anchor = sourceEvents[intentIndex - 1]
    if (anchor === undefined) throw new Error('Source continuation anchor is unavailable')
    const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
    const nativeRoot = async (session: Session) => {
      if (typeof session.header.cwd !== 'string' || session.header.cwd.trim() === '') throw new Error('Native project identity is unavailable')
      const cwd = session.header.cwd
      return normalize(await observe(() => realpath(cwd)))
    }
    const workspaceRoot = async (projection: TeamProjection) => {
      if (projection.workspace?.status !== 'ready' || (projection.workspace.project as { mode?: string }).mode !== 'direct') {
        throw new Error('Follow-up workspace is not a proven ready direct workspace')
      }
      return normalize(await observe(() => realpath(projection.workspace!.worktreePath)))
    }
    const sourceRoot = await workspaceRoot(sourceProjection)
    const candidates: FollowupTargetCandidate[] = []
    for (const header of before.headers) {
      signal?.throwIfAborted()
      const id = String(header.id)
      const session = await load(id)
      if (session.header.parentSession !== header.parentSession || session.header.cwd !== header.cwd) throw new Error('Native metadata changed during enumeration')
      const events = readTeamEventsFromSession(session)
      if (events.length === 0) {
        if (readYuqiSessionEvents(session).some(event => event.type === 'yuqi/team-event')) throw new Error('Invalid controller journal in enumeration')
        continue
      }
      const projection = replayTeamEvents(events)
      const provenance = projection.team.continuedFrom
      if (provenance === undefined || provenance.operationId !== source.operationId) continue
      // Operation IDs may independently occur on another source. A partial
      // source match, however, is contradictory evidence, never filterable noise.
      if (provenance.sourceTeamId !== source.teamId && provenance.sourceControllerSessionId !== source.controllerSessionId) continue
      if (provenance.sourceTeamId !== source.teamId || provenance.sourceControllerSessionId !== source.controllerSessionId
        || provenance.sourceEventId !== String(anchor.eventId)
        || String(session.header.parentSession) !== parentSessionId
        || readActiveTeamParentBinding(session)?.parentSessionId !== parentSessionId
        || session.header.origin === 'subagent' || (session.header.seedLength ?? 0) !== 0
        || await workspaceRoot(projection) !== sourceRoot
        || await nativeRoot(session) !== sourceRoot) throw new Error('Untrusted follow-up target provenance')
      candidates.push({ teamId: String(projection.team.id), controllerSessionId: id,
        sourceTeamId: source.teamId, sourceControllerSessionId: source.controllerSessionId,
        operationId: source.operationId, parentSessionId })
    }
    if ((await inventory()).fingerprint !== before.fingerprint) throw new Error('Native/sidecar inventory changed during enumeration')
    signal?.throwIfAborted()
    return candidates
  }

  /** Read an already-created continuation without restarting or rebinding it. */
  async readFollowupResult(controllerSessionId: string, teamId: string, parentSessionId: string): Promise<RunTeamLoopResult> {
    const session = harnessSessionAccess(this.ctx).get?.(SessionId(controllerSessionId))
      ?? await this.loadPersistedControllerSession(controllerSessionId)
    if (session === undefined || String(session.id) !== controllerSessionId || readActiveTeamParentBinding(session)?.parentSessionId !== parentSessionId) {
      throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'Previously created follow-up is unavailable or belongs to another parent')
    }
    const projection = this.projectionForTeam(this.journalForSession(session, this.persistenceOnlySessionStore(), false), teamId)
    const status = projection.team.status
    const reason = status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'paused' || status === 'needs_reconciliation'
      ? status : this.teamRunnerSupervisor.has(controllerSessionId) ? 'background-started' : 'needs_reconciliation'
    return { projection, reason, disposition: teamRunDisposition(reason), cycles: 0 }
  }

  private async prepareTeam(request: HarnessStartTeamRequest, continuedFrom?: TeamContinuation, directAdmissionHeld = false): Promise<HarnessStartedTeam> {
    if (this.disposed) throw new YuqiOrchestratorError('SERVICE_DISPOSED', 'Host is shutting down')
    await this.ensureSidecarReady()
    this.assertVerificationReadiness(request.tasks)
    // Reject malformed graphs before Direct writer admission needs to inspect
    // persistence. Admission protects a valid side effect; it is not input validation.
    validateAndOrderTaskContracts(request.tasks)
    // The invoking Session uses the same Host event implementation. Reject an
    // incompatible Host before allocating a workspace or controller when this
    // live parent is available; bootstrap also checks the actual controller.
    const parentSession = request.controllerParentSessionId === undefined
      ? undefined
      : harnessSessionAccess(this.ctx).get?.(SessionId(request.controllerParentSessionId))
    if (parentSession !== undefined) {
      this.bindSidecar(parentSession)
      assertYuqiSessionEventCompatibility(parentSession)
    }
    const workspaceMode = request.workspaceMode ?? 'direct'
    const startRequest = { ...request, workspaceMode } as HarnessStartTeamRequest
    const coordinator = new StartTeamCoordinator<Agent, AgentOptions, Awaited<ReturnType<TeamBootstrapCoordinator['bootstrap']>>>(
      workspaceMode === 'direct' ? this.directWorkspaces : this.gitWorkspaces,
      {
        launch: async launchRequest => {
          const launched = await this.launchTeamController(launchRequest)
          return {
            sessionId: launched.sessionId,
            controller: launched.handle.agent,
            dispose: () => launched.handle.dispose(),
          }
        },
      },
      {
        bootstrap: async bootstrapRequest => {
          try {
            const controllerModel = validAgentModel(bootstrapRequest.controllerModel)
            if (controllerModel === undefined) {
              throw new YuqiOrchestratorError('FIXED_MODEL_INVALID', 'Team controller requires a durable model provider')
            }
            return await this.bootstrapTeam({ ...bootstrapRequest, controllerModel, ...(continuedFrom === undefined ? {} : { continuedFrom }) })
          } catch (cause) {
            logHostCompatibilityFailure(this.ctx, 'team-bootstrap', cause)
            throw cause
          }
        },
      },
      { provision: workspaceRequest => this.provisionWorkspace(workspaceRequest) },
    )
    if (directAdmissionHeld || workspaceMode !== 'direct' || request.tasks.every(task => task.authorityMode === 'read-only')) {
      return coordinator.start(startRequest)
    }
    return this.directWorkspaceOwnership.withWriterAdmission({
      projectRoot: request.projectCwd,
      protectedRoots: [],
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }, () => coordinator.start(startRequest))
  }

  /** Move only the parent control address; the controller journal and workers remain unchanged. */
  async rebindTeam(request: { readonly controller: Agent; readonly teamId: string; readonly parent: Agent; readonly operationId: string }): Promise<void> {
    assertControlOperationId(request.operationId)
    const projection = replayTeamEvents(this.journalFor(request.controller).read())
    if (projection.team.id !== request.teamId) throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${request.teamId} does not own this controller journal`)
    if (request.parent.session.header.parentSession !== undefined || String(request.parent.id) === String(request.controller.id)) {
      throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'Team 只能切换到顶层主控对话')
    }
    const currentBinding = readActiveTeamParentBinding(request.controller.session)
    const previousParent = currentBinding === undefined ? undefined : harnessSessionAccess(this.ctx).get?.(SessionId(currentBinding.parentSessionId))
    const previousCwd = previousParent?.header.cwd
    const destinationCwd = request.parent.session.header.cwd
    if (previousCwd === undefined || destinationCwd === undefined || normalizeProjectPath(previousCwd) !== normalizeProjectPath(destinationCwd)) {
      throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'Team 只能切换到同一项目工作区的主控对话')
    }
    // A brand-new blank conversation can exist only in the live SessionStore.
    // Rebinding to it and then leaving the page used to detach the durable old
    // parent while the new parent disappeared, stranding the Team on its hidden
    // controller. Materialize the destination before changing authority.
    await this.ensureSessionDurable(request.parent.session)
    await this.journalFor(request.controller).rebindParent(String(request.parent.id), request.operationId)
    this.scheduleParentReportDelivery(String(request.controller.id))
  }

  private async ensureSessionDurable(session: Session): Promise<void> {
    if (hasSidecarSession(session)) return this.materializeSidecarSession(session)
    const persistence = this.ctx.sessionPersistence as unknown as {
      list(): Promise<readonly unknown[]>
      open?(id: ReturnType<typeof SessionId>, access: 'read' | 'write'): Promise<any>
      create(header: Session['header']): Promise<any>
      append?(id: ReturnType<typeof SessionId>, events: readonly SessionEvent[]): Promise<void>
      readFrom?(id: ReturnType<typeof SessionId>, offset: number): Promise<{ events: readonly SessionEvent[] }>
    }
    const rawHeaders = await persistence.list()
    const headers = extractPersistenceHeaders(rawHeaders)
    if (headers.some(header => String(header.id) === String(session.id))) return
    if (typeof persistence.open === 'function') {
      const handle = await persistence.create(session.header)
      try {
        const events = readSessionEvents(session)
        if (events.length > 0) await handle.append(events)
        await handle.flush?.()
      } finally {
        await handle.close?.().catch?.(() => {})
      }
      return
    }
    await persistence.create(session.header)
    if (readSessionEvents(session).length > 0 && typeof persistence.append === 'function') {
      await persistence.append(session.id, readSessionEvents(session))
    }
    const durable = typeof persistence.readFrom === 'function' ? await persistence.readFrom(session.id, 0) : undefined
    if (durable === undefined || durable.events.length !== readSessionEvents(session).length) {
      throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', '目标主控对话尚未持久化，Team 未切换')
    }
  }

  /** Resolve one fixed task route through Harness exact-model metadata. */
  resolveFixedModel(request: HarnessResolveFixedModelRequest): Promise<FixedModelRef> {
    return resolveFixedModelFromPort(request.role, request.policy, this.modelCatalog, request.signal)
  }

  /** Provision or verify the one durable Team-owned worktree before execution. */
  provisionWorkspace(request: HarnessProvisionWorkspaceRequest): Promise<TeamWorkspace> {
    return this.workspaceCoordinatorForIdentity(request.identity).provision({
      teamId: request.teamId,
      workspaceId: request.workspaceId,
      identity: request.identity,
      managedRoot: request.managedRoot,
      worktreePath: request.worktreePath,
      branchName: request.branchName,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }, this.journalFor(request.controller))
  }

  private workspaceCoordinatorFor(workspace: TeamWorkspace | undefined): TeamWorkspaceCoordinator {
    return this.workspaceCoordinatorForIdentity(workspace?.project)
  }

  private journalFor(controller: Agent): HarnessSessionJournal {
    return this.journalForSession(controller.session, requireHarnessSessionStore(this.ctx))
  }

  private journalForSession(
    session: Session,
    sessions: HarnessSessionStore,
    notifyParent = true,
  ): HarnessSessionJournal {
    this.bindSidecar(session)
    return new HarnessSessionJournal(
      session,
      sessions,
      this.ctx.sessionPersistence as HarnessSessionPersistence,
      () => {
        this.journalProgressWake.committed(String(session.id))
        if (notifyParent) this.scheduleParentReportDelivery(String(session.id))
      },
    )
  }

  /**
   * A Host restart destroys this process's child-run ownership. Persisted
   * `running`/`pausing`/`cancelling` facts must therefore fail closed instead
   * of continuing to age forever in the Client projection.
   */
  private installColdRecoveryScanner(ctx: Context): void {
    const sessions = harnessSessionAccess(ctx)
    const scan = (session: Session): void => { this.scanColdRecoverySession(session) }
    for (const session of sessions.list?.() ?? []) scan(session)
    // Persisted Sessions are often hydrated from the web/host scope after this
    // plugin scope has already started. A scoped listener misses those cold
    // loads, leaving durable `running` attempts visible forever after restart.
    // Observe the global Session lifecycle so every later-hydrated controller
    // and parent bridge gets the same fail-closed recovery scan.
    ctx.on('session/created', scan, { global: true })
  }

  private scanColdRecoverySession(session: Session): void {
    this.scheduleColdRecovery(session)
    const bridge = selectActiveTeamProjectionBridge(readYuqiSessionEvents(session))
    if (bridge === undefined) return
    let projection: ReturnType<typeof replayTeamEvents>
    try {
      projection = replayTeamEvents(bridge.events)
    } catch {
      return
    }
    if (projection.team.status === 'cancelled' && hasSchedulableTasks(projection)) {
      this.scheduleColdRecoveryDiscovery(bridge.controllerSessionId)
      return
    }
    if (projection.team.status === 'running'
      || (['pausing', 'cancelling'].includes(projection.team.status) && hasActiveAttempts(projection))) {
      this.scheduleColdRecoveryDiscovery(bridge.controllerSessionId)
    }
  }

  private scheduleColdRecoveryDiscovery(controllerSessionId: string): void {
    if (this.coldRecoveryScans.has(controllerSessionId) || this.coldRecoveryDiscoveries.has(controllerSessionId)) return
    this.coldRecoveryDiscoveries.add(controllerSessionId)
    void (async () => {
      // Inspect the durable cut before rehydrating the model. A restarted Host
      // has no proof that an interrupted active attempt is safe to replay;
      // resuming the controller first can replay its old tool call and create a
      // second child request. Active attempts must therefore enter the same
      // controllerless, fail-closed recovery path used for an unavailable
      // controller.
      const liveSession = harnessSessionAccess(this.ctx).get?.(SessionId(controllerSessionId))
      const session = liveSession ?? await this.loadPersistedControllerSession(controllerSessionId)
      if (session !== undefined) {
        const sessions = liveSession === undefined
          ? this.persistenceOnlySessionStore()
          : requireHarnessSessionStore(this.ctx)
        const journal = this.journalForSession(session, sessions)
        try {
          const projection = replayTeamEvents(journal.read())
          if (['running', 'pausing', 'cancelling'].includes(projection.team.status)
            && hasActiveAttempts(projection)) {
            this.scheduleColdRecovery(session, false)
            return
          }
        } catch {
          // The normal resolver below remains the authority for malformed or
          // incomplete historical cuts.
        }
      }

      const controller = await this.resolveTeamController(controllerSessionId)
      if (controller !== undefined) {
        this.recoverColdControllerState(controller)
        return
      }
      if (session === undefined) return
      const journal = this.journalForSession(
        session,
        liveSession === undefined ? this.persistenceOnlySessionStore() : requireHarnessSessionStore(this.ctx),
      )
      let projection: ReturnType<typeof replayTeamEvents>
      try {
        projection = replayTeamEvents(journal.read())
      } catch {
        return
      }
      if (projection.team.status === 'running' && !hasActiveAttempts(projection)) {
        if (await this.settleQuiescentRunningTeam(journal, String(projection.team.id))) return
        void this.markBackgroundRunnerFailure(
          journal,
          String(projection.team.id),
          'cold controller discovery',
          new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'Persisted controller route could not be recovered'),
        )
      }
    })().catch(cause => {
      this.ctx.logger.error(`[yuqi-team] cold controller discovery failed: ${renderErrorChain(cause)}`)
    }).finally(() => {
      this.coldRecoveryDiscoveries.delete(controllerSessionId)
    })
  }

  private async loadPersistedControllerSession(controllerSessionId: string, signal?: AbortSignal, inspection = false): Promise<Session | undefined> {
    const persistence = this.ctx.sessionPersistence as HarnessSessionPersistence & {
      inspect?: (id: ReturnType<typeof SessionId>, signal?: AbortSignal) => ReturnType<NonNullable<HarnessSessionPersistence['load']>>
      open?: (id: ReturnType<typeof SessionId>, access: 'read' | 'write', options?: { signal?: AbortSignal }) => Promise<{
        header: Session['header']
        inheritedEventCount?: number
        read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ events: readonly SessionEvent[] }>
        close(): Promise<void>
      }>
    }
    let stage: SidecarReadStage = 'native-persistence'
    // Inspection is the public non-resume read API. Prefer it even on Hosts
    // that also expose handle open(), whose full read path otherwise ignores
    // the caller's explicit inspection request.
    if (inspection && typeof persistence.inspect === 'function') {
      try {
        const stored = await persistence.inspect(SessionId(controllerSessionId), signal)
        signal?.throwIfAborted()
        if (stored === undefined) return undefined
        if (String(stored.meta.id) !== controllerSessionId) throw new Error('Persisted Session identity mismatch')
        stage = 'native-restore'
        const session = restorePersistedSession(stored)
        stage = 'native-bind'
        this.bindSidecar(session)
        return session
      } catch (cause) {
        markSidecarReadFailure(cause, stage)
        throw cause
      }
    }
    if (typeof persistence.open === 'function') {
      let handle: {
        header: Session['header']
        inheritedEventCount?: number
        read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{ events: readonly SessionEvent[] }>
        close(): Promise<void>
      }
      try {
        handle = await persistence.open(SessionId(controllerSessionId), 'read', ...(signal === undefined ? [] : [{ signal }]))
      } catch (cause) {
        if (cause instanceof Error && (cause.name === 'SessionPersistenceNotFoundError' || cause.message.includes('not found'))) {
          return undefined
        }
        markSidecarReadFailure(cause, stage)
        throw cause
      }
      try {
        signal?.throwIfAborted()
        const readResult = await handle.read(undefined, undefined, ...(signal === undefined ? [] : [{ signal }]))
        signal?.throwIfAborted()
        if (String(handle.header.id) !== controllerSessionId) throw new Error('Persisted Session identity mismatch')
        stage = 'native-restore'
        const session = restorePersistedSession({
          meta: handle.header,
          events: readResult.events,
          ...(handle.inheritedEventCount === undefined ? {} : { inheritedEventCount: handle.inheritedEventCount }),
        })
        stage = 'native-bind'
        this.bindSidecar(session)
        return session
      } catch (cause) {
        markSidecarReadFailure(cause, stage)
        throw cause
      } finally {
        await handle.close().catch(() => {})
      }
    }
    if (persistence.load === undefined) return undefined
    try {
      const stored = inspection && typeof persistence.inspect === 'function'
        ? await persistence.inspect(SessionId(controllerSessionId), signal)
        : await persistence.load(SessionId(controllerSessionId))
      signal?.throwIfAborted()
      if (stored === undefined) return undefined
      if (String(stored.meta.id) !== controllerSessionId) throw new Error('Persisted Session identity mismatch')
      stage = 'native-restore'
      const session = restorePersistedSession(stored)
      stage = 'native-bind'
      this.bindSidecar(session)
      return session
    } catch (cause) {
      markSidecarReadFailure(cause, stage)
      throw cause
    }
  }

  /** Explicit UI target recovery: one durable controller, never a resume or retry. */
  private async resolveColdTargetParent(teamId: string, controllerSessionId: string, signal: AbortSignal): Promise<string> {
    await this.ensureSidecarReady()
    signal.throwIfAborted()
    if (!controllerSessionId.startsWith('yuqi-team-')) throw new YuqiOrchestratorError('TEAM_MISMATCH', 'Invalid Team controller identity')
    const session = this.controllerAgents?.get(SessionId(controllerSessionId))?.session
      ?? harnessSessionAccess(this.ctx).get?.(SessionId(controllerSessionId))
      ?? await this.loadPersistedControllerSession(controllerSessionId, signal)
    if (session === undefined) throw new YuqiOrchestratorError('TEAM_MISMATCH', 'Team controller binding is unavailable')
    const binding = readActiveTeamParentBinding(session)
    if (binding === undefined) throw new YuqiOrchestratorError('TEAM_MISMATCH', 'Team controller binding is unavailable')
    // The visible top-level conversation is owned by the Agent registry on
    // some Hosts and is therefore absent from the controller Session store.
    // Prefer that exact registered parent before falling back to durable
    // lookup, matching the bridge-sync path below.
    const parent = this.controllerAgents?.get(SessionId(binding.parentSessionId))?.session
      ?? harnessSessionAccess(this.ctx).get?.(SessionId(binding.parentSessionId))
      ?? await this.loadPersistedControllerSession(binding.parentSessionId, signal, true)
    const bridge = parent === undefined ? undefined : selectActiveTeamProjectionBridge(readYuqiSessionEvents(parent))
    if (bridge?.controllerSessionId !== controllerSessionId || (bridge.bindingGeneration ?? 0) !== binding.generation) {
      throw new YuqiOrchestratorError('TEAM_MISMATCH', 'Team parent binding does not match its controller')
    }
    const journal = this.journalForSession(session, this.persistenceOnlySessionStore(), false)
    if (String(replayTeamEvents(journal.read()).team.id) !== teamId) throw new YuqiOrchestratorError('TEAM_MISMATCH', 'Team target does not match its controller')
    signal.throwIfAborted()
    return binding.parentSessionId
  }

  /** Explicit UI target recovery: one durable controller, never a resume or retry. */
  private async recoverColdTarget(teamId: string, controllerSessionId: string, signal: AbortSignal): Promise<void> {
    await this.ensureSidecarReady()
    signal.throwIfAborted()
    if (!controllerSessionId.startsWith('yuqi-team-')) throw new YuqiOrchestratorError('TEAM_MISMATCH', 'Invalid Team controller identity')
    const session = this.controllerAgents?.get(SessionId(controllerSessionId))?.session
      ?? harnessSessionAccess(this.ctx).get?.(SessionId(controllerSessionId))
      ?? await this.loadPersistedControllerSession(controllerSessionId, signal)
    if (session === undefined) throw new YuqiOrchestratorError('TEAM_MISMATCH', 'Team controller binding is unavailable')
    const binding = readActiveTeamParentBinding(session)
    if (binding === undefined) throw new YuqiOrchestratorError('TEAM_MISMATCH', 'Team controller binding is unavailable')
    const parent = this.controllerAgents?.get(SessionId(binding.parentSessionId))?.session
      ?? harnessSessionAccess(this.ctx).get?.(SessionId(binding.parentSessionId))
      ?? await this.loadPersistedControllerSession(binding.parentSessionId, signal, true)
    const bridge = parent === undefined ? undefined : selectActiveTeamProjectionBridge(readYuqiSessionEvents(parent))
    if (bridge?.controllerSessionId !== controllerSessionId || (bridge.bindingGeneration ?? 0) !== binding.generation) {
      throw new YuqiOrchestratorError('TEAM_MISMATCH', 'Team parent binding does not match its controller')
    }
    const journal = this.journalForSession(session, this.persistenceOnlySessionStore(), false)
    const projection = replayTeamEvents(journal.read())
    if (String(projection.team.id) !== teamId) throw new YuqiOrchestratorError('TEAM_MISMATCH', 'Team target does not match its controller')
    signal.throwIfAborted()
    // The target may have changed after the Client rendered its recovery card.
    // A stale click must never turn an ordinary paused/running/terminal cut into
    // a new recovery operation.
    if (projection.team.status !== 'needs_reconciliation') {
      if (projection.team.status === 'running' || projection.team.status === 'pausing' || projection.team.status === 'cancelling') {
        this.scheduleColdRecovery(session, false)
      }
      return
    }
    const initialSourceEventCount = readTeamEventsFromSession(session).length
    const suppression = this.parentReportSuppressions.get(controllerSessionId)
      ?? { active: 0, through: initialSourceEventCount }
    suppression.active += 1
    suppression.through = Math.max(suppression.through, initialSourceEventCount)
    this.parentReportSuppressions.set(controllerSessionId, suppression)
    let suppressThrough = initialSourceEventCount
    try {
      if (this.teamRunnerSupervisor.isRunning(journal.key)
        || this.reviewCalls.has(controllerSessionId)
        || this.reviewStopGates.has(controllerSessionId)) {
        throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', 'Team recovery still has a local writer')
      }

      const operationId = targetedRecoveryOperationId(controllerSessionId, teamId, projection.lastEventId)
      let recovered: ReturnType<typeof replayTeamEvents>
      if (hasCurrentCancellationIntent(projection)) {
        recovered = hasUnresolvedRecoveryFacts(projection)
          ? await this.reconcileCancellation({
              teamId,
              parentSessionId: controllerSessionId,
              operationId: `${operationId}:cancel`,
              signal,
            }, journal)
          : await this.teamControls.cancelWithoutController({
              teamId,
              operationId: String(projection.latestTeamControlOperationId),
            }, journal)
      } else {
        // Reuse the controller-less recovery saga so the Host checks the child
        // list twice, rejects foreign/active writers, verifies the exact
        // workspace, and stops at paused. No retry, resume, or dispatch callback
        // is installed on this path.
        recovered = await this.recoverColdReconciledTeam(
          controllerSessionId,
          journal,
          projection,
          false,
          operationId,
          signal,
        )
      }
      if (recovered.team.status === 'needs_reconciliation') {
        throw new YuqiOrchestratorError('RECONCILIATION_NOT_ALLOWED', 'Team recovery still has unresolved Host facts')
      }
      suppressThrough = readTeamEventsFromSession(session).length
    } finally {
      // The Team panel needs a fresh rebuildable bridge, not a model turn.
      // Keep any already-queued report for this cut suppressed at its final
      // send boundary; a later real Team event advances the count and reopens it.
      suppression.through = Math.max(suppression.through, suppressThrough)
      suppression.active -= 1
      await this.syncProjectionToDurableParent(session)
    }
  }

  async recoverDormantProjection(request: { readonly controllerSessionId: string; readonly teamId: string }): Promise<ReturnType<typeof replayTeamEvents> | undefined> {
    const liveSession = harnessSessionAccess(this.ctx).get?.(SessionId(request.controllerSessionId))
    const session = liveSession ?? await this.loadPersistedControllerSession(request.controllerSessionId)
    if (session === undefined) return undefined
    const journal = this.journalForSession(
      session,
      liveSession === undefined ? this.persistenceOnlySessionStore() : requireHarnessSessionStore(this.ctx),
    )
    let projection = this.projectionForTeam(journal, request.teamId)
    if (projection.team.status === 'running' && !hasActiveAttempts(projection)) {
      const settled = await this.settleQuiescentRunningTeam(journal, request.teamId)
      if (!settled) {
        await this.markBackgroundRunnerFailure(
          journal,
          request.teamId,
          'client stale-running probe',
          new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'Running Team has no active attempt after the recovery grace period'),
        )
      }
      projection = this.projectionForTeam(journal, request.teamId)
    }
    return projection
  }

  /**
   * Controller-less fail-closed control over one exact persisted journal.
   * This path can only persist reconciliation, close cancellation, or clear a
   * provably quiescent gate to paused; it never restores a runner.
   */
  async controlDormantTeam(request: {
    readonly controllerSessionId: string
    readonly parentSessionId: string
    readonly teamId: string
    readonly operationId: string
    readonly action: 'cancel' | 'reconcile'
    readonly signal?: AbortSignal
  }): Promise<ReturnType<typeof replayTeamEvents> | undefined> {
    assertControlOperationId(request.operationId)
    const liveSession = harnessSessionAccess(this.ctx).get?.(SessionId(request.controllerSessionId))
    const session = liveSession ?? await this.loadPersistedControllerSession(request.controllerSessionId)
    if (session === undefined) return undefined
    const binding = readActiveTeamParentBinding(session)
    if (binding?.parentSessionId !== request.parentSessionId) {
      throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${request.teamId} is not controlled by the current parent conversation`)
    }
    const journal = this.journalForSession(
      session,
      liveSession === undefined ? this.persistenceOnlySessionStore() : requireHarnessSessionStore(this.ctx),
    )
    let projection = this.projectionForTeam(journal, request.teamId)
    if (request.action === 'cancel') {
      return this.teamControls.cancelWithoutController(request, journal)
    }

    if (projection.team.status === 'cancelling' && !hasUnresolvedRecoveryFacts(projection)) {
      return this.teamControls.cancelWithoutController(request, journal)
    }
    if (projection.team.status === 'needs_reconciliation' && !hasUnresolvedRecoveryFacts(projection)) {
      if (hasCurrentCancellationIntent(projection)) {
        return this.teamControls.cancelWithoutController(request, journal)
      }
      return this.recoveryClear.clearFromDurableJournal(request, journal, request.controllerSessionId)
    }
    if (projection.team.status === 'running' && !hasActiveAttempts(projection)) {
      const settled = await this.settleQuiescentRunningTeam(journal, request.teamId)
      if (!settled) {
        await this.markBackgroundRunnerFailure(
          journal,
          request.teamId,
          'controller-less reconciliation',
          new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'Persisted controller route is unavailable and no runtime attempt remains'),
        )
      }
      projection = this.projectionForTeam(journal, request.teamId)
      if (projection.team.status !== 'needs_reconciliation') return projection
      if (!hasUnresolvedRecoveryFacts(projection)) {
        return this.recoveryClear.clearFromDurableJournal(request, journal, request.controllerSessionId)
      }
    }
    return this.reconcileCancellation({
      teamId: request.teamId,
      parentSessionId: request.controllerSessionId,
      operationId: request.operationId,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }, journal)
  }

  /**
   * Control one exact Team discovered outside the current conversation.
   * Identity is verified against the controller journal before any mutation.
   * A live controller uses the normal runtime-aware path; a cold controller
   * falls back to the fail-closed durable path with its recorded parent.
   */
  async controlTeamByIdentity(request: {
    readonly controllerSessionId: string
    readonly teamId: string
    readonly operationId: string
    readonly action: 'cancel' | 'reconcile'
    readonly signal?: AbortSignal
  }): Promise<ReturnType<typeof replayTeamEvents> | undefined> {
    assertControlOperationId(request.operationId)
    const controller = await this.resolveTeamController(request.controllerSessionId)
    if (controller !== undefined) {
      const projection = replayTeamEvents(this.journalFor(controller).read())
      if (String(projection.team.id) !== request.teamId) {
        throw new YuqiOrchestratorError('TEAM_MISMATCH', `controller ${request.controllerSessionId} does not own Team ${request.teamId}`)
      }
      if (request.action === 'cancel' && projection.team.status === 'cancelled') {
        await this.syncProjectionToDurableParent(controller.session)
        return projection
      }
      if (request.action === 'cancel'
        && (projection.team.status === 'needs_reconciliation' || projection.team.status === 'cancelling')) {
        const binding = readActiveTeamParentBinding(controller.session)
        if (binding === undefined) return undefined
        const next = await this.controlDormantTeam({
          ...request,
          parentSessionId: binding.parentSessionId,
        })
        await this.syncProjectionToDurableParent(controller.session)
        return next
      }
      const next = request.action === 'cancel'
        ? this.cancelTeam({ controller, teamId: request.teamId, operationId: request.operationId })
        : this.reconcileTeam({
            controller,
            teamId: request.teamId,
            operationId: request.operationId,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          })
      const settled = await next
      await this.syncProjectionToDurableParent(controller.session)
      return settled
    }

    const session = await this.loadPersistedControllerSession(request.controllerSessionId)
    if (session === undefined) return undefined
    const events = readTeamEventsFromSession(session)
    const persistedProjection = events.length === 0 ? undefined : replayTeamEvents(events)
    if (persistedProjection === undefined || String(persistedProjection.team.id) !== request.teamId) {
      throw new YuqiOrchestratorError('TEAM_MISMATCH', `controller ${request.controllerSessionId} does not own Team ${request.teamId}`)
    }
    if (request.action === 'cancel' && persistedProjection.team.status === 'cancelled') {
      await this.syncProjectionToDurableParent(session)
      return persistedProjection
    }
    const binding = readActiveTeamParentBinding(session)
    if (binding === undefined) return undefined
    const next = await this.controlDormantTeam({
      ...request,
      parentSessionId: binding.parentSessionId,
    })
    await this.syncProjectionToDurableParent(session)
    return next
  }

  /** Refresh the public parent bridge even when its conversation is not live. */
  private async syncProjectionToDurableParent(controllerSession: Session): Promise<boolean> {
    const binding = readActiveTeamParentBinding(controllerSession)
    if (binding === undefined) return false
    const sessions = await this.parentProjectionSessionStore(controllerSession)
    return syncTeamProjectionToParent(controllerSession, sessions)
  }

  /**
   * Use the Session attached to the live parent Agent when available. During a
   * cold load the public SessionStore may still omit that Session, even though
   * the Agent registry already exposes the exact instance rendered by the UI.
   * Falling back to persistence makes the bridge durable without ever making a
   * second controller or child request.
   */
  private async parentProjectionSessionStore(controllerSession: Session, base?: HarnessSessionStore): Promise<HarnessSessionStore> {
    const binding = readActiveTeamParentBinding(controllerSession)
    const access = harnessSessionAccess(this.ctx)
    const liveParentAgent = binding === undefined
      ? undefined
      : this.controllerAgents?.get(SessionId(binding.parentSessionId))
    const liveParent = liveParentAgent?.session
      ?? (binding === undefined ? undefined : access.get?.(SessionId(binding.parentSessionId)))
    if (liveParent !== undefined) {
      this.bindSidecar(liveParent)
      await this.hydrateLiveParentFromDurable(liveParent)
    }
    const persistedParent = liveParent === undefined && binding !== undefined
      ? await this.loadPersistedControllerSession(binding.parentSessionId)
      : undefined
    const parent = liveParent ?? persistedParent
    const normalFlush = base?.flush
    return {
      get: id => {
        if (parent !== undefined && String(id) === String(parent.id)) return parent
        if (String(id) === String(controllerSession.id)) return controllerSession
        const session = access.get?.(id)
        if (session !== undefined) this.bindSidecar(session)
        return session
      },
      flush: session => this.flushProjectionSession(session, normalFlush),
    }
  }

  private async hydrateLiveParentFromDurable(session: Session): Promise<void> {
    if (hasSidecarSession(session)) return
    const persistence = this.ctx.sessionPersistence as HarnessSessionPersistence | undefined
    if (persistence?.readFrom === undefined) return
    try {
      const durable = await persistence.readFrom(session.id, 0)
      const live = readSessionEvents(session)
      if (durable.events.length > live.length) {
        for (let index = 0; index < live.length; index += 1) {
          if (!this.durableSessionEventMatches(durable.events[index], live[index])) return
        }
        const durableTail = durable.events.slice(live.length)
        for (const ev of durableTail) {
          if (ev.type === TEAM_PARENT_PROJECTION_EVENT) {
            const bridge = parseTeamProjectionBridgeData(ev.data)
            if (bridge !== undefined) appendYuqiSessionEvent(session, TEAM_PARENT_PROJECTION_EVENT, bridge)
          } else {
            session.append(ev.type, ev.data)
          }
        }
      }
    } catch {
      // Best-effort hydration for live in-memory parent Session
    }
  }

  private durableSessionEventMatches(
    durableEvent: SessionEvent | undefined,
    liveEvent: SessionEvent | undefined,
  ): boolean {
    if (durableEvent === undefined || liveEvent === undefined) return false
    if (JSON.stringify(durableEvent) === JSON.stringify(liveEvent)) return true
    if (durableEvent.type !== liveEvent.type) return false
    if (JSON.stringify(durableEvent.data) === JSON.stringify(liveEvent.data)) return true
    if (durableEvent.type === TEAM_PARENT_PROJECTION_EVENT) {
      const durableBridge = parseTeamProjectionBridgeData(durableEvent.data)
      const liveBridge = parseTeamProjectionBridgeData(liveEvent.data)
      return durableBridge !== undefined && liveBridge !== undefined
        && (durableBridge.bindingGeneration ?? 0) === (liveBridge.bindingGeneration ?? 0)
        && sameBridgeContent(durableBridge, liveBridge)
    }
    return false
  }

  private async flushProjectionSession(
    session: Session,
    normalFlush?: HarnessSessionStore['flush'],
  ): Promise<boolean> {
    if (hasSidecarSession(session)) {
      // Plugin bridges have their own durable barrier. This callback is also
      // used after Agent.send: its native inbox MUST be flushed before the
      // sidecar delivery checkpoint can acknowledge a report.
      try {
        if (normalFlush !== undefined && await normalFlush(session)) return true
        // Cold controller recovery deliberately supplies no controller flush.
        // The parent can still be the live Host Session whose inbox write must
        // cross SessionStore's public durability barrier before we checkpoint.
        // JsonlSessionPersistence does not expose a public flush method.
        const hostFlush = harnessSessionAccess(this.ctx).flush
        if (hostFlush === undefined || hostFlush === normalFlush) return false
        return await hostFlush(session)
      } catch { return false }
    }
    try {
      if (normalFlush !== undefined && await normalFlush(session)) return true
    } catch {
      // The public store can reject a cold clone or a Session that was created
      // in a sibling Host scope. The persistence append below is the supported
      // recovery fallback, not a second logical event write.
    }
    const persistence = this.ctx.sessionPersistence as HarnessSessionPersistence
    const durable = await persistence.readFrom(session.id, 0)
    const live = readSessionEvents(session)
    if (durable.events.length > live.length) {
      // A stale live Session may be shorter than its durable copy, but it must
      // still be an exact prefix. Never hydrate a divergent live history.
      for (let index = 0; index < live.length; index += 1) {
        if (!this.durableSessionEventMatches(durable.events[index], live[index])) return false
      }
      // A live parent Agent can be hydrated after a cold controller recovery.
      // The durable parent may already contain this exact derived bridge from
      // an earlier clone, while the live Session has just received the same
      // bridge for its UI projection. Accept only that semantic duplicate;
      // divergent durable history remains a hard failure.
      const durableTail = durable.events.slice(live.length)
      const projectionTail = durableTail.map(event => event.type === TEAM_PARENT_PROJECTION_EVENT
        ? parseTeamProjectionBridgeData(event.data)
        : undefined)
      if (projectionTail.some(bridge => bridge === undefined)) return false
      for (const bridge of projectionTail) appendYuqiSessionEvent(session, TEAM_PARENT_PROJECTION_EVENT, bridge)
      const hydrated = readSessionEvents(session)
      return hydrated.length === durable.events.length
        && hydrated.every((event, index) => this.durableSessionEventMatches(durable.events[index], event))
    }
    for (let index = 0; index < durable.events.length; index += 1) {
      if (!this.durableSessionEventMatches(durable.events[index], live[index])) return false
    }
    const tail = live.slice(durable.events.length)
    if (tail.length > 0) await persistence.append(session.id, tail)
    const after = await persistence.readFrom(session.id, 0)
    const current = readSessionEvents(session)
    return after.events.length === current.length
      && after.events.every((event, index) => this.durableSessionEventMatches(after.events[index], current[index]))
  }

  private persistenceOnlySessionStore(): HarnessSessionStore {
    return {
      get: id => harnessSessionAccess(this.ctx).get?.(id),
      flush: async () => false,
    }
  }

  private recoverColdControllerState(controller: Agent): void {
    this.scheduleColdRecovery(controller.session)
    const journal = this.journalFor(controller)
    let projection: ReturnType<typeof replayTeamEvents>
    try {
      projection = replayTeamEvents(journal.read())
    } catch {
      return
    }
    if (projection.team.status !== 'running' || hasActiveAttempts(projection)) return
    void this.recoverDormantRunningTeam(controller, journal, String(projection.team.id)).catch(cause => {
      this.ctx.logger.error(`[yuqi-team] dormant running Team recovery failed: ${renderErrorChain(cause)}`)
    })
  }

  private async recoverDormantRunningTeam(
    controller: Agent,
    journal: HarnessSessionJournal,
    teamId: string,
  ): Promise<void> {
    if (this.teamRunnerSupervisor.canWake(journal.key)) return
    const projection = this.projectionForTeam(journal, teamId)
    if (projection.taskIds.length > 0 && projection.taskIds.every(taskId => projection.tasks[taskId]?.status === 'completed')) {
      await this.restoreRecoveredTeamRunner(controller, teamId, journal.key)
      this.wakeTeamRunner(journal, teamId, 'gate-aware completion recovery')
      return
    }
    const plan = planTeamSchedule(projection, { maxConcurrency: projection.team.maxConcurrency ?? this.maxConcurrencyLimit() })
    if (plan.status !== 'runnable' || plan.dispatchTaskIds.length === 0) {
      if (await this.settleQuiescentRunningTeam(journal, teamId)) return
      await this.markBackgroundRunnerFailure(
        journal,
        teamId,
        'cold restart recovery',
        new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'Running Team has no active or runnable task'),
      )
      return
    }
    await this.restoreRecoveredTeamRunner(controller, teamId, journal.key)
    this.wakeTeamRunner(journal, teamId, 'cold restart recovery')
  }

  private async settleQuiescentRunningTeam(journal: HarnessSessionJournal, teamId: string): Promise<boolean> {
    let settled = false
    await this.transactions.run(journal, async transaction => {
      const projection = replayTeamEvents(transaction.read())
      // A resume/recovery-clear can race another durable control operation.
      // This helper only settles the running cut it was asked to inspect; it
      // must not manufacture a transition from a newer paused/cancelling cut.
      if (projection.team.status !== 'running') return
      const events: TeamEvent[] = []
      const plan = planTeamSchedule(projection, { maxConcurrency: projection.team.maxConcurrency ?? this.maxConcurrencyLimit() })
      if (teamCompletionReady(projection) && decideQualityGate(projection).kind === 'complete') {
        events.push(createTeamEvent(this.progressClock, this.progressEventIds, teamId, {
          type: 'yuqi/team-status-changed', from: 'running', to: 'completed',
          reason: 'all tasks completed without pending verification',
        }))
      } else if (quiescentRetryableGraphReady(projection) && plan.unblockedTaskIds.length === 0) {
        events.push(
          createTeamEvent(this.progressClock, this.progressEventIds, teamId, {
            type: 'yuqi/team-status-changed', from: 'running', to: 'pausing',
            reason: 'task graph settled with retryable terminal tasks',
          }),
          createTeamEvent(this.progressClock, this.progressEventIds, teamId, {
            type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused',
            reason: 'controller decision required for failed, cancelled, or blocked tasks',
          }),
        )
      } else {
        if (!hasActiveAttempts(projection) && plan.status === 'runnable'
          && plan.dispatchTaskIds.length === 0 && plan.newlyBlockedTaskIds.length > 0) {
        // Terminal ancestors can leave dependent tasks pending but permanently
        // unrunnable. Preserve those pending facts; pause for a controller
        // decision instead of pretending the graph completed or re-dispatching.
        events.push(
          createTeamEvent(this.progressClock, this.progressEventIds, teamId, {
            type: 'yuqi/team-status-changed', from: 'running', to: 'pausing',
            reason: 'no runnable work remains after terminal dependency settlement',
          }),
          createTeamEvent(this.progressClock, this.progressEventIds, teamId, {
            type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused',
            reason: 'controller decision required for dependency-blocked pending tasks',
          }),
        )
        }
      }
      if (events.length === 0) return
      validateTeamEvents(transaction.read(), events)
      await transaction.commit(events, 'SETTLEMENT_PERSISTENCE_FAILED', 'Yuqi could not durably settle a quiescent Team graph')
      settled = true
    })
    return settled
  }

  private scheduleColdRecovery(session: Session, allowControllerResume = true): void {
    const controllerSessionId = String(session.id)
    if (!controllerSessionId.startsWith('yuqi-team-') || this.coldRecoveryScans.has(controllerSessionId)) return
    // A discovery triggered from a parent bridge may have loaded a durable
    // controller clone that is not registered in this Host's live SessionStore.
    // Requiring the live store here aborts recovery before its first durable
    // reconciliation event. Use it only for the exact live instance; the
    // journal's persistence fallback is the safe path for a cold clone.
    const liveSession = harnessSessionAccess(this.ctx).get?.(SessionId(controllerSessionId))
    const sessions = liveSession === session
      ? requireHarnessSessionStore(this.ctx)
      : this.persistenceOnlySessionStore()
    // Recovery itself is one durable saga. Suppress per-event parent reports
    // while it is settling so the parent receives one actionable final cut,
    // rather than one needs_reconciliation item for each internal checkpoint.
    const journal = this.journalForSession(session, sessions, false)
    let projection: ReturnType<typeof replayTeamEvents>
    try {
      projection = replayTeamEvents(journal.read())
    } catch {
      return
    }
    if (projection.team.status === 'cancelled') {
      if (hasSchedulableTasks(projection) && !this.terminalConsistencyRepairs.has(controllerSessionId)) {
        this.terminalConsistencyRepairs.add(controllerSessionId)
        void this.transactions.run(journal, async transaction => {
          const current = replayTeamEvents(transaction.read())
          const events = current.taskIds.flatMap(taskId => {
            const task = current.tasks[taskId]!
            if (!isSchedulableTaskStatus(task.status)) return []
            return [createTeamEvent(this.progressClock, this.progressEventIds, current.team.id, {
              type: 'yuqi/task-status-changed' as const, taskId, from: task.status, to: 'cancelled' as const,
              reason: 'startup repair: terminal Team cannot retain schedulable tasks',
            })]
          })
          if (events.length === 0) return current
          const next = validateTeamEvents(transaction.read(), events)
          await transaction.commit(events, 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not repair cancelled Team task state')
          return next
        }).catch(cause => {
          this.ctx.logger.error(`[yuqi-team] cancelled Team consistency repair failed: ${renderErrorChain(cause)}`)
        })
      }
      return
    }
    if (projection.team.status === 'needs_reconciliation') {
      this.coldRecoveryScans.add(controllerSessionId)
      void this.confirmOwnedLiveColdRecovery(journal, String(projection.team.id))
        .finally(() => { this.coldRecoveryScans.delete(controllerSessionId) })
      return
    }
    if (projection.team.status === 'running' && !hasActiveAttempts(projection)) {
      // Explicit cold inspection must never escalate into controller resume.
      // A later user-authorized recovery path may schedule discovery itself.
      if (allowControllerResume) this.scheduleColdRecoveryDiscovery(controllerSessionId)
      return
    }
    if (!['running', 'pausing', 'cancelling'].includes(projection.team.status) || !hasActiveAttempts(projection)) return
    this.coldRecoveryScans.add(controllerSessionId)
    void this.#recoverColdTerminalFacts(controllerSessionId, journal).then(async () => {
      const current = replayTeamEvents(journal.read())
      // This scan is also reached from parent-bridge/session hydration while
      // the current Host still owns every active attempt.  Such attempts have
      // an exact in-memory admission/settlement callback, so treating them as
      // cold would only turn healthy work into an unknown recovery cut.  Do
      // not infer that ownership from a child listing: the batch executor is
      // the only local authority.  A mixed or fully unowned set deliberately
      // falls through to the fail-closed reconciliation path below.
      if (hasOnlyLocallyManagedActiveAttempts(current, journal.key, this.batchExecutor)) {
        // No durable recovery operation was begun; permit a later cold scan if
        // ownership is actually lost after this point.
        this.coldRecoveryScans.delete(controllerSessionId)
        return current
      }
      if (!hasActiveAttempts(current)) {
        const settled = current.team.status === 'running'
          && await this.settleQuiescentRunningTeam(journal, String(current.team.id))
        const after = replayTeamEvents(journal.read())
        if (settled) {
          const taskId = after.taskIds.find(taskId => ['blocked', 'cancelled', 'failed', 'completed'].includes(after.tasks[taskId]?.status ?? ''))
          if (taskId !== undefined) this.queueParentTeamUpdate(journal.key, String(after.team.id), String(taskId))
        }
        return after
      }
      return this.reconciliations.reconcile({
        teamId: String(current.team.id),
        parentSessionId: controllerSessionId,
        operationId: `startup-reconcile:${randomUUID()}`,
      }, journal, this.runtimeObservations)
    }).then(async recovered => {
      if (recovered === undefined) return
      if (recovered.team.status !== 'needs_reconciliation') return
      // First try to rehydrate the exact controller. If that is unavailable,
      // the same saga still closes Host-proven negative facts and stops at a
      // safe paused state. Neither branch creates a replacement attempt for
      // a live or otherwise ambiguous child.
      let afterRecovery = recovered
      try {
        afterRecovery = await this.recoverColdReconciledTeam(controllerSessionId, journal, recovered, allowControllerResume)
      } catch (cause) {
        this.ctx.logger.warn(`[yuqi-team] automatic cold recovery remained closed: ${renderErrorChain(cause)}`)
      }
      const affectedTaskId = Object.values(afterRecovery.attempts)
        .find(attempt => attempt.status === 'unknown' || attempt.status === 'running')?.taskId
        ?? Object.values(afterRecovery.tasks).find(task => task.status === 'failed' || task.status === 'blocked')?.contract.taskId
      if (affectedTaskId !== undefined) this.queueParentTeamUpdate(journal.key, String(afterRecovery.team.id), String(affectedTaskId))
    }).catch(cause => {
      this.ctx.logger.error(`[yuqi-team] cold controller recovery failed: ${renderErrorChain(cause)}`)
    })
  }

  /** Correct only a previously persisted startup-reconciliation false gate. */
  private async confirmOwnedLiveColdRecovery(
    journal: HarnessSessionJournal,
    teamId: string,
  ): Promise<void> {
    const before = replayTeamEvents(journal.read())
    const operationId = `cold-owner-recovery:${String(before.lastEventId ?? 'none')}`
    await this.ownedLiveAttemptRecovery.recover({ teamId, operationId }, journal, this.batchExecutor)
    // A passive scan must never wake a parent. Parent-report delivery remains
    // driven by the original actionable durable cut and its checkpoint.
  }

  /** Recover only exact inactive child Sessions before classifying residual facts unknown. */
  async #recoverColdTerminalFacts(controllerSessionId: string, journal: TeamEventJournal): Promise<void> {
    const signal = AbortSignal.timeout(5_000)
    let entries: Awaited<ReturnType<Context['subagents']['listChildren']>>
    try {
      entries = await this.ctx.subagents.listChildren(SessionId(controllerSessionId), signal)
    } catch {
      return
    }
    const byId = new Map(entries.map(entry => [String(entry.id), entry]))
    const projection = replayTeamEvents(journal.read())
    for (const attempt of Object.values(projection.attempts)) {
      if ((attempt.status !== 'running' && attempt.status !== 'unknown')
        || attempt.agentSessionId === undefined || attempt.messageId === undefined
        || this.batchExecutor.hasActiveAttempt(journal.key, String(attempt.id))) continue
      const entry = byId.get(attempt.agentSessionId)
      if (entry?.kind !== 'child' || entry.mode !== 'continuable' || entry.activity !== 'inactive') continue
      const end = await loadInactiveTerminalFact(this.ctx, {
        childSessionId: attempt.agentSessionId,
        messageId: attempt.messageId,
      }, signal, 5_000)
      if (end === undefined || this.batchExecutor.hasActiveAttempt(journal.key, String(attempt.id))) continue
      const current = replayTeamEvents(journal.read())
      const exact = current.attempts[attempt.id]
      const task = current.tasks[attempt.taskId]
      if (exact?.status !== 'running' && exact?.status !== 'unknown') continue
      if (task?.status !== 'running' || exact.agentSessionId !== attempt.agentSessionId || exact.messageId !== attempt.messageId) continue
      await this.settleObservedAttempt({
        teamId: String(current.team.id), taskId: String(attempt.taskId), attemptId: String(attempt.id), journal, end,
        canSettle: () => !this.batchExecutor.hasActiveAttempt(journal.key, String(attempt.id)),
      })
    }
  }

  private async recoverColdReconciledTeam(
    controllerSessionId: string,
    journal: HarnessSessionJournal,
    projection: ReturnType<typeof replayTeamEvents>,
    allowControllerResume: boolean,
    operationId = `startup-recover:${randomUUID()}`,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof replayTeamEvents>> {
    if (allowControllerResume) {
      const recoveredController = await this.resolveTeamController(controllerSessionId)
      if (recoveredController !== undefined) {
        return this.recoverAndContinueTeam({
          controller: recoveredController,
          teamId: String(projection.team.id),
          operationId,
        })
      }
    }

    const safety = new HarnessAttemptResolutionSafetyPort(this.ctx, controllerSessionId, this.batchExecutor, this.workspacePorts)
    return this.controllerRecovery.recover({
      teamId: String(projection.team.id), operationId,
      ...(signal === undefined ? {} : { signal }),
    }, {
      projection: () => this.projectionForTeam(journal, String(projection.team.id)),
      reconcile: ({ operationId, signal }) => this.reconciliations.reconcile({
        teamId: String(projection.team.id), parentSessionId: controllerSessionId, operationId,
        ...(signal === undefined ? {} : { signal }),
      }, journal, this.runtimeObservations),
      resolveAttempt: ({ operationId, taskId, attemptId, observationOperationId, signal }) => this.resolutions.resolve({
        teamId: String(projection.team.id), taskId, attemptId, observationOperationId,
        decision: 'failed', operationId,
        ...(signal === undefined ? {} : { signal }),
      }, journal, safety),
      clearRecovery: ({ operationId, signal }) => this.recoveryClear.clear({
        teamId: String(projection.team.id), operationId, target: 'paused', releaseOrphanedLeases: true,
        ...(signal === undefined ? {} : { signal }),
      }, journal, safety),
    })
  }

  private workspaceCoordinatorForIdentity(identity: unknown): TeamWorkspaceCoordinator {
    return isDirectWorkspaceValue(identity) ? this.directWorkspaceCoordinator : this.workspaceCoordinator
  }

  /** Grant ownership only after the existing pause flow has durably settled. */
  async acquireManualTask(request: { readonly controller: Agent; readonly teamId: string; readonly taskId: string; readonly operationId: string }): Promise<TeamProjection> {
    const project = this.projectionForTeam(this.journalFor(request.controller), request.teamId).workspace?.project
    if (isDirectWorkspaceValue(project)) return this.directWorkspaceOwnership.withAuthorityUpgrade({
      projectRoot: project.projectRoot, protectedRoots: project.protectedRoots, selfSessionId: String(request.controller.id),
    }, () => this.acquireManualTaskWithinAdmission(request))
    return this.acquireManualTaskWithinAdmission(request)
  }

  private async acquireManualTaskWithinAdmission(request: { readonly controller: Agent; readonly teamId: string; readonly taskId: string; readonly operationId: string }): Promise<TeamProjection> {
    const journal = this.journalFor(request.controller)
    assertControlOperationId(request.operationId)
    return this.transactions.run(journal, async transaction => {
      const current = this.projectionForTeam({ key: journal.key, read: () => transaction.read(), commit: async () => undefined }, request.teamId)
      if (current.team.manualOwnershipOperations?.[request.operationId] === undefined) {
        const issue = manualTakeoverIssue(current, request.taskId)
        if (issue !== undefined) throw new YuqiOrchestratorError('CONTROL_NOT_ALLOWED', issue)
      }
      if (Object.keys(current.attempts).some(id => this.batchExecutor.hasActiveAttempt(journal.key, id))
        || hasUnresolvedRecoveryFacts(current)) throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', 'Team execution is not confirmed quiescent; manual ownership was not granted')
      const event = createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
        type: 'yuqi/task-manual-acquired', operationId: ControlOperationId(request.operationId), taskId: TaskId(request.taskId),
        workspacePath: current.workspace?.worktreePath ?? '',
      })
      const next = validateTeamEvents(transaction.read(), [event])
      await transaction.commit([event], 'INTENT_PERSISTENCE_FAILED', 'Could not persist manual ownership')
      return next
    })
  }

  async returnManualTask(request: { readonly controller: Agent; readonly teamId: string; readonly taskId: string; readonly operationId: string; readonly acquisitionId: string; readonly summary: string }): Promise<TeamProjection> {
    const journal = this.journalFor(request.controller)
    assertControlOperationId(request.operationId)
    return this.transactions.run(journal, async transaction => {
      this.projectionForTeam({ key: journal.key, read: () => transaction.read(), commit: async () => undefined }, request.teamId)
      const event = createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
        type: 'yuqi/task-manual-returned', operationId: ControlOperationId(request.operationId), taskId: TaskId(request.taskId),
        acquisitionId: ControlOperationId(request.acquisitionId), summary: request.summary,
      })
      const next = validateTeamEvents(transaction.read(), [event])
      await transaction.commit([event], 'INTENT_PERSISTENCE_FAILED', 'Could not persist return of manual ownership')
      // Deliberately do not resume, retry, or replace the task/attempt history.
      return next
    })
  }

  /** Stop new scheduling and become paused after current attempts settle. */
  async pauseTeam(request: TeamControlRequest & { readonly controller: Agent; readonly immediate?: boolean }) {
    const journal = this.journalFor(request.controller)
    let projection = await this.teamControls.pause(request, journal)
    if (projection.team.status === 'pausing' && hasActiveVerificationOnly(projection)) {
      this.teamRunnerSupervisor.interrupt(journal.key, 'Team pause interrupted active verification collection')
    }
    if (request.immediate && (projection.team.status === 'pausing' || projection.team.status === 'running')) {
      this.teamRunnerSupervisor.interrupt(journal.key, 'Immediate Team pause interrupted active runner')
      try {
        await this.batchExecutor.cancelActiveAndWait(journal.key, 5_000)
      } catch (cause) {
        this.ctx.logger.warn(`[yuqi-team] immediate pause child cancellation failed for ${request.teamId}: ${renderErrorChain(cause)}`)
      }
      projection = this.projectionForTeam(journal, request.teamId)
    }
    return projection
  }

  /** Resume scheduling for a fully paused Team. */
  async resumeTeam(request: TeamControlRequest & { readonly controller: Agent }) {
    const journal = this.journalFor(request.controller)
    let before = this.projectionForTeam(journal, request.teamId)
    if (before.team.manualOwnership?.state === 'human-owned') throw new YuqiOrchestratorError('CONTROL_NOT_ALLOWED', 'Return manual ownership before resuming the Team')
    const previousRecovery = before.recoveryClearOperations[request.operationId]
    if (previousRecovery?.target === 'running') return before
    if (before.team.status === 'needs_reconciliation' && !hasUnresolvedRecoveryFacts(before)) {
      assertPausedTeamCanResume({ ...before, team: { ...before.team, status: 'paused' } }, before.team.maxConcurrency ?? this.maxConcurrencyLimit())
      return this.clearTeamRecovery({ ...request, target: 'running' })
    }
    const previous = before.controlOperations[request.operationId]
    // A panel confirmation may have started the Team while a model still sees
    // the paused bridge. Observe current state without another wake or mutation.
    if (before.team.status === 'running' && previous === undefined
      && !hasCurrentCancellationIntent(before) && !projectionHasReconciliationGap(before)) return before
    if (before.team.status === 'paused' && previous === undefined) {
      for (const taskId of before.taskIds) {
        const task = before.tasks[taskId]
        if (task === undefined) continue
        const lastAttemptId = task.attemptIds.at(-1)
        const attempt = lastAttemptId !== undefined ? before.attempts[lastAttemptId] : undefined
        const stopReason = attempt?.evidence?.stopReason
        const isInterrupted = stopReason === 'interrupted' || stopReason === 'aborted'
        const outcomeStatus = attempt?.evidence?.taskOutcome?.status
        const isMissingOutcome = attempt?.evidence !== undefined && (outcomeStatus === undefined || outcomeStatus === 'missing')
        const shouldResume = (task.status === 'failed' || task.status === 'cancelled') && isInterrupted
          || (task.status === 'blocked' && (isMissingOutcome || isInterrupted))
        if (shouldResume) {
          before = await this.retryTask({
            controller: request.controller,
            teamId: request.teamId,
            taskId,
            operationId: `${request.operationId}:resume-retry:${taskId}`,
          })
        }
      }
      assertPausedTeamCanResume(before, before.team.maxConcurrency ?? this.maxConcurrencyLimit())
    }
    if (before.team.status === 'paused' && !this.teamRunnerSupervisor.canWake(journal.key)) {
      await this.restoreRecoveredTeamRunner(request.controller, request.teamId, journal.key)
    }
    const requiresWake = (previous === undefined && (before.team.status === 'paused' || before.team.status === 'pausing'))
      || (previous?.action === 'resume' && before.team.status === 'running')
    const lease = requiresWake ? this.acquireRunnerWakeLease(journal.key, 'resume') : undefined
    try {
      const projection = await this.teamControls.resume(request, journal)
      if (projection.team.status !== 'running') return projection
      // A schedule can be structurally runnable while having no dispatchable
      // work: terminal failures can still leave dependent tasks pending. Settle
      // that durable cut before waking the runner, otherwise it reports
      // no-progress and turns a normal controller decision into reconciliation.
      if (await this.settleQuiescentRunningTeam(journal, request.teamId)) {
        return this.projectionForTeam(journal, request.teamId)
      }
      this.wakeTeamRunner(journal, request.teamId, 'resume', lease)
      return projection
    } finally {
      lease?.release()
    }
  }

  /**
   * A paused Team has no live child attempt, so a Host restart may safely
   * rebind its recovered controller before committing a resume operation.
   * Running/pausing/cancelling Teams still require reconciliation and never
   * enter this path.
   */
  private async restoreRecoveredTeamRunner(controller: Agent, teamId: string, journalKey: string): Promise<void> {
    const handle = this.recoveredControllers.get(String(controller.id))
    const isLiveOwned = this.controllerAgents?.get(SessionId(String(controller.id))) === controller
    if (handle?.agent !== controller && !isLiveOwned) {
      throw new YuqiOrchestratorError(
        'CONTROLLER_REQUIRES_RECONCILIATION',
        'Team cannot resume because this Host has not recovered its exact controller ownership',
      )
    }
    const controllerSessionId = String(controller.id)
    const maxConcurrency = this.projectionForTeam(this.journalFor(controller), teamId).team.maxConcurrency ?? this.maxConcurrencyLimit()
    const directWriteStrategy = this.projectionForTeam(this.journalFor(controller), teamId).team.directWriteStrategy
    // Transfer the exact handle from the cold-recovery cache to the runner;
    // otherwise Host shutdown would dispose the same controller twice.
    this.recoveredControllers.delete(controllerSessionId)
    try {
      this.teamRunnerSupervisor.register({
        journalKey,
        controller,
        teamId,
        maxConcurrency,
        directWriteStrategy,
        disposeController: () => handle !== undefined
          ? handle.dispose()
          : Promise.resolve(),
        run: signal => this.runTeamPass({
          controller,
          teamId,
          maxConcurrency,
          directWriteStrategy,
        }, this.journalFor(controller), signal),
      })
    } catch (cause) {
      if (handle !== undefined) this.recoveredControllers.set(controllerSessionId, handle)
      throw cause
    }
  }

  /** Durably request cancellation, then signal every locally owned active child. */
  private closeStoppedReview(controllerId: string, reviewId: string): Promise<void> {
    const key = JSON.stringify([controllerId, reviewId])
    const previous = this.reviewCloseTails.get(key)
    if (previous !== undefined) return previous
    const source = this.reviewCloseSources.get(key)
    if (source === undefined) return Promise.resolve() // No proof/ownership for cold requests.
    const operation = (async () => {
      this.reviewer.assertNoUnsettled(controllerId)
      const journal = this.journalFor(source.controller)
      const projection = this.projectionForTeam(journal, source.teamId)
      const review = projection.reviews[reviewId]
      if (review === undefined || review.result !== undefined) return
      await this.reviewResults.record({
        teamId: source.teamId, candidateEventId: String(review.candidateEventId),
        result: {
          reviewId, trigger: review.trigger,
          reviewerSessionId: this.reviewer.settledChildId(controllerId, reviewId) ?? `not-admitted:${reviewId}`,
          decision: 'inconclusive', findings: [],
          unverified: [localized(projection.team.locale,
            '审查未产生可用结论；已确认未完成子代理接入，或已核实精确审查子代理停止。此记录不代表审查通过。',
            'Reviewer did not produce a usable result. Admission did not complete, or exact child cleanup was confirmed. This is not a review pass.')],
        },
      }, journal)
    })()
    this.reviewCloseTails.set(key, operation)
    void operation.then(() => {
      this.reviewCloseSources.delete(key)
      this.reviewCloseTails.delete(key)
      this.reviewer.forgetSettled(controllerId, reviewId)
    }, () => { this.reviewCloseTails.delete(key) })
    return operation
  }

  private assertReviewQuiescent(controller: Agent, teamId: string, stopping = false): void {
    const key = String(controller.id)
    if (!stopping && this.reviewStopGates.has(key)) throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', 'Reviewer cancellation is in progress')
    if (this.reviewCalls.has(key)) throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', 'A review call is still in flight')
    // The durable review projection below remains authoritative. The runtime
    // guard is absent only in headless Host compositions without a live
    // reviewer child registry.
    this.reviewer.assertNoUnsettled?.(key)
    const projection = this.projectionForTeam(this.journalFor(controller), teamId)
    const unknown = Object.values(projection.reviews).find(review => review.result === undefined)
    if (unknown !== undefined) throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN',
      `Review ${unknown.id} has a durable request but no confirmed child outcome; controller reconciliation is required, not redispatch`)
  }

  private async withStoppedReviewer<T>(request: { controller: Agent; teamId: string; operationId: string }, action: () => Promise<T>): Promise<T> {
    assertControlOperationId(request.operationId)
    const key = String(request.controller.id)
    const journal = this.journalFor(request.controller)
    const current = this.projectionForTeam(journal, request.teamId)
    const prior = current.controlOperations[request.operationId]
    if (prior !== undefined && prior.action !== 'cancel') throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Operation is not a cancellation')
    this.reviewStopGates.set(key, (this.reviewStopGates.get(key) ?? 0) + 1)
    try {
      const call = this.reviewCalls.get(key)
      if (call !== undefined) {
        call.abort.abort(new Error('Team cancellation stopped reviewer'))
        this.teamRunnerSupervisor.interrupt(key, 'Team cancellation stopped reviewer')
      }
      try {
        await this.reviewer.cancelForController(key)
        if (call !== undefined) {
          const settled = await settleWithin([call.done], REVIEW_STOP_TIMEOUT_MS)
          if (settled === undefined || settled.some(result => result.status === 'rejected')) {
            throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', 'Reviewer preparation/result persistence has not stopped')
          }
        }
        for (const source of this.reviewCloseSources.values()) {
          if (String(source.controller.id) === key && this.reviewer.hasSettled(key, source.reviewId)) {
            await this.closeStoppedReview(key, source.reviewId)
          }
        }
        this.assertReviewQuiescent(request.controller, request.teamId, true)
      } catch (cause) {
        await this.markBackgroundRunnerFailure(journal, request.teamId, 'reviewer cancellation', cause)
        throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', 'Reviewer stop is unconfirmed; Team cancellation was not finalized', { cause })
      }
      return await action()
    } finally {
      const count = (this.reviewStopGates.get(key) ?? 1) - 1
      if (count === 0) this.reviewStopGates.delete(key)
      else this.reviewStopGates.set(key, count)
    }
  }

  async cancelTeam(request: HarnessCancelTeamRequest) {
    return this.withStoppedReviewer(request, () => this.cancelTeamAfterReview(request))
  }

  private async cancelTeamAfterReview(request: HarnessCancelTeamRequest) {
    const timeoutMs = cancelTimeout(request.timeoutMs)
    const journal = this.journalFor(request.controller)
    const command = await this.teamControls.cancelWithDisposition(request, journal)
    const projection = command.projection
    if (projection.team.status === 'cancelled') {
      this.releaseTeamRunner(journal.key, 'Terminal Team cancellation')
      return projection
    }
    if (projection.team.status === 'needs_reconciliation') return projection
    const verificationOnly = hasActiveVerificationOnly(projection)
    const runnerInterrupted = this.teamRunnerSupervisor.interrupt(
      journal.key,
      command.disposition === 'replayed'
        ? 'Replayed Team cancellation interrupted active runner'
        : 'Team cancellation interrupted active runner',
    )
    let result: CancellationWaitResult
    try {
      result = await this.batchExecutor.cancelActiveAndWait(journal.key, timeoutMs)
    } catch (cause) {
      this.ctx.logger.warn(`[yuqi-team] child cancellation failed for ${request.teamId}: ${renderErrorChain(cause)}`)
      console.error(`[yuqi-team] child cancellation failed for ${request.teamId}: ${renderErrorChain(cause)}`)
      const uncertain = await this.teamControls.markCancellationUncertain(request.teamId, journal, 'Harness rejected one or more child interrupts')
      if (uncertain.team.status === 'cancelled') return uncertain
      throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', 'Team cancellation could not safely signal every child', { cause })
    }
    const afterWait = replayTeamEvents(journal.read())
    if (afterWait.team.status === 'cancelled') {
      this.releaseTeamRunner(journal.key, 'Terminal Team cancellation')
      return afterWait
    }
    // A verification collector is Host runner work, not a child runtime. Its
    // abort path owns the short verdict transaction, so a missing child binding
    // is not by itself reconciliation evidence.
    if (result.activeCount === 0 && verificationOnly && runnerInterrupted) return afterWait
    // A timeout alone does not prove cancellation failed. While this Host
    // still owns an exact active attempt, preserve the durable `cancelling`
    // state and let the child's terminal callback close the transaction.
    if (result.outcome === 'timeout' && projection.taskIds.some(taskId => {
      const attemptId = projection.tasks[taskId]?.attemptIds.at(-1)
      return attemptId !== undefined && this.batchExecutor.hasActiveAttempt(journal.key, String(attemptId))
    })) return afterWait
    const reason = result.outcome === 'timeout'
      ? 'Timed out waiting for child terminal events after cancellation'
      : result.outcome === 'settled'
        ? 'Child runtime settled without complete durable cancellation accounting'
        : 'Cancellation terminal accounting failed or has no live runtime binding'
    const uncertain = await this.teamControls.markCancellationUncertain(request.teamId, journal, reason)
    if (uncertain.team.status === 'cancelled') return uncertain
    throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', reason)
  }

  /**
   * Abort-path control: durably enter `cancelling` and interrupt local work,
   * but never wait for child settlement. Tool cancellation must return quickly
   * so the native conversation can be stopped, ended, or prompted again.
   */
  async abortTeam(request: Omit<HarnessCancelTeamRequest, 'timeoutMs'>): Promise<ReturnType<typeof replayTeamEvents>> {
    return this.withStoppedReviewer(request, () => this.abortTeamAfterReview(request))
  }

  private async abortTeamAfterReview(request: Omit<HarnessCancelTeamRequest, 'timeoutMs'>): Promise<ReturnType<typeof replayTeamEvents>> {
    const journal = this.journalFor(request.controller)
    const command = await this.teamControls.cancelWithDisposition(request, journal)
    if (command.projection.team.status === 'cancelled') {
      this.releaseTeamRunner(journal.key, 'Terminal Team abort')
      return command.projection
    }
    const verificationOnly = hasActiveVerificationOnly(command.projection)
    const runnerInterrupted = this.teamRunnerSupervisor.interrupt(journal.key, 'Tool abort interrupted active Team runner')
    let activeCount: number
    try {
      activeCount = this.batchExecutor.cancelActiveInBackground(journal.key, cause => {
        void this.teamControls.markCancellationUncertain(request.teamId, journal,
          'Harness rejected child cancellation during tool abort').then(() => {
          this.scheduleParentReportDelivery(journal.key)
        }).catch(failure => {
          this.ctx.logger.warn(`[yuqi-team] tool abort cancellation could not be recorded: ${renderErrorChain(failure)}; native cause: ${renderErrorChain(cause)}`)
        })
      })
    } catch {
      return this.teamControls.markCancellationUncertain(request.teamId, journal, 'Harness rejected one or more child interrupts during tool abort')
    }
    const projection = replayTeamEvents(journal.read())
    if (projection.team.status === 'cancelled') this.releaseTeamRunner(journal.key, 'Terminal Team abort')
    if (projection.team.status === 'cancelling' && activeCount === 0 && !(verificationOnly && runnerInterrupted)) {
      return this.teamControls.markCancellationUncertain(
        request.teamId,
        journal,
        'Tool abort has no live runtime binding for durable active work',
      )
    }
    return projection
  }

  /** Queue a new attempt opportunity without replacing prior attempt evidence. */
  async retryTask(request: TaskRetryRequest & { readonly controller: Agent }) {
    const journal = this.journalFor(request.controller)
    const before = this.projectionForTeam(journal, request.teamId)
    const lease = before.team.status === 'running' ? this.acquireRunnerWakeLease(journal.key, 'retry') : undefined
    try {
      const projection = await this.taskRetries.retry(request, journal)
      if (projection.team.status === 'running') this.wakeTeamRunner(journal, request.teamId, 'retry', lease)
      return projection
    } finally {
      lease?.release()
    }
  }

  /** Add an independently tracked revision; never restart the completed source child. */
  async createTaskRevision(request: TaskRevisionRequest & { readonly controller: Agent }) {
    const journal = this.journalFor(request.controller)
    const before = this.projectionForTeam(journal, request.teamId)
    const { controller: _controller, ...input } = request
    if (before.taskIds.some(id => before.tasks[id]?.contract.userRevision?.operationId === request.operationId.trim())) {
      // Only the coordinator may validate digest/payload. An idempotent replay
      // must not require a live runner or turn into an implicit restart.
      return this.taskRevisions.create(input, journal)
    }
    const lease = before.team.status === 'running' ? this.acquireRunnerWakeLease(journal.key, 'user revision') : undefined
    try {
      const projection = await this.taskRevisions.create(input, journal)
      if (projection.team.status === 'running') this.wakeTeamRunner(journal, request.teamId, 'user revision', lease)
      return projection
    } finally {
      lease?.release()
    }
  }

  /** Durably target one active attempt, then interrupt only that child runtime. */
  async stopTask(request: {
    readonly controller: Agent
    readonly teamId: string
    readonly taskId: string
    readonly operationId: string
  }) {
    const journal = this.journalFor(request.controller)
    assertControlOperationId(request.operationId)
    const existingStop = journal.read().map((event, index) => parseTeamEvent(event, index))
      .find((event): event is Extract<TeamEvent, { readonly type: 'yuqi/task-stop-requested' }> =>
        event.type === 'yuqi/task-stop-requested' && event.operationId === request.operationId)
    let projection = this.projectionForTeam(journal, request.teamId)
    let attemptId: string
    if (existingStop !== undefined) {
      if (String(existingStop.taskId) !== request.taskId) {
        throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', `Stop operation ${request.operationId} already targets task ${existingStop.taskId}`)
      }
      attemptId = String(existingStop.attemptId)
      const replayTask = projection.tasks[request.taskId]
      const replayAttempt = projection.attempts[attemptId]
      if (replayTask?.status !== 'running'
        || (replayAttempt?.status !== 'dispatching' && replayAttempt?.status !== 'running')) return projection
    } else {
      const task = projection.tasks[request.taskId]
      if (task === undefined) throw new YuqiOrchestratorError('INVALID_BATCH', `Task ${request.taskId} does not exist`)
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') return projection
      if (projection.team.status !== 'running' || task.status !== 'running') {
        throw new YuqiOrchestratorError('CONTROL_NOT_ALLOWED', `Task ${request.taskId} cannot stop while ${task.status} in Team ${projection.team.status}`)
      }
      const latestAttemptId = task.attemptIds.at(-1)
      const attempt = latestAttemptId === undefined ? undefined : projection.attempts[String(latestAttemptId)]
      if (latestAttemptId === undefined || (attempt?.status !== 'dispatching' && attempt?.status !== 'running')) {
        throw new YuqiOrchestratorError('CONTROL_NOT_ALLOWED', `Task ${request.taskId} has no active attempt`)
      }
      attemptId = String(latestAttemptId)

      projection = await this.transactions.run(journal, async transaction => {
        const currentEvents = transaction.read()
        const current = replayTeamEvents(currentEvents)
        const currentTask = current.tasks[request.taskId]
        if (currentTask?.status === 'completed' || currentTask?.status === 'failed' || currentTask?.status === 'cancelled') return current
        const replayed = currentEvents.some((event, index) => {
          const parsed = parseTeamEvent(event, index)
          return parsed.type === 'yuqi/task-stop-requested' && parsed.operationId === request.operationId
        })
        if (replayed) return current
        const event = createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
          type: 'yuqi/task-stop-requested', operationId: ControlOperationId(request.operationId),
          taskId: TaskId(request.taskId), attemptId: AttemptId(attemptId),
        })
        const next = validateTeamEvents(currentEvents, [event])
        await transaction.commit([event], 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably persist the task stop intent')
        return next
      })
    }

    if (projection.tasks[request.taskId]?.status !== 'running') return projection
    const stopped = await this.batchExecutor.cancelAttemptAndWait(journal.key, attemptId, 15_000)
    const after = this.projectionForTeam(journal, request.teamId)
    if (after.tasks[request.taskId]?.status === 'cancelled') return after
    if (stopped.outcome !== 'settled') {
      throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', `Task ${request.taskId} stop intent is durable but its child outcome is unknown`)
    }
    throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', `Task ${request.taskId} child settled without a durable cancelled task state`)
  }

  /** Revise an unstarted task, retry a terminal task, or safely restart one active attempt with a new model. */
  async setTaskModel(request: {
    readonly controller: Agent
    readonly teamId: string
    readonly taskId: string
    readonly providerId?: string
    readonly modelId: string
    readonly operationId: string
  }) {
    if (request.modelId.trim() === '') throw new YuqiOrchestratorError('FIXED_MODEL_INVALID', 'Task model must not be empty')
    if (request.providerId !== undefined && request.providerId.trim() === '') throw new YuqiOrchestratorError('FIXED_MODEL_INVALID', 'Task model provider must not be empty')
    const journal = this.journalFor(request.controller)
    let projection = this.projectionForTeam(journal, request.teamId)
    const task = projection.tasks[request.taskId]
    if (task === undefined) throw new YuqiOrchestratorError('INVALID_BATCH', `Task ${request.taskId} does not exist`)

    const wasRunning = task.status === 'running'
    const requiresRetry = wasRunning || task.status === 'failed' || task.status === 'cancelled'
    const teamWasRunning = projection.team.status === 'running'
    if (wasRunning) {
      await this.pauseTeam({ controller: request.controller, teamId: request.teamId, operationId: `${request.operationId}:pause` })
      const attemptId = task.attemptIds.at(-1)
      if (attemptId === undefined) throw new YuqiOrchestratorError('RETRY_NOT_ALLOWED', `Task ${request.taskId} has no active attempt`)
      const stopped = await this.batchExecutor.cancelAttemptAndWait(journal.key, String(attemptId), 15_000)
      if (stopped.outcome !== 'settled') {
        throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', `Task ${request.taskId} did not reach a durable stopped state`)
      }
      projection = await waitForTeamPaused(journal, request.teamId, MODEL_SWITCH_PAUSE_TIMEOUT_MS)
    } else if (teamWasRunning && requiresRetry) {
      // A terminal task can be retried while its Team is still running. Pause
      // the scheduler before retrying so it cannot create the replacement
      // attempt between the retry event and the new model revision.
      await this.pauseTeam({ controller: request.controller, teamId: request.teamId, operationId: `${request.operationId}:pause` })
      projection = await waitForTeamPaused(journal, request.teamId, MODEL_SWITCH_PAUSE_TIMEOUT_MS)
    }

    if (requiresRetry) {
      projection = await this.retryTask({
        controller: request.controller, teamId: request.teamId, taskId: request.taskId,
        operationId: `${request.operationId}:retry`,
      })
    }

    projection = await this.transactions.run(journal, async transaction => {
      const current = replayTeamEvents(transaction.read())
      if (current.team.id !== request.teamId) throw new YuqiOrchestratorError('TEAM_MISMATCH', 'Task model target changed')
      const currentTask = current.tasks[request.taskId]
      if (currentTask === undefined || (currentTask.status !== 'pending' && currentTask.status !== 'ready')) {
        throw new YuqiOrchestratorError('RETRY_NOT_ALLOWED', `Task ${request.taskId} model cannot change while ${currentTask?.status ?? 'missing'}`)
      }
      const modelRequest = request.providerId === undefined
        ? { kind: 'legacy' as const, modelId: request.modelId }
        : { kind: 'exact' as const, model: { modelProvider: request.providerId, modelId: request.modelId } }
      if (JSON.stringify(modelRequestForTask(currentTask.contract)) === JSON.stringify(modelRequest)) return current
      const contract = { ...currentTask.contract }
      delete contract.modelId
      delete contract.modelRequest
      const event = createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
        type: 'yuqi/task-revised',
        contract: { ...contract, revision: currentTask.contract.revision + 1, modelRequest },
      })
      const next = validateTeamEvents(transaction.read(), [event])
      await transaction.commit([event], 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably persist the task model')
      return next
    })

    if (teamWasRunning && requiresRetry) {
      projection = await this.resumeTeam({ controller: request.controller, teamId: request.teamId, operationId: `${request.operationId}:resume` })
    }
    return projection
  }

  /** Revise a task permission through the same pause/stop/retry lifecycle used by model switching. */
  async setTaskAuthority(request: {
    readonly controller: Agent
    readonly teamId: string
    readonly taskId: string
    readonly authorityMode: TeamAuthorityMode
    readonly operationId: string
  }) {
    const journal = this.journalFor(request.controller)
    const projection = this.projectionForTeam(journal, request.teamId)
    const task = projection.tasks[request.taskId]
    if (task === undefined) throw new YuqiOrchestratorError('INVALID_BATCH', `Task ${request.taskId} does not exist`)
    const project = projection.workspace?.project
    const upgradesWriter = task.contract.authorityMode === 'read-only' && request.authorityMode !== 'read-only'
    if (upgradesWriter && isDirectWorkspaceValue(project)) {
      return this.directWorkspaceOwnership.withAuthorityUpgrade({
        projectRoot: project.projectRoot,
        protectedRoots: project.protectedRoots,
        selfSessionId: String(request.controller.id),
      }, () => this.setTaskAuthorityWithinAdmission(request))
    }
    return this.setTaskAuthorityWithinAdmission(request)
  }

  private async setTaskAuthorityWithinAdmission(request: {
    readonly controller: Agent
    readonly teamId: string
    readonly taskId: string
    readonly authorityMode: TeamAuthorityMode
    readonly operationId: string
  }) {
    const journal = this.journalFor(request.controller)
    let projection = this.projectionForTeam(journal, request.teamId)
    const task = projection.tasks[request.taskId]
    if (task === undefined) throw new YuqiOrchestratorError('INVALID_BATCH', `Task ${request.taskId} does not exist`)

    const wasRunning = task.status === 'running'
    const requiresRetry = wasRunning || task.status === 'failed' || task.status === 'cancelled'
    if (wasRunning) {
      await this.pauseTeam({ controller: request.controller, teamId: request.teamId, operationId: `${request.operationId}:pause` })
      const attemptId = task.attemptIds.at(-1)
      if (attemptId === undefined) throw new YuqiOrchestratorError('RETRY_NOT_ALLOWED', `Task ${request.taskId} has no active attempt`)
      const stopped = await this.batchExecutor.cancelAttemptAndWait(journal.key, String(attemptId), 15_000)
      if (stopped.outcome !== 'settled') {
        throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', `Task ${request.taskId} did not reach a durable stopped state`)
      }
      projection = await waitForTeamPaused(journal, request.teamId, MODEL_SWITCH_PAUSE_TIMEOUT_MS)
    }

    if (requiresRetry) {
      projection = await this.retryTask({
        controller: request.controller, teamId: request.teamId, taskId: request.taskId,
        operationId: `${request.operationId}:retry`,
      })
    }

    projection = await this.transactions.run(journal, async transaction => {
      const current = replayTeamEvents(transaction.read())
      if (current.team.id !== request.teamId) throw new YuqiOrchestratorError('TEAM_MISMATCH', 'Task permission target changed')
      const currentTask = current.tasks[request.taskId]
      if (currentTask === undefined || (currentTask.status !== 'pending' && currentTask.status !== 'ready')) {
        throw new YuqiOrchestratorError('RETRY_NOT_ALLOWED', `Task ${request.taskId} permission cannot change while ${currentTask?.status ?? 'missing'}`)
      }
      if (currentTask.contract.authorityMode === request.authorityMode) return current
      const event = createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
        type: 'yuqi/task-revised',
        contract: { ...currentTask.contract, revision: currentTask.contract.revision + 1, authorityMode: request.authorityMode },
      })
      const next = validateTeamEvents(transaction.read(), [event])
      await transaction.commit([event], 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably persist the task permission')
      return next
    })

    if (wasRunning) {
      projection = await this.resumeTeam({ controller: request.controller, teamId: request.teamId, operationId: `${request.operationId}:resume` })
    }
    return projection
  }

  /** Replace a paused task's planning scope without changing authority or starting execution. */
  async setTaskFileScope(request: {
    readonly controller: Agent
    readonly teamId: string
    readonly taskId: string
    readonly fileScope: readonly string[]
    readonly operationId: string
  }): Promise<TeamProjection> {
    assertControlOperationId(request.operationId)
    const parsed = fileScopePatternSchema.array().min(1).max(512).safeParse(request.fileScope)
    if (!parsed.success) throw new YuqiOrchestratorError('INVALID_BATCH', 'fileScope requires 1 to 512 normalized project-relative patterns')
    const fileScope = [...new Set(parsed.data)].sort()
    const journal = this.journalFor(request.controller)
    // task-revised has no operationId field. Its deterministic event identity is
    // the durable receipt, including for pending tasks that need no retry fact.
    const receipt = `task-scope-v1:${createHash('sha256').update(JSON.stringify([request.teamId, request.operationId])).digest('hex')}`
    return this.transactions.run(journal, async transaction => {
      const events = transaction.read()
      const current = this.projectionForTeam({ key: journal.key, read: () => events, commit: async () => undefined }, request.teamId)
      const facts = events.map((event, index) => parseTeamEvent(event, index))
      const previous = facts.find(event => event.eventId === receipt)
      if (previous !== undefined) {
        if (previous.type !== 'yuqi/task-revised' || previous.contract.taskId !== request.taskId
          || JSON.stringify(previous.contract.fileScope) !== JSON.stringify(fileScope)) {
          throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Scope operation already has a different task or fileScope')
        }
        return current
      }
      if (facts.some(event => 'operationId' in event && event.operationId === request.operationId)) {
        throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Scope operation id was already used for another control')
      }
      const issue = manualTakeoverIssue(current, request.taskId)
      if (issue !== undefined) throw new YuqiOrchestratorError('CONTROL_NOT_ALLOWED', issue)
      if (Object.keys(current.attempts).some(id => this.batchExecutor.hasActiveAttempt(journal.key, id))
        || hasUnresolvedRecoveryFacts(current)) {
        throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', 'Team execution is not confirmed quiescent; scope was not changed')
      }
      const task = current.tasks[request.taskId]!
      const revised = { ...task.contract, revision: task.contract.revision + 1, fileScope }
      const { inputDigest: _previousDigest, ...digestInput } = revised
      const inputDigest = createHash('sha256').update(JSON.stringify(digestInput), 'utf8').digest('hex')
      const additions: TeamEvent[] = []
      if (task.status !== 'pending' && task.status !== 'ready') {
        additions.push(createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
          type: 'yuqi/task-retry-requested', taskId: task.contract.taskId,
          operationId: ControlOperationId(receipt),
        }))
      }
      additions.push({
        ...createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
          type: 'yuqi/task-revised', contract: { ...revised, inputDigest },
        }),
        eventId: TeamEventId(receipt),
      })
      const next = validateTeamEvents(events, additions)
      await transaction.commit(additions, 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably persist the task file scope')
      return next
    })
  }

  private readonly instructionQueues = new Map<string, Promise<unknown>>()

  async sendTeamInstruction(request: {
    readonly controller: Agent; readonly teamId: string; readonly operationId: string
    readonly authorSessionId: string; readonly target: string; readonly message: string; readonly signal: AbortSignal
  }): Promise<TeamInstruction> {
    const key = String(request.controller.id)
    const work = (this.instructionQueues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const journal = this.journalFor(request.controller)
      const projection = this.projectionForTeam(journal, request.teamId)
      const tasks = request.target === 'all' ? Object.values(projection.tasks).filter(task => task.status === 'running')
        : Object.values(projection.tasks).filter(task => task.contract.taskId === request.target)
      return deliverTeamInstruction({
        record: { operationId: request.operationId, teamId: request.teamId, controllerSessionId: key,
          authorSessionId: request.authorSessionId, target: request.target, text: request.message,
          createdAt: new Date().toISOString(), recipients: tasks.map(task => {
            const attemptId = task.attemptIds.at(-1)
            const childSessionId = attemptId === undefined ? undefined : projection.attempts[attemptId]?.agentSessionId
            return { taskId: task.contract.taskId, goal: task.contract.goal, status: 'sending' as const,
              ...(childSessionId === undefined ? {} : { childSessionId }) }
          }) },
        read: () => readYuqiSessionEvents(request.controller.session),
        confirmPersisted: async () => {
          if (!hasSidecarSession(request.controller.session)
            && !await requireHarnessSessionStore(this.ctx).flush(request.controller.session)) throw new Error('Instruction receipt persistence remains unconfirmed')
        },
        persist: async record => {
          await commitYuqiSessionEvent(request.controller.session, TEAM_INSTRUCTION_EVENT, record)
          if (!hasSidecarSession(request.controller.session)
            && !await requireHarnessSessionStore(this.ctx).flush(request.controller.session)) throw new Error('Instruction receipt persistence failed')
        },
        send: taskId => this.sendTaskMessage({ ...request, taskId }),
        rejected: cause => cause instanceof YuqiOrchestratorError,
      })
    })
    this.instructionQueues.set(key, work)
    try { return await work }
    finally { if (this.instructionQueues.get(key) === work) this.instructionQueues.delete(key) }
  }

  /** Deliver a later controller instruction to one exact running Team child through Harness's public message operation. */
  async sendTaskMessage(request: {
    readonly controller: Agent
    readonly teamId: string
    readonly taskId: string
    readonly message: string
    readonly signal: AbortSignal
  }): Promise<{ readonly childSessionId: string; readonly messageId: string }> {
    const message = request.message.trim()
    if (message === '' || message.length > 16_384) throw new YuqiOrchestratorError('INVALID_BATCH', 'Task message must contain 1 to 16384 characters')
    const journal = this.journalFor(request.controller)
    // Serialize the lifecycle check and message admission with attempt settlement.
    // Without this lock, a child could become terminal after the stale check
    // but before message admission, causing a completed task to restart invisibly.
    return this.transactions.run(journal, async transaction => {
      const projection = this.projectionForTeam({
        key: journal.key,
        read: () => transaction.read(),
        commit: events => transaction.commit(events, 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not persist a controller instruction'),
      }, request.teamId)
      if (projection.team.status !== 'running') {
        throw new YuqiOrchestratorError('RETRY_NOT_ALLOWED', `Team messages require a running Team; current status is ${projection.team.status}`)
      }
      if (hasCurrentCancellationIntent(projection) || projectionHasReconciliationGap(projection)) {
        throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'Team cancellation or recovery gate prevents instructions')
      }
      const task = projection.tasks[request.taskId]
      if (task === undefined) throw new YuqiOrchestratorError('INVALID_BATCH', `Task ${request.taskId} does not exist`)
      if (task.status !== 'running') throw new YuqiOrchestratorError('RETRY_NOT_ALLOWED', `Task ${request.taskId} is ${task.status}, not running`)
      const attemptId = task.attemptIds.at(-1)
      const childSessionId = attemptId === undefined ? undefined : projection.attempts[attemptId]?.agentSessionId
      if (childSessionId === undefined) throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', `Task ${request.taskId} has no admitted child Session`)
      const messageId = await sendControllerTaskMessage(
        this.ctx.subagents,
        request.controller,
        SessionId(childSessionId),
        [{ type: 'text', text: message }],
        { kind: 'coordinator', form: 'relay', senderSessionId: request.controller.id },
        request.signal,
      )
      return { childSessionId, messageId: String(messageId) }
    })
  }

  /** Queue bounded automatic rework only from an exact durable failed verdict. */
  async retryFailedVerification(request: AutomaticTaskRetryRequest & { readonly controller: Agent }) {
    const journal = this.journalFor(request.controller)
    const before = this.projectionForTeam(journal, request.teamId)
    if (before.team.reviewPolicy?.mode === 'quality-gate' && consecutiveFailedVerdicts(before, request.taskId) >= 2) {
      const anchorEventId = verificationVerdictEventId(journal.read(), request.verdictOperationId)
      const ready = await this.coordinateReviewCheckpoint({
        controller: request.controller,
        teamId: request.teamId,
        journal,
        target: {
          subject: 'failure-escalation', candidateEventId: anchorEventId,
          anchor: { eventId: anchorEventId, taskId: request.taskId, attemptId: request.attemptId },
          automaticReworkBudget: reviewBudget(before), independentReviewerRequired: true,
        },
        signal: new AbortController().signal,
      })
      if (!ready) return this.projectionForTeam(journal, request.teamId)
    }
    const lease = before.team.status === 'running' ? this.acquireRunnerWakeLease(journal.key, 'automatic retry') : undefined
    try {
      const projection = await this.automaticRetries.retry(request, journal)
      if (projection.team.status === 'running') this.wakeTeamRunner(journal, request.teamId, 'automatic retry', lease)
      return projection
    } finally {
      lease?.release()
    }
  }

  /** Classify unresolved attempts after restart without inferring completion. */
  reconcileTeam(request: Omit<ReconcileTeamRequest, 'parentSessionId'> & { readonly controller: Agent }) {
    const projection = this.projectionForTeam(this.journalFor(request.controller), request.teamId)
    if (projection.team.status === 'needs_reconciliation' && !hasUnresolvedRecoveryFacts(projection)) {
      if (hasCurrentCancellationIntent(projection)) {
        return this.teamControls.cancelWithoutController(request, this.journalFor(request.controller)).then(settled => {
          if (settled.team.status === 'cancelled') this.releaseTeamRunner(String(request.controller.id), 'Reconciled terminal Team cancellation')
          return settled
        })
      }
      return this.clearTeamRecovery({ ...request, target: 'paused' })
    }
    return this.reconcileCancellation({
      ...request,
      parentSessionId: String(request.controller.id),
    }, this.journalFor(request.controller))
  }

  /** A stop reconciliation may settle proven inactive children, but never resume them. */
  private async reconcileCancellation(request: ReconcileTeamRequest, journal: TeamEventJournal) {
    let projection = await this.reconciliations.reconcile(request, journal, this.runtimeObservations)
    if (!hasCurrentCancellationIntent(projection) || projection.team.status !== 'needs_reconciliation') return projection
    const safety = new HarnessAttemptResolutionSafetyPort(this.ctx, request.parentSessionId, this.batchExecutor, this.workspacePorts)
    const observations = projection.reconciliationOperations[request.operationId]?.observations ?? []
    for (const observation of observations) {
      if (request.signal?.aborted) throw request.signal.reason
      if (projection.team.status !== 'needs_reconciliation') break
      const attempt = projection.attempts[observation.attemptId]
      if (attempt?.status !== 'unknown'
        || !['durable', 'missing', 'not-admitted'].includes(observation.state)) continue
      projection = await this.resolutions.resolve({
        teamId: request.teamId,
        taskId: observation.taskId,
        attemptId: observation.attemptId,
        observationOperationId: request.operationId,
        operationId: `${request.operationId}:cancel:${observation.attemptId}`,
        decision: 'cancelled',
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      }, journal, safety)
    }
    if (projection.team.status === 'cancelled') this.releaseTeamRunner(request.parentSessionId, 'Reconciled terminal Team cancellation')
    return projection
  }

  /** Explicitly resolve one cold-reconciled attempt only after a fresh public Harness check. */
  async resolveAttempt(request: ResolveAttemptRequest & { readonly controller: Agent }) {
    assertControlOperationId(request.operationId)
    return this.resolutions.resolve(request, this.journalFor(request.controller),
      new HarnessAttemptResolutionSafetyPort(this.ctx, String(request.controller.id), this.batchExecutor, this.workspacePorts))
  }

  /** Clear only a fully host-verified reconciliation gate; default target is paused. */
  async clearTeamRecovery(request: ClearRecoveryRequest & { readonly controller: Agent }) {
    assertControlOperationId(request.operationId)
    const journal = this.journalFor(request.controller)
    const before = this.projectionForTeam(journal, request.teamId)
    if (before.recoveryClearOperations[request.operationId]?.target === (request.target ?? 'paused')) return before
    if (request.target === 'running' && before.team.status === 'needs_reconciliation' && !hasUnresolvedRecoveryFacts(before)) {
      assertPausedTeamCanResume({ ...before, team: { ...before.team, status: 'paused' } }, before.team.maxConcurrency ?? this.maxConcurrencyLimit())
    }
    // A quiescent Team has no live or unknown child fact left for the Host to
    // prove. Requiring runtime child enumeration here makes old, fully-settled
    // Teams impossible to recover after restart. Clear only to `paused` from
    // the durable journal; resuming still performs the separate controller-
    // ownership check below.
    if ((request.target ?? 'paused') === 'paused'
      && before.team.status === 'needs_reconciliation'
      && !hasUnresolvedRecoveryFacts(before)) {
      return this.recoveryClear.clearFromDurableJournal(request, journal, String(request.controller.id))
    }
    if (request.target === 'running' && !this.teamRunnerSupervisor.canWake(journal.key)) {
      await this.restoreRecoveredTeamRunner(request.controller, request.teamId, journal.key)
    }
    const requiresWake = request.target === 'running'
      && (before.recoveryClearOperations[request.operationId] === undefined || before.team.status === 'running')
    const lease = requiresWake ? this.acquireRunnerWakeLease(journal.key, 'recovery clear') : undefined
    try {
      const projection = await this.recoveryClear.clear(request, journal,
        new HarnessAttemptResolutionSafetyPort(this.ctx, String(request.controller.id), this.batchExecutor, this.workspacePorts))
      if (projection.team.status !== 'running') return projection
      // Recovery clearance has the same empty-dispatch edge as an ordinary
      // resume. Preserve failed and dependency-pending facts and leave the
      // Team paused for an explicit task decision rather than starting a
      // runner that can only yield no-progress.
      if (await this.settleQuiescentRunningTeam(journal, request.teamId)) {
        return this.projectionForTeam(journal, request.teamId)
      }
      this.wakeTeamRunner(journal, request.teamId, 'recovery clear', lease)
      return projection
    } finally {
      lease?.release()
    }
  }

  /**
   * Controller-owned recovery saga. It closes only attempts whose latest Host
   * observation is independently resolvable, preserves the shared worktree,
   * requeues their tasks, and resumes scheduling without asking the user to
   * understand internal attempt states.
   */
  async recoverAndContinueTeam(request: {
    readonly controller: Agent
    readonly teamId: string
    readonly operationId: string
    readonly signal?: AbortSignal
  }) {
    const journal = this.journalFor(request.controller)
    return this.controllerRecovery.recover(request, {
      projection: () => this.projectionForTeam(journal, request.teamId),
      reconcile: ({ operationId, signal }) => this.reconcileTeam({
        controller: request.controller, teamId: request.teamId, operationId,
        ...(signal === undefined ? {} : { signal }),
      }),
      resolveAttempt: ({ operationId, taskId, attemptId, observationOperationId, signal }) => this.resolveAttempt({
        controller: request.controller, teamId: request.teamId, taskId, attemptId,
        decision: 'failed', operationId, observationOperationId,
        ...(signal === undefined ? {} : { signal }),
      }),
      clearRecovery: ({ operationId, signal }) => this.clearTeamRecovery({
        controller: request.controller, teamId: request.teamId, operationId, target: 'paused', releaseOrphanedLeases: true,
        ...(signal === undefined ? {} : { signal }),
      }),
      retryTask: ({ taskId, operationId }) => this.retryTask({
        controller: request.controller, teamId: request.teamId, taskId, operationId,
      }),
      resume: ({ operationId }) => this.resumeTeam({
        controller: request.controller, teamId: request.teamId, operationId,
      }),
    })
  }

  /** Collect only evidence that the current Harness Host can independently prove. */
  collectVerificationEvidence(request: HarnessCollectVerificationEvidenceRequest) {
    const journal = this.journalFor(request.controller)
    const projection = replayTeamEvents(journal.read())
    if (projection.team.id !== request.teamId) {
      throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${request.teamId} does not own this controller journal`)
    }
    const task = projection.tasks[request.taskId]
    const checks = task?.contract.verificationChecks
    const workspace = projection.workspace
    const runtime = this.subprocessRuntime()
    const requirements = checks?.map(check => ({ checkId: check.checkId, kind: check.kind, expectedStatusCodes: check.kind === 'interface' ? check.expectedStatusCodes : undefined })) ?? request.requirements
    const collector: HostEvidenceCollectorPort = runtime === undefined || task === undefined || workspace === undefined
      ? this.evidenceCollector
      : {
          collect: hostRequest => {
            const current = replayTeamEvents(journal.read())
            const currentTask = current.tasks[request.taskId]
            const currentWorkspace = current.workspace
            if (currentTask === undefined || currentWorkspace === undefined) {
              return Promise.resolve({ kind: 'failed', code: 'WORKSPACE_NOT_READY', reason: 'Durable task or workspace facts changed before collection' })
            }
            return new SubprocessEvidenceCollector(new HarnessStructuredSubprocessPort(runtime)).collect({
              task: currentTask.contract,
              workspace: currentWorkspace,
              requirementIds: hostRequest.requirementIds,
              ...(hostRequest.signal === undefined ? {} : { signal: hostRequest.signal }),
            })
          },
        }
    return this.verificationVerdicts.recordFromCollector(
      { ...request, requirements },
      journal,
      collector,
    )
  }

  /** Discover Host collector capabilities without widening the Client command surface. */
  evidenceCapabilities(): readonly HarnessEvidenceCapability[] {
    if (this.subprocessRuntime() === undefined) return this.evidenceCollector.capabilities()
    return [
      { kind: 'build', available: true, reason: 'Host fixed-command subprocess collector is available' },
      { kind: 'test', available: true, reason: 'Host Vitest JSON subprocess collector is available' },
      { kind: 'interface', available: true, reason: 'Host fixed subprocess interface probe is available when the explicit yuqi-interface-probe script is configured' },
      { kind: 'screenshot', available: true, reason: 'Host fixed subprocess screenshot probe is available when the explicit yuqi-screenshot-probe script is configured' },
    ]
  }

  readProjectSummary(projectRoot: string): Promise<ProjectSummary> {
    return this.projectSummaryFile.read(projectRoot)
  }

  updateProjectSummary(projectRoot: string, patch: ProjectSummaryPatch): Promise<ProjectSummary> {
    return this.projectSummaryFile.update(projectRoot, patch)
  }

  async recordProjectSummary(request: { readonly controller: Agent; readonly summary: ProjectSummary }): Promise<void> {
    const journal = this.journalFor(request.controller)
    const projection = replayTeamEvents(journal.read())
    if (projection.workspace?.status !== 'ready') {
      throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'Project knowledge publication requires a ready Team workspace')
    }
    const root = workspaceProjectRoot(projection.workspace)
    // Keep the caller shape compatible, but never republish request.summary:
    // it may predate a deletion. Memory belongs to this execution worktree,
    // independently of Host project/session settings inheritance.
    await this.projectSummaryFile.publishLatest(root, async latest => {
      const current = replayTeamEvents(journal.read())
      if (current.team.id !== projection.team.id || current.workspace?.status !== 'ready'
        || workspaceProjectRoot(current.workspace) !== root) {
        throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'Team workspace changed before project knowledge publication')
      }
      await journal.commitProjectSummary(validateProjectSummary(latest))
    })
  }

  /** Advance one semantic checkpoint without converting review outcomes into runtime reconciliation. */
  private async coordinateReviewCheckpoint(request: {
    readonly controller: Agent
    readonly teamId: string
    readonly journal: HarnessSessionJournal
    readonly target: ReviewCheckpointTarget
    readonly signal: AbortSignal
  }): Promise<boolean> {
    for (let step = 0; step < 8; step += 1) {
      request.signal.throwIfAborted()
      const projection = this.projectionForTeam(request.journal, request.teamId)
      const decision = decideReviewCheckpoint(projection, request.target)
      if (decision.kind === 'complete') return true
      if (decision.kind === 'review') {
        const reviewId = reviewIdentity(request.teamId, decision.candidateEventId, decision.round, decision.trigger, decision.retryKey)
        await this.reviewTeam({
          controller: request.controller,
          teamId: request.teamId,
          trigger: decision.trigger,
          reviewId,
          signal: request.signal,
          candidateEventId: decision.candidateEventId,
          round: decision.round,
          checkpointSubject: decision.checkpointSubject,
          checkpointAnchor: decision.checkpointAnchor,
          automaticReworkBudget: decision.automaticReworkBudget,
          independentReviewerRequired: decision.independentReviewerRequired,
        })
        continue
      }
      if (decision.kind === 'create-rework') {
        const contract = reviewReworkContract(projection, decision.sourceReviewId, decision.round, decision.findings)
        const safeContract = contract.authorityMode === 'full-access'
          ? { ...contract, authorityMode: 'write-authorized' as const }
          : contract
        const next = await this.reviewResults.createRework({
          teamId: request.teamId, sourceReviewId: decision.sourceReviewId, contract: safeContract,
        }, request.journal)
        await this.notifyParentQualityGate(request.controller, next, 'rework-created', localized(
          next.team.locale,
          `已创建安全返工任务 ${safeContract.taskId}。`,
          `Created safe rework task ${safeContract.taskId}.`,
        ))
        return false
      }
      if (decision.kind === 'verify') return false
      await this.pauseForSemanticReview(request.controller, request.journal, request.teamId, decision.reason)
      const paused = this.projectionForTeam(request.journal, request.teamId)
      await this.notifyParentQualityGate(
        request.controller,
        paused,
        'awaiting-user',
          localized(
            projection.team.locale,
            `审查节点 ${request.target.subject} 需要主控处理：${decision.reason}`,
            `Review checkpoint ${request.target.subject} requires controller action: ${decision.reason}`,
          ),
      )
      return false
    }
    await this.pauseForSemanticReview(request.controller, request.journal, request.teamId, 'review coordination step budget exhausted')
    return false
  }

  private async pauseForSemanticReview(
    controller: Agent,
    journal: TeamEventJournal,
    teamId: string,
    reason: string,
  ): Promise<void> {
    await this.transactions.run(journal, async transaction => {
      const current = replayTeamEvents(transaction.read())
      if (current.team.id !== teamId || current.team.status !== 'running') return current
      const events: TeamEvent[] = [
        createTeamEvent(this.progressClock, this.progressEventIds, teamId, {
          type: 'yuqi/team-status-changed', from: 'running', to: 'pausing', reason: `semantic review requires controller: ${reason}`,
        }),
        createTeamEvent(this.progressClock, this.progressEventIds, teamId, {
          type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused', reason: `semantic review requires controller: ${reason}`,
        }),
      ]
      const next = validateTeamEvents(transaction.read(), events)
      await transaction.commit(events, 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably pause for controller review')
      return next
    })
    this.queueParentTeamUpdate(journal.key, teamId, 'review')
    void controller
  }

  /** Advance one quiescent graph through the sole durable completion state machine. */
  async coordinateCompletion(request: {
    readonly controller: Agent
    readonly teamId: string
    readonly journal: TeamEventJournal
    readonly signal: AbortSignal
  }): Promise<void> {
    this.assertReviewQuiescent(request.controller, request.teamId)
    for (let step = 0; step < 12; step += 1) {
      request.signal.throwIfAborted()
      const projection = this.projectionForTeam(request.journal, request.teamId)
      const decision = decideReviewCheckpoint(projection)
      if (decision.kind === 'complete') {
        await this.transactions.run(request.journal, async transaction => {
          const current = this.projectionForTeam({ key: request.journal.key, read: () => transaction.read(), commit: events => transaction.commit(events, 'SETTLEMENT_PERSISTENCE_FAILED', 'Yuqi could not durably complete the Team') }, request.teamId)
          if (current.team.status === 'completed') return
          const latest = decideReviewCheckpoint(current)
          if (latest.kind !== 'complete') throw new YuqiOrchestratorError('STALE_SCHEDULE', 'Quality gate changed before Team completion')
          const event = createTeamEvent(this.progressClock, this.progressEventIds, request.teamId, {
            type: 'yuqi/team-status-changed', from: 'running', to: 'completed', reason: latest.reason,
          })
          validateTeamEvents(transaction.read(), [event])
          await transaction.commit([event], 'SETTLEMENT_PERSISTENCE_FAILED', 'Yuqi could not durably complete the Team')
        })
        await this.notifyParentQualityGate(request.controller, this.projectionForTeam(request.journal, request.teamId), 'completed')
        return
      }
      if (decision.kind === 'review') {
        const reviewId = reviewIdentity(request.teamId, decision.candidateEventId, decision.round, decision.trigger, decision.retryKey)
        await this.notifyParentQualityGate(request.controller, projection, 'review-started', localized(
          projection.team.locale,
          `Review ${reviewId} 已开始，只读检查 candidate ${decision.candidateEventId}。`,
          `Review ${reviewId} started a read-only check of candidate ${decision.candidateEventId}.`,
        ))
        await this.reviewTeam({
          controller: request.controller, teamId: request.teamId, trigger: decision.trigger,
          reviewId, signal: request.signal, candidateEventId: decision.candidateEventId, round: decision.round,
          checkpointSubject: decision.checkpointSubject,
          checkpointAnchor: decision.checkpointAnchor,
          automaticReworkBudget: decision.automaticReworkBudget,
          independentReviewerRequired: decision.independentReviewerRequired,
        })
        continue
      }
      if (decision.kind === 'create-rework') {
        const contract = reviewReworkContract(projection, decision.sourceReviewId, decision.round, decision.findings)
        const next = await this.reviewResults.createRework({
          teamId: request.teamId, sourceReviewId: decision.sourceReviewId, contract,
        }, request.journal)
        await this.notifyParentQualityGate(request.controller, next, 'rework-created', localized(
          next.team.locale,
          `已创建 ${contract.taskId}，不会 reopen 已完成任务。`,
          `Created ${contract.taskId} without reopening completed tasks.`,
        ))
        return
      }
      if (decision.kind === 'verify') return
      await this.pauseForSemanticReview(request.controller, request.journal, request.teamId, decision.reason)
      const paused = this.projectionForTeam(request.journal, request.teamId)
      await this.notifyParentQualityGate(
        request.controller,
        paused,
        'awaiting-user',
        localized(
          projection.team.locale,
          `Review ${decision.reviewId ?? 'unknown'} 需要主控处理；只有超出既有授权的选择才应询问用户。可选 retry_review、authorize_final_rework、waive（需原因）、fail 或 cancel。`,
          `Review ${decision.reviewId ?? 'unknown'} requires controller action. Ask the user only when the choice exceeds existing authority. Options: retry_review, authorize_final_rework, waive (reason required), fail, or cancel.`,
        ),
      )
      return
    }
      await this.pauseForSemanticReview(request.controller, request.journal, request.teamId, 'quality gate coordination step budget exhausted')
      return
  }

  async reviewTeam(request: {
    readonly controller: Agent
    readonly teamId: string
    readonly trigger: ReviewTrigger
    readonly reviewId?: string
    readonly candidateEventId?: string
    readonly round?: number
    readonly checkpointSubject?: ReviewCheckpointSubject
    readonly checkpointAnchor?: ReviewCheckpointAnchor
    readonly automaticReworkBudget?: ReviewAutomaticReworkBudget
    readonly independentReviewerRequired?: boolean
    readonly additionalCriteria?: string
    readonly signal?: AbortSignal
  }): Promise<ReviewOutcome> {
    const key = String(request.controller.id)
    if (this.disposed || this.reviewStopGates.has(key)) throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', 'Reviewer admission is closed')
    this.assertReviewQuiescent(request.controller, request.teamId)
    const abort = new AbortController()
    let finish!: () => void
    const call: { abort: AbortController; done: Promise<void>; reviewId?: string } = { abort, done: new Promise<void>(resolve => { finish = resolve }) }
    this.reviewCalls.set(key, call)
    const signal = request.signal === undefined ? abort.signal : AbortSignal.any([request.signal, abort.signal])
    let failed = false
    try {
      const result = await this.runReviewTeam({ ...request, signal })
      if (call.reviewId !== undefined) {
        this.reviewCloseSources.delete(JSON.stringify([key, call.reviewId]))
        this.reviewer.forgetSettled?.(key, call.reviewId)
      }
      return result
    } catch (cause) {
      failed = true
      throw cause
    } finally {
      try {
        this.reviewer.assertNoUnsettled?.(key)
        if (failed && call.reviewId !== undefined) await this.closeStoppedReview(key, call.reviewId)
      } catch (cause) {
        this.ctx.logger.warn(`[yuqi-team] reviewer request remains unresolved: ${renderErrorChain(cause)}`)
      } finally {
        if (this.reviewCalls.get(key) === call) this.reviewCalls.delete(key)
        finish()
      }
    }
  }

  private async runReviewTeam(request: Parameters<YuqiTeamOrchestratorService['reviewTeam']>[0]): Promise<ReviewOutcome> {
    request.signal?.throwIfAborted()
    const journal = this.journalFor(request.controller)
    const projection = replayTeamEvents(journal.read())
    if (projection.team.id !== request.teamId) throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${request.teamId} does not own this controller journal`)
    const candidateEventId = request.candidateEventId ?? projection.completionCandidateEventId ?? projection.lastEventId
    const round = request.round ?? 0
    const reviewId = request.reviewId ?? reviewIdentity(request.teamId, candidateEventId, round, request.trigger)
    const call = this.reviewCalls.get(String(request.controller.id))
    if (call !== undefined) call.reviewId = reviewId
    if (projection.team.status === 'cancelled' || projection.team.status === 'cancelling' || projection.team.status === 'needs_reconciliation') {
      throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', 'Team is not safe for reviewer admission')
    }
    const durableExisting = projection.reviews[reviewId]
    if (durableExisting?.result !== undefined) {
      return { status: 'completed', result: reviewResultSchema.parse({ reviewId, trigger: durableExisting.trigger, ...durableExisting.result }) }
    }
    const reviewJournal = new HarnessReviewJournal(request.controller.session, requireHarnessSessionStore(this.ctx))
    const existing = reviewJournal.read().find(result => result.reviewId === reviewId)
    if (existing !== undefined) return { status: 'completed', result: existing }
    const dispatch = decideReviewDispatch(projection, request.trigger)
    if (dispatch.kind === 'skip') {
      const reason = localizedReviewSkipReason(projection.team.locale, dispatch.reason)
      await this.notifyParentQualityGate(request.controller, projection, 'review-skipped', reason)
      return { status: 'skipped', reviewId, trigger: request.trigger, reason }
    }
    if ((request.checkpointSubject ?? 'team-completion') === 'team-completion'
      && Object.values(projection.attempts).some(attempt => attempt.status === 'dispatching' || attempt.status === 'running')) {
      const reason = localized(projection.team.locale, '存在活动中的子 Agent；审查延迟到安全边界', 'Active child agents are still running; review is deferred to a safe boundary.')
      await this.notifyParentQualityGate(request.controller, projection, 'review-skipped', reason)
      return { status: 'skipped', reviewId, trigger: request.trigger, reason }
    }
    if ((request.checkpointSubject ?? 'team-completion') === 'team-completion'
      && projection.completionCandidateEventId === undefined && projection.team.status !== 'completed') {
      const reason = localized(projection.team.locale, 'Team 尚未形成可审查的 durable completion candidate', 'The Team does not yet have a durable completion candidate to review.')
      await this.notifyParentQualityGate(request.controller, projection, 'review-skipped', reason)
      return { status: 'skipped', reviewId, trigger: request.trigger, reason }
    }
    const workspace = projection.workspace
    if (workspace === undefined) throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'Reviewer requires a durable Team workspace')
    this.reviewCloseSources.set(JSON.stringify([String(request.controller.id), reviewId]), { controller: request.controller, teamId: request.teamId, reviewId })
    const requested = projection.team.status === 'completed'
      ? projection
      : await this.reviewResults.request({
          teamId: request.teamId, reviewId, trigger: request.trigger, candidateEventId, round,
          ...(request.checkpointSubject === undefined ? {} : { checkpointSubject: request.checkpointSubject }),
          ...(request.checkpointAnchor === undefined ? {} : { checkpointAnchor: request.checkpointAnchor }),
          ...(request.automaticReworkBudget === undefined ? {} : { automaticReworkBudget: request.automaticReworkBudget }),
           ...(request.independentReviewerRequired === undefined ? {} : { independentReviewerRequired: request.independentReviewerRequired }),
          ...(request.additionalCriteria === undefined ? {} : { additionalCriteria: request.additionalCriteria }),
        }, journal)
    // Recovered/archived controllers may no longer expose the transient Agent
    // provider option. The attempt route is durable Team evidence and is the
    // authoritative fallback for a post-run reviewer.
    const durableRoute = Object.values(projection.attempts).at(-1)
    const controllerRoute = durableControllerRouteOrAttempt(projection, request.controller, durableRoute)
    const subjectAttempt = request.checkpointAnchor?.attemptId === undefined
      ? undefined
      : projection.attempts[request.checkpointAnchor.attemptId]
    const independenceBaseline = subjectAttempt ?? durableRoute ?? controllerRoute
    const reviewerCatalog = await this.modelCatalog.inspectAutomaticRoutes({
      configuredCandidates: [],
      controllerModel: controllerRoute,
      providerScope: projection.team.modelRouting?.providerScope ?? { kind: 'controller-only' },
    }, request.signal)
    const routable = reviewerCatalog.filter(fact => fact.metadataResolved && fact.routable)
    const diverseRoute = independenceBaseline === undefined ? undefined : routable.find(fact =>
      fact.model.modelProvider !== independenceBaseline.modelProvider
      || fact.model.modelId !== independenceBaseline.modelId)
    const reviewerRoute = diverseRoute?.model ?? routable[0]?.model
    const reviewerIndependence = diverseRoute === undefined ? 'context-only' as const : 'model-diverse' as const
    const modelProvider = reviewerRoute?.modelProvider ?? durableRoute?.modelProvider ?? request.controller.options.provider
    if (modelProvider === undefined || modelProvider.trim() === '') throw new YuqiOrchestratorError('FIXED_MODEL_INVALID', 'Reviewer requires the controller model provider')
    const firstTaskRequest = Object.values(projection.tasks)[0]?.contract
    const legacyReviewerModel = firstTaskRequest === undefined ? undefined : modelRequestForTask(firstTaskRequest)
    const modelId = reviewerRoute?.modelId ?? durableRoute?.modelId ?? (legacyReviewerModel?.kind === 'legacy' ? legacyReviewerModel.modelId : undefined)
    if (modelId === undefined || modelId.trim() === '') throw new YuqiOrchestratorError('FIXED_MODEL_INVALID', 'Reviewer requires a fixed model from the Team contract')
    let projectSummary: ProjectSummary | undefined
    try { projectSummary = await this.readProjectSummary(workspaceProjectRoot(workspace)) } catch { projectSummary = undefined }
    const childReport = subjectAttempt?.agentSessionId === undefined
      ? undefined
      : (await readLastAssistantOutput(this.ctx, subjectAttempt.agentSessionId, 12_000, request.signal))?.text
    request.signal?.throwIfAborted()
    const beforeRun = this.projectionForTeam(journal, request.teamId)
    if (beforeRun.team.status !== requested.team.status || beforeRun.completionCandidateEventId !== requested.completionCandidateEventId) {
      throw new YuqiOrchestratorError('STALE_SCHEDULE', 'Team changed before reviewer admission')
    }
    const result = await this.reviewer.run({
      reviewId, teamId: request.teamId, trigger: request.trigger, projection: requested, controller: request.controller, workspace,
      ...(projectSummary === undefined ? {} : { projectSummary }),
      ...(request.checkpointSubject === undefined ? {} : { checkpointSubject: request.checkpointSubject }),
      ...(request.checkpointAnchor === undefined ? {} : { checkpointAnchor: request.checkpointAnchor }),
      reviewerIndependence,
      ...(childReport === undefined ? {} : { childReport }),
      ...(requested.reviews[reviewId]?.additionalCriteria === undefined ? {} : { additionalCriteria: requested.reviews[reviewId]!.additionalCriteria }),
      modelPolicy: { harnessDefault: { subagentProvider: 'spawn', modelProvider, modelId, role: 'verifier' } },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    request.signal?.throwIfAborted()
    const current = this.projectionForTeam(journal, request.teamId)
    if (current.team.status !== requested.team.status || current.completionCandidateEventId !== requested.completionCandidateEventId) {
      throw new YuqiOrchestratorError('STALE_SCHEDULE', 'Team or completion candidate changed while reviewing')
    }
    const recorded = projection.team.status === 'completed'
      ? projection
      : await this.reviewResults.record({ teamId: request.teamId, candidateEventId, result, reviewerIndependence }, journal)
    request.signal?.throwIfAborted()
    await reviewJournal.commit(result)
    request.signal?.throwIfAborted()
    await this.notifyParentQualityGate(request.controller, recorded, 'review-result', renderReviewResult(result, recorded.team.locale))
    return { status: 'completed', result }
  }

  async decideReview(request: RecordReviewUserDecisionRequest & { readonly controller: Agent }): Promise<ReturnType<typeof replayTeamEvents>> {
    assertControlOperationId(request.operationId)
    this.assertReviewQuiescent(request.controller, request.teamId)
    const journal = this.journalFor(request.controller)
    let projection = await this.reviewResults.decide(request, journal)
    if (request.decision === 'cancel') {
      // Review cancellation shares the Team control lifecycle. A recovery
      // gate can record intent, but unknown runtime facts remain closed.
      const cancellationOperationId = derivedOperationId(request.operationId, 'cancel')
      const cancellation = { ...request, operationId: cancellationOperationId }
      projection = await this.cancelTeam(cancellation)
    } else if (request.decision === 'fail') {
      this.releaseTeamRunner(journal.key, 'Terminal review user decision')
    } else {
      if (projection.team.status === 'paused') {
        projection = await this.resumeTeam({
          controller: request.controller,
          teamId: request.teamId,
          operationId: `${request.operationId}:resume`,
        })
      }
      const lease = this.acquireRunnerWakeLease(journal.key, 'review user decision')
      try { this.wakeTeamRunner(journal, request.teamId, 'review user decision', lease) } finally { lease?.release() }
    }
    try {
      await this.notifyParentQualityGate(request.controller, projection, 'user-decision', localized(
        projection.team.locale,
        `已持久化 ${request.decision}${request.reason === undefined ? '' : `：${request.reason}`}`,
        `Persisted ${request.decision}${request.reason === undefined ? '' : `: ${request.reason}`}`,
      ))
    } catch (cause) {
      // Durable facts are authoritative. Parent notification is best-effort;
      // do not turn a committed decision into an opaque command rejection.
      this.scheduleParentReportDelivery(String(request.controller.id))
      this.ctx.logger.error(`[yuqi-team] review decision parent notification failed: ${renderErrorChain(cause)}`)
    }
    return projection
  }

  /** Read bounded child conclusions without duplicating them into Team events. */
  async readTeamTaskReports(request: {
    readonly controller: Agent
    readonly teamId: string
    readonly signal?: AbortSignal
  }): Promise<readonly HarnessTaskReport[]> {
    request.signal?.throwIfAborted()
    const projection = replayTeamEvents(this.journalFor(request.controller).read())
    if (projection.team.id !== request.teamId) {
      throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${request.teamId} does not own this controller journal`)
    }
    return Promise.all(projection.taskIds.map(async taskId => {
      const task = projection.tasks[taskId]!
      const attemptId = task.attemptIds.at(-1)
      const attempt = attemptId === undefined ? undefined : projection.attempts[attemptId]
      const agentSessionId = attempt?.evidence?.agentSessionId ?? attempt?.agentSessionId
      const output = agentSessionId === undefined
        ? undefined
        : await readLastAssistantOutput(this.ctx, agentSessionId, 4_000, request.signal)
      const verificationId = task.verificationIds.at(-1)
      const verificationReasons = verificationId === undefined
        ? undefined
        : projection.verifications[verificationId]?.verdict?.reasons
      const needsReport = task.status === 'failed' || task.status === 'cancelled' || task.status === 'blocked'
      return {
        taskId: String(taskId),
        status: task.status,
        ...(agentSessionId === undefined ? {} : { agentSessionId }),
        ...(output === undefined ? {} : { output: output.text, truncated: output.truncated }),
        ...(attempt?.evidence?.stopReason === undefined ? {} : { stopReason: attempt.evidence.stopReason }),
        ...(verificationReasons === undefined || verificationReasons.length === 0 ? {} : { verificationReasons: [...verificationReasons] }),
        ...(!needsReport || output !== undefined ? {} : { reportUnavailable: true }),
      }
    }))
  }

  private drainReviewShutdown(): Promise<void> {
    return this.reviewShutdown ??= (async () => {
      this.disposed = true
      const deadline = Date.now() + REVIEW_STOP_TIMEOUT_MS * 2
      const calls = [...this.reviewCalls.values()]
      for (const call of calls) call.abort.abort(new Error('Host disposed'))
      const stopped = await settleWithin([this.reviewer.dispose(), ...calls.map(call => call.done)], deadline - Date.now())
      if (stopped === undefined || stopped.some(result => result.status === 'rejected')) {
        this.ctx.logger.error('[yuqi-team] reviewer shutdown remains unconfirmed; pending requests must not be redispatched')
      }
      // Stop callbacks enqueue durable closes without awaiting them. Calls.done
      // plus this tail drain must precede domain/transaction disposal.
      const closed = await settleWithin([...this.reviewCloseTails.values()], deadline - Date.now())
      if (closed === undefined || closed.some(result => result.status === 'rejected')) {
        this.ctx.logger.error('[yuqi-team] reviewer shutdown did not confirm durable review closure')
      }
    })()
  }

  private async disposeHost(): Promise<void> {
    console.error('[yuqi-team] lifecycle phase=service-dispose')
    this.disposed = true
    this.teamStartShutdown.abort(new Error('Host disposed'))
    const startShutdown = this.teamStartGate.dispose()
    const reviewerResult = this.drainReviewShutdown()
    for (const resolve of this.parentReportDeliveryDelayResolvers.values()) resolve()
    this.parentReportDeliveryDelayResolvers.clear()
    this.parentReportDeliveryTails.clear()
    this.parentReportDeliveryGenerations.clear()
    for (const timer of this.parentReportDeliveryRetryTimers.values()) clearTimeout(timer)
    this.parentReportDeliveryRetryTimers.clear()
    for (const timer of this.parentReportDeliveryDelayTimers.values()) clearTimeout(timer)
    this.parentReportDeliveryDelayTimers.clear()
    this.parentReportDeliveryRetryAttempts.clear()
    const runnerShutdown = this.disposeTeamRunnerOwnership()
    const recoveredShutdown = [...this.recoveredControllers.values()].map(handle => handle.dispose())
    this.recoveredControllers.clear()
    await Promise.all([
      startShutdown,
      reviewerResult,
      runnerShutdown,
      Promise.allSettled(recoveredShutdown).then(() => undefined),
      this.batchExecutor.dispose(),
      this.workspaceCoordinator.dispose(),
      this.directWorkspaceCoordinator.dispose(),
    ])
    await this.transactions.dispose()
  }

  private async disposeTeamRunnerOwnership(): Promise<void> {
    const deadline = Date.now() + HOST_SHUTDOWN_TIMEOUT_MS
    for (let attempt = 1; attempt <= HOST_SHUTDOWN_DISPOSAL_ATTEMPTS; attempt += 1) {
      const disposals = this.teamRunnerSupervisor.dispose()
      if (disposals.length === 0) return
      const remainingMs = deadline - Date.now()
      const settled = await settleWithin(disposals, remainingMs)
      if (settled === undefined) {
        this.ctx.logger.error(`[yuqi-team] Host shutdown timed out after ${HOST_SHUTDOWN_TIMEOUT_MS}ms with ${disposals.length} controller disposal(s) pending`)
        return
      }
      const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      for (const failure of failures) {
        this.ctx.logger.error(`[yuqi-team] controller disposal attempt ${attempt} failed during Host shutdown: ${renderErrorChain(failure.reason)}`)
      }
      if (failures.length === 0) return
    }
    this.ctx.logger.error('[yuqi-team] Host shutdown retained controller ownership after bounded disposal retries')
  }

  private subprocessRuntime(): HarnessSubprocessRuntime | undefined {
    const candidate = this.ctx.get('subprocess' as never) as unknown
    if (candidate === null || typeof candidate !== 'object') return undefined
    return typeof (candidate as { readonly spawn?: unknown }).spawn === 'function'
      ? candidate as HarnessSubprocessRuntime
      : undefined
  }

  private wakeTeamRunner(
    journal: HarnessSessionJournal,
    teamId: string,
    reason: string,
    lease?: HarnessTeamRunnerWakeLease,
  ): void {
    const operation = lease?.wake() ?? this.teamRunnerSupervisor.wake(journal.key)
    if (operation === undefined) {
      throw new YuqiOrchestratorError(
        'CONTROLLER_REQUIRES_RECONCILIATION',
        `Team cannot ${reason} because this Host does not own a runnable controller`,
      )
    }
    void operation.then(result => {
      if (this.observedBackgroundRunnerOperations.has(operation)) return
      this.observedBackgroundRunnerOperations.add(operation)
      this.staleScheduleReplans.delete(journal.key)
      if (result.disposition === 'recoverable') {
        console.error(`[yuqi-team] background runner stopped after ${reason}: ${result.reason}`)
        void this.markBackgroundRunnerFailure(
          journal,
          teamId,
          reason,
          new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', `Runner stopped with ${result.reason}`),
        )
      }
    }, cause => {
      if (this.observedBackgroundRunnerOperations.has(operation)) return
      this.observedBackgroundRunnerOperations.add(operation)
      if (this.replanStaleBackgroundSchedule(journal, teamId, reason, cause)) return
      this.ctx.logger.error(`[yuqi-team] background runner failed after ${reason}: ${renderErrorChain(cause)}`)
      console.error(`[yuqi-team] background runner failed after ${reason}: ${renderErrorChain(cause)}`)
      void this.markBackgroundRunnerFailure(journal, teamId, reason, cause)
    })
  }

  /**
   * A retry/resume commits a new journal cut before waking the retained
   * runner. The preceding pass can therefore reject its now-obsolete plan
   * with STALE_SCHEDULE. Replan once for the retained runner lifecycle; a
   * second stale failure remains a real runner failure and is reconciled.
   */
  private replanStaleBackgroundSchedule(
    journal: HarnessSessionJournal,
    teamId: string,
    reason: string,
    cause: unknown,
  ): boolean {
    if (!isStaleScheduleError(cause)) return false
    const current = replayTeamEvents(journal.read())
    if (current.team.id !== teamId || current.team.status !== 'running') return false
    if (this.staleScheduleReplans.has(journal.key) || !this.teamRunnerSupervisor.canWake(journal.key)) {
      return false
    }
    this.staleScheduleReplans.add(journal.key)
    this.wakeTeamRunner(journal, teamId, `${reason} stale-schedule replan`)
    return true
  }

  /** Never leave a rejected background pass presented as a healthy running Team. */
  private async markBackgroundRunnerFailure(
    journal: HarnessSessionJournal,
    teamId: string,
    action: string,
    cause: unknown,
  ): Promise<void> {
    try {
      await this.transactions.run(journal, async transaction => {
        const current = replayTeamEvents(transaction.read())
        if (current.team.id !== teamId || current.team.status !== 'running') return current
        const event = createTeamEvent(this.progressClock, this.progressEventIds, teamId, {
          type: 'yuqi/team-status-changed',
          from: 'running',
          to: 'needs_reconciliation',
          reason: `background runner failed after ${action}: ${renderErrorChain(cause)}`,
        })
        const next = validateTeamEvents(transaction.read(), [event])
        await transaction.commit([event], 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably expose the background runner failure')
        return next
      })
    } catch (persistenceCause) {
      this.ctx.logger.error(`[yuqi-team] background runner failure could not be persisted: ${renderErrorChain(persistenceCause)}`)
    }
  }

  private projectionForTeam(journal: TeamEventJournal, teamId: string): ReturnType<typeof replayTeamEvents> {
    const projection = replayTeamEvents(journal.read())
    if (projection.team.id !== teamId) {
      throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${teamId} does not own this controller journal`)
    }
    return projection
  }

  private assertRunnableTeamRunner(journalKey: string, action: string): void {
    if (this.teamRunnerSupervisor.canWake(journalKey)) return
    throw new YuqiOrchestratorError(
      'CONTROLLER_REQUIRES_RECONCILIATION',
      `Team cannot ${action} because this Host has no registered runner/controller ownership`,
    )
  }

  private acquireRunnerWakeLease(journalKey: string, action: string): HarnessTeamRunnerWakeLease {
    const lease = this.teamRunnerSupervisor.acquireWakeLease(journalKey)
    if (lease !== undefined) return lease
    throw new YuqiOrchestratorError(
      'CONTROLLER_REQUIRES_RECONCILIATION',
      `Team cannot ${action} because this Host has no registered runner/controller ownership`,
    )
  }

  private releaseTeamRunner(journalKey: string, reason: string): void {
    const disposal = this.teamRunnerSupervisor.release(journalKey, reason, true)
    if (disposal === undefined) return
    void disposal.catch(cause => {
      this.ctx.logger.error(`[yuqi-team] terminal controller disposal failed: ${renderErrorChain(cause)}`)
    })
  }

  private assertVerificationReadiness(tasks: readonly TeamTaskContract[]): void {
    const issue = findVerificationReadinessIssue(tasks, this.evidenceCapabilities())
    if (issue !== undefined) {
      throw new YuqiOrchestratorError(
        'VERIFICATION_NOT_ALLOWED',
        `Task ${issue.taskId} cannot start verification: ${issue.reason}`,
      )
    }
  }

  private childPort(controller: Agent): HarnessContinuableChildPort {
    const existing = this.childPorts.get(controller)
    if (existing !== undefined) return existing
    const created = new HarnessContinuableChildPort(this.ctx, controller, this.workspacePorts,
      id => this.controllerAgents?.get(id))
    this.childPorts.set(controller, created)
    return created
  }

  /** A durable Team cut is the queue; this method only schedules replay of that source. */
  private queueParentTeamUpdate(controllerSessionId: string, teamId: string, taskId: string): void {
    void teamId
    void taskId
    this.scheduleParentReportDelivery(controllerSessionId)
  }

  private scheduleParentReportDelivery(controllerSessionId: string): void {
    if (this.disposed) return
    this.parentReportDeliveryGenerations.set(
      controllerSessionId,
      (this.parentReportDeliveryGenerations.get(controllerSessionId) ?? 0) + 1,
    )
    this.startParentReportDelivery(controllerSessionId)
  }

  private startParentReportDelivery(controllerSessionId: string): void {
    if (this.disposed) return
    if (this.parentReportDeliveryTails.has(controllerSessionId)) return
    const delivery = this.deliverCoalescedParentReports(controllerSessionId)
    this.parentReportDeliveryTails.set(controllerSessionId, delivery)
    void delivery.catch(cause => {
      this.ctx.logger.warn(`[yuqi-team] durable parent report remains pending for ${controllerSessionId}: ${renderErrorChain(cause)}`)
      return { generation: this.parentReportDeliveryGenerations.get(controllerSessionId) ?? 0, pending: true }
    }).then(result => {
      if (this.disposed) return
      if (this.parentReportDeliveryTails.get(controllerSessionId) === delivery) {
        this.parentReportDeliveryTails.delete(controllerSessionId)
        const pendingGeneration = this.parentReportDeliveryGenerations.get(controllerSessionId)
        if (result.pending) {
          if (pendingGeneration !== undefined) this.scheduleParentReportRetry(controllerSessionId)
          return
        }
        this.parentReportDeliveryRetryAttempts.delete(controllerSessionId)
        if (pendingGeneration === result.generation) this.parentReportDeliveryGenerations.delete(controllerSessionId)
        else if (pendingGeneration !== undefined) this.startParentReportDelivery(controllerSessionId)
      }
    })
  }

  private scheduleParentReportRetry(controllerSessionId: string): void {
    if (this.parentReportDeliveryRetryTimers.has(controllerSessionId)) return
    const attempt = (this.parentReportDeliveryRetryAttempts.get(controllerSessionId) ?? 0) + 1
    this.parentReportDeliveryRetryAttempts.set(controllerSessionId, attempt)
    const delay = Math.min(10_000, 250 * 2 ** Math.min(attempt - 1, 6))
    const timer = setTimeout(() => {
      if (this.disposed) return
      this.parentReportDeliveryRetryTimers.delete(controllerSessionId)
      this.startParentReportDelivery(controllerSessionId)
    }, delay)
    unrefTimer(timer)
    this.parentReportDeliveryRetryTimers.set(controllerSessionId, timer)
  }

  private async deliverCoalescedParentReports(controllerSessionId: string): Promise<{ readonly generation: number; readonly pending: boolean }> {
    let deliveredGeneration = -1
    while (deliveredGeneration !== this.parentReportDeliveryGenerations.get(controllerSessionId)) {
      deliveredGeneration = this.parentReportDeliveryGenerations.get(controllerSessionId) ?? 0
      // Journal commits arrive in bursts. Deliver the newest durable cut once
      // instead of creating one parent turn for every low-level event.
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          this.parentReportDeliveryDelayTimers.delete(controllerSessionId)
          this.parentReportDeliveryDelayResolvers.delete(controllerSessionId)
          resolve()
        }, 25)
        unrefTimer(timer)
        this.parentReportDeliveryDelayTimers.set(controllerSessionId, timer)
        this.parentReportDeliveryDelayResolvers.set(controllerSessionId, resolve)
      })
      if (this.disposed) return { generation: deliveredGeneration, pending: false }
      if (!await this.deliverLatestParentReport(controllerSessionId)) return { generation: deliveredGeneration, pending: true }
    }
    return { generation: deliveredGeneration, pending: false }
  }

  private async deliverLatestParentReport(controllerSessionId: string): Promise<boolean> {
    if ((this.parentReportSuppressions.get(controllerSessionId)?.active ?? 0) > 0) return true
    const liveController = this.controllerAgents?.get(SessionId(controllerSessionId))
      ?? this.recoveredControllers.get(controllerSessionId)?.agent
    const session = liveController?.session ?? await this.loadPersistedControllerSession(controllerSessionId)
    if (session === undefined || readTeamEventsFromSession(session).length === 0) return true
    const sessions = await this.parentProjectionSessionStore(
      session,
      liveController === undefined ? undefined : requireHarnessSessionStore(this.ctx),
    )
    await syncTeamProjectionToParent(session, sessions)
    const binding = readActiveTeamParentBinding(session)
    const parent = binding === undefined ? undefined : this.controllerAgents?.get(SessionId(binding.parentSessionId))
    const controller = liveController ?? { id: session.id, session }
    const journal = this.journalForSession(session, sessions)
    const sourceEvents = journal.read().map(parseTeamEvent)
    if (isTargetRecoveryOnlyCut(sourceEvents)) return true
    const checkpoint = binding === undefined ? undefined
      : readLatestTeamParentReportCheckpoint(session, binding.parentSessionId, binding.generation)
    // A previous append may be visible despite a failed flush. Never use that
    // optimistic cut to suppress notification until persistence succeeds again.
    let newRevisionCompletion: boolean
    try {
      newRevisionCompletion = await hasNewRevisionCompletion(checkpoint,
        async () => { if (checkpoint !== undefined) await journal.commitParentReportCheckpoint(checkpoint) },
        () => {
          const events = journal.read().map(parseTeamEvent)
          const current = replayTeamEvents(events)
          return { events, isCompletedRevision: taskId => current.tasks[taskId]?.status === 'completed'
            && current.tasks[taskId]?.contract.kind === 'user-revision' }
        })
    } catch (cause) {
      this.ctx.logger.warn(`[yuqi-team] parent checkpoint reflush pending: ${renderErrorChain(cause)}`)
      return false
    }
    const projection = replayTeamEvents(journal.read())
    const sourceEventCount = readTeamEventsFromSession(session).length
    const suppression = this.parentReportSuppressions.get(controllerSessionId)
    if (suppression !== undefined) {
      if (suppression.active > 0 || sourceEventCount <= suppression.through) return true
      this.parentReportSuppressions.delete(controllerSessionId)
    }
    // The start tool already reports ordinary running progress and the Team UI
    // projects every durable cut. Waking the parent model for pending, leases,
    // admission, usage, or cancelling churn creates a queue of repetitive
    // replies. Parent turns are reserved for terminal or actionable states.
    const hasActionableTask = projection.taskIds.some(taskId => {
      const status = projection.tasks[taskId]?.status
      return status === 'blocked' || status === 'failed' || status === 'cancelled'
    })
    if (!newRevisionCompletion && (projection.team.status === 'draft' || projection.team.status === 'pausing'
      || projection.team.status === 'cancelling'
      || (projection.team.status === 'running' && !hasActionableTask))) return true
    const hasSettledTask = projection.taskIds.some(taskId => {
      const status = projection.tasks[taskId]?.status
      return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'blocked'
    })
    const taskReports = projection.team.status !== 'cancelled' && hasSettledTask && liveController !== undefined
      ? await this.readTeamTaskReports({ controller: liveController, teamId: String(projection.team.id) })
      : undefined
    const result = await deliverParentReport({
      controller,
      parent,
      journal,
      sessions,
      ...(taskReports === undefined ? {} : { taskReports }),
      shouldDeliver: sourceCut => {
        const currentSuppression = this.parentReportSuppressions.get(controllerSessionId)
        return currentSuppression === undefined
          || (currentSuppression.active === 0 && sourceCut > currentSuppression.through)
      },
    })
    if (result.kind === 'pending' && result.reason !== 'parent-offline' && result.reason !== 'binding-unavailable') {
      this.ctx.logger.warn(`[yuqi-team] parent report ${controllerSessionId} pending: ${result.reason}`)
    }
    return result.kind !== 'pending'
  }

  private scheduleParentReportRecovery(session: Session): void {
    if (readTeamEventsFromSession(session).length > 0) this.scheduleParentReportDelivery(String(session.id))
    const id = String(session.id)
    if (this.parentReportRecoveryScans.has(id)) return
    const scan = this.replayParentReportsFor(id).catch(cause => {
      this.ctx.logger.warn(`[yuqi-team] parent report recovery scan failed for ${String(session.id)}: ${renderErrorChain(cause)}`)
    }).finally(() => {
      if (this.parentReportRecoveryScans.get(id) === scan) this.parentReportRecoveryScans.delete(id)
    })
    this.parentReportRecoveryScans.set(id, scan)
  }

  private async replayParentReportsFor(parentSessionId: string): Promise<void> {
    const persistence = this.ctx.sessionPersistence as HarnessSessionPersistence
    const rawHeaders = await persistence.list()
    const headers = extractPersistenceHeaders(rawHeaders)
    const indexed = new Set(this.sidecar?.listSessionIds() ?? [])
    for (const header of headers) {
      if (this.disposed) return
      const controllerSessionId = String(header.id)
      if (controllerSessionId === parentSessionId) continue
      // Agent creation used to inflate EVERY historical chat here, once per
      // new agent. Ordinary transcripts can be huge and have no parent report
      // authority. Include current controllers, indexed sidecar journals and
      // legacy top-level parent-linked controllers, never arbitrary history.
      if (!controllerSessionId.startsWith('yuqi-team-') && !indexed.has(controllerSessionId)
        && (header.parentSession === undefined || header.origin === 'subagent')) continue
      if (indexed.has(controllerSessionId)) {
        const facts = this.sidecar!.readStoredEvents(controllerSessionId)
        const binding = [...facts].reverse().filter(event => event.type === TEAM_PARENT_BINDING_EVENT)
          .map(event => parseTeamParentBindingData(event.data)).find(value => value !== undefined)
        // A durable rebind supersedes the immutable native header.
        if ((binding?.parentSessionId ?? header.parentSession) !== parentSessionId) continue
      }
      const live = this.controllerAgents?.get(SessionId(controllerSessionId))
      let controllerSession: Session | undefined
      try {
        controllerSession = live?.session ?? await this.loadPersistedControllerSession(controllerSessionId, undefined, true)
      } catch (cause) {
        this.ctx.logger.warn(`[yuqi-team] isolated unreadable controller Session ${JSON.stringify(controllerSessionId)} during parent recovery: ${cause instanceof Error ? cause.message : String(cause)}`)
        continue
      }
      if (controllerSession === undefined || readActiveTeamParentBinding(controllerSession)?.parentSessionId !== parentSessionId) continue
      this.scheduleParentReportDelivery(controllerSessionId)
    }
  }

  private async notifyParentQualityGate(
    controller: Agent,
    projection: ReturnType<typeof replayTeamEvents>,
    stage: 'review-started' | 'review-result' | 'review-skipped' | 'rework-created' | 'awaiting-user' | 'user-decision' | 'completed',
    detail?: string,
  ): Promise<void> {
    const binding = readActiveTeamParentBinding(controller.session)
    const parent = binding === undefined ? undefined : this.controllerAgents?.get(SessionId(binding.parentSessionId))
    if (parent !== undefined && stage !== 'completed') {
      const text = renderParentQualityGateNotice(projection.team.locale, projection, stage, detail)
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin', plugin: 'yuqi-team-orchestrator', form: 'notice',
          summary: boundContextSummary(`${projection.team.title}: ${stage}`),
        },
      })
      if (parent.status === 'running') parent.steer(message)
      else parent.followup(message)
    }
    this.scheduleParentReportDelivery(String(controller.id))
    await this.parentReportDeliveryTails.get(String(controller.id))?.catch(() => undefined)
  }

}

function skippedBatchResult(children: readonly HarnessGatedBatchChildRequest[]): ExecuteTeamBatchResult {
  return Object.freeze({
    handles: Object.freeze(children.map(child => Object.freeze({
      taskId: child.taskId,
      attemptId: child.attemptId,
      admission: Promise.resolve(undefined as never),
      settled: Promise.resolve(undefined as never),
    }))),
  })
}

function attemptEvidenceEventId(events: readonly unknown[], taskId: string, attemptId: string): TeamEventId {
  const event = events.map(parseTeamEvent).reverse().find(candidate => candidate.type === 'yuqi/attempt-evidence-recorded'
    && String(candidate.taskId) === taskId && String(candidate.attemptId) === attemptId)
  if (event === undefined) throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', `Attempt ${attemptId} has no durable settlement anchor`)
  return event.eventId
}

function verificationVerdictEventId(events: readonly unknown[], operationId: string): TeamEventId {
  const event = events.map(parseTeamEvent).reverse().find(candidate => candidate.type === 'yuqi/verification-verdict-recorded'
    && String(candidate.operationId) === operationId)
  if (event === undefined) throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', `Verification ${operationId} has no durable verdict anchor`)
  return event.eventId
}

function reviewBudget(projection: ReturnType<typeof replayTeamEvents>): ReviewAutomaticReworkBudget {
  return Object.freeze({
    checkpointLimit: projection.team.reviewPolicy?.maxReworkRounds ?? 0,
    teamLimit: DEFAULT_MAX_TEAM_AUTOMATIC_REWORKS,
  })
}

function consecutiveFailedVerdicts(projection: ReturnType<typeof replayTeamEvents>, taskId: string): number {
  let count = 0
  const verdicts = Object.values(projection.verificationVerdictOperations)
    .filter(verdict => String(verdict.taskId) === taskId)
  for (let index = verdicts.length - 1; index >= 0; index -= 1) {
    if (verdicts[index]!.disposition !== 'failed') break
    count += 1
  }
  return count
}

function reviewIdentity(teamId: string, candidateEventId: string, round: number, trigger: ReviewTrigger, retryKey?: string): string {
  const base = `review:${teamId}:${trigger}:${round}:${candidateEventId}`
  if (retryKey === undefined) return base.slice(0, 160)
  const suffix = `:retry:${retryKey}`
  return `${base.slice(0, Math.max(0, 160 - suffix.length))}${suffix}`.slice(0, 160)
}

function reviewReworkContract(
  projection: ReturnType<typeof replayTeamEvents>,
  sourceReviewId: string,
  round: number,
  findings: readonly ReviewFinding[],
): TeamTaskContract {
  const source = projection.taskIds.map(taskId => projection.tasks[taskId]!).findLast(task => task.contract.kind !== 'review-rework')
    ?? projection.tasks[projection.taskIds.at(-1)!]!
  const recommendations = findings.map(finding => finding.recommendation)
  const fileScope = [...new Set(projection.taskIds.flatMap(taskId => projection.tasks[taskId]!.contract.fileScope))]
  // A failure-escalation review may create corrective work while its source
  // task is failed. Depending on every historical task would make that rework
  // permanently unschedulable, so only completed prerequisites are retained.
  const dependencies = projection.taskIds.filter(taskId => projection.tasks[taskId]?.status === 'completed')
  const model = modelRequestForTask(source.contract)
  return {
    taskId: TaskId(`review-rework:${sourceReviewId}:${round}`),
    revision: 1,
    goal: `Address reviewer findings from ${sourceReviewId}`,
    scope: recommendations.length === 0 ? ['Resolve the bounded reviewer findings'] : recommendations,
    nonGoals: ['Do not reopen or rewrite completed task history.', ...source.contract.nonGoals],
    dependencies,
    fileScope,
    modelRole: 'worker',
    ...(model.kind === 'legacy' ? { modelId: model.modelId } : { modelRequest: model }),
    acceptanceCriteria: recommendations.length === 0 ? ['Resolve the authorized review rework and report changed files'] : recommendations,
    authorityMode: source.contract.authorityMode,
    inputDigest: `review-rework:${sourceReviewId}:${round}`,
    ...(source.contract.baselineRef === undefined ? {} : { baselineRef: source.contract.baselineRef }),
    ...(source.contract.verificationChecks === undefined ? {} : { verificationChecks: source.contract.verificationChecks }),
    ...(source.contract.maxAttempts === undefined ? {} : { maxAttempts: source.contract.maxAttempts }),
    kind: 'review-rework',
    reviewRework: { sourceReviewId, round },
  }
}

function renderReviewResult(result: ReviewResult, locale: TeamLocale): string {
  const firstUnverified = result.unverified[0]
  const detail = firstUnverified === undefined ? '' : localized(
    locale,
    `；首项未核验原因=${boundedReviewDetail(firstUnverified)}`,
    `; first unverified reason=${boundedReviewDetail(firstUnverified)}`,
  )
  return localized(
    locale,
    `Review ${result.reviewId} 结论=${result.decision}；发现=${result.findings.length}；未核验=${result.unverified.length}${detail}。`,
    `Review ${result.reviewId} decision=${result.decision}; findings=${result.findings.length}; unverified=${result.unverified.length}${detail}.`,
  )
}

function boundedReviewDetail(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ')
  return normalized.length <= 320 ? normalized : `${normalized.slice(0, 319)}…`
}

function renderParentQualityGateNotice(
  locale: TeamLocale,
  projection: ReturnType<typeof replayTeamEvents>,
  stage: string,
  detail: string | undefined,
): string {
  const reviewId = projection.reviewIds.at(-1)
  const base = localized(
    locale,
    `Yuqi Team 主控通知：stage=${stage} team=${projection.team.id} status=${projection.team.status}${reviewId === undefined ? '' : ` review=${reviewId}`}。`,
    `Yuqi Team controller notice: stage=${stage} team=${projection.team.id} status=${projection.team.status}${reviewId === undefined ? '' : ` review=${reviewId}`}.`,
  )
  const fallback = stage === 'completed'
    ? localized(locale, '质量门已满足，无需进入 reviewer。', 'The quality gate is satisfied; no reviewer is needed.')
    : localized(locale, '请按当前 durable Team 状态继续处理。', 'Continue from the current durable Team state.')
  return `${base}\n${detail ?? fallback}`
}

function localizedReviewSkipReason(locale: TeamLocale, reason: string): string {
  if (reason === '简单单任务不强制消耗 reviewer Token') {
    return localized(locale, reason, 'A simple single-task Team does not require reviewer token usage.')
  }
  if (reason === 'pre-completion review requires a completed Team projection') {
    return localized(locale, 'pre-completion review 需要已完成的 Team projection', reason)
  }
  if (reason === '当前没有两次可核验的连续失败') {
    return localized(locale, reason, 'There are not two verifiable consecutive failures.')
  }
  return reason
}

function localized(locale: TeamLocale, zh: string, en: string): string {
  return locale === 'en' ? en : zh
}

function assertControlOperationId(operationId: string): void {
  if (!CONTROL_OPERATION_ID.test(operationId)) throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Control operation id format is invalid')
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const candidate = timer as unknown as { readonly unref?: () => void }
  candidate.unref?.()
}

function derivedOperationId(root: string, phase: string): string {
  const suffix = `:${phase}`
  const full = `${root}${suffix}`
  if (full.length <= 128) return full
  const hash = [...root].reduce((value, character) => ((value * 31) + character.codePointAt(0)!) >>> 0, 0).toString(36)
  return `${root.slice(0, Math.max(1, 128 - suffix.length - hash.length - 1))}:${hash}${suffix}`
}

function combinedSignal(children: readonly HarnessGatedBatchChildRequest[]): AbortSignal {
  return AbortSignal.any(children.map(child => child.signal))
}

function isDirectWorkspaceValue(value: unknown): value is {
  readonly mode: 'direct'
  readonly projectRoot: string
  readonly protectedRoots: readonly string[]
} {
  return typeof value === 'object' && value !== null
    && (value as { readonly mode?: unknown }).mode === 'direct'
    && typeof (value as { readonly projectRoot?: unknown }).projectRoot === 'string'
    && Array.isArray((value as { readonly protectedRoots?: unknown }).protectedRoots)
}

function normalizeProjectPath(value: string): string {
  return value.replace(/[\\/]+$/u, '').replaceAll('\\', '/').toLowerCase()
}

function cancelTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_CANCEL_TIMEOUT_MS
  if (!Number.isInteger(timeout) || timeout < MIN_CANCEL_TIMEOUT_MS || timeout > MAX_CANCEL_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be an integer from ${MIN_CANCEL_TIMEOUT_MS} to ${MAX_CANCEL_TIMEOUT_MS}`)
  }
  return timeout
}

async function waitForTeamPaused(journal: HarnessSessionJournal, teamId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const projection = replayTeamEvents(journal.read())
    if (projection.team.id !== teamId) throw new YuqiOrchestratorError('TEAM_MISMATCH', 'Task model target changed while pausing')
    if (projection.team.status === 'paused') return projection
    if (projection.team.status !== 'pausing') {
      throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', `Team left pausing as ${projection.team.status} during task model switch`)
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new YuqiOrchestratorError('CONTROL_RUNTIME_UNCERTAIN', 'Timed out waiting for Team to finish pausing before task model switch')
    await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)))
  }
}

function hasActiveVerificationOnly(projection: ReturnType<typeof replayTeamEvents>): boolean {
  const hasActiveChild = Object.values(projection.attempts)
    .some(attempt => attempt.status === 'dispatching' || attempt.status === 'running')
  if (hasActiveChild) return false
  return Object.values(projection.verifications)
    .some(verification => verification.status === 'pending' || verification.status === 'running')
}

function hasSchedulableTasks(projection: ReturnType<typeof replayTeamEvents>): boolean {
  return projection.taskIds.some(taskId => isSchedulableTaskStatus(projection.tasks[taskId]?.status))
}

/**
 * A cold scan may run because a parent bridge or Session was hydrated, not
 * because this Host lost its runner.  Only the batch executor can establish
 * that every active attempt is still owned by this exact Host process.
 */
export function hasOnlyLocallyManagedActiveAttempts(
  projection: ReturnType<typeof replayTeamEvents>,
  journalKey: string,
  localActivity: Pick<TeamBatchExecutor<ContentBlock[]>, 'hasActiveAttempt'>,
): boolean {
  const active = Object.values(projection.attempts)
    .filter(attempt => attempt.status === 'dispatching' || attempt.status === 'running')
  return active.length > 0 && active.every(attempt => localActivity.hasActiveAttempt(journalKey, String(attempt.id)))
}

function teamCompletionReady(projection: ReturnType<typeof replayTeamEvents>): boolean {
  return projection.team.status === 'running' && projection.taskIds.length > 0
    && domainTeamCompletionReady(projection)
}

function quiescentRetryableGraphReady(projection: ReturnType<typeof replayTeamEvents>): boolean {
  const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'blocked'])
  return projection.team.status === 'running'
    && !hasActiveAttempts(projection)
    && projection.taskIds.length > 0
    && projection.taskIds.every(taskId => terminalStatuses.has(projection.tasks[taskId]?.status ?? ''))
    && projection.taskIds.some(taskId => projection.tasks[taskId]?.status !== 'completed')
    && !projectionHasReconciliationGap(projection)
    && !Object.values(projection.fileLeases).some(lease => lease.status === 'active')
    && (projection.workspace === undefined || projection.workspace.status === 'ready')
}

function assertPausedTeamCanResume(projection: ReturnType<typeof replayTeamEvents>, maxConcurrency: number): void {
  const disposition = classifyTeamResume(projection, { maxConcurrency })
  if (disposition === 'requires-reconciliation') {
    throw new YuqiOrchestratorError(
      'CONTROLLER_REQUIRES_RECONCILIATION',
      'Team cannot resume until the current runtime and durable facts are reconciled',
    )
  }
  if (disposition === 'decision-required') {
    throw new YuqiOrchestratorError(
      'CONTROL_NOT_ALLOWED',
      'Team has no executable work; resolve the current task or review decision, then retry or revise work before continuing',
    )
  }
}

async function settleWithin(
  disposals: readonly Promise<void>[],
  timeoutMs: number,
): Promise<readonly PromiseSettledResult<void>[] | undefined> {
  if (timeoutMs <= 0) return undefined
  let timer!: ReturnType<typeof setTimeout>
  const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs) })
  try {
    return await Promise.race([Promise.allSettled(disposals), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Stable for concurrent clicks on one cut, distinct after any durable change. */
function targetedRecoveryOperationId(controllerSessionId: string, teamId: string, lastEventId: unknown): string {
  const digest = createHash('sha256')
    .update(`${controllerSessionId}\0${teamId}\0${String(lastEventId ?? '')}`)
    .digest('hex')
    .slice(0, 24)
  return `target-recover:${digest}`
}

/** A persisted UI recovery clear remains non-waking after a Host restart. */
function isTargetRecoveryOnlyCut(events: readonly TeamEvent[]): boolean {
  const latest = events.at(-1)
  return (latest?.type === 'yuqi/team-recovery-cleared' || latest?.type === 'yuqi/team-recovery-cleared-from-journal')
    && String(latest.operationId).startsWith('target-recover:')
}

export default YuqiTeamOrchestratorService

function recoveredBudgetSettlementEvents(
  clock: { readonly nowIso: () => string },
  eventIds: { readonly next: () => string },
  teamId: string,
  projection: ReturnType<typeof replayTeamEvents>,
  taskId: TaskId,
  attemptId: AttemptId,
  end: HarnessProgressSettlementRequest['end'],
): TeamEvent[] {
  const reservation = Object.values(projection.budgetReservations).find(candidate => candidate.status === 'active' && candidate.taskId === taskId && candidate.attemptId === attemptId)
  if (reservation === undefined) return []
  return [createTeamEvent(clock, eventIds, teamId, {
    type: 'yuqi/budget-reservation-settled',
    reservationId: reservation.reservationId,
    taskId,
    attemptId,
    status: end.usage === undefined ? 'unknown' : 'known',
    ...(end.usage === undefined
      ? { reason: 'admitted child ended without usage' }
      : { usage: { totalTokens: totalTokens(end.usage) } }),
  })]
}

function totalTokens(usage: NonNullable<HarnessProgressSettlementRequest['end']['usage']>): number {
  return usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

function renderErrorChain(value: unknown): string {
  const seen = new Set<unknown>()
  const messages: string[] = []
  let current: unknown = value
  while (current instanceof Error && !seen.has(current) && messages.length < 6) {
    seen.add(current)
    const code = 'code' in current && typeof current.code === 'string' ? ` [${current.code}]` : ''
    messages.push(`${current.name}${code}: ${current.message}`)
    current = current.cause
  }
  if (messages.length === 0) return 'unknown error'
  return messages.join(' <- ')
}

function isStaleScheduleError(value: unknown): value is YuqiOrchestratorError {
  return value instanceof YuqiOrchestratorError && value.code === 'STALE_SCHEDULE'
}

function validAgentModel(
  value: AgentOptions | undefined,
): { readonly provider: string; readonly model?: string; readonly maxTokens?: number } | undefined {
  const provider = value?.provider?.trim()
  if (provider === undefined || provider === '') return undefined
  const model = value?.model?.trim()
  const maxTokens = value?.maxTokens
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) return undefined
  return {
    provider,
    ...(model === undefined || model === '' ? {} : { model }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  }
}

function durableControllerRoute(projection: ReturnType<typeof replayTeamEvents>, controller: Agent): ProviderModelRef {
  const modelProvider = projection.team.controllerModel?.provider ?? controller.options.provider
  const modelId = projection.team.controllerModel?.model ?? controller.options.model
  if (modelProvider === undefined || modelProvider.trim() === '' || modelId === undefined || modelId.trim() === '') {
    throw new YuqiOrchestratorError('FIXED_MODEL_INVALID', 'Team controller has no complete durable model route')
  }
  return Object.freeze({ modelProvider: modelProvider.trim(), modelId: modelId.trim() })
}

function durableControllerRouteOrAttempt(
  projection: ReturnType<typeof replayTeamEvents>,
  controller: Agent,
  attempt: ReturnType<typeof replayTeamEvents>['attempts'][string] | undefined,
): ProviderModelRef {
  try { return durableControllerRoute(projection, controller) } catch (cause) {
    if (attempt?.modelProvider !== undefined && attempt.modelProvider.trim() !== ''
      && attempt.modelId !== undefined && attempt.modelId.trim() !== '') {
      return Object.freeze({ modelProvider: attempt.modelProvider.trim(), modelId: attempt.modelId.trim() })
    }
    throw cause
  }
}

function routingCandidates(
  controller: ProviderModelRef,
  providerScope: ProviderScope,
  teamPolicy: TeamModelPolicy,
  taskRequest: TaskModelRequest,
): readonly ProviderModelRef[] {
  const candidates: ProviderModelRef[] = [controller]
  if (taskRequest.kind === 'exact') candidates.push(taskRequest.model)
  else if (taskRequest.kind === 'legacy') candidates.push({ modelProvider: controller.modelProvider, modelId: taskRequest.modelId })
  if (teamPolicy.kind === 'fixed') candidates.push(teamPolicy.model)
  else if (teamPolicy.kind === 'automatic') {
    const tier = automaticTierForTaskRequest(taskRequest)
    if (tier !== undefined) candidates.push(...teamPolicy.tierCandidates[tier])
  }
  return candidates.filter(candidate => isProviderAllowed(candidate.modelProvider, controller.modelProvider, providerScope))
}

function isFallbackReason(reason: ModelRouteReason): reason is HarnessResolvedModelRoute['fallbackReason'] & string {
  return reason === 'automatic-candidates-exhausted'
    || reason === 'task-default-controller-inherit'
    || reason === 'team-inherit-controller'
}

function routeAsFixedModel(route: HarnessResolvedModelRoute, role: TeamTaskContract['modelRole']): FixedModelRef {
  return Object.freeze({
    subagentProvider: 'spawn',
    modelProvider: route.route.modelProvider,
    modelId: route.route.modelId,
    role,
  })
}
