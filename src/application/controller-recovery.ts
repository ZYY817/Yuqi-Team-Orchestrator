/** Idempotent controller recovery orchestration shared by warm and cold Hosts. */

import type { TeamProjection } from '../domain/projection.ts'
import { replayTeamEvents } from '../domain/projection.ts'
import { YuqiOrchestratorError } from './errors.ts'

export interface ControllerRecoveryRequest {
  readonly teamId: string
  readonly operationId: string
  readonly signal?: AbortSignal
}

export interface ControllerRecoveryAttempt {
  readonly operationId: string
  readonly taskId: string
  readonly attemptId: string
  readonly observationOperationId: string
}

/**
 * The Host owns these callbacks; this coordinator only decides ordering.
 * Keeping Agent and Harness types out of this seam makes the durable saga
 * usable when the original controller cannot be rehydrated.
 */
export interface ControllerRecoveryPort {
  projection(): TeamProjection
  reconcile(request: { readonly operationId: string; readonly signal?: AbortSignal }): Promise<TeamProjection>
  resolveAttempt(request: ControllerRecoveryAttempt & { readonly signal?: AbortSignal }): Promise<TeamProjection>
  clearRecovery(request: {
    readonly operationId: string
    readonly target: 'paused'
    readonly releaseOrphanedLeases?: boolean
    readonly signal?: AbortSignal
  }): Promise<TeamProjection>
  retryTask?(request: { readonly taskId: string; readonly operationId: string }): Promise<TeamProjection>
  resume?(request: { readonly operationId: string }): Promise<TeamProjection>
}

/**
 * Recover only from a fresh, durable Host observation.  Unknown/live facts
 * are returned untouched, so a caller can expose exactly one controller
 * action without ever creating a replacement attempt for an ambiguous run.
 */
export class ControllerRecoveryCoordinator {
  async recover(request: ControllerRecoveryRequest, port: ControllerRecoveryPort): Promise<TeamProjection> {
    let current = port.projection()
    if (current.team.id !== request.teamId) throw new YuqiOrchestratorError('TEAM_MISMATCH', 'Recovery request does not match the Team journal')
    if (recoveryMustStop(current, request.signal)) return current
    const resolved = new Set<string>()
    // Reconstruct completed saga steps after a Host restart, rather than
    // relying on the in-memory set surviving resolve → clear → retry.
    for (const taskId of current.taskIds) {
      const operationId = childOperationId(request.operationId, 'resolve', String(taskId))
      const resolution = current.attemptResolutionOperations?.[operationId]
      if (resolution?.decision === 'failed' && resolution.attemptId === current.tasks[taskId]?.attemptIds.at(-1)) {
        resolved.add(String(taskId))
      }
    }
    let clearedRecovery = current.recoveryClearOperations?.[childOperationId(request.operationId, 'clear')] !== undefined

    const observationOperationId = childOperationId(request.operationId, 'observe')
    if (needsObservation(current, observationOperationId)) {
      current = await port.reconcile({
        operationId: observationOperationId,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      if (recoveryMustStop(current, request.signal)) return current
    }

    for (const taskId of current.taskIds) {
      const task = current.tasks[taskId]
      const attemptId = task?.attemptIds.at(-1)
      const attempt = attemptId === undefined ? undefined : current.attempts[attemptId]
      if (attemptId === undefined || attempt?.status !== 'unknown') continue
      const observationOperationId = current.latestReconciliationOperationIds[attemptId]
      const observation = observationOperationId === undefined
        ? undefined
        : current.reconciliationOperations[observationOperationId]?.observations.find(item => item.attemptId === attemptId)
      if (observationOperationId === undefined || observation === undefined || !isQuiescent(observation.state)) return current

      current = await port.resolveAttempt({
        operationId: childOperationId(request.operationId, 'resolve', String(taskId)),
        taskId: String(taskId), attemptId: String(attemptId), observationOperationId,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      if (recoveryMustStop(current, request.signal)) return current
      resolved.add(String(taskId))
    }

    if (hasUnknownAttempt(current)) return current
    if (current.team.status === 'needs_reconciliation') {
      current = await port.clearRecovery({
        operationId: childOperationId(request.operationId, 'clear'), target: 'paused',
        releaseOrphanedLeases: true,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      clearedRecovery = true
      if (recoveryMustStop(current, request.signal)) return current
    }

    // A controller-less Host has no retry/resume callback. It still gets all
    // safe negative facts durably closed, and remains paused until ownership
    // is available; this is safer than silently leaving a recovery gate.
    if (port.retryTask === undefined || port.resume === undefined) return current

    let retried = false
    for (const taskId of resolved) {
      const task = current.tasks[taskId]
      if (task === undefined || !['failed', 'cancelled', 'blocked', 'verifying'].includes(task.status)) continue
      current = await port.retryTask({ taskId, operationId: childOperationId(request.operationId, 'retry', taskId) })
      if (recoveryMustStop(current, request.signal)) return current
      retried = true
    }
    // Clearing a stale recovery flag is not permission to restart already
    // cancelled/failed tasks. With no remaining work, stay paused instead of
    // cycling running → no progress → recovery again.
    const hasWork = current.taskIds.some(id => {
      const status = current.tasks[id]?.status
      return status === 'pending' || status === 'ready' || status === 'verifying'
    }) || (current.taskIds.length > 0 && current.taskIds.every(id => current.tasks[id]?.status === 'completed'))
    if ((retried || resolved.size > 0 || (clearedRecovery && hasWork)) && current.team.status === 'paused') {
      current = await port.resume({ operationId: childOperationId(request.operationId, 'resume') })
    }
    return current
  }
}

function recoveryMustStop(projection: TeamProjection, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (['completed', 'failed', 'cancelled', 'cancelling'].includes(projection.team.status)) return true
  const latest = projection.latestTeamControlOperationId
  return latest !== undefined && projection.controlOperations?.[latest]?.action === 'cancel'
}

function needsObservation(projection: TeamProjection, operationId: string): boolean {
  return Object.values(projection.attempts).some(attempt => attempt.status === 'dispatching' || attempt.status === 'running')
    || Object.entries(projection.attempts).some(([attemptId, attempt]) => {
      if (attempt.status !== 'unknown') return false
      const latestOperationId = projection.latestReconciliationOperationIds[attemptId]
      if (latestOperationId === undefined) return true
      // A retry of the same durable recovery operation must reuse its own
      // observation. A later recovery, though, cannot reuse an ambiguous
      // result such as `live`: the Host may have restarted or the child may
      // have stopped after that old check. Already quiescent facts remain
      // safe to reuse and can proceed directly to durable resolution.
      if (latestOperationId === operationId) return false
      const observation = projection.reconciliationOperations[latestOperationId]?.observations
        .find(item => item.attemptId === attemptId)
      return observation === undefined || !isQuiescent(observation.state)
    })
}

function hasUnknownAttempt(projection: TeamProjection): boolean {
  return Object.values(projection.attempts).some(attempt => attempt.status === 'unknown')
}

function isQuiescent(state: string): boolean {
  return state === 'durable' || state === 'missing' || state === 'not-admitted'
}

function childOperationId(root: string, phase: string, identity?: string): string {
  const suffix = identity === undefined ? `${phase}` : `${phase}:${identity}`
  const full = `${root}:${suffix}`
  if (full.length <= 128) return full
  const hash = [...root].reduce((value, character) => ((value * 31) + character.codePointAt(0)!) >>> 0, 0).toString(36)
  return `${root.slice(0, Math.max(1, 128 - suffix.length - hash.length - 2))}:${hash}:${suffix}`
}

/** Convenience adapter for callers that only need a durable projection. */
export function projectionFromJournal(journal: { readonly read: () => readonly unknown[] }): TeamProjection {
  return replayTeamEvents(journal.read())
}
