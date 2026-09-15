/** Stable errors raised while parsing or replaying Yuqi Team events. */

/** Machine-readable domain failure categories. */
export type YuqiDomainErrorCode =
  | 'INVALID_EVENT'
  | 'EVENT_ID_COLLISION'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'TEAM_NOT_CREATED'
  | 'TEAM_ALREADY_CREATED'
  | 'TEAM_ID_MISMATCH'
  | 'ENTITY_ALREADY_EXISTS'
  | 'ENTITY_NOT_FOUND'
  | 'REFERENCE_MISMATCH'
  | 'INVALID_TASK_CONTRACT'
  | 'INVALID_TASK_REVISION'
  | 'INVALID_ATTEMPT_ORDINAL'
  | 'INVALID_TRANSITION'

/** Structured context attached to a domain failure. */
export interface YuqiDomainErrorDetails {
  /** Zero-based event position during replay, when known. */
  readonly eventIndex?: number
  /** Entity category involved in the failure. */
  readonly entity?: 'team' | 'task' | 'attempt' | 'verification' | 'workspace' | 'file-lease' | 'control-operation' | 'budget-reservation' | 'event'
  /** Opaque entity id involved in the failure. */
  readonly entityId?: string
}

/** Error with a stable code and replay location. */
export class YuqiDomainError extends Error {
  /** Stable failure category. */
  readonly code: YuqiDomainErrorCode
  /** Structured non-secret context. */
  readonly details: YuqiDomainErrorDetails

  /**
   * Create a domain error.
   * @param code - Stable machine-readable category.
   * @param message - Human-readable diagnostic.
   * @param details - Entity and replay position context.
   */
  constructor(code: YuqiDomainErrorCode, message: string, details: YuqiDomainErrorDetails = {}) {
    super(message)
    this.name = 'YuqiDomainError'
    this.code = code
    this.details = details
  }
}
