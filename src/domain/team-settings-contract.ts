/** Browser-safe Team settings contract shared by Host and Client. */

import type { ModelRoutingPolicy } from './model-route.ts'
import { DEFAULT_REVIEW_POLICY, type ReviewPolicy } from './review-policy.ts'

/** Hard product boundary for a single Team scheduler. */
export const MAX_TEAM_CONCURRENCY = 100
export const MIN_TEAM_CONCURRENCY = 1
/** By default every schedulable task may run; MAX_TEAM_TASKS is also 100. */
export const DEFAULT_TEAM_CONCURRENCY = MAX_TEAM_CONCURRENCY
export const DEFAULT_CHILD_PRESET_ID = 'standard'
export const CHILD_MODEL_POLICIES = ['inherit', 'fixed', 'automatic'] as const
export type ChildModelPolicy = (typeof CHILD_MODEL_POLICIES)[number]
export const TEAM_AUTHORITY_MODES = ['read-only', 'write-authorized', 'full-access'] as const
export type TeamAuthorityMode = (typeof TEAM_AUTHORITY_MODES)[number]
export const DEFAULT_TEAM_AUTHORITY_MODE: TeamAuthorityMode = 'write-authorized'
export const TEAM_WORKSPACE_MODES = ['direct', 'git-worktree'] as const
export type TeamWorkspaceMode = (typeof TEAM_WORKSPACE_MODES)[number]
export const DEFAULT_TEAM_WORKSPACE_MODE: TeamWorkspaceMode = 'direct'

/** Browser-safe syntax check; physical ownership, volume and links are checked by Host at start. */
export const GIT_WORKSPACE_ROOT_PATTERN = /^(?:|[A-Za-z]:[\\/][^\x00-\x1f<>:"|?*]+|\/[^\x00-\x1f<>:"|?*\\]+)$/u

export interface TeamSettings {
  /** User-selected safety override. The default equals the maximum Team task count. */
  maxConcurrency: number
  /** Native Harness preset inherited by every worker in a newly started Team. */
  childPresetId: string
  /** Empty means inherit the model selected in the invoking conversation. */
  childModelId: string
  /** How a task without an exact modelId receives its model. */
  childModelPolicy: ChildModelPolicy
  /** User-owned deterministic routes for automatic task tiers; empty falls back to the controller model. */
  quickModelId: string
  standardModelId: string
  criticalModelId: string
  /** Experimental structured policy. Absent values are legacy settings and are normalized by the application core. */
  modelRouting?: ModelRoutingPolicy
  /** Create the Team paused so the operator can review the graph and per-task models before dispatch. */
  requirePlanConfirmation: boolean
  /** Permission inherited by tasks that do not declare an exact authority mode. */
  defaultAuthorityMode: TeamAuthorityMode
  /** New Teams use the current project unless the user explicitly opts into Git isolation. */
  defaultWorkspaceMode: TeamWorkspaceMode
  /** Empty keeps the automatic location. Only new Git-isolated Teams use this parent directory. */
  gitWorkspaceRoot?: string
  /** Atomic reviewer policy copied into every newly started Team. */
  reviewPolicy?: ReviewPolicy
}

/** New automatic routing never leaves the controller Provider unless the user expands this scope. */
export const DEFAULT_EXPERIMENTAL_MODEL_ROUTING: ModelRoutingPolicy = Object.freeze({
  providerScope: Object.freeze({ kind: 'controller-only' }),
  teamPolicy: Object.freeze({
    kind: 'automatic',
    tierCandidates: Object.freeze({
      quick: Object.freeze([]),
      standard: Object.freeze([]),
      critical: Object.freeze([]),
    }),
  }),
})

export const DEFAULT_TEAM_SETTINGS: TeamSettings = Object.freeze({
  maxConcurrency: DEFAULT_TEAM_CONCURRENCY,
  childPresetId: DEFAULT_CHILD_PRESET_ID,
  childModelId: '',
  childModelPolicy: 'automatic',
  quickModelId: '',
  standardModelId: '',
  criticalModelId: '',
  modelRouting: DEFAULT_EXPERIMENTAL_MODEL_ROUTING,
  requirePlanConfirmation: true,
  defaultAuthorityMode: DEFAULT_TEAM_AUTHORITY_MODE,
  defaultWorkspaceMode: DEFAULT_TEAM_WORKSPACE_MODE,
  gitWorkspaceRoot: '',
  reviewPolicy: DEFAULT_REVIEW_POLICY,
})
