/** Atomically create a Team and its initial dependency graph. */

import { teamTaskContractSchema, type TeamTaskContract } from '../domain/task-contract.ts'
import type { TeamProjection } from '../domain/projection.ts'
import { replayTeamEvents } from '../domain/projection.ts'
import { DurableJournalCoordinator } from './durable-journal.ts'
import { YuqiOrchestratorError } from './errors.ts'
import type { Clock, EventIdSource, TeamEventJournal } from './ports.ts'
import { createTeamEvent, validateTeamEvents } from './team-events.ts'
import { DEFAULT_DIRECT_WRITE_STRATEGY, parseDirectWriteStrategy, type DirectWriteStrategy } from '../domain/execution-policy.ts'
import { DEFAULT_REVIEW_POLICY, normalizeReviewPolicy, type ReviewPolicy } from '../domain/review-policy.ts'
import { providerScopeSchema, teamModelPolicySchema, type ModelRoutingPolicy } from '../domain/model-route.ts'
import { DEFAULT_TEAM_LOCALE, teamLocaleSchema, type TeamLocale } from '../domain/locale.ts'
import { ControlOperationId } from '../domain/ids.ts'
import { withAutomaticModelAttemptBudget } from './model-call-retry.ts'
import type { TeamContinuation } from '../domain/team-continuation.ts'

export interface TeamBootstrapMetadata {
  readonly continuedFrom?: TeamContinuation
  /** Immutable user-owned concurrency captured at admission. */
  readonly maxConcurrency?: number
  readonly teamId: string
  readonly title: string
  readonly objective: string
  readonly locale?: TeamLocale
  readonly controllerModel?: { readonly provider: string; readonly model?: string; readonly maxTokens?: number }
  readonly directWriteStrategy?: DirectWriteStrategy
  readonly reviewPolicy?: Partial<ReviewPolicy>
  readonly modelRouting?: ModelRoutingPolicy
}

export type BootstrapTeamRequest = {
  readonly tasks: readonly TeamTaskContract[]
  /** Persist the initial user plan gate in the same journal commit as Team creation. */
  readonly requirePlanConfirmation?: boolean
} & ({
  readonly metadata: TeamBootstrapMetadata
} | TeamBootstrapMetadata)

/** Serializes one durable Team initialization bundle. */
export class TeamBootstrapCoordinator {
  readonly #clock: Clock
  readonly #eventIds: EventIdSource
  readonly #transactions: DurableJournalCoordinator

  constructor(clock: Clock, eventIds: EventIdSource, transactions: DurableJournalCoordinator) {
    this.#clock = clock
    this.#eventIds = eventIds
    this.#transactions = transactions
  }

  bootstrap(request: BootstrapTeamRequest, journal: TeamEventJournal): Promise<TeamProjection> {
    return this.#transactions.run(journal, async transaction => {
      const metadata = requestMetadata(request)
      const inputs = transaction.read()
      if (inputs.length > 0) {
        const current = replayTeamEvents(inputs)
        if (current.team.id !== metadata.teamId) {
          throw new YuqiOrchestratorError('TEAM_MISMATCH', `Team ${metadata.teamId} does not own this controller journal`)
        }
        if (!sameBootstrapFacts(current, metadata, request.tasks, request.requirePlanConfirmation === true)) {
          throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Team bootstrap conflicts with existing durable facts')
        }
        if (current.team.status === 'draft') {
          throw new YuqiOrchestratorError('CONTROL_OPERATION_CONFLICT', 'Team bootstrap was only partially persisted')
        }
        return current
      }

      if (request.tasks.length === 0) {
        throw new YuqiOrchestratorError('INVALID_BATCH', 'Team bootstrap requires at least one task')
      }
      const orderedTasks = validateAndOrderTaskContracts(request.tasks.map(contract => withAutomaticModelAttemptBudget(contract, metadata.modelRouting)))
      const requirePlanConfirmation = request.requirePlanConfirmation === true
      const events = [
        createTeamEvent(this.#clock, this.#eventIds, metadata.teamId, {
          type: 'yuqi/team-created', title: metadata.title, objective: metadata.objective,
          ...(metadata.continuedFrom === undefined ? {} : { continuedFrom: metadata.continuedFrom }),
          locale: teamLocaleSchema.parse(metadata.locale ?? DEFAULT_TEAM_LOCALE),
          ...(metadata.controllerModel === undefined ? {} : { controllerModel: metadata.controllerModel }),
          directWriteStrategy: parseDirectWriteStrategy(metadata.directWriteStrategy),
          reviewPolicy: normalizeReviewPolicy(metadata.reviewPolicy),
          ...(metadata.modelRouting === undefined ? {} : { modelRouting: {
            providerScope: providerScopeSchema.parse(metadata.modelRouting.providerScope),
            teamPolicy: teamModelPolicySchema.parse(metadata.modelRouting.teamPolicy),
          } }),
          planConfirmationRequired: requirePlanConfirmation,
          ...(metadata.maxConcurrency === undefined ? {} : { maxConcurrency: metadata.maxConcurrency }),
        }),
        ...(requirePlanConfirmation ? [createTeamEvent(this.#clock, this.#eventIds, metadata.teamId, {
          type: 'yuqi/team-control-requested' as const,
          operationId: ControlOperationId(`plan-review:${metadata.teamId}`),
          action: 'pause' as const,
        })] : []),
        createTeamEvent(this.#clock, this.#eventIds, metadata.teamId, {
          type: 'yuqi/team-status-changed', from: 'draft', to: 'running', reason: 'initial Team bootstrap',
        }),
        ...(requirePlanConfirmation ? [
          createTeamEvent(this.#clock, this.#eventIds, metadata.teamId, {
            type: 'yuqi/team-status-changed' as const, from: 'running' as const, to: 'pausing' as const,
            reason: 'waiting for initial plan confirmation',
          }),
          createTeamEvent(this.#clock, this.#eventIds, metadata.teamId, {
            type: 'yuqi/team-status-changed' as const, from: 'pausing' as const, to: 'paused' as const,
            reason: 'waiting for initial plan confirmation',
          }),
        ] : []),
        ...orderedTasks.map(contract => createTeamEvent(this.#clock, this.#eventIds, metadata.teamId, {
          type: 'yuqi/task-created', contract,
        })),
      ]
      // `replayTeamEvents` intentionally rejects an empty stream; seed the
      // validation fold with the Team-created fact so the whole bundle still
      // goes through the shared projection validator before one commit.
      const next = validateTeamEvents([events[0]!], events.slice(1))
      await transaction.commit(events, 'INTENT_PERSISTENCE_FAILED', 'Yuqi could not durably persist the initial Team bootstrap')
      return next
    })
  }

}

function requestMetadata(request: BootstrapTeamRequest): TeamBootstrapMetadata {
  return 'metadata' in request
    ? request.metadata
    : request
}

function sameBootstrapFacts(current: TeamProjection, metadata: TeamBootstrapMetadata, contracts: readonly TeamTaskContract[], requirePlanConfirmation: boolean): boolean {
  if (JSON.stringify(current.team.continuedFrom) !== JSON.stringify(metadata.continuedFrom)) return false
  if (current.team.maxConcurrency !== metadata.maxConcurrency) return false
  if (current.team.title !== metadata.title || current.team.objective !== metadata.objective) return false
  if (current.team.locale !== (metadata.locale ?? DEFAULT_TEAM_LOCALE)) return false
  if (current.team.directWriteStrategy !== (metadata.directWriteStrategy ?? DEFAULT_DIRECT_WRITE_STRATEGY)) return false
  const requestedReviewPolicy = normalizeReviewPolicy(metadata.reviewPolicy)
  if (current.team.reviewPolicy === undefined) {
    if (JSON.stringify(requestedReviewPolicy) !== JSON.stringify(DEFAULT_REVIEW_POLICY)) return false
  } else if (JSON.stringify(current.team.reviewPolicy) !== JSON.stringify(requestedReviewPolicy)) return false
  if (JSON.stringify(current.team.controllerModel) !== JSON.stringify(metadata.controllerModel)) return false
  if (JSON.stringify(current.team.modelRouting) !== JSON.stringify(metadata.modelRouting)) return false
  if (current.team.planConfirmationRequired !== undefined
    && current.team.planConfirmationRequired !== requirePlanConfirmation) return false
  if (current.team.planConfirmationRequired === undefined) {
    const hasLegacyPlanGate = current.controlOperations[`plan-review:${metadata.teamId}`]?.action === 'pause'
    if (hasLegacyPlanGate !== requirePlanConfirmation) return false
  }
  if (current.taskIds.length !== contracts.length) return false
  return contracts.every(contract => {
    const task = current.tasks[contract.taskId]
    return task !== undefined && JSON.stringify(teamTaskContractSchema.parse(withAutomaticModelAttemptBudget(task.contract, metadata.modelRouting)))
      === JSON.stringify(teamTaskContractSchema.parse(withAutomaticModelAttemptBudget(contract, metadata.modelRouting)))
  })
}

/** Order only what is needed for event references; semantic validation stays in the projection. */
export function validateAndOrderTaskContracts(contracts: readonly TeamTaskContract[]): readonly TeamTaskContract[] {
  const ids = contracts.map(contract => contract.taskId)
  if (new Set(ids).size !== ids.length) {
    throw new YuqiOrchestratorError('INVALID_BATCH', 'Task ids must be unique')
  }
  const knownIds = new Set(ids)
  const missing = contracts.flatMap(contract => contract.dependencies.filter(dependency => !knownIds.has(dependency)))
  if (missing.length > 0) {
    throw new YuqiOrchestratorError('INVALID_BATCH', `Task dependency ${missing[0]} does not exist`)
  }

  const pending = [...contracts]
  const ordered: TeamTaskContract[] = []
  while (pending.length > 0) {
    const created = new Set(ordered.map(contract => contract.taskId))
    const index = pending.findIndex(contract => contract.dependencies.every(dependency => created.has(dependency)))
    if (index >= 0) {
      ordered.push(pending.splice(index, 1)[0]!)
      continue
    }

    throw new YuqiOrchestratorError('INVALID_BATCH', 'Task dependency graph contains a cycle')
  }
  return ordered
}
