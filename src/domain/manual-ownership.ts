/** Explicit task ownership; acquiring it fences execution of the entire Team. */
import { z } from 'zod'
import type { TeamProjection } from './projection.ts'

export const manualOwnershipSchema = z.object({
  state: z.enum(['human-owned', 'returned']),
  taskId: z.string().min(1),
  acquisitionId: z.string().min(1),
  workspacePath: z.string().min(1),
  acquiredAt: z.string().min(1),
  returnedAt: z.string().optional(),
  summary: z.string().max(4000).optional(),
}).strict()
export type ManualOwnership = z.infer<typeof manualOwnershipSchema>
export interface ManualOwnershipOperation {
  readonly action: 'acquire' | 'return'
  readonly taskId: string
  readonly acquisitionId: string
  readonly summary?: string
}

export function isHumanOwned(projection: TeamProjection): boolean {
  return projection.team.manualOwnership?.state === 'human-owned'
}

/** Return history survives another task acquiring ownership; no synthetic timestamps. */
export function manualReturnSummaryFor(projection: TeamProjection, taskId: string): string | undefined {
  let summary: string | undefined
  for (const operation of Object.values(projection.team.manualOwnershipOperations ?? {})) {
    if (operation.action === 'return' && operation.taskId === taskId) summary = operation.summary
  }
  return summary
}

/** Durable quiescence is necessary; the Host additionally checks its live executor. */
export function manualTakeoverIssue(projection: TeamProjection, taskId: string): string | undefined {
  if (isHumanOwned(projection)) return 'Another manual ownership must be returned first'
  if (projection.team.status !== 'paused') return 'Pause the entire Team and wait for paused before confirming takeover'
  if (projection.latestTeamControlOperationId !== undefined
    && projection.controlOperations[projection.latestTeamControlOperationId]?.action === 'cancel') return 'Cancellation is pending'
  const task = projection.tasks[taskId]
  if (task === undefined || !['pending', 'ready', 'blocked', 'failed', 'cancelled'].includes(task.status)) return 'Only an unfinished, quiescent task can be taken over'
  if (projection.workspace?.status !== 'ready') return 'The Team workspace is not ready'
  if (Object.values(projection.attempts).some(attempt => ['dispatching', 'running', 'unknown'].includes(attempt.status))
    || Object.values(projection.verifications).some(verification => ['pending', 'running'].includes(verification.status))
    || Object.values(projection.reviews).some(review => review.status === 'requested')
    || Object.values(projection.fileLeases).some(lease => lease.status === 'active')
    || Object.values(projection.budgetReservations).some(reservation => ['active', 'unknown'].includes(reservation.status))) return 'Execution or resource settlement is still unresolved'
  return undefined
}
