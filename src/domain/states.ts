/** Closed Team-domain states and their legal transitions. */

import { YuqiDomainError } from './errors.ts'

/** Lifecycle states for the complete Team. */
export type TeamStatus = 'draft' | 'running' | 'pausing' | 'paused' | 'cancelling' | 'cancelled' | 'completed' | 'failed' | 'needs_reconciliation'
/** Lifecycle states for one task. */
export type TaskStatus = 'pending' | 'ready' | 'running' | 'verifying' | 'blocked' | 'completed' | 'failed' | 'cancelled'
/** Lifecycle states for one task execution attempt. */
export type AttemptStatus = 'dispatching' | 'running' | 'settled' | 'verification_failed' | 'completed' | 'failed' | 'cancelled' | 'unknown'
/** Lifecycle states for one verification run. */
export type VerificationStatus = 'pending' | 'running' | 'passed' | 'failed' | 'waived' | 'cancelled'

const SCHEDULABLE_TASK_STATUSES = new Set<TaskStatus>(['pending', 'ready', 'blocked'])
const MODEL_CONFIGURABLE_TASK_STATUSES = new Set<TaskStatus>(['pending', 'ready', 'running', 'failed', 'cancelled'])

/** Whether cancellation must remove this task from future scheduling. */
export function isSchedulableTaskStatus(status: TaskStatus | undefined): boolean {
  return SCHEDULABLE_TASK_STATUSES.has(status as TaskStatus)
}

/** Whether an operator may select the model used by this or its next attempt. */
export function isModelConfigurableTaskStatus(status: TaskStatus): boolean {
  return MODEL_CONFIGURABLE_TASK_STATUSES.has(status)
}

const TEAM_TRANSITIONS: Readonly<Record<TeamStatus, readonly TeamStatus[]>> = {
  draft: ['running', 'cancelled'],
  running: ['pausing', 'cancelling', 'completed', 'failed', 'needs_reconciliation'],
  pausing: ['paused', 'running', 'cancelling', 'needs_reconciliation'],
  paused: ['running', 'cancelling'],
  cancelling: ['cancelled', 'needs_reconciliation'],
  cancelled: [],
  completed: [],
  failed: [],
  needs_reconciliation: ['paused', 'running', 'cancelled', 'failed'],
}

const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['ready', 'blocked', 'cancelled'],
  ready: ['running', 'blocked', 'cancelled'],
  // A task with no declared verification checks completes from its durable
  // child settlement. Checked tasks still take the verifying path.
  running: ['verifying', 'completed', 'blocked', 'failed', 'cancelled'],
  verifying: ['completed', 'ready', 'blocked', 'failed', 'cancelled'],
  blocked: ['pending', 'ready', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

const ATTEMPT_TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
  dispatching: ['running', 'failed', 'cancelled', 'unknown'],
  running: ['settled', 'failed', 'cancelled', 'unknown'],
  settled: ['verification_failed', 'completed', 'failed', 'unknown'],
  verification_failed: ['completed', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
  // Returning to running is reserved for a Host-owned cold-reconciliation
  // correction. The reducer additionally requires the exact latest runtime
  // observation to have been live while the Team remains gated.
  unknown: ['running', 'settled', 'failed', 'cancelled'],
}

const VERIFICATION_TRANSITIONS: Readonly<Record<VerificationStatus, readonly VerificationStatus[]>> = {
  pending: ['running', 'waived', 'cancelled'],
  running: ['passed', 'failed', 'waived', 'cancelled'],
  passed: [],
  failed: [],
  waived: [],
  cancelled: [],
}

function assertTransition<T extends string>(entity: string, from: T, to: T, allowed: Readonly<Record<T, readonly T[]>>): T {
  if (!allowed[from].includes(to)) {
    throw new YuqiDomainError('INVALID_TRANSITION', `${entity} cannot transition from ${from} to ${to}`)
  }
  return to
}

/** Validate a Team transition. @param from - Current state. @param to - Requested state. @returns The accepted state. */
export function transitionTeam(from: TeamStatus, to: TeamStatus): TeamStatus {
  return assertTransition('team', from, to, TEAM_TRANSITIONS)
}

/** Validate a task transition. @param from - Current state. @param to - Requested state. @returns The accepted state. */
export function transitionTask(from: TaskStatus, to: TaskStatus): TaskStatus {
  return assertTransition('task', from, to, TASK_TRANSITIONS)
}

/** Validate an attempt transition. @param from - Current state. @param to - Requested state. @returns The accepted state. */
export function transitionAttempt(from: AttemptStatus, to: AttemptStatus): AttemptStatus {
  return assertTransition('attempt', from, to, ATTEMPT_TRANSITIONS)
}

/** Validate a verification transition. @param from - Current state. @param to - Requested state. @returns The accepted state. */
export function transitionVerification(from: VerificationStatus, to: VerificationStatus): VerificationStatus {
  return assertTransition('verification', from, to, VERIFICATION_TRANSITIONS)
}
