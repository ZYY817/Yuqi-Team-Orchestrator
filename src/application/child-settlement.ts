import type { ChildEnd } from './ports.ts'
import { taskOutcomeAllowsCompletion } from '../domain/task-outcome.ts'

/** One decision for both live end events and cold-replayed end events. */
export function decideChildSettlement(end: ChildEnd, cancelling: boolean, hasVerification: boolean, outcomeVersion?: 1) {
  const completedWithOutput = end.stopReason === 'completed' && end.hasAssistantOutput
  const semanticSuccess = taskOutcomeAllowsCompletion(outcomeVersion, end.taskOutcome)
  const reported = end.taskOutcome?.status === 'reported' ? end.taskOutcome.outcome : undefined
  const completedWithoutVerification = !cancelling && completedWithOutput && semanticSuccess && !hasVerification
  const attemptStatus = end.stopReason === 'completed' ? 'settled' as const : end.stopReason === 'aborted' ? 'cancelled' as const : 'failed' as const
  const taskStatus = cancelling ? 'cancelled' as const
    : !completedWithOutput ? (end.stopReason === 'aborted' ? 'cancelled' as const : 'failed' as const)
    : !semanticSuccess ? (reported?.kind === 'failed' ? 'failed' as const : 'blocked' as const)
    : hasVerification ? 'verifying' as const : 'completed' as const
  const reason = cancelling ? 'child stopped after cancellation was requested'
    : !completedWithOutput ? (end.stopReason === 'completed' ? 'child stopped completed without non-blank assistant output' : `child stopped: ${end.stopReason}`)
    : !semanticSuccess ? reported === undefined
      ? `child task outcome ${end.taskOutcome?.status ?? 'missing'}; controller must resolve the incomplete report before retrying`
      : `child task ${reported.kind}: ${reported.summary}${'nextAction' in reported && reported.nextAction ? `; next: ${reported.nextAction}` : ''}${'question' in reported && reported.question ? `; question: ${reported.question}` : ''}`
    : `child stopped: ${end.stopReason}`
  return { attemptStatus, taskStatus, completedWithoutVerification, reason, releaseLease: taskStatus !== 'verifying' }
}
