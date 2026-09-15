/** Multi-child execution for one durable deterministic Team batch. */

import { AttemptId, FileLeaseId, TaskId } from '../domain/ids.ts'
import { projectionHasReconciliationGap, replayTeamEvents, teamCompletionReady } from '../domain/projection.ts'
import type { AttemptEvidenceView } from '../domain/projection.ts'
import type { TeamEvent } from '../domain/events.ts'
import { TeamBatchIntentCoordinator } from './commit-team-batch.ts'
import { hasActiveAttempts } from './control-team.ts'
import { DurableJournalCoordinator } from './durable-journal.ts'
import { YuqiOrchestratorError } from './errors.ts'
import type { BatchAttemptIntent } from './prepare-team-batch.ts'
import type { PrepareTeamBatchRequest } from './prepare-team-batch.ts'
import type { ChildAdmission, ChildControlPort, ChildEnd, ChildExecutionBoundary, ChildUsage, Clock, ContinuableChildPort, EventIdSource, TeamEventJournal } from './ports.ts'
import { SettlementRouter } from './settlement-router.ts'
import { createTeamEvent, validateTeamEvents } from './team-events.ts'
import { decideChildSettlement } from './child-settlement.ts'

export interface BatchChildRequest<Prompt> extends BatchAttemptIntent {
  readonly subagentProvider: string
  readonly label: string
  readonly prompt: Prompt
  readonly signal: AbortSignal
  readonly executionBoundary?: ChildExecutionBoundary
}

export interface ExecuteTeamBatchRequest<Prompt> extends Omit<PrepareTeamBatchRequest, 'attempts'> {
  readonly children: readonly BatchChildRequest<Prompt>[]
  /** One shared Host proof awaited by every child after durable intent and before runtime admission. */
  readonly beforeAdmission?: () => Promise<void>
}

export interface BatchChildHandle {
  readonly taskId: string
  readonly attemptId: string
  readonly admission: Promise<ChildAdmission>
  readonly settled: Promise<AttemptEvidenceView>
}

export interface ExecuteTeamBatchResult {
  readonly handles: readonly BatchChildHandle[]
}

export interface CancellationWaitResult {
  readonly activeCount: number
  readonly outcome: 'settled' | 'failed' | 'timeout'
}

interface RouterEntry<Prompt> {
  readonly source: ContinuableChildPort<Prompt>
  readonly router: SettlementRouter
}

interface ActiveExecution {
  readonly abort: AbortController
  readonly controls: ChildControlPort
  readonly rejectSettlement: (error: unknown) => void
  readonly terminal: Promise<void>
  readonly resolveTerminal: () => void
  readonly rejectTerminal: (error: unknown) => void
  disposeUsageListener: () => void
  childSessionId?: string
  disposeInterruptRequested: boolean
  disposeInterruptFailure?: unknown
  settlementStarted: boolean
  latestUsage?: ChildUsage
  usagePending: boolean
  usageWriting: boolean
}

/** Starts and durably accounts for multiple direct children of one Controller. */
export class TeamBatchExecutor<Prompt> {
  readonly #clock: Clock
  readonly #eventIds: EventIdSource
  readonly #transactions: DurableJournalCoordinator
  readonly #ownsTransactions: boolean
  readonly #intents: TeamBatchIntentCoordinator
  readonly #routers = new Map<string, RouterEntry<Prompt>>()
  /** Bind a Controller journal to one child runtime before the intent transaction. */
  readonly #boundSources = new Map<string, ContinuableChildPort<Prompt>>()
  readonly #active = new Map<string, Map<string, ActiveExecution>>()
  readonly #inFlight = new Set<Promise<unknown>>()
  #disposed = false
  #disposal: Promise<void> | undefined

  constructor(clock: Clock, eventIds: EventIdSource, transactions?: DurableJournalCoordinator) {
    this.#clock = clock
    this.#eventIds = eventIds
    this.#transactions = transactions ?? new DurableJournalCoordinator()
    this.#ownsTransactions = transactions === undefined
    this.#intents = new TeamBatchIntentCoordinator(clock, eventIds, this.#transactions)
  }

  async execute(
    request: ExecuteTeamBatchRequest<Prompt>,
    journal: TeamEventJournal,
    children: ContinuableChildPort<Prompt> & ChildControlPort,
  ): Promise<ExecuteTeamBatchResult> {
    if (this.#disposed) throw disposedError()
    this.#assertSourceCompatible(journal.key, children)
    const sourceWasBound = this.#boundSources.has(journal.key)
    if (!sourceWasBound) this.#boundSources.set(journal.key, children)
    let prepared: Awaited<ReturnType<TeamBatchIntentCoordinator['commit']>>
    try {
      prepared = await this.#intents.commit({
        teamId: request.teamId,
        plan: request.plan,
        maxConcurrency: request.maxConcurrency,
        attempts: request.children,
        ...(request.execution === undefined ? {} : { execution: request.execution }),
      }, journal)
    } catch (cause) {
      if (!sourceWasBound && !this.#routers.has(journal.key) && !this.#active.has(journal.key)) this.#boundSources.delete(journal.key)
      throw cause
    }
    if (this.#disposed) throw disposedError()
    const router = this.#routerFor(journal.key, children)

    const admissionGate = request.beforeAdmission?.() ?? Promise.resolve()
    // Every handle observes the same proof. Keep the rejected promise handled
    // even if a caller abandons the returned child handles.
    void admissionGate.catch(() => undefined)
    const handles = request.children.map(child => {
      const recoveryToken = requiredRecoveryToken(child.attemptId, prepared.projection.attempts[child.attemptId]?.recoveryToken)
      return this.#launch(request.teamId, child, recoveryToken, admissionGate, journal, children, router)
    })
    Object.freeze(handles)
    return Object.freeze({ handles })
  }

  #launch(
    teamId: string,
    request: BatchChildRequest<Prompt>,
    recoveryToken: string,
    admissionGate: Promise<void>,
    journal: TeamEventJournal,
    children: ContinuableChildPort<Prompt> & ChildControlPort,
    router: SettlementRouter,
  ): BatchChildHandle {
    const taskId = TaskId(request.taskId)
    const attemptId = AttemptId(request.attemptId)
    const claim = router.openAdmission()
    const settlement = deferred<AttemptEvidenceView>()
    void settlement.promise.catch(() => undefined)
    const terminal = deferred<void>()
    void terminal.promise.catch(() => undefined)
    const abort = new AbortController()
    const active: ActiveExecution = {
      abort,
      controls: children,
      rejectSettlement: settlement.reject,
      terminal: terminal.promise,
      resolveTerminal: () => terminal.resolve(undefined),
      rejectTerminal: terminal.reject,
      disposeUsageListener: () => undefined,
      disposeInterruptRequested: false,
      settlementStarted: false,
      usagePending: false,
      usageWriting: false,
    }
    this.#setActive(journal.key, attemptId, active)
    active.disposeUsageListener = children.onUsage?.((observed) => {
      if (this.#disposed || active.childSessionId !== observed.childSessionId || active.settlementStarted) return
      active.latestUsage = { ...observed, usage: { ...observed.usage } }
      active.usagePending = true
      // One outstanding transaction per child, not one per model message.
      // Read the latest slot only after acquiring the shared journal gate.
      if (active.usageWriting) return
      active.usageWriting = true
      void this.#track((async () => {
        try {
          while (active.usagePending && !active.settlementStarted && !this.#disposed) {
            await this.#recordUsage(teamId, taskId, attemptId, active, journal)
          }
        } finally { active.usageWriting = false }
      })()).catch(() => undefined)
    }) ?? (() => undefined)
    let claimOpen = true
    let admissionPersisted = false

    const admission = this.#track((async (): Promise<ChildAdmission> => {
      try {
        await admissionGate
        if (replayTeamEvents(journal.read()).team.manualOwnership?.state === 'human-owned') throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'Manual ownership blocks child admission')
        const admitted = await children.start({
          subagentProvider: request.subagentProvider,
          label: `yuqi:v1:${recoveryToken}:${request.label}`,
          prompt: request.prompt,
          modelProvider: request.modelProvider,
          modelId: request.modelId,
          maxDepth: 1,
          signal: AbortSignal.any([request.signal, abort.signal]),
          ...(request.executionBoundary === undefined ? {} : { executionBoundary: request.executionBoundary }),
        })
        active.childSessionId = admitted.childSessionId
        await this.#transactions.run(journal, async (transaction) => {
          const events = this.#admissionEvents(teamId, taskId, attemptId, admitted)
          validateTeamEvents(transaction.read(), events)
          await transaction.commit(events, 'ADMISSION_PERSISTENCE_FAILED', 'Harness admitted a child, but Yuqi could not durably persist the admission')
        })
        admissionPersisted = true
        claimOpen = false
        claim.admit(admitted.childSessionId, end => {
          void this.#track(this.#settle(teamId, taskId, attemptId, request.leaseId, end, journal, settlement, active))
        })
        if (abort.signal.aborted && !(this.#disposed && active.disposeInterruptRequested)) {
          try {
            children.interrupt(admitted.childSessionId)
            if (this.#disposed) active.disposeInterruptRequested = true
          } catch (cause) {
            if (this.#disposed) {
              active.disposeInterruptRequested = true
              active.disposeInterruptFailure = cause
            }
            else await this.#recordCancellationRuntimeUncertain(teamId, journal)
          }
        }
        return admitted
      } catch (cause) {
        let terminalPersisted = false
        if (claimOpen) {
          claim.cancel()
          claimOpen = false
        }
        if (!admissionPersisted && !(cause instanceof YuqiOrchestratorError && cause.code === 'ADMISSION_PERSISTENCE_FAILED')) {
          try {
            await this.#recordStartFailure(teamId, taskId, attemptId, request.leaseId, journal)
            terminalPersisted = true
          } catch (persistenceCause) {
            const error = new AggregateError([cause, persistenceCause], 'Child start and failure persistence both failed')
            settlement.reject(error)
            active.rejectTerminal(error)
            this.#deleteActive(journal.key, attemptId, active)
            throw error
          }
        }
        const error = cause instanceof YuqiOrchestratorError
          ? cause
          : new YuqiOrchestratorError('CHILD_ADMISSION_FAILED', 'Harness rejected the child before admission', { cause })
        settlement.reject(error)
        if (terminalPersisted) active.resolveTerminal()
        else active.rejectTerminal(error)
        this.#deleteActive(journal.key, attemptId, active)
        throw error
      }
    })())
    void admission.catch(() => undefined)
    return Object.freeze({ taskId: request.taskId, attemptId: request.attemptId, admission, settled: settlement.promise })
  }

  async #settle(
    teamId: string,
    taskId: TaskId,
    attemptId: AttemptId,
    leaseId: string | undefined,
    end: ChildEnd,
    journal: TeamEventJournal,
    settlement: Deferred<AttemptEvidenceView>,
    active: ActiveExecution,
  ): Promise<void> {
    /* v8 ignore next -- SettlementRouter removes a child listener before its one delivery. */
    if (active.settlementStarted) return
    active.settlementStarted = true
    active.usagePending = false
    active.disposeUsageListener()
    const settledAt = this.#clock.nowIso()
    let evidence: AttemptEvidenceView = {
      runId: end.runId, agentSessionId: end.childSessionId, provider: end.provider,
      stopReason: end.stopReason, hasAssistantOutput: end.hasAssistantOutput, settledAt,
      ...(end.taskOutcome === undefined ? {} : { taskOutcome: end.taskOutcome }),
    }
    try {
      await this.#transactions.run(journal, async (transaction) => {
        const current = replayTeamEvents(transaction.read())
        const currentAttempt = current.attempts[attemptId]
        const currentTask = current.tasks[taskId]
        if (currentAttempt?.evidence !== undefined) {
          const recorded = currentAttempt.evidence
          if (recorded.agentSessionId !== end.childSessionId
            || recorded.runId !== end.runId
            || recorded.stopReason !== end.stopReason) {
            throw new YuqiOrchestratorError(
              'CONTROLLER_REQUIRES_RECONCILIATION',
              `Attempt ${attemptId} received a conflicting duplicate terminal observation`,
            )
          }
          // The public progress observer may win the race against the direct
          // child listener. Its durable evidence is authoritative; replaying
          // the same terminal fact is a successful idempotent settlement.
          evidence = recorded
          return
        }
        if (currentAttempt === undefined || currentTask === undefined
          || (currentAttempt.status !== 'running' && currentAttempt.status !== 'unknown')
          || currentTask.status !== 'running') {
          throw new YuqiOrchestratorError('SETTLEMENT_PERSISTENCE_FAILED', `Attempt ${attemptId} is no longer eligible for terminal settlement`)
        }
        const stopped = taskStopWasRequested(current, taskId, attemptId)
        // Keep the last observed cumulative snapshot even when its telemetry
        // write was coalesced away. Only end.usage proves final budget usage.
        const latest = active.latestUsage
        const usageEvents: TeamEvent[] = latest !== undefined
          && currentAttempt.status === 'running'
          && latest.childSessionId === end.childSessionId
          && (currentAttempt.observedUsage === undefined || !sameUsage(currentAttempt.observedUsage, latest.usage))
          ? [this.#event(teamId, { type: 'yuqi/attempt-usage-observed', taskId, attemptId, agentSessionId: end.childSessionId, usage: latest.usage })]
          : []
        const events = this.#withQuiescentTeamCompletion(
          teamId,
          transaction.read(),
          [...usageEvents, ...this.#settlementEvents(teamId, taskId, attemptId, currentAttempt.status, leaseId, end, settledAt, cancellationWasRequested(current) || stopped, current)],
        )
        validateTeamEvents(transaction.read(), events)
        await transaction.commit(events, 'SETTLEMENT_PERSISTENCE_FAILED', 'Child settled, but Yuqi could not durably persist its settlement')
      })
      settlement.resolve(evidence)
      active.resolveTerminal()
    } catch (error) {
      settlement.reject(error)
      active.rejectTerminal(error)
    } finally {
      this.#deleteActive(journal.key, attemptId, active)
    }
  }

  async #recordUsage(
    teamId: string,
    taskId: TaskId,
    attemptId: AttemptId,
    active: ActiveExecution,
    journal: TeamEventJournal,
  ): Promise<void> {
    await this.#transactions.run(journal, async transaction => {
      if (active.settlementStarted || this.#disposed || !active.usagePending) return
      const observed = active.latestUsage!
      active.usagePending = false
      const projection = replayTeamEvents(transaction.read())
      const attempt = projection.attempts[attemptId]
      if (attempt?.status !== 'running' || attempt.agentSessionId !== observed.childSessionId) return
      if (attempt.observedUsage !== undefined && sameUsage(attempt.observedUsage, observed.usage)) return
      const event = this.#event(teamId, {
        type: 'yuqi/attempt-usage-observed', taskId, attemptId,
        agentSessionId: observed.childSessionId, usage: observed.usage,
      })
      validateTeamEvents(transaction.read(), [event])
      await transaction.commit([event], 'SETTLEMENT_PERSISTENCE_FAILED', 'Yuqi could not persist live child usage')
    })
  }

  async #recordStartFailure(
    teamId: string,
    taskId: TaskId,
    attemptId: AttemptId,
    leaseId: string | undefined,
    journal: TeamEventJournal,
  ): Promise<void> {
    await this.#transactions.run(journal, async (transaction) => {
      const current = replayTeamEvents(transaction.read())
      const cancelling = cancellationWasRequested(current)
      const events = this.#withQuiescentTeamCompletion(teamId, transaction.read(), [
        ...budgetSettlementEvents(this.#clock, this.#eventIds, teamId, current, taskId, attemptId, 'not-admitted', undefined, 'child admission failed'),
        this.#event(teamId, { type: 'yuqi/attempt-status-changed', taskId, attemptId, from: 'dispatching', to: cancelling ? 'cancelled' : 'failed', reason: cancelling ? 'Team cancellation before admission' : 'child admission failed' }),
        this.#event(teamId, { type: 'yuqi/task-status-changed', taskId, from: 'running', to: cancelling ? 'cancelled' : 'failed', reason: cancelling ? 'Team cancellation before admission' : 'child admission failed' }),
        ...(leaseId === undefined ? [] : [this.#event(teamId, {
          type: 'yuqi/file-lease-released', leaseId: FileLeaseId(leaseId), taskId, attemptId, reason: cancelling ? 'Team cancellation before admission' : 'child admission failed',
        })]),
      ])
      validateTeamEvents(transaction.read(), events)
      await transaction.commit(events, 'ADMISSION_PERSISTENCE_FAILED', 'Yuqi could not durably persist the child admission failure')
    })
  }

  async #recordCancellationRuntimeUncertain(teamId: string, journal: TeamEventJournal): Promise<void> {
    try {
      await this.#transactions.run(journal, async transaction => {
        const current = replayTeamEvents(transaction.read())
        if (current.team.status !== 'cancelling') return
        const event = this.#event(teamId, {
          type: 'yuqi/team-status-changed', from: 'cancelling', to: 'needs_reconciliation',
          reason: 'Harness rejected an interrupt after admission won the cancellation race',
        })
        validateTeamEvents(transaction.read(), [event])
        await transaction.commit([event], 'SETTLEMENT_PERSISTENCE_FAILED', 'Yuqi could not persist an uncertain cancellation race')
      })
    } catch {
      // The shared transaction coordinator is already poisoned on durability failure.
      // Keeping the admitted child routed allows a later terminal fact to reject
      // through the same fail-closed boundary instead of fabricating completion.
    }
  }

  #admissionEvents(teamId: string, taskId: TaskId, attemptId: AttemptId, admission: ChildAdmission): readonly TeamEvent[] {
    return [
      this.#event(teamId, { type: 'yuqi/attempt-admitted', taskId, attemptId, agentSessionId: admission.childSessionId, messageId: admission.messageId }),
      this.#event(teamId, { type: 'yuqi/attempt-status-changed', taskId, attemptId, from: 'dispatching', to: 'running' }),
    ]
  }

  #settlementEvents(
    teamId: string,
    taskId: TaskId,
    attemptId: AttemptId,
    attemptFrom: 'running' | 'unknown',
    leaseId: string | undefined,
    end: ChildEnd,
    settledAt: string,
    cancelling: boolean,
    projection: ReturnType<typeof replayTeamEvents>,
  ): readonly TeamEvent[] {
    const decision = decideChildSettlement(end, cancelling, projection.tasks[taskId]?.contract.verificationChecks !== undefined, projection.attempts[attemptId]?.taskOutcomeVersion)
    const { completedWithoutVerification, attemptStatus, taskStatus, reason: settlementReason } = decision
    const events: TeamEvent[] = [
      this.#event(teamId, { type: 'yuqi/attempt-status-changed', taskId, attemptId, from: attemptFrom, to: attemptStatus, reason: settlementReason }),
      this.#event(teamId, { type: 'yuqi/attempt-evidence-recorded', taskId, attemptId, runId: end.runId, agentSessionId: end.childSessionId, provider: end.provider, stopReason: end.stopReason, hasAssistantOutput: end.hasAssistantOutput, ...(end.taskOutcome === undefined ? {} : { taskOutcome: end.taskOutcome }), ...(end.reportedChangedFiles === undefined ? {} : { reportedChangedFiles: [...end.reportedChangedFiles] }), ...(end.usage === undefined ? {} : { usage: end.usage }), settledAt }),
      ...budgetSettlementEvents(this.#clock, this.#eventIds, teamId, projection, taskId, attemptId, end.usage === undefined ? 'unknown' : 'known', end.usage === undefined ? undefined : { totalTokens: totalTokens(end.usage) }, end.usage === undefined ? 'admitted child ended without usage' : undefined),
      this.#event(teamId, { type: 'yuqi/task-status-changed', taskId, from: 'running', to: taskStatus, reason: settlementReason }),
    ]
    if (completedWithoutVerification) {
      events.splice(events.length - 1, 0, this.#event(teamId, {
        type: 'yuqi/attempt-status-changed', taskId, attemptId, from: 'settled', to: 'completed', reason: 'task has no verification checks',
      }))
    }
    if (decision.releaseLease && leaseId !== undefined) {
      events.push(this.#event(teamId, {
        type: 'yuqi/file-lease-released', leaseId: FileLeaseId(leaseId), taskId, attemptId, reason: settlementReason,
      }))
    }
    return events
  }

  #event(teamId: string, body: Parameters<typeof createTeamEvent>[3]): TeamEvent {
    return createTeamEvent(this.#clock, this.#eventIds, teamId, body)
  }

  #withQuiescentTeamCompletion(teamId: string, inputs: readonly unknown[], events: readonly TeamEvent[]): readonly TeamEvent[] {
    const projected = validateTeamEvents(inputs, events)
    if (hasActiveAttempts(projected)) return events
    if (projected.team.status === 'pausing') return [...events, this.#event(teamId, {
        type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused', reason: 'all active attempts settled',
      })]
    if (projected.team.status === 'cancelling') return [...events, this.#event(teamId, {
      type: 'yuqi/team-status-changed', from: 'cancelling', to: 'cancelled', reason: 'all active attempts settled',
    })]
    if (projected.team.status === 'running' && projected.taskIds.length > 0 && teamCompletionReady(projected)) {
      return [...events, this.#event(teamId, {
        type: 'yuqi/team-status-changed', from: 'running', to: 'completed',
        reason: 'all tasks completed and the reviewer gate is satisfied',
      })]
    }
    // A pending quality gate remains owned by the run coordinator. Settlement
    // commits only worker/attempt facts until that durable gate is satisfied.
    // A failed, cancelled, or blocked task is a durable controller decision point,
    // not a reconciliation gap. Once the whole graph is quiescent, pause it so the
    // controller can retry or accept the terminal result without cold recovery
    // later misclassifying the Team as an orphaned running process.
    if (quiescentRetryableGraphReady(projected)) {
      return [...events,
        this.#event(teamId, {
          type: 'yuqi/team-status-changed', from: 'running', to: 'pausing',
          reason: 'task graph settled with retryable terminal tasks',
        }),
        this.#event(teamId, {
          type: 'yuqi/team-status-changed', from: 'pausing', to: 'paused',
          reason: 'controller decision required for failed, cancelled, or blocked tasks',
        }),
      ]
    }
    return events
  }

  /** Signal all in-memory attempts after the durable cancellation intent commits. */
  cancelActive(journalKey: string): number {
    const active = this.#active.get(journalKey)
    if (active === undefined) return 0
    this.#signalCancellation(active.values())
    return active.size
  }

  /** Start exact-child cancellation without blocking a native tool abort. */
  cancelActiveInBackground(journalKey: string, onFailure: (cause: unknown) => void): number {
    const executions = [...(this.#active.get(journalKey)?.values() ?? [])]
    void this.#cancelInbox(executions).catch(onFailure)
    return executions.length
  }

  /** Read-only local admission/settlement fact used by manual-resolution safety gates. */
  hasActiveAttempt(journalKey: string, attemptId: string): boolean {
    return this.#active.get(journalKey)?.has(attemptId) === true
  }

  /** Wait for exact locally owned attempts; cold-runtime gaps require reconciliation. */
  async waitForAttempts(journalKey: string, attemptIds: readonly string[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const active = this.#active.get(journalKey)
    const executions = attemptIds.map((attemptId) => {
      const execution = active?.get(attemptId)
      if (execution === undefined) {
        throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', `Attempt ${attemptId} is not owned by this Host runtime`)
      }
      return execution
    })
    let rejectAbort!: (reason: unknown) => void
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    const onAbort = () => rejectAbort(signal.reason ?? new Error('Team progress wait aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await Promise.race([Promise.all(executions.map(execution => execution.terminal)), aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** Wait for the first exact locally owned attempt to reach durable terminal accounting. */
  async waitForAnyAttempt(journalKey: string, attemptIds: readonly string[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (attemptIds.length === 0) {
      throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'A progress wait requires at least one active attempt')
    }
    const active = this.#active.get(journalKey)
    const executions = attemptIds.map((attemptId) => {
      const execution = active?.get(attemptId)
      if (execution === undefined) {
        throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', `Attempt ${attemptId} is not owned by this Host runtime`)
      }
      return execution
    })
    let rejectAbort!: (reason: unknown) => void
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    const onAbort = () => rejectAbort(signal.reason ?? new Error('Team progress wait aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await Promise.race([...executions.map(execution => execution.terminal), aborted])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** Signal cancellation once and wait for durable terminal accounting. */
  async cancelActiveAndWait(journalKey: string, timeoutMs: number): Promise<CancellationWaitResult> {
    const active = this.#active.get(journalKey)
    if (active === undefined) return { activeCount: 0, outcome: 'failed' }
    const executions = [...active.values()]
    const cancellation = this.#cancelInbox(executions)
    let timer!: ReturnType<typeof setTimeout>
    const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs) })
    // A failed native cancel is an actionable runtime error, not a failed
    // attempt result. Preserve that rejection; only the later durable terminal
    // promise is normalized to the legacy `failed` outcome.
    const terminal = cancellation.then(
      () => Promise.all(executions.map(execution => execution.terminal))
        .then(() => 'settled' as const, () => 'failed' as const),
      cause => Promise.reject(cause),
    )
    try {
      return { activeCount: executions.length, outcome: await Promise.race([terminal, timeout]) }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Signal one exact attempt and wait for its durable terminal accounting. */
  async cancelAttemptAndWait(journalKey: string, attemptId: string, timeoutMs: number): Promise<CancellationWaitResult> {
    const execution = this.#active.get(journalKey)?.get(attemptId)
    if (execution === undefined) return { activeCount: 0, outcome: 'failed' }
    const cancellation = this.#cancelInbox([execution])
    let timer!: ReturnType<typeof setTimeout>
    const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs) })
    const terminal = cancellation.then(
      () => execution.terminal.then(() => 'settled' as const, () => 'failed' as const),
      cause => Promise.reject(cause),
    )
    try {
      return { activeCount: 1, outcome: await Promise.race([terminal, timeout]) }
    } finally {
      clearTimeout(timer)
    }
  }

  #signalCancellation(executions: Iterable<ActiveExecution>): void {
    const failures: unknown[] = []
    for (const execution of executions) {
      try {
        if (execution.childSessionId === undefined) execution.abort.abort(new Error('Team cancellation requested'))
        else execution.controls.interrupt(execution.childSessionId)
      } catch (cause) {
        failures.push(cause)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'One or more child interrupts failed')
  }

  /**
   * Cancellation is deliberately a second control plane. The first signal
   * stops the current turn while preserving the inbox; only adapters that can
   * prove exact child ownership may then release that child's queued work.
   */
  #cancelInbox(executions: Iterable<ActiveExecution>): Promise<void> {
    const operations: Promise<void>[] = []
    for (const execution of executions) {
      const childSessionId = execution.childSessionId
      const cancel = execution.controls.cancel
      try {
        if (childSessionId === undefined) execution.abort.abort(new Error('Team cancellation requested'))
        else if (cancel === undefined) execution.controls.interrupt(childSessionId)
        else operations.push(cancel.call(execution.controls, childSessionId))
      } catch (cause) {
        operations.push(Promise.reject(cause))
      }
    }
    return Promise.all(operations).then(() => undefined)
  }

  #routerFor(key: string, source: ContinuableChildPort<Prompt>): SettlementRouter {
    const existing = this.#routers.get(key)
    if (existing !== undefined) {
      /* v8 ignore next 3 -- Compatibility is checked before intent commit; this only guards invalid duplicate journal stores racing under one key. */
      if (existing.source !== source) throw new YuqiOrchestratorError('INVALID_BATCH', 'A Controller must use one child runtime source')
      return existing.router
    }
    const router = new SettlementRouter(source)
    this.#routers.set(key, { source, router })
    return router
  }

  #assertSourceCompatible(key: string, source: ContinuableChildPort<Prompt>): void {
    const existing = this.#boundSources.get(key) ?? this.#routers.get(key)?.source
    if (existing !== undefined && existing !== source) {
      throw new YuqiOrchestratorError('INVALID_BATCH', 'An active Controller batch is bound to another Agent instance')
    }
  }

  dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal
    this.#disposed = true
    const disposal = this.#drain()
    let tracked!: Promise<void>
    tracked = disposal.catch(error => {
      // A failed runtime interrupt leaves the binding available for a later
      // retry. Do not make a failed disposal permanently hide that state.
      if (this.#disposal === tracked) this.#disposal = undefined
      throw error
    })
    this.#disposal = tracked
    return tracked
  }

  async #drain(): Promise<void> {
    this.#requestDisposal()
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight])

    const failures = [...this.#active.values()]
      .flatMap(executions => [...executions.values()])
      .flatMap(active => active.disposeInterruptFailure === undefined ? [] : [active.disposeInterruptFailure])
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more admitted child interrupts failed during disposal')
    }

    for (const router of this.#routers.values()) router.router.dispose()
    const error = disposedError()
    for (const controller of this.#active.values()) for (const active of controller.values()) {
      active.disposeUsageListener()
      active.abort.abort(error)
      active.rejectSettlement(error)
      active.rejectTerminal(error)
    }
    this.#active.clear()
    this.#routers.clear()
    this.#boundSources.clear()
    if (this.#ownsTransactions) await this.#transactions.dispose()
  }

  /** Stop every admitted runtime before the local binding can be cleared. */
  #requestDisposal(): void {
    const error = disposedError()
    for (const controller of this.#active.values()) for (const active of controller.values()) {
      active.disposeUsageListener()
      active.usagePending = false
      active.disposeInterruptRequested = false
      active.disposeInterruptFailure = undefined
      active.abort.abort(error)
      if (active.childSessionId === undefined) continue
      try {
        active.controls.interrupt(active.childSessionId)
        active.disposeInterruptRequested = true
      } catch (cause) {
        active.disposeInterruptRequested = true
        active.disposeInterruptFailure = cause
      }
    }
  }

  #track<Result>(operation: Promise<Result>): Promise<Result> {
    const tracked = operation.finally(() => { this.#inFlight.delete(tracked) })
    this.#inFlight.add(tracked)
    return tracked
  }

  #setActive(journalKey: string, attemptId: AttemptId, active: ActiveExecution): void {
    let controller = this.#active.get(journalKey)
    if (controller === undefined) {
      controller = new Map()
      this.#active.set(journalKey, controller)
    }
    controller.set(attemptId, active)
  }

  #deleteActive(journalKey: string, attemptId: AttemptId, active: ActiveExecution): void {
    const controller = this.#active.get(journalKey)
    /* v8 ignore next -- Only the exact ActiveExecution that was registered can call this private release path. */
    if (controller?.get(attemptId) !== active) return
    active.disposeUsageListener()
    controller.delete(attemptId)
    if (controller.size > 0) return
    this.#active.delete(journalKey)
    const router = this.#routers.get(journalKey)
    router?.router.dispose()
    this.#routers.delete(journalKey)
    this.#boundSources.delete(journalKey)
  }
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

function sameUsage(left: ChildUsage['usage'], right: ChildUsage['usage']): boolean {
  return left.uncachedInputTokens === right.uncachedInputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
}

function totalTokens(usage: NonNullable<ChildEnd['usage']>): number {
  return usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

function budgetSettlementEvents(
  clock: Clock,
  eventIds: EventIdSource,
  teamId: string,
  projection: ReturnType<typeof replayTeamEvents>,
  taskId: TaskId,
  attemptId: AttemptId,
  status: 'known' | 'not-admitted' | 'unknown',
  usage: { readonly totalTokens: number } | undefined,
  reason: string | undefined,
): readonly TeamEvent[] {
  const reservation = Object.values(projection.budgetReservations).find(candidate => candidate.taskId === taskId && candidate.attemptId === attemptId && candidate.status === 'active')
  if (reservation === undefined) return []
  return [createTeamEvent(clock, eventIds, teamId, {
    type: 'yuqi/budget-reservation-settled', reservationId: reservation.reservationId, taskId, attemptId, status,
    ...(usage === undefined ? {} : { usage }),
    ...(reason === undefined ? {} : { reason }),
  })]
}

/** Prevents a child launch when its durable recovery identity was not committed. */
export function requiredRecoveryToken(attemptId: string, recoveryToken: string | undefined): string {
  if (recoveryToken === undefined) {
    throw new YuqiOrchestratorError('INTENT_PERSISTENCE_FAILED', `Attempt ${attemptId} has no durable recovery token`)
  }
  return recoveryToken
}

interface Deferred<Value> {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
  readonly reject: (error: unknown) => void
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

function disposedError(): YuqiOrchestratorError {
  return new YuqiOrchestratorError('SERVICE_DISPOSED', 'Yuqi Team batch executor is disposed')
}

/** Cancellation remains authoritative after a runtime scan moves the Team to reconciliation. */
function cancellationWasRequested(projection: ReturnType<typeof replayTeamEvents>): boolean {
  return projection.team.status === 'cancelling'
    || Object.values(projection.controlOperations).some(operation => operation.action === 'cancel')
}

function taskStopWasRequested(
  projection: ReturnType<typeof replayTeamEvents>,
  taskId: TaskId,
  attemptId: AttemptId,
): boolean {
  return Object.values(projection.controlOperations).some(operation => operation.action === 'stop-task'
    && operation.taskId === taskId && operation.attemptId === attemptId)
}
