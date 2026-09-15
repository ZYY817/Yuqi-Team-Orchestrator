/** Single-controller, single-child dispatch use case. */

import { AttemptId, TaskId, TeamId } from '../domain/ids.ts'
import { applyTeamEvent, replayTeamEvents } from '../domain/projection.ts'
import type { AttemptEvidenceView } from '../domain/projection.ts'
import type { TeamEvent } from '../domain/events.ts'
import { YuqiOrchestratorError } from './errors.ts'
import { DurableJournalCoordinator } from './durable-journal.ts'
import { projectionRequiresReconciliation } from './reconciliation.ts'
import { createTeamEvent, validateTeamEvents } from './team-events.ts'
import { decideChildSettlement } from './child-settlement.ts'
import type { ChildEnd, Clock, ContinuableChildPort, EventIdSource, TeamEventJournal } from './ports.ts'
import type { TeamEventBody } from './team-events.ts'
import type { ModelCatalogFact, ModelRouteTaskTier, ProviderModelRef } from '../domain/model-route.ts'
import type { ModelRouteBasis, ModelRouteReason } from './model-routing.ts'

const MAX_BUFFERED_EARLY_ENDS = 128

/** Request to dispatch one direct continuable child. */
export interface DispatchOneRequest<Prompt> {
  readonly taskOutcomeVersion?: 1
  readonly teamId: string
  readonly taskId: string
  readonly attemptId: string
  readonly subagentProvider: string
  readonly modelProvider: string
  readonly modelId: string
  readonly route?: ProviderModelRef
  readonly routeBasis?: ModelRouteBasis
  readonly requestedTier?: ModelRouteTaskTier
  readonly fallbackReason?: Extract<ModelRouteReason,
    'automatic-candidates-exhausted' | 'task-default-controller-inherit' | 'team-inherit-controller'>
  readonly catalogEvidence?: readonly ModelCatalogFact[]
  readonly label: string
  readonly prompt: Prompt
  readonly signal: AbortSignal
}

/** Accepted child plus a promise for durable settlement processing. */
export interface DispatchOneResult {
  readonly attemptId: string
  readonly childSessionId: string
  readonly messageId: string
  readonly settled: Promise<AttemptEvidenceView>
}

interface ActiveDispatch {
  readonly disposeEndListener: () => void
  readonly rejectSettlement: (error: unknown) => void
  readonly abortAdmission: () => void
  settlementStarted: boolean
}

interface PendingSettlement {
  readonly promise: Promise<AttemptEvidenceView>
  readonly resolve: (evidence: AttemptEvidenceView) => void
  readonly reject: (error: unknown) => void
}

/** Coordinates at most one admitted child per controller journal. */
export class OneChildCoordinator<Prompt> {
  readonly #clock: Clock
  readonly #eventIds: EventIdSource
  readonly #transactions: DurableJournalCoordinator
  readonly #ownsTransactions: boolean
  readonly #active = new Map<string, ActiveDispatch>()
  readonly #inFlight = new Set<Promise<unknown>>()
  #disposed = false
  #disposal: Promise<void> | undefined

  constructor(clock: Clock, eventIds: EventIdSource, transactions?: DurableJournalCoordinator) {
    this.#clock = clock
    this.#eventIds = eventIds
    this.#transactions = transactions ?? new DurableJournalCoordinator()
    this.#ownsTransactions = transactions === undefined
  }

  dispatch(request: DispatchOneRequest<Prompt>, journal: TeamEventJournal, children: ContinuableChildPort<Prompt>): Promise<DispatchOneResult> {
    return this.#track(this.#dispatch(request, journal, children))
  }

  async #dispatch(request: DispatchOneRequest<Prompt>, journal: TeamEventJournal, children: ContinuableChildPort<Prompt>): Promise<DispatchOneResult> {
    if (this.#disposed) throw new YuqiOrchestratorError('SERVICE_DISPOSED', 'Yuqi orchestrator service is disposed')
    if (this.#active.has(journal.key)) throw new YuqiOrchestratorError('CONTROLLER_BUSY', 'This controller already has an active Yuqi child')

    const teamId = TeamId(request.teamId)
    const taskId = TaskId(request.taskId)
    const attemptId = AttemptId(request.attemptId)
    if (request.route !== undefined
      && (request.route.modelProvider !== request.modelProvider || request.route.modelId !== request.modelId)) {
      throw new YuqiOrchestratorError('INVALID_BATCH', 'Structured route must match child start model arguments')
    }
    if (request.route !== undefined && (request.routeBasis === undefined || request.catalogEvidence === undefined)) {
      throw new YuqiOrchestratorError('INVALID_BATCH', 'Structured route requires durable decision evidence')
    }
    let recoveryToken: string | undefined
    await this.#transactions.run(journal, async (transaction) => {
      const projection = replayTeamEvents(transaction.read())
      if (projection.team.id !== teamId) throw new YuqiOrchestratorError('TEAM_MISMATCH', 'The requested Team does not belong to this controller')
      if (projection.team.status !== 'running') throw new YuqiOrchestratorError('TEAM_NOT_RUNNING', 'The requested Team must be running')
      if (projectionRequiresReconciliation(projection)) {
        throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'This controller has an unresolved Yuqi attempt')
      }
      const task = Object.hasOwn(projection.tasks, taskId) ? projection.tasks[taskId] : undefined
      if (task === undefined || task.status !== 'running') throw new YuqiOrchestratorError('TASK_NOT_RUNNABLE', 'The requested task must exist and be running')
      recoveryToken = recoveryTokenFrom(this.#eventIds)
      const intent = this.#event(request.teamId, {
        type: 'yuqi/attempt-created', taskId, attemptId,
        ...(request.taskOutcomeVersion === undefined ? {} : { taskOutcomeVersion: request.taskOutcomeVersion }),
        ordinal: task.attemptIds.length + 1,
        ...(request.route === undefined
          ? { modelProvider: request.modelProvider, modelId: request.modelId }
          : {
              route: request.route,
              routeBasis: request.routeBasis!,
              ...(request.requestedTier === undefined ? {} : { requestedTier: request.requestedTier }),
              ...(request.fallbackReason === undefined ? {} : { fallbackReason: request.fallbackReason }),
              catalogEvidence: request.catalogEvidence!.map(fact => ({ ...fact, model: { ...fact.model } })),
            }),
        recoveryToken,
      })
      applyTeamEvent(projection, intent)
      await transaction.commit([intent], 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably persist the child dispatch intent')
    })

    const settlement = pendingSettlement()
    void settlement.promise.catch(() => undefined)
    const admissionAbort = new AbortController()
    let admittedChildId: string | undefined
    let readyForSettlement = false
    let earlyOverflow = false
    const earlyEnds = new Map<string, ChildEnd>()
    let active!: ActiveDispatch

    const release = (): void => {
      active.disposeEndListener()
      /* v8 ignore else -- one Controller key cannot be replaced while this active transaction holds its lock. */
      if (this.#active.get(journal.key) === active) this.#active.delete(journal.key)
    }

    const settle = async (end: ChildEnd): Promise<void> => {
      if (active.settlementStarted || admittedChildId !== end.childSessionId) return
      active.settlementStarted = true
      try {
        const terminalStatus = statusFor(end.stopReason)
        const settledAt = this.#clock.nowIso()
        const events: TeamEvent[] = [
          this.#event(request.teamId, {
            type: 'yuqi/attempt-status-changed', taskId, attemptId, from: 'running', to: terminalStatus,
            reason: `child stopped: ${end.stopReason}`,
          }),
          this.#event(request.teamId, {
            type: 'yuqi/attempt-evidence-recorded', taskId, attemptId, runId: end.runId,
            agentSessionId: end.childSessionId, provider: end.provider, stopReason: end.stopReason,
            hasAssistantOutput: end.hasAssistantOutput,
            ...(end.taskOutcome === undefined ? {} : { taskOutcome: end.taskOutcome }),
            ...(end.usage === undefined ? {} : { usage: end.usage }),
            settledAt,
          }),
        ]
        await this.#transactions.run(journal, async (transaction) => {
          const current = replayTeamEvents(transaction.read())
          const cancelling = current.team.status === 'cancelling'
            || Object.values(current.controlOperations).some(operation => operation.action === 'cancel'
              || (operation.action === 'stop-task' && operation.taskId === taskId && operation.attemptId === attemptId))
          // This compatibility entry always requires independent verification;
          // it still shares the same business-result and cancellation decision.
          const decision = decideChildSettlement(end, cancelling, true, current.attempts[attemptId]?.taskOutcomeVersion)
          // Preserve the legacy caller-owned failure transition when no result
          // contract/evidence was supplied. Modern results cannot bypass it.
          if (terminalStatus === 'settled' || current.attempts[attemptId]?.taskOutcomeVersion !== undefined || end.taskOutcome !== undefined) {
            events.push(this.#event(request.teamId, {
              type: 'yuqi/task-status-changed', taskId, from: 'running', to: decision.taskStatus, reason: decision.reason,
            }))
          }
          validateTeamEvents(transaction.read(), events)
          await transaction.commit(events, 'SETTLEMENT_PERSISTENCE_FAILED', 'Child settled, but Yuqi could not durably persist its settlement')
        })
        settlement.resolve({
          runId: end.runId, agentSessionId: end.childSessionId, provider: end.provider,
          stopReason: end.stopReason, hasAssistantOutput: end.hasAssistantOutput, settledAt,
          ...(end.taskOutcome === undefined ? {} : { taskOutcome: end.taskOutcome }),
        })
        release()
      } catch (cause) {
        active.disposeEndListener()
        settlement.reject(new YuqiOrchestratorError('SETTLEMENT_PERSISTENCE_FAILED', 'Child settled, but Yuqi could not durably persist its settlement', { cause }))
      }
    }

    const disposeEndListener = children.onEnd((end) => {
      if (!readyForSettlement) {
        if (earlyEnds.has(end.childSessionId) || earlyEnds.size < MAX_BUFFERED_EARLY_ENDS) earlyEnds.set(end.childSessionId, end)
        else earlyOverflow = true
        return
      }
      void this.#track(settle(end))
    })
    active = {
      disposeEndListener,
      rejectSettlement: settlement.reject,
      abortAdmission: () => admissionAbort.abort(new YuqiOrchestratorError('SERVICE_DISPOSED', 'Yuqi orchestrator is disposing')),
      settlementStarted: false,
    }
    this.#active.set(journal.key, active)

    if (this.#disposed) {
      await this.#recordPreAdmissionFailure(request.teamId, taskId, attemptId, journal, 'service disposed before child admission')
      release()
      throw new YuqiOrchestratorError('SERVICE_DISPOSED', 'Yuqi orchestrator disposed before child admission')
    }

    let admission
    try {
      if (replayTeamEvents(journal.read()).team.manualOwnership?.state === 'human-owned') throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'Manual ownership blocks child admission')
      admission = await children.start({
        subagentProvider: request.subagentProvider,
        label: `yuqi:v1:${recoveryToken!}:${request.label}`,
        prompt: request.prompt,
        modelProvider: request.modelProvider,
        modelId: request.modelId,
        maxDepth: 1,
        signal: AbortSignal.any([request.signal, admissionAbort.signal]),
      })
    } catch (cause) {
      try {
        await this.#recordPreAdmissionFailure(request.teamId, taskId, attemptId, journal, 'child admission failed')
      } catch (persistenceCause) {
        release()
        throw new AggregateError([cause, persistenceCause], 'Child admission and failure persistence both failed')
      }
      release()
      if (this.#disposed) throw new YuqiOrchestratorError('SERVICE_DISPOSED', 'Yuqi orchestrator disposed before child admission', { cause })
      throw new YuqiOrchestratorError('CHILD_ADMISSION_FAILED', 'Harness rejected the child before admission', { cause })
    }

    admittedChildId = admission.childSessionId
    const admissionEvents = [
      this.#event(request.teamId, {
        type: 'yuqi/attempt-admitted', taskId, attemptId,
        agentSessionId: admission.childSessionId, messageId: admission.messageId,
      }),
      this.#event(request.teamId, {
        type: 'yuqi/attempt-status-changed', taskId, attemptId, from: 'dispatching', to: 'running',
      }),
    ] as const
    try {
      await this.#transactions.run(journal, async (transaction) => {
        validateTeamEvents(transaction.read(), admissionEvents)
        await transaction.commit(admissionEvents, 'ADMISSION_PERSISTENCE_FAILED', 'Harness admitted the child, but Yuqi could not durably persist the admission; reconciliation is required')
      })
      readyForSettlement = true
    } catch (cause) {
      active.disposeEndListener()
      const error = new YuqiOrchestratorError('ADMISSION_PERSISTENCE_FAILED', 'Harness admitted the child, but Yuqi could not durably persist the admission; reconciliation is required', { cause })
      settlement.reject(error)
      throw error
    }

    const earlyEnd = earlyEnds.get(admission.childSessionId)
    earlyEnds.clear()
    if (earlyEnd !== undefined) {
      void this.#track(settle(earlyEnd))
    } else if (earlyOverflow) {
      active.disposeEndListener()
      const error = new YuqiOrchestratorError('EARLY_END_OVERFLOW', 'The early child settlement buffer overflowed; reconciliation is required')
      settlement.reject(error)
      throw error
    }

    if (this.#disposed) {
      active.disposeEndListener()
      throw new YuqiOrchestratorError('SERVICE_DISPOSED', 'Yuqi orchestrator disposed after child admission; reconciliation is required')
    }

    return {
      attemptId: request.attemptId,
      childSessionId: admission.childSessionId,
      messageId: admission.messageId,
      settled: settlement.promise,
    }
  }

  /** Stop new admissions and wait until every in-flight transaction is safe. */
  dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal
    this.#disposed = true
    for (const active of this.#active.values()) {
      active.abortAdmission()
      active.disposeEndListener()
      if (!active.settlementStarted) active.rejectSettlement(new YuqiOrchestratorError('SERVICE_DISPOSED', 'Yuqi orchestrator stopped observing this child'))
    }
    this.#disposal = this.#drainInFlight()
    return this.#disposal
  }

  async #drainInFlight(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight])
    this.#active.clear()
    if (this.#ownsTransactions) await this.#transactions.dispose()
  }

  async #recordPreAdmissionFailure(teamId: string, taskId: TaskId, attemptId: AttemptId, journal: TeamEventJournal, reason: string): Promise<void> {
    const event = this.#event(teamId, {
      type: 'yuqi/attempt-status-changed', taskId, attemptId, from: 'dispatching', to: 'failed', reason,
    })
    await this.#transactions.run(journal, async (transaction) => {
      validateTeamEvents(transaction.read(), [event])
      await transaction.commit([event], 'ADMISSION_PERSISTENCE_FAILED', 'Yuqi could not durably persist the child admission failure')
    })
  }

  #track<Result>(operation: Promise<Result>): Promise<Result> {
    const tracked = operation.finally(() => { this.#inFlight.delete(tracked) })
    this.#inFlight.add(tracked)
    return tracked
  }

  #event(teamId: string, body: TeamEventBody): TeamEvent {
    return createTeamEvent(this.#clock, this.#eventIds, teamId, body)
  }
}

function statusFor(stopReason: string): 'settled' | 'failed' | 'cancelled' {
  if (stopReason === 'completed') return 'settled'
  if (stopReason === 'aborted') return 'cancelled'
  return 'failed'
}

function recoveryTokenFrom(eventIds: EventIdSource): string {
  const token = eventIds.next()
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new YuqiOrchestratorError('INVALID_BATCH', 'The event-id source cannot provide a safe recovery token')
  }
  return token
}

function pendingSettlement(): PendingSettlement {
  let resolve!: (evidence: AttemptEvidenceView) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<AttemptEvidenceView>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}
