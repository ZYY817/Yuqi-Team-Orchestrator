/** Shared fail-closed projection checks used before dispatch or scheduling. */

import type { TeamProjection } from '../domain/projection.ts'
import { projectionHasReconciliationGap as domainProjectionHasReconciliationGap } from '../domain/projection.ts'

/** Whether a projection contains a child side effect that is not fully accounted for. */
export function projectionRequiresReconciliation(projection: TeamProjection): boolean {
  if (domainProjectionHasReconciliationGap(projection)) return true
  return Object.values(projection.attempts).some(attempt => attempt.status === 'dispatching' || attempt.status === 'running')
}
