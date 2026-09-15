/** Deterministic routing over explicit policy, ordered candidates, and catalog facts. */

import {
  modelCatalogFactSchema,
  providerModelRefSchema,
  providerScopeSchema,
  taskModelRequestSchema,
  teamModelPolicySchema,
  type ModelCatalogFact,
  type ModelRouteTaskTier,
  type ProviderModelRef,
  type ProviderScope,
  type TaskModelRequest,
  type TeamModelPolicy,
} from '../domain/model-route.ts'

export const MODEL_ROUTE_REASONS = {
  taskExact: 'task-exact',
  legacyTaskExact: 'legacy-task-exact',
  teamFixed: 'team-fixed',
  automaticCandidate: 'automatic-tier-candidate',
  automaticCandidatesExhausted: 'automatic-candidates-exhausted',
  taskDefault: 'task-default-controller-inherit',
  teamInherit: 'team-inherit-controller',
} as const

export type ModelRouteReason = (typeof MODEL_ROUTE_REASONS)[keyof typeof MODEL_ROUTE_REASONS]
export type ModelRouteBasis = 'task-exact' | 'team-fixed' | 'automatic' | 'controller-inherit'
export type ModelRoutingErrorCode =
  | 'TASK_MODEL_UNRESOLVED'
  | 'TEAM_FIXED_MODEL_UNRESOLVED'
  | 'PROVIDER_NOT_ALLOWED'

export class ModelRoutingError extends Error {
  readonly code: ModelRoutingErrorCode

  constructor(code: ModelRoutingErrorCode, message: string) {
    super(message)
    this.name = 'ModelRoutingError'
    this.code = code
  }
}

export interface ResolveModelRouteInput {
  /** Proven failed routes; only automatic policy may skip them. */
  readonly failedModels?: readonly ProviderModelRef[]
  readonly controllerModel: ProviderModelRef
  readonly providerScope: ProviderScope
  readonly teamPolicy: TeamModelPolicy
  readonly taskRequest: TaskModelRequest
  readonly catalog: readonly ModelCatalogFact[]
}

export interface ResolvedModelRoute {
  readonly model: ProviderModelRef
  readonly basis: ModelRouteBasis
  readonly reason: ModelRouteReason
  readonly requestedTier?: ModelRouteTaskTier
  readonly candidateIndex?: number
}

export interface AutomaticModelCandidatesInput {
  readonly configuredCandidates: readonly ProviderModelRef[]
  readonly controllerModel: ProviderModelRef
  readonly providerScope: ProviderScope
  /** Provider catalog evidence; ordering inside one Provider is preserved. */
  readonly catalog: readonly ModelCatalogFact[]
}

/** Automatic `default` intentionally shares the standard tier. */
export function automaticTierForTaskRequest(taskRequest: TaskModelRequest): ModelRouteTaskTier | undefined {
  const parsed = taskModelRequestSchema.parse(taskRequest)
  return parsed.kind === 'tier' ? parsed.tier : parsed.kind === 'default' ? 'standard' : undefined
}

/**
 * Build the deterministic automatic route order without scoring or I/O:
 * user tier candidates in configuration order, the controller, then the
 * currently allowed Providers' catalogs. Automatic routing is still
 * deterministic and never crosses a Provider boundary that the policy did
 * not explicitly allow.
 */
export function automaticModelCandidates(input: AutomaticModelCandidatesInput): readonly ProviderModelRef[] {
  const controllerModel = providerModelRefSchema.parse(input.controllerModel)
  const providerScope = providerScopeSchema.parse(input.providerScope)
  const configuredCandidates = input.configuredCandidates.map(candidate => providerModelRefSchema.parse(candidate))
  const catalog = input.catalog.map(fact => modelCatalogFactSchema.parse(fact))
  const ordered = [
    ...configuredCandidates,
    controllerModel,
    ...catalog.map(fact => fact.model),
  ]
  const unique = new Map<string, ProviderModelRef>()
  for (const candidate of ordered) {
    if (!isAllowedProvider(candidate, controllerModel, providerScope)) continue
    const key = modelKey(candidate)
    if (!unique.has(key)) unique.set(key, Object.freeze({ ...candidate }))
  }
  return Object.freeze([...unique.values()])
}

/**
 * Resolve one route without network access, scoring, price data, or credential claims.
 * Exact task and fixed Team routes fail closed; automatic routing alone may fall back.
 */
export function resolveModelRoute(input: ResolveModelRouteInput): ResolvedModelRoute {
  const controllerModel = providerModelRefSchema.parse(input.controllerModel)
  const providerScope = providerScopeSchema.parse(input.providerScope)
  const teamPolicy = teamModelPolicySchema.parse(input.teamPolicy)
  const taskRequest = taskModelRequestSchema.parse(input.taskRequest)
  const catalog = input.catalog.map(fact => modelCatalogFactSchema.parse(fact))

  if (taskRequest.kind === 'exact') {
    assertAllowedProvider(taskRequest.model, controllerModel, providerScope)
    assertCatalogRoute(taskRequest.model, catalog, 'TASK_MODEL_UNRESOLVED')
    return freezeResult({ model: taskRequest.model, basis: 'task-exact', reason: MODEL_ROUTE_REASONS.taskExact })
  }

  if (taskRequest.kind === 'legacy') {
    const legacyModel = { modelProvider: controllerModel.modelProvider, modelId: taskRequest.modelId }
    assertCatalogRoute(legacyModel, catalog, 'TASK_MODEL_UNRESOLVED')
    return freezeResult({ model: legacyModel, basis: 'task-exact', reason: MODEL_ROUTE_REASONS.legacyTaskExact })
  }

  if (teamPolicy.kind === 'fixed') {
    assertAllowedProvider(teamPolicy.model, controllerModel, providerScope)
    assertCatalogRoute(teamPolicy.model, catalog, 'TEAM_FIXED_MODEL_UNRESOLVED')
    return freezeResult({ model: teamPolicy.model, basis: 'team-fixed', reason: MODEL_ROUTE_REASONS.teamFixed })
  }

  const automaticTier = teamPolicy.kind === 'automatic' ? automaticTierForTaskRequest(taskRequest) : undefined
  if (teamPolicy.kind === 'automatic' && automaticTier !== undefined) {
    const configuredCandidates = teamPolicy.tierCandidates[automaticTier]
    const candidates = automaticModelCandidates({
      configuredCandidates,
      controllerModel,
      providerScope,
      catalog,
    })
    for (const [expandedCandidateIndex, candidate] of candidates.entries()) {
      if (input.failedModels?.some(failed => sameModel(failed, candidate))) continue
      if (!isCatalogRoute(candidate, catalog)) continue
      const configuredCandidateIndex = configuredCandidates.findIndex(configured => sameModel(configured, candidate))
      if (configuredCandidateIndex === -1 && sameModel(candidate, controllerModel)) {
        return freezeResult({
          model: controllerModel,
          basis: 'controller-inherit',
          reason: MODEL_ROUTE_REASONS.automaticCandidatesExhausted,
          requestedTier: automaticTier,
        })
      }
      return freezeResult({
        model: candidate,
        basis: 'automatic',
        reason: MODEL_ROUTE_REASONS.automaticCandidate,
        requestedTier: automaticTier,
        candidateIndex: configuredCandidateIndex === -1 ? expandedCandidateIndex : configuredCandidateIndex,
      })
    }
    if (input.failedModels?.length) {
      throw new ModelRoutingError('TASK_MODEL_UNRESOLVED', 'Allowed automatic model candidates exhausted after verified call failures')
    }
    return freezeResult({
      model: controllerModel,
      basis: 'controller-inherit',
      reason: MODEL_ROUTE_REASONS.automaticCandidatesExhausted,
      requestedTier: automaticTier,
    })
  }

  return freezeResult({
    model: controllerModel,
    basis: 'controller-inherit',
    reason: taskRequest.kind === 'default' ? MODEL_ROUTE_REASONS.taskDefault : MODEL_ROUTE_REASONS.teamInherit,
    ...(taskRequest.kind === 'tier' ? { requestedTier: taskRequest.tier } : {}),
  })
}

export function isProviderAllowed(
  modelProvider: string,
  controllerProvider: string,
  scope: ProviderScope,
): boolean {
  const parsedScope = providerScopeSchema.parse(scope)
  return modelProvider === controllerProvider
    || (parsedScope.kind === 'controller-plus-allowlist' && parsedScope.providerAllowlist.includes(modelProvider))
}

function assertAllowedProvider(model: ProviderModelRef, controller: ProviderModelRef, scope: ProviderScope): void {
  if (!isAllowedProvider(model, controller, scope)) {
    throw new ModelRoutingError('PROVIDER_NOT_ALLOWED', `Model provider ${model.modelProvider} is outside the configured provider scope`)
  }
}

function isAllowedProvider(model: ProviderModelRef, controller: ProviderModelRef, scope: ProviderScope): boolean {
  return isProviderAllowed(model.modelProvider, controller.modelProvider, scope)
}

function assertCatalogRoute(
  model: ProviderModelRef,
  catalog: readonly ModelCatalogFact[],
  code: 'TASK_MODEL_UNRESOLVED' | 'TEAM_FIXED_MODEL_UNRESOLVED',
): void {
  if (!isCatalogRoute(model, catalog)) {
    throw new ModelRoutingError(code, `Model ${model.modelProvider}/${model.modelId} is not a metadata-resolved routable catalog entry`)
  }
}

function isCatalogRoute(model: ProviderModelRef, catalog: readonly ModelCatalogFact[]): boolean {
  return catalog.some(fact => fact.metadataResolved && fact.routable && sameModel(fact.model, model))
}

function sameModel(left: ProviderModelRef, right: ProviderModelRef): boolean {
  return left.modelProvider === right.modelProvider && left.modelId === right.modelId
}

function modelKey(model: ProviderModelRef): string {
  return `${model.modelProvider}\u0000${model.modelId}`
}

function freezeResult(result: ResolvedModelRoute): ResolvedModelRoute {
  return Object.freeze({ ...result, model: Object.freeze({ ...result.model }) })
}
