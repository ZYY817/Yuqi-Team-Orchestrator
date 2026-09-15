/** Host-neutral continuous scheduling and verification loop for one Team. */

import type { TeamProjection, TaskView } from '../domain/projection.ts'
import { replayTeamEvents } from '../domain/projection.ts'
import { YuqiOrchestratorError } from './errors.ts'
import type { TeamEventJournal } from './ports.ts'
import { planTeamSchedule, type TeamSchedulePlan } from './schedule-team.ts'
import type { DirectWriteStrategy } from '../domain/execution-policy.ts'

export interface TeamRunBatchRequest {
  readonly teamId: string
  readonly journal: TeamEventJournal
  readonly plan: TeamSchedulePlan
  readonly signal: AbortSignal
}

export interface TeamRunProgressRequest {
  readonly teamId: string
  readonly journal: TeamEventJournal
  readonly activeTaskIds: readonly string[]
  readonly signal: AbortSignal
}

export interface TeamVerificationTarget {
  readonly taskId: string
  readonly attemptId: string
  readonly verificationId?: string
}

export interface TeamRunVerificationRequest {
  readonly teamId: string
  readonly journal: TeamEventJournal
  readonly tasks: readonly TeamVerificationTarget[]
  readonly signal: AbortSignal
}

export interface TeamScheduleTaskTransition {
  readonly taskId: string
  readonly from: 'pending' | 'ready' | 'blocked'
  readonly to: 'pending' | 'blocked'
  readonly reason: string
}

export interface TeamRunScheduleStateRequest {
  readonly teamId: string
  readonly journal: TeamEventJournal
  readonly plan: TeamSchedulePlan
  readonly taskTransitions: readonly TeamScheduleTaskTransition[]
  readonly requiresReconciliation: boolean
  readonly signal: AbortSignal
}

export interface TeamCompletionCoordinationRequest {
  readonly teamId: string
  readonly journal: TeamEventJournal
  readonly signal: AbortSignal
}

/** External behavior needed by the loop; implementations own child/verification details. */
export interface TeamRunCyclePort {
  executeBatch(request: TeamRunBatchRequest): Promise<void>
  waitForProgress(request: TeamRunProgressRequest): Promise<void>
  verify(request: TeamRunVerificationRequest): Promise<void>
  /** Sole path allowed to turn a quiescent completed task graph into a terminal Team. */
  coordinateCompletion?(request: TeamCompletionCoordinationRequest): Promise<void>
  /** Optional for source compatibility; the loop fails closed when durable scheduling facts are needed but this seam is absent. */
  persistScheduleState?(request: TeamRunScheduleStateRequest): Promise<void>
}

export interface RunTeamLoopRequest {
  readonly teamId: string
  readonly journal: TeamEventJournal
  readonly maxConcurrency: number
  readonly directWriteStrategy?: DirectWriteStrategy
  readonly driver: TeamRunCyclePort
  readonly maxCycles?: number
  readonly signal?: AbortSignal
}

export type TeamRunStopReason =
  | 'background-started'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'cancelled'
  | 'needs_reconciliation'
  | 'aborted'
  | 'inactive'
  | 'max-cycles'
  | 'no-progress'

/** Machine-readable meaning of a loop stop; stopReason preserves the exact cause. */
export type TeamRunDisposition =
  | 'started'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'yielded'
  | 'recoverable'
  | 'needs_reconciliation'

export interface RunTeamLoopResult {
  readonly projection: TeamProjection
  readonly reason: TeamRunStopReason
  readonly disposition: TeamRunDisposition
  readonly cycles: number
}

/** Runs one journal continuously without holding a durability transaction over driver calls. */
export class TeamRunLoopCoordinator {
  readonly #inFlight = new Map<string, { readonly request: RunTeamLoopRequest; readonly promise: Promise<RunTeamLoopResult> }>()

  run(request: RunTeamLoopRequest): Promise<RunTeamLoopResult> {
    const existing = this.#inFlight.get(request.journal.key)
    if (existing !== undefined) {
      if (!sameRunRequest(existing.request, request)) {
        throw new YuqiOrchestratorError('INVALID_BATCH', `Team run is already active for journal ${request.journal.key} with different run semantics`)
      }
      return existing.promise
    }
    const signal = request.signal ?? new AbortController().signal
    const maxCycles = request.maxCycles ?? 100
    if (!Number.isInteger(maxCycles) || maxCycles < 1) throw new RangeError('maxCycles must be a positive integer')
    const operation = this.#run({ ...request, signal, maxCycles })
    this.#inFlight.set(request.journal.key, { request, promise: operation })
    void operation.then(
      () => this.#clear(request.journal.key, operation),
      () => this.#clear(request.journal.key, operation),
    )
    return operation
  }

  #clear(journalKey: string, operation: Promise<RunTeamLoopResult>): void {
    if (this.#inFlight.get(journalKey)?.promise === operation) this.#inFlight.delete(journalKey)
  }

  async #run(request: RunTeamLoopRequest & { readonly signal: AbortSignal; readonly maxCycles: number }): Promise<RunTeamLoopResult> {
    let cycles = 0
    while (true) {
      const projection = replayTeamEvents(request.journal.read())
      if (projection.team.id !== request.teamId) {
        throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${request.teamId} does not own this controller journal`)
      }
      const plan = planTeamSchedule(projection, {
        maxConcurrency: request.maxConcurrency,
        ...(request.directWriteStrategy === undefined ? {} : { directWriteStrategy: request.directWriteStrategy }),
      })
      const stopped = stopReason(projection)
      if (stopped !== undefined) return loopResult(projection, stopped, cycles)

      const taskTransitions = scheduleTaskTransitions(projection, plan)
      if (plan.status === 'requires_reconciliation' || taskTransitions.length > 0) {
        const persist = request.driver.persistScheduleState
        if (persist === undefined) {
          throw new YuqiOrchestratorError(
            'CONTROLLER_REQUIRES_RECONCILIATION',
            'The Team runner cannot persist required scheduling state with the current Host adapter',
          )
        }
        await persist.call(request.driver, {
          teamId: request.teamId,
          journal: request.journal,
          plan,
          taskTransitions,
          requiresReconciliation: plan.status === 'requires_reconciliation',
          signal: request.signal,
        })
        const persisted = replayTeamEvents(request.journal.read())
        assertScheduleStatePersisted(persisted, plan, taskTransitions)
        if (plan.status === 'requires_reconciliation') {
          return loopResult(persisted, 'needs_reconciliation', cycles)
        }
        continue
      }
      if (request.signal.aborted) return loopResult(projection, 'aborted', cycles)
      if (cycles >= request.maxCycles) return loopResult(projection, 'max-cycles', cycles)

      const verifying = verificationTargets(projection)
      const beforeEventId = projection.lastEventId
      cycles += 1
      try {
        // Fill every currently safe slot before waiting for existing children.
        // A shorter child may unlock more disjoint work while a longer sibling
        // is still running; waiting first would serialize that newly-ready work.
        if (plan.dispatchTaskIds.length > 0) {
          await request.driver.executeBatch({ teamId: request.teamId, journal: request.journal, plan, signal: request.signal })
        } else if (plan.activeTaskIds.length > 0) {
          await request.driver.waitForProgress({
            teamId: request.teamId, journal: request.journal, activeTaskIds: plan.activeTaskIds.map(String), signal: request.signal,
          })
        } else if (verifying.length > 0) {
          await request.driver.verify({ teamId: request.teamId, journal: request.journal, tasks: verifying, signal: request.signal })
        } else if (allTasksCompleted(projection)) {
          const coordinate = request.driver.coordinateCompletion
          if (coordinate === undefined) {
            throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'The Team runner has no gate-aware completion coordinator')
          }
          await coordinate.call(request.driver, { teamId: request.teamId, journal: request.journal, signal: request.signal })
        } else {
          return loopResult(projection, 'no-progress', cycles)
        }
      } catch (cause) {
        if (request.signal.aborted) {
          const afterAbort = replayTeamEvents(request.journal.read())
          const stoppedAfterAbort = stopReason(afterAbort)
          return stoppedAfterAbort === undefined
            ? loopResult(afterAbort, 'aborted', cycles)
            : loopResult(afterAbort, stoppedAfterAbort, cycles)
        }
        throw cause
      }

      const after = replayTeamEvents(request.journal.read())
      const stoppedAfter = stopReason(after)
      if (stoppedAfter !== undefined) return loopResult(after, stoppedAfter, cycles)
      if (request.signal.aborted) return loopResult(after, 'aborted', cycles)
      if (after.lastEventId === beforeEventId) return loopResult(after, 'no-progress', cycles)
    }
  }
}

function allTasksCompleted(projection: TeamProjection): boolean {
  return projection.taskIds.length > 0
    && projection.taskIds.every(taskId => projection.tasks[taskId]?.status === 'completed')
}

/** Stable result mapping shared by direct callers and the Agent-facing adapter. */
export function teamRunDisposition(reason: TeamRunStopReason): TeamRunDisposition {
  switch (reason) {
    case 'background-started': return 'started'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
    case 'aborted':
    case 'needs_reconciliation': return 'needs_reconciliation'
    case 'paused':
    case 'inactive':
    case 'no-progress': return 'recoverable'
    case 'max-cycles': return 'yielded'
  }
}

function loopResult(projection: TeamProjection, reason: TeamRunStopReason, cycles: number): RunTeamLoopResult {
  return { projection, reason, disposition: teamRunDisposition(reason), cycles }
}

function sameRunRequest(left: RunTeamLoopRequest, right: RunTeamLoopRequest): boolean {
  return left.teamId === right.teamId
    && left.maxConcurrency === right.maxConcurrency
    && left.directWriteStrategy === right.directWriteStrategy
    && (left.maxCycles ?? 100) === (right.maxCycles ?? 100)
    && left.driver === right.driver
    && left.signal === right.signal
}

function stopReason(projection: TeamProjection): TeamRunStopReason | undefined {
  switch (projection.team.status) {
    case 'completed':
    case 'failed':
    case 'paused':
    case 'cancelled':
    case 'needs_reconciliation':
      return projection.team.status
    case 'draft':
    case 'pausing':
    case 'cancelling':
      return 'inactive'
    case 'running':
      return undefined
  }
}

function verificationTargets(projection: TeamProjection): readonly TeamVerificationTarget[] {
  const targets: TeamVerificationTarget[] = []
  for (const taskId of projection.taskIds) {
    const task: TaskView = projection.tasks[taskId]!
    if (task.status !== 'verifying') continue
    const attemptId = task.attemptIds.at(-1)
    if (attemptId === undefined) continue
    const verificationId = task.verificationIds.at(-1)
    targets.push({
      taskId: String(task.contract.taskId),
      attemptId: String(attemptId),
      ...(verificationId === undefined ? {} : { verificationId: String(verificationId) }),
    })
  }
  return targets
}

function scheduleTaskTransitions(projection: TeamProjection, plan: TeamSchedulePlan): readonly TeamScheduleTaskTransition[] {
  return [
    ...plan.newlyBlockedTaskIds.map((taskId): TeamScheduleTaskTransition => ({
      taskId: String(taskId),
      from: projection.tasks[taskId]!.status as 'pending' | 'ready',
      to: 'blocked',
      reason: 'dependency failed, was cancelled, or remains durably blocked',
    })),
    ...plan.unblockedTaskIds.map((taskId): TeamScheduleTaskTransition => ({
      taskId: String(taskId),
      from: 'blocked',
      to: 'pending',
      reason: 'dependency block cleared',
    })),
  ]
}

function assertScheduleStatePersisted(
  projection: TeamProjection,
  plan: TeamSchedulePlan,
  taskTransitions: readonly TeamScheduleTaskTransition[],
): void {
  if (plan.status === 'requires_reconciliation' && projection.team.status !== 'needs_reconciliation') {
    throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', 'Host did not durably persist the required Team reconciliation state')
  }
  for (const transition of taskTransitions) {
    if (projection.tasks[transition.taskId]?.status !== transition.to) {
      throw new YuqiOrchestratorError('CONTROLLER_REQUIRES_RECONCILIATION', `Host did not durably persist scheduling state for task ${transition.taskId}`)
    }
  }
}
