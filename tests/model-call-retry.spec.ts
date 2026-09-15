import { describe, expect, it } from 'vitest'
import { canRetryModelCall, withAutomaticModelAttemptBudget } from '../src/application/model-call-retry.ts'
import { resolveModelRoute } from '../src/application/model-routing.ts'
import type { ModelRoutingPolicy } from '../src/domain/model-route.ts'
import type { TeamProjection } from '../src/domain/projection.ts'
import { contract } from './fixtures.ts'

const a = { modelProvider: 'p', modelId: 'a' }, b = { modelProvider: 'p', modelId: 'b' }
const outside = { modelProvider: 'q', modelId: 'outside' }
const policy: ModelRoutingPolicy = { providerScope: { kind: 'controller-only' }, teamPolicy: {
  kind: 'automatic', tierCandidates: { quick: [], standard: [a, outside, b], critical: [] },
} }
describe('safe model retry policy', () => {
  it('persists a bounded automatic default but preserves explicit budgets and models', () => {
    const { modelId: _legacy, ...base } = contract()
    const task = { ...base, modelRequest: { kind: 'default' as const } }
    expect(withAutomaticModelAttemptBudget(task, policy).maxAttempts).toBe(3)
    expect(withAutomaticModelAttemptBudget({ ...task, maxAttempts: 1 }, policy).maxAttempts).toBe(1)
    expect(withAutomaticModelAttemptBudget({ ...task, maxAttempts: 5 }, policy).maxAttempts).toBe(5)
    expect(withAutomaticModelAttemptBudget(contract(), policy).maxAttempts).toBeUndefined()
    expect(withAutomaticModelAttemptBudget(task, { ...policy, teamPolicy: { kind: 'inherit' } }).maxAttempts).toBeUndefined()
  })
  it('skips failures within provider scope and stops on exhaustion; explicit choices never change', () => {
    const input = { controllerModel: a, ...policy, taskRequest: { kind: 'default' as const },
      catalog: [a, outside, b].map(model => ({ model, metadataResolved: true, routable: true })), failedModels: [a] }
    expect(resolveModelRoute(input).model).toEqual(b)
    expect(() => resolveModelRoute({ ...input, failedModels: [a, b] })).toThrow('exhausted')
    expect(resolveModelRoute({ ...input, taskRequest: { kind: 'exact', model: a } }).model).toEqual(a)
    expect(resolveModelRoute({ ...input, teamPolicy: { kind: 'fixed', model: a } }).model).toEqual(a)
    expect(resolveModelRoute({ ...input, teamPolicy: { kind: 'inherit' } }).model).toEqual(a)
  })
  it('blocks human ownership before inspecting retryable task state', () => {
    const source = { team: { modelRouting: policy, status: 'paused', manualOwnership: { state: 'human-owned' } },
      tasks: { t: { status: 'failed' } } } as unknown as TeamProjection
    expect(canRetryModelCall(source, 't')).toBe(false)
  })
})
