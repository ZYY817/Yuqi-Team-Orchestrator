/** Pure, deterministic planning for one Team scheduling batch. */

import type { TaskId } from '../domain/ids.ts'
import { MAX_TEAM_CONCURRENCY, MIN_TEAM_CONCURRENCY } from '../domain/team-settings-contract.ts'
import { fileScopePatternSchema, fileScopeSetsConflict } from '../domain/file-scope.ts'
import type { TaskView, TeamProjection } from '../domain/projection.ts'
import { projectionHasReconciliationGap, taskHasSemanticBlock, teamCompletionReady } from '../domain/projection.ts'
import { parseDirectWriteStrategy, type DirectWriteStrategy } from '../domain/execution-policy.ts'

export { MIN_TEAM_CONCURRENCY, MAX_TEAM_CONCURRENCY }

export interface TeamScheduleOptions {
  readonly maxConcurrency: number
  /** Optional override for compatibility callers; durable Team policy is the default. */
  readonly directWriteStrategy?: DirectWriteStrategy
}

export interface TeamSchedulePlan {
  readonly status: 'runnable' | 'inactive' | 'requires_reconciliation'
  readonly activeTaskIds: readonly TaskId[]
  readonly readyTaskIds: readonly TaskId[]
  readonly blockedTaskIds: readonly TaskId[]
  /** Pending/ready tasks whose dependency block is not yet durable. */
  readonly newlyBlockedTaskIds: readonly TaskId[]
  /** Durable dependency blocks whose blocking prerequisite chain has cleared. */
  readonly unblockedTaskIds: readonly TaskId[]
  readonly dispatchTaskIds: readonly TaskId[]
  readonly availableSlots: number
  /** Effective policy; optional only for compatibility with older serialized/test plans. */
  readonly directWriteStrategy?: DirectWriteStrategy
  readonly sourceLastEventAt: string
  readonly sourceLastEventId: string
}

/**
 * Authoritative answer for a paused Team's Continue action. This evaluates the
 * same dependency, scope, reconciliation, verification, and completion facts
 * used by the scheduler without mutating the durable projection.
 */
export type TeamResumeDisposition =
  | 'runnable'
  | 'completion-ready'
  | 'decision-required'
  | 'requires-reconciliation'
  | 'inactive'

export function classifyTeamResume(
  projection: TeamProjection,
  options: Partial<TeamScheduleOptions> = {},
): TeamResumeDisposition {
  if (projection.team.status !== 'paused') return 'inactive'
  if (projectionHasReconciliationGap(projection)) return 'requires-reconciliation'

  const runningProjection: TeamProjection = {
    ...projection,
    team: { ...projection.team, status: 'running' },
  }
  const plan = planTeamSchedule(runningProjection, {
    maxConcurrency: options.maxConcurrency ?? projection.team.maxConcurrency ?? MIN_TEAM_CONCURRENCY,
    ...(options.directWriteStrategy === undefined ? {} : { directWriteStrategy: options.directWriteStrategy }),
  })
  if (plan.status === 'requires_reconciliation') return 'requires-reconciliation'
  if (teamCompletionReady(runningProjection)) return 'completion-ready'

  const latestReviewId = projection.reviewIds.at(-1)
  const latestReview = latestReviewId === undefined ? undefined : projection.reviews[latestReviewId]
  if (latestReview?.status === 'awaiting_user' && latestReview.userDecision === undefined) return 'decision-required'

  const hasVerificationWork = projection.taskIds.some(taskId => projection.tasks[taskId]!.status === 'verifying')
    || Object.values(projection.verifications).some(verification => verification.status === 'pending' || verification.status === 'running')
  const hasReviewOrCompletionWork = projection.taskIds.length > 0
    && projection.taskIds.every(taskId => projection.tasks[taskId]!.status === 'completed')

  const hasInterruptedOrPausedTasks = projection.taskIds.some(taskId => {
    const task = projection.tasks[taskId]
    if (task === undefined) return false
    const lastAttemptId = task.attemptIds.at(-1)
    const attempt = lastAttemptId !== undefined ? projection.attempts[lastAttemptId] : undefined
    const stopReason = attempt?.evidence?.stopReason
    const isInterrupted = stopReason === 'interrupted' || stopReason === 'aborted'
    if (task.status === 'failed' || task.status === 'cancelled') {
      return isInterrupted
    }
    if (task.status === 'blocked') {
      const outcomeStatus = attempt?.evidence?.taskOutcome?.status
      const isMissingOutcome = attempt?.evidence !== undefined && (outcomeStatus === undefined || outcomeStatus === 'missing')
      return isInterrupted || isMissingOutcome
    }
    return false
  })

  return plan.activeTaskIds.length > 0
    || plan.dispatchTaskIds.length > 0
    || plan.unblockedTaskIds.length > 0
    || hasVerificationWork
    || hasReviewOrCompletionWork
    || hasInterruptedOrPausedTasks
    ? 'runnable'
    : 'decision-required'
}
/** Calculate one side-effect-free scheduling batch from a replayed projection. */
export function planTeamSchedule(projection: TeamProjection, options: TeamScheduleOptions): TeamSchedulePlan {
  assertConcurrency(options.maxConcurrency)
  const directWriteStrategy = parseDirectWriteStrategy(options.directWriteStrategy ?? projection.team.directWriteStrategy)
  if (projection.team.status === 'needs_reconciliation' || projectionHasReconciliationGap(projection)) {
    return emptyPlan('requires_reconciliation', projection, directWriteStrategy)
  }
  if (projection.team.manualOwnership?.state === 'human-owned' || projection.team.status !== 'running') return emptyPlan('inactive', projection, directWriteStrategy)
  if (projection.taskIds.some(taskId => !taskScopeIsSchedulable(projection.tasks[taskId]!))) {
    return emptyPlan('requires_reconciliation', projection, directWriteStrategy)
  }

  const activeTaskIds = activeTasksInCreationOrder(projection)
  if (activeTaskIds === undefined || activeScopesConflict(projection, activeTaskIds, directWriteStrategy)) {
    return emptyPlan('requires_reconciliation', projection, directWriteStrategy)
  }
  const activeAuthorities = new Set(activeTaskIds.map(taskId => projection.tasks[taskId]!.contract.authorityMode))
  if (activeAuthorities.size > 1) return emptyPlan('requires_reconciliation', projection, directWriteStrategy)

  const blocked = new Set<TaskId>()
  const blockMemo = new Map<TaskId, boolean>()
  for (const taskId of projection.taskIds) {
    const task = projection.tasks[taskId]!
    if (taskHasSemanticBlock(projection, task)) blocked.add(taskId)
    if ((task.status === 'pending' || task.status === 'ready' || task.status === 'blocked')
      && task.contract.dependencies.some(dependency => taskBlocksDependents(projection, dependency, blockMemo))) blocked.add(taskId)
  }
  const newlyBlockedTaskIds = projection.taskIds.filter(taskId => {
    const status = projection.tasks[taskId]!.status
    return blocked.has(taskId) && (status === 'pending' || status === 'ready')
  })
  const unblockedTaskIds = projection.taskIds.filter(taskId =>
    projection.tasks[taskId]!.status === 'blocked' && !blocked.has(taskId))

  const readyTaskIds: TaskId[] = []
  for (const taskId of projection.taskIds) {
    const task = projection.tasks[taskId]!
    if (task.status === 'pending' && !blocked.has(taskId) && dependenciesCompleted(projection, task)) readyTaskIds.push(taskId)
  }

  const availableSlots = Math.max(0, options.maxConcurrency - activeTaskIds.length)
  const activeTaskSet = new Set(activeTaskIds)
  const candidates = projection.taskIds.filter((taskId) => {
    const task = projection.tasks[taskId]!
    return !activeTaskSet.has(taskId)
      && !blocked.has(taskId)
      && (task.status === 'ready' || readyTaskIds.includes(taskId))
      && dependenciesCompleted(projection, task)
  })
  const selectedAuthority: TaskView['contract']['authorityMode'] | undefined = activeTaskIds.length === 0
    ? undefined
    : projection.tasks[activeTaskIds[0]!]!.contract.authorityMode
  const batchAuthority = selectedAuthority ?? (candidates[0] === undefined
    ? undefined
    : projection.tasks[candidates[0]]!.contract.authorityMode)
  const eligible = candidates.filter((taskId) => {
    const task = projection.tasks[taskId]!
    return task.contract.authorityMode === batchAuthority
      && !activeTaskIds.some(activeId => tasksConflict(task, projection.tasks[activeId]!, directWriteStrategy))
  })
  const creationOrder = new Map(candidates.map((taskId, index) => [taskId, index]))
  const ranked = [...eligible].sort((leftId, rightId) => {
    const left = projection.tasks[leftId]!
    const right = projection.tasks[rightId]!
    const leftConflicts = eligible.filter(taskId => taskId !== leftId && tasksConflict(left, projection.tasks[taskId]!, directWriteStrategy)).length
    const rightConflicts = eligible.filter(taskId => taskId !== rightId && tasksConflict(right, projection.tasks[taskId]!, directWriteStrategy)).length
    return leftConflicts - rightConflicts
      || creationOrder.get(leftId)! - creationOrder.get(rightId)!
  })
  const selected: TaskId[] = []
  for (const taskId of ranked) {
    if (selected.length >= availableSlots) break
    const task = projection.tasks[taskId]!
    if (!selected.some(selectedId => tasksConflict(task, projection.tasks[selectedId]!, directWriteStrategy))) selected.push(taskId)
  }
  const dispatchTaskIds = selected.sort((leftId, rightId) => creationOrder.get(leftId)! - creationOrder.get(rightId)!)

  return freezePlan({
    status: 'runnable',
    activeTaskIds,
    readyTaskIds,
    blockedTaskIds: projection.taskIds.filter(taskId => blocked.has(taskId)),
    newlyBlockedTaskIds,
    unblockedTaskIds,
    dispatchTaskIds,
    availableSlots,
    directWriteStrategy,
    sourceLastEventAt: projection.lastEventAt,
    sourceLastEventId: projection.lastEventId,
  })
}

function assertConcurrency(value: number): void {
  if (!Number.isInteger(value) || value < MIN_TEAM_CONCURRENCY || value > MAX_TEAM_CONCURRENCY) {
    throw new RangeError(`maxConcurrency must be an integer from ${MIN_TEAM_CONCURRENCY} to ${MAX_TEAM_CONCURRENCY}`)
  }
}

function activeTasksInCreationOrder(projection: TeamProjection): readonly TaskId[] | undefined {
  const active = new Set<TaskId>()
  for (const attempt of Object.values(projection.attempts)) {
    if (attempt.status !== 'dispatching' && attempt.status !== 'running') continue
    if (active.has(attempt.taskId)) return undefined
    active.add(attempt.taskId)
  }
  return projection.taskIds.filter(taskId => active.has(taskId))
}

function activeScopesConflict(
  projection: TeamProjection,
  activeTaskIds: readonly TaskId[],
  directWriteStrategy: DirectWriteStrategy,
): boolean {
  for (let left = 0; left < activeTaskIds.length; left += 1) {
    for (let right = left + 1; right < activeTaskIds.length; right += 1) {
      if (tasksConflict(projection.tasks[activeTaskIds[left]!]!, projection.tasks[activeTaskIds[right]!]!, directWriteStrategy)) return true
    }
  }
  return false
}

function taskBlocksDependents(projection: TeamProjection, taskId: TaskId, memo: Map<TaskId, boolean>): boolean {
  const previous = memo.get(taskId)
  if (previous !== undefined) return previous
  const task = projection.tasks[taskId]!
  if (task.status === 'failed' || task.status === 'cancelled' || taskHasSemanticBlock(projection, task)) {
    memo.set(taskId, true)
    return true
  }
  if (task.status === 'blocked' && task.contract.dependencies.length === 0) {
    memo.set(taskId, true)
    return true
  }
  // A durable blocked status created by this scheduler is derived state. Its
  // dependents remain blocked only while the same prerequisite chain remains
  // terminal, which makes clearing a retried/completed prerequisite deterministic.
  const blocked = (task.status === 'pending' || task.status === 'ready' || task.status === 'blocked')
    && task.contract.dependencies.some(dependency => taskBlocksDependents(projection, dependency, memo))
  memo.set(taskId, blocked)
  return blocked
}

function dependenciesCompleted(projection: TeamProjection, task: TaskView): boolean {
  return task.contract.dependencies.every(dependency => projection.tasks[dependency]!.status === 'completed')
}

function tasksConflict(left: TaskView, right: TaskView, directWriteStrategy: DirectWriteStrategy): boolean {
  if (left.contract.authorityMode === 'read-only' || right.contract.authorityMode === 'read-only') return false
  if (directWriteStrategy === 'strict-writer-serial') return true
  return fileScopeSetsConflict(left.contract.fileScope, right.contract.fileScope)
}

function taskScopeIsSchedulable(task: TaskView): boolean {
  if (task.contract.authorityMode === 'read-only') return true
  return task.contract.fileScope.length > 0
    && task.contract.fileScope.every(pattern => fileScopePatternSchema.safeParse(pattern).success)
}

function emptyPlan(
  status: 'inactive' | 'requires_reconciliation',
  projection: TeamProjection,
  directWriteStrategy: DirectWriteStrategy,
): TeamSchedulePlan {
  return freezePlan({
    status,
    activeTaskIds: [],
    readyTaskIds: [],
    blockedTaskIds: [],
    newlyBlockedTaskIds: [],
    unblockedTaskIds: [],
    dispatchTaskIds: [],
    availableSlots: 0,
    directWriteStrategy,
    sourceLastEventAt: projection.lastEventAt,
    sourceLastEventId: projection.lastEventId,
  })
}

function freezePlan(plan: TeamSchedulePlan): TeamSchedulePlan {
  Object.freeze(plan.activeTaskIds)
  Object.freeze(plan.readyTaskIds)
  Object.freeze(plan.blockedTaskIds)
  Object.freeze(plan.newlyBlockedTaskIds)
  Object.freeze(plan.unblockedTaskIds)
  Object.freeze(plan.dispatchTaskIds)
  return Object.freeze(plan)
}
