/** Durable intent preparation for one deterministic Team scheduling batch. */

import { AttemptId, TaskId, TeamId } from '../domain/ids.ts'
import type { TeamEvent } from '../domain/events.ts'
import { budgetReservationDecision } from '../domain/projection.ts'
import type { TeamProjection } from '../domain/projection.ts'
import type { FileLease, FixedModelRef } from '../domain/workspace.ts'
import { acquireFileLease } from './file-ownership.ts'
import { YuqiOrchestratorError } from './errors.ts'
import type { Clock, EventIdSource } from './ports.ts'
import { planTeamSchedule } from './schedule-team.ts'
import type { TeamSchedulePlan } from './schedule-team.ts'
import { applyTeamEventBatch, createTeamEvent } from './team-events.ts'
import type { ModelCatalogFact, ModelRouteTaskTier, ProviderModelRef } from '../domain/model-route.ts'
import type { ModelRouteBasis, ModelRouteReason } from './model-routing.ts'

/** Fixed execution identity for one task selected by C1. */
export interface BatchAttemptIntent {
  readonly taskOutcomeVersion?: 1
  readonly taskId: string
  readonly attemptId: string
  readonly modelProvider: string
  readonly modelId: string
  /** Structured decision used by new Host callers; flat fields remain the exact runtime arguments. */
  readonly route?: ProviderModelRef
  readonly routeBasis?: ModelRouteBasis
  readonly requestedTier?: ModelRouteTaskTier
  readonly fallbackReason?: Extract<ModelRouteReason,
    'automatic-candidates-exhausted' | 'task-default-controller-inherit' | 'team-inherit-controller'>
  readonly catalogEvidence?: readonly ModelCatalogFact[]
  readonly subagentProvider?: string
  readonly leaseId?: string
  readonly fixedModel?: FixedModelRef
  /** Conservative token hold required before this attempt may be admitted. */
  readonly tokenReserve?: number
  /** Stable reservation identity for retries/recovery; defaults to the attempt identity. */
  readonly reservationId?: string
}

export interface BatchExecutionGate {
  readonly workspaceId: string
  readonly worktreePath: string
}

export interface PrepareTeamBatchRequest {
  readonly teamId: string
  readonly plan: TeamSchedulePlan
  readonly maxConcurrency: number
  readonly attempts: readonly BatchAttemptIntent[]
  readonly execution?: BatchExecutionGate
}

export interface PreparedTeamBatch {
  readonly events: readonly TeamEvent[]
  readonly projection: TeamProjection
}

/**
 * Revalidate a caller plan and create the complete pre-side-effect event group.
 * No child may be started before this event group crosses the journal barrier.
 */
export function prepareTeamBatchIntent(
  projection: TeamProjection,
  request: PrepareTeamBatchRequest,
  clock: Clock,
  eventIds: EventIdSource,
): PreparedTeamBatch {
  if (projection.team.id !== TeamId(request.teamId)) {
    throw new YuqiOrchestratorError('TEAM_MISMATCH', 'The requested Team does not belong to this controller')
  }

  const currentPlan = planTeamSchedule(projection, {
    maxConcurrency: request.maxConcurrency,
    ...(request.plan.directWriteStrategy === undefined ? {} : { directWriteStrategy: request.plan.directWriteStrategy }),
  })
  if (currentPlan.status !== 'runnable' || currentPlan.dispatchTaskIds.length === 0) {
    throw new YuqiOrchestratorError('SCHEDULE_NOT_RUNNABLE', 'The Team does not currently have a runnable batch')
  }
  if (!plansEqual(request.plan, currentPlan)) {
    throw new YuqiOrchestratorError('STALE_SCHEDULE', 'The scheduling plan is stale or does not match the current Team projection')
  }
  if (request.attempts.length !== currentPlan.dispatchTaskIds.length) {
    throw new YuqiOrchestratorError('INVALID_BATCH', 'Every dispatched task must have exactly one attempt intent')
  }

  const attemptIds = new Set<string>()
  const activeLeases: FileLease[] = Object.values(projection.fileLeases).filter(lease => lease.status === 'active')
  const events: TeamEvent[] = []
  let intentProjection = projection
  const workspace = request.execution === undefined ? undefined : projection.workspace
  if (request.execution !== undefined && (workspace?.status !== 'ready'
    || workspace.workspaceId !== request.execution.workspaceId
    || workspace.worktreePath !== request.execution.worktreePath)) {
    throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', 'The batch requires its exact durable ready Team workspace')
  }
  for (let index = 0; index < currentPlan.dispatchTaskIds.length; index += 1) {
    const plannedTaskId = currentPlan.dispatchTaskIds[index]!
    const intent = request.attempts[index]!
    const taskId = TaskId(intent.taskId)
    const attemptId = AttemptId(intent.attemptId)
    const task = projection.tasks[plannedTaskId]!
    if (taskId !== plannedTaskId) {
      throw new YuqiOrchestratorError('INVALID_BATCH', 'Attempt intents must follow the deterministic dispatch order')
    }
    if (attemptIds.has(attemptId) || Object.hasOwn(projection.attempts, attemptId)) {
      throw new YuqiOrchestratorError('INVALID_BATCH', `Attempt id ${attemptId} is not unique`)
    }
    if (intent.route !== undefined
      && (intent.route.modelProvider !== intent.modelProvider || intent.route.modelId !== intent.modelId)) {
      throw new YuqiOrchestratorError('INVALID_BATCH', `Task ${taskId} structured route must match its runtime model arguments`)
    }
    if (intent.route === undefined && task.contract.modelId !== undefined && intent.modelId !== task.contract.modelId) {
      throw new YuqiOrchestratorError('INVALID_BATCH', `Legacy task ${taskId} must use its contracted model ${task.contract.modelId}`)
    }
    if (intent.route !== undefined && (intent.routeBasis === undefined || intent.catalogEvidence === undefined)) {
      throw new YuqiOrchestratorError('INVALID_BATCH', `Task ${taskId} structured route requires durable decision evidence`)
    }
    if (projection.budgetPolicy !== undefined) {
      const tokenReserve = intent.tokenReserve
      if (tokenReserve === undefined || !Number.isInteger(tokenReserve) || tokenReserve <= 0) {
        throw new YuqiOrchestratorError('BUDGET_BLOCKED', `Task ${taskId} requires a positive token reservation before dispatch`)
      }
      const reservationId = intent.reservationId ?? `budget:${attemptId}`
      const decision = budgetReservationDecision(intentProjection, tokenReserve)
      if (decision !== 'allow') {
        throw new YuqiOrchestratorError('BUDGET_BLOCKED', `Task ${taskId} is blocked by ${decision}`)
      }
      const reservation = createTeamEvent(clock, eventIds, request.teamId, {
        type: 'yuqi/budget-reservation-acquired', reservationId, taskId, attemptId, tokenReserve,
      })
      events.push(reservation)
      intentProjection = applyTeamEventBatch(intentProjection, [reservation])
    }
    if (workspace !== undefined) {
      const directWorkspace = (workspace.project as unknown as { readonly mode?: unknown }).mode === 'direct'
      if (!directWorkspace && (task.contract.baselineRef === undefined || task.contract.baselineRef !== workspace.project.baselineRef)) {
        throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', `Task ${taskId} baseline does not match the Team workspace`)
      }
      const fixed = intent.fixedModel
      if (fixed === undefined
        || intent.leaseId === undefined
        || intent.subagentProvider !== fixed.subagentProvider
        || intent.modelProvider !== fixed.modelProvider
        || intent.modelId !== fixed.modelId
        || task.contract.modelRole !== fixed.role) {
        throw new YuqiOrchestratorError('EXECUTION_GATE_REJECTED', `Task ${taskId} is missing an exact fixed-model or file-lease grant`)
      }
      const lease = acquireFileLease({
        leaseId: intent.leaseId,
        taskId,
        attemptId,
        mode: task.contract.authorityMode === 'read-only' ? 'read' : 'write',
        fileScope: task.contract.fileScope,
        ...(currentPlan.directWriteStrategy === undefined ? {} : { directWriteStrategy: currentPlan.directWriteStrategy }),
      }, activeLeases)
      activeLeases.push(lease)
      events.push(createTeamEvent(clock, eventIds, request.teamId, {
        type: 'yuqi/file-lease-acquired', lease: { ...lease, status: 'active' },
      }))
    }
    attemptIds.add(attemptId)

    if (task.status === 'pending') {
      events.push(createTeamEvent(clock, eventIds, request.teamId, {
        type: 'yuqi/task-status-changed', taskId, from: 'pending', to: 'ready',
        reason: 'dependencies satisfied; selected for dispatch',
      }))
    }
    events.push(
      createTeamEvent(clock, eventIds, request.teamId, {
        type: 'yuqi/task-status-changed', taskId, from: 'ready', to: 'running',
        reason: 'durable batch dispatch intent',
      }),
      createTeamEvent(clock, eventIds, request.teamId, {
        type: 'yuqi/attempt-created', taskId, attemptId,
        ...(intent.taskOutcomeVersion === undefined ? {} : { taskOutcomeVersion: intent.taskOutcomeVersion }),
        ordinal: task.attemptIds.length + 1,
        ...(intent.route === undefined
          ? {
              modelProvider: intent.modelProvider,
              modelId: intent.modelId,
              ...(intent.fixedModel === undefined ? {} : { routeBasis: 'user-fixed' as const }),
            }
          : {
              route: intent.route,
              routeBasis: intent.routeBasis!,
              ...(intent.requestedTier === undefined ? {} : { requestedTier: intent.requestedTier }),
              ...(intent.fallbackReason === undefined ? {} : { fallbackReason: intent.fallbackReason }),
              catalogEvidence: intent.catalogEvidence!.map(fact => ({ ...fact, model: { ...fact.model } })),
            }),
        recoveryToken: recoveryToken(eventIds),
      }),
    )
  }

  const nextProjection = applyTeamEventBatch(projection, events)
  Object.freeze(events)
  return Object.freeze({ events, projection: nextProjection })
}

/** Event ids are UUIDs in the hosted service; this fails closed for unsafe custom sources. */
function recoveryToken(eventIds: EventIdSource): string {
  const token = eventIds.next()
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new YuqiOrchestratorError('INVALID_BATCH', 'The event-id source cannot provide a safe recovery token')
  }
  return token
}

function plansEqual(left: TeamSchedulePlan, right: TeamSchedulePlan): boolean {
  return planFingerprint(left) === planFingerprint(right)
}

function planFingerprint(plan: TeamSchedulePlan): string {
  return JSON.stringify([
    plan.status,
    plan.activeTaskIds,
    plan.readyTaskIds,
    plan.blockedTaskIds,
    plan.dispatchTaskIds,
    plan.availableSlots,
    plan.directWriteStrategy,
    plan.sourceLastEventAt,
    plan.sourceLastEventId,
  ])
}
