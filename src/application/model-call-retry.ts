import { projectionHasReconciliationGap, type TeamProjection } from '../domain/projection.ts'
import type { TeamTaskContract } from '../domain/task-contract.ts'
import type { ModelRoutingPolicy } from '../domain/model-route.ts'

export const MODEL_CALL_RETRY_PREFIX = 'safe-model-call-retry:'
export const DEFAULT_AUTOMATIC_MODEL_ATTEMPTS = 3

export function withAutomaticModelAttemptBudget(contract: TeamTaskContract, policy: ModelRoutingPolicy | undefined): TeamTaskContract {
  const kind = contract.modelRequest?.kind
  if (policy?.teamPolicy.kind !== 'automatic' || contract.maxAttempts !== undefined
    || (kind !== undefined && kind !== 'default' && kind !== 'tier')
    || (kind === undefined && contract.modelId !== undefined)) return contract
  return { ...contract, maxAttempts: DEFAULT_AUTOMATIC_MODEL_ATTEMPTS }
}

/** Pure precondition; native evidence and a fresh permitted candidate are also mandatory. */
export function canRetryModelCall(projection: TeamProjection, taskId: string): boolean {
  const task = projection.tasks[taskId]
  if (!task || task.status !== 'failed' || projection.team.modelRouting?.teamPolicy.kind !== 'automatic'
    || projection.team.manualOwnership?.state === 'human-owned'
    || projection.team.status !== 'paused' || projectionHasReconciliationGap(projection)
    || projection.workspace?.status !== 'ready') return false
  const kind = task.contract.modelRequest?.kind
  if ((kind !== undefined && kind !== 'default' && kind !== 'tier')
    || (kind === undefined && task.contract.modelId !== undefined)) return false
  if (task.attemptIds.length === 0 || task.attemptIds.length >= (task.contract.maxAttempts ?? 1)) return false
  if (projection.fileLeaseIds.some(id => projection.fileLeases[id]?.taskId === taskId && projection.fileLeases[id]?.status === 'active')) return false
  return task.attemptIds.every(id => {
    const attempt = projection.attempts[id]
    return attempt?.status === 'failed' && attempt.agentSessionId !== undefined
      && attempt.evidence?.stopReason === 'error' && !attempt.evidence.hasAssistantOutput
  })
}
