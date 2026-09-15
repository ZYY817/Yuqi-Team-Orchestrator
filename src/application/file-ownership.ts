/** Pure file-lease admission for one shared Team worktree. */

import { fileScopeSetsConflict } from '../domain/file-scope.ts'
import type { FileLease } from '../domain/workspace.ts'
import { fileLeaseSchema } from '../domain/workspace.ts'
import { YuqiOrchestratorError } from './errors.ts'
import { DEFAULT_DIRECT_WRITE_STRATEGY, type DirectWriteStrategy } from '../domain/execution-policy.ts'

export interface AcquireFileLeaseRequest {
  readonly leaseId: string
  readonly taskId: string
  readonly attemptId?: string
  readonly mode: 'read' | 'write'
  readonly fileScope: readonly string[]
  readonly directWriteStrategy?: DirectWriteStrategy
}

/** Validate and admit one lease without mutating the active lease collection. */
export function acquireFileLease(request: AcquireFileLeaseRequest, activeLeases: readonly FileLease[]): FileLease {
  const lease = fileLeaseSchema.parse({
    leaseId: request.leaseId,
    taskId: request.taskId,
    ...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
    mode: request.mode,
    fileScope: [...request.fileScope],
    status: 'active',
  })
  if (activeLeases.some(active => active.status === 'active' && active.leaseId === lease.leaseId)) {
    throw new YuqiOrchestratorError('FILE_LEASE_CONFLICT', `File lease ${lease.leaseId} already exists`)
  }
  const conflict = activeLeases.find(active => leasesConflict(lease, active, request.directWriteStrategy))
  if (conflict !== undefined) {
    throw new YuqiOrchestratorError('FILE_LEASE_CONFLICT', `Task ${lease.taskId} conflicts with active task ${conflict.taskId}`)
  }
  Object.freeze(lease.fileScope)
  return Object.freeze(lease)
}

/** Read/read leases may overlap; every overlapping pair involving a writer conflicts. */
export function leasesConflict(
  left: FileLease,
  right: FileLease,
  directWriteStrategy: DirectWriteStrategy = DEFAULT_DIRECT_WRITE_STRATEGY,
): boolean {
  if (left.status !== 'active' || right.status !== 'active') return false
  if (left.mode === 'read' && right.mode === 'read') return false
  if (directWriteStrategy === 'strict-writer-serial' && left.mode === 'write' && right.mode === 'write') return true
  return fileScopeSetsConflict(left.fileScope, right.fileScope)
}
