import { describe, expect, it } from 'vitest'
import { automaticModelCandidates, MODEL_ROUTE_REASONS, resolveModelRoute } from '../src/application/model-routing.ts'
import type {
  ModelCatalogFact,
  ProviderModelRef,
  ProviderScope,
  TaskModelRequest,
  TeamModelPolicy,
} from '../src/domain/model-route.ts'

const controller = model('controller-main')

function model(modelId: string, modelProvider = 'controller-provider'): ProviderModelRef {
  return { modelProvider, modelId }
}

function fact(ref: ProviderModelRef, overrides: Partial<ModelCatalogFact> = {}): ModelCatalogFact {
  return { model: ref, metadataResolved: true, routable: true, ...overrides }
}

function resolve(
  taskRequest: TaskModelRequest,
  teamPolicy: TeamModelPolicy,
  catalog: readonly ModelCatalogFact[],
  providerScope: ProviderScope = { kind: 'controller-only' },
) {
  return resolveModelRoute({ controllerModel: controller, providerScope, teamPolicy, taskRequest, catalog })
}

describe('experimental model routing core', () => {
  it('applies task exact before Team fixed and returns a frozen, explainable route', () => {
    const exact = model('task-exact')
    const result = resolve(
      { kind: 'exact', model: exact },
      { kind: 'fixed', model: model('team-fixed') },
      [fact(exact), fact(model('team-fixed'))],
    )

    expect(result).toEqual({ model: exact, basis: 'task-exact', reason: MODEL_ROUTE_REASONS.taskExact })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.model)).toBe(true)
  })

  it('applies Team fixed before automatic routing inputs', () => {
    const fixed = model('team-fixed')
    expect(resolve(
      { kind: 'tier', tier: 'critical' },
      { kind: 'fixed', model: fixed },
      [fact(fixed), fact(model('automatic'))],
    )).toEqual({ model: fixed, basis: 'team-fixed', reason: MODEL_ROUTE_REASONS.teamFixed })
  })

  it('uses the first ordered tier candidate that is allowed and catalog-routable', () => {
    const disallowed = model('outside', 'outside-provider')
    const unresolved = model('unresolved')
    const unroutable = model('unroutable')
    const selected = model('selected')
    const later = model('later')
    const result = resolve(
      { kind: 'tier', tier: 'standard' },
      { kind: 'automatic', tierCandidates: { quick: [], standard: [disallowed, unresolved, unroutable, selected, later], critical: [] } },
      [
        fact(disallowed),
        fact(unresolved, { metadataResolved: false }),
        fact(unroutable, { routable: false }),
        fact(selected),
        fact(later),
      ],
    )

    expect(result).toEqual({
      model: selected,
      basis: 'automatic',
      reason: MODEL_ROUTE_REASONS.automaticCandidate,
      requestedTier: 'standard',
      candidateIndex: 3,
    })
  })

  it('treats default as standard under automatic policy', () => {
    const standard = model('standard')
    expect(resolve(
      { kind: 'default' },
      { kind: 'automatic', tierCandidates: { quick: [model('quick')], standard: [standard], critical: [] } },
      [fact(standard), fact(controller)],
    )).toEqual({
      model: standard,
      basis: 'automatic',
      reason: MODEL_ROUTE_REASONS.automaticCandidate,
      requestedTier: 'standard',
      candidateIndex: 0,
    })
  })

  it('uses allowlisted Providers for automatic candidates without widening scope', () => {
    const configured = model('configured', 'external-provider')
    const controllerCatalog = model('controller-catalog')
    const allowlistedCatalog = model('allowlisted-catalog', 'external-provider')
    const blockedCatalog = model('blocked-catalog', 'blocked-provider')
    const scope = { kind: 'controller-plus-allowlist', providerAllowlist: ['external-provider'] } as const

    expect(automaticModelCandidates({
      configuredCandidates: [configured, configured],
      controllerModel: controller,
      providerScope: scope,
      catalog: [
        fact(allowlistedCatalog),
        fact(controllerCatalog),
        fact(controller),
        fact(configured),
        fact(blockedCatalog),
        fact(allowlistedCatalog),
      ],
    })).toEqual([configured, controller, allowlistedCatalog, controllerCatalog])
  })

  it('uses all routable models exposed by an allowed aggregating Provider', () => {
    const aggregateController = model('deepseek/deepseek-v4-flash-0731', 'deepxiaohao')
    expect(automaticModelCandidates({
      configuredCandidates: [
        model('moonshotai/kimi-k3', 'deepxiaohao'),
        model('deepseek/deepseek-v4-pro-0813', 'deepxiaohao'),
      ],
      controllerModel: aggregateController,
      providerScope: { kind: 'controller-only' },
      catalog: [
        fact(model('xai/grok-4.6', 'deepxiaohao')),
        fact(model('deepseek/deepseek-v4-pro-0813', 'deepxiaohao')),
      ],
    })).toEqual([
      model('moonshotai/kimi-k3', 'deepxiaohao'),
      model('deepseek/deepseek-v4-pro-0813', 'deepxiaohao'),
      aggregateController,
      model('xai/grok-4.6', 'deepxiaohao'),
    ])
  })

  it('selects an allowlisted catalog model after configured candidates fail', () => {
    const controllerCatalog = model('controller-catalog')
    const allowlistedCatalog = model('allowlisted-catalog', 'external-provider')
    const scope = { kind: 'controller-plus-allowlist', providerAllowlist: ['external-provider'] } as const

    expect(resolve(
      { kind: 'tier', tier: 'quick' },
      { kind: 'automatic', tierCandidates: { quick: [model('configured-missing')], standard: [], critical: [] } },
      [
        fact(controller, { metadataResolved: false, routable: false }),
        fact(controllerCatalog, { routable: false }),
        fact(allowlistedCatalog),
      ],
      scope,
    )).toEqual({ model: allowlistedCatalog, basis: 'automatic',
      reason: MODEL_ROUTE_REASONS.automaticCandidate, requestedTier: 'quick', candidateIndex: 3 })
  })

  it('allows an explicitly allowlisted Provider but never treats the allowlist as catalog resolution', () => {
    const external = model('external', 'external-provider')
    const scope = { kind: 'controller-plus-allowlist', providerAllowlist: ['external-provider'] } as const
    expect(resolve(
      { kind: 'exact', model: external },
      { kind: 'inherit' },
      [fact(external)],
      scope,
    ).model).toEqual(external)
    expect(() => resolve(
      { kind: 'exact', model: external },
      { kind: 'inherit' },
      [],
      scope,
    )).toThrow(expect.objectContaining({ code: 'TASK_MODEL_UNRESOLVED' }))
  })

  it('enforces Provider scope as a hard constraint for exact and fixed routes', () => {
    const external = model('external', 'external-provider')
    expect(() => resolve(
      { kind: 'exact', model: external },
      { kind: 'inherit' },
      [fact(external)],
    )).toThrow(expect.objectContaining({ code: 'PROVIDER_NOT_ALLOWED' }))
    expect(() => resolve(
      { kind: 'default' },
      { kind: 'fixed', model: external },
      [fact(external)],
    )).toThrow(expect.objectContaining({ code: 'PROVIDER_NOT_ALLOWED' }))
  })

  it('fails closed when exact, legacy exact, or fixed routes are not resolved and routable', () => {
    expect(() => resolve(
      { kind: 'exact', model: model('missing') }, { kind: 'inherit' }, [],
    )).toThrow(expect.objectContaining({ code: 'TASK_MODEL_UNRESOLVED' }))
    expect(() => resolve(
      { kind: 'legacy', modelId: 'legacy-missing' }, { kind: 'inherit' }, [],
    )).toThrow(expect.objectContaining({ code: 'TASK_MODEL_UNRESOLVED' }))
    expect(() => resolve(
      { kind: 'default' }, { kind: 'fixed', model: model('missing') }, [],
    )).toThrow(expect.objectContaining({ code: 'TEAM_FIXED_MODEL_UNRESOLVED' }))
  })

  it('normalizes a legacy model id to the controller Provider', () => {
    const legacy = model('legacy-model')
    expect(resolve(
      { kind: 'legacy', modelId: legacy.modelId }, { kind: 'inherit' }, [fact(legacy)],
    )).toEqual({ model: legacy, basis: 'task-exact', reason: MODEL_ROUTE_REASONS.legacyTaskExact })
  })

  it.each([
    { quick: [], standard: [], critical: [] },
    { quick: [model('missing')], standard: [], critical: [] },
  ])('falls back to the controller with a stable reason when automatic candidates are exhausted', tierCandidates => {
    expect(resolve(
      { kind: 'tier', tier: 'quick' }, { kind: 'automatic', tierCandidates }, [],
    )).toEqual({
      model: controller,
      basis: 'controller-inherit',
      reason: 'automatic-candidates-exhausted',
      requestedTier: 'quick',
    })
  })

  it('keeps the legacy controller fallback audit basis when the controller resolves', () => {
    expect(resolve(
      { kind: 'tier', tier: 'quick' },
      { kind: 'automatic', tierCandidates: { quick: [model('missing')], standard: [], critical: [] } },
      [fact(controller)],
    )).toEqual({
      model: controller,
      basis: 'controller-inherit',
      reason: MODEL_ROUTE_REASONS.automaticCandidatesExhausted,
      requestedTier: 'quick',
    })
  })

  it('inherits the controller for default/inherit without claiming catalog credential validity', () => {
    expect(resolve(
      { kind: 'default' }, { kind: 'inherit' }, [],
    )).toEqual({
      model: controller,
      basis: 'controller-inherit',
      reason: MODEL_ROUTE_REASONS.taskDefault,
    })
  })

})
