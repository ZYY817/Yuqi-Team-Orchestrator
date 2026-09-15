/**
 * Opaque identities owned by the Yuqi Team domain.
 * @module yuqi-team-orchestrator/ids
 */

declare const YUQI_BRAND: unique symbol

type Branded<B extends string> = string & { readonly [YUQI_BRAND]: B }

/** Identifies one managed Team. */
export type TeamId = Branded<'YuqiTeamId'>
/** Identifies one task within a Team. */
export type TaskId = Branded<'YuqiTaskId'>
/** Identifies one execution attempt for a task. */
export type AttemptId = Branded<'YuqiAttemptId'>
/** Identifies one verification run for an attempt. */
export type VerificationId = Branded<'YuqiVerificationId'>
/** Identifies one managed Team worktree. */
export type WorkspaceId = Branded<'YuqiWorkspaceId'>
/** Identifies one durable file ownership lease. */
export type FileLeaseId = Branded<'YuqiFileLeaseId'>
/** Identifies one durable Team event for idempotent replay. */
export type TeamEventId = Branded<'YuqiTeamEventId'>
/** Identifies one idempotent user or host control request. */
export type ControlOperationId = Branded<'YuqiControlOperationId'>

/** Brand a raw string as a Team id. @param id - Raw id. @returns The branded id. */
export function TeamId(id: string): TeamId {
  return id as TeamId
}

/** Brand a raw string as a task id. @param id - Raw id. @returns The branded id. */
export function TaskId(id: string): TaskId {
  return id as TaskId
}

/** Brand a raw string as an attempt id. @param id - Raw id. @returns The branded id. */
export function AttemptId(id: string): AttemptId {
  return id as AttemptId
}

/** Brand a raw string as a verification id. @param id - Raw id. @returns The branded id. */
export function VerificationId(id: string): VerificationId {
  return id as VerificationId
}

/** Brand a raw string as a workspace id. */
export function WorkspaceId(id: string): WorkspaceId {
  return id as WorkspaceId
}

/** Brand a raw string as a file lease id. */
export function FileLeaseId(id: string): FileLeaseId {
  return id as FileLeaseId
}

/** Brand a raw string as an event id. @param id - Raw id. @returns The branded id. */
export function TeamEventId(id: string): TeamEventId {
  return id as TeamEventId
}

/** Brand a raw string as a durable control operation id. */
export function ControlOperationId(id: string): ControlOperationId {
  return id as ControlOperationId
}
