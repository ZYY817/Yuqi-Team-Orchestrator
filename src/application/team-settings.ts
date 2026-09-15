/** User-owned limits for Yuqi Team orchestration. */

import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_TEAM_CONCURRENCY,
  DEFAULT_CHILD_PRESET_ID,
  CHILD_MODEL_POLICIES,
  DEFAULT_TEAM_AUTHORITY_MODE,
  DEFAULT_TEAM_WORKSPACE_MODE,
  GIT_WORKSPACE_ROOT_PATTERN,
  TEAM_AUTHORITY_MODES,
  TEAM_WORKSPACE_MODES,
  MAX_TEAM_CONCURRENCY,
  MIN_TEAM_CONCURRENCY,
  type TeamSettings,
} from '../domain/team-settings-contract.ts'
import {
  DEFAULT_MAX_REWORK_ROUNDS,
  DEFAULT_REVIEW_POLICY,
  MAX_REWORK_ROUNDS,
  REVIEW_POLICY_MODES,
  normalizeReviewPolicy,
  type ReviewPolicy,
} from '../domain/review-policy.ts'
import {
  providerModelRefSchema,
  providerScopeSchema,
  teamModelPolicySchema,
  type ModelRoutingPolicy,
  type ProviderModelRef,
  type TeamModelPolicy,
} from '../domain/model-route.ts'
export {
  DEFAULT_CHILD_PRESET_ID,
  DEFAULT_TEAM_CONCURRENCY,
  DEFAULT_TEAM_SETTINGS,
  MAX_TEAM_CONCURRENCY,
  MIN_TEAM_CONCURRENCY,
  type TeamSettings,
} from '../domain/team-settings-contract.ts'

/** Stable Host settings namespace, shared with the header settings modal. */
// Branding is compile-time only; the Host validates this at registration.
export const TEAM_SETTINGS_NAMESPACE = 'yuqi-team-orchestrator' as SettingsNamespace

export const TEAM_SETTINGS_SCHEMA = z.object({
  maxConcurrency: z.number().step(1).min(MIN_TEAM_CONCURRENCY).max(MAX_TEAM_CONCURRENCY).default(DEFAULT_TEAM_CONCURRENCY),
  childPresetId: z.string().default(DEFAULT_CHILD_PRESET_ID),
  childModelId: z.string().default(''),
  childModelPolicy: z.union(CHILD_MODEL_POLICIES).default('automatic'),
  quickModelId: z.string().default(''),
  standardModelId: z.string().default(''),
  criticalModelId: z.string().default(''),
  modelRouting: z.union([
    z.object({
      providerScope: z.object({ kind: z.const('controller-only') }),
      teamPolicy: z.object({
        kind: z.const('automatic'),
        tierCandidates: z.object({
          quick: z.array(z.object({ modelProvider: z.string(), modelId: z.string() })).default([]),
          standard: z.array(z.object({ modelProvider: z.string(), modelId: z.string() })).default([]),
          critical: z.array(z.object({ modelProvider: z.string(), modelId: z.string() })).default([]),
        }),
      }),
    }),
    z.object({
      providerScope: z.object({
        kind: z.const('controller-plus-allowlist'),
        providerAllowlist: z.array(z.string()).default([]),
      }),
      teamPolicy: z.union([
        z.object({ kind: z.const('inherit') }),
        z.object({ kind: z.const('fixed'), model: z.object({ modelProvider: z.string(), modelId: z.string() }) }),
        z.object({
          kind: z.const('automatic'),
          tierCandidates: z.object({
            quick: z.array(z.object({ modelProvider: z.string(), modelId: z.string() })).default([]),
            standard: z.array(z.object({ modelProvider: z.string(), modelId: z.string() })).default([]),
            critical: z.array(z.object({ modelProvider: z.string(), modelId: z.string() })).default([]),
          }),
        }),
      ]),
    }),
    z.object({
      providerScope: z.object({ kind: z.const('controller-only') }),
      teamPolicy: z.union([
        z.object({ kind: z.const('inherit') }),
        z.object({ kind: z.const('fixed'), model: z.object({ modelProvider: z.string(), modelId: z.string() }) }),
      ]),
    }),
  ]),
  requirePlanConfirmation: z.boolean().default(true),
  defaultAuthorityMode: z.union(TEAM_AUTHORITY_MODES).default(DEFAULT_TEAM_AUTHORITY_MODE),
  defaultWorkspaceMode: z.union(TEAM_WORKSPACE_MODES).default(DEFAULT_TEAM_WORKSPACE_MODE),
  gitWorkspaceRoot: z.string().pattern(GIT_WORKSPACE_ROOT_PATTERN).default(''),
  reviewPolicy: z.object({
    mode: z.union(REVIEW_POLICY_MODES).default(DEFAULT_REVIEW_POLICY.mode),
    maxReworkRounds: z.number().step(1).min(0).max(MAX_REWORK_ROUNDS).default(DEFAULT_MAX_REWORK_ROUNDS),
    additionalPrompt: z.string().default(''),
  }).default({ ...DEFAULT_REVIEW_POLICY }),
}) as unknown as z<TeamSettings>

/** Validate and trim the compound setting as one value before Team bootstrap. */
export function normalizeTeamReviewPolicy(settings: Pick<TeamSettings, 'reviewPolicy'> | { readonly reviewPolicy?: Partial<ReviewPolicy> }): ReviewPolicy {
  return normalizeReviewPolicy(settings.reviewPolicy)
}

/** Validate values at the last Host-owned boundary before they affect scheduling. */
export function assertTeamConcurrency(value: number): void {
  if (!Number.isInteger(value) || value < MIN_TEAM_CONCURRENCY || value > MAX_TEAM_CONCURRENCY) {
    throw new RangeError(`maxConcurrency must be an integer from ${MIN_TEAM_CONCURRENCY} to ${MAX_TEAM_CONCURRENCY}`)
  }
}

/** Prevent recursive Team composition and malformed persisted preset ids. */
export function assertChildPresetId(value: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(value) || value === 'yuqi-team') {
    throw new RangeError('childPresetId must name a non-Yuqi Harness Agent preset')
  }
}

/**
 * Convert legacy scalar model settings into the structured routing contract.
 * The controller Provider supplies the Provider identity that old model ids did not store.
 */
export function normalizeTeamModelRouting(
  settings: Pick<TeamSettings,
    | 'childModelId'
    | 'childModelPolicy'
    | 'quickModelId'
    | 'standardModelId'
    | 'criticalModelId'
    | 'modelRouting'>,
  controllerModel: ProviderModelRef,
): ModelRoutingPolicy {
  const controller = providerModelRefSchema.parse(controllerModel)
  if (settings.modelRouting !== undefined) {
    return freezeRoutingPolicy({
      providerScope: providerScopeSchema.parse(settings.modelRouting.providerScope),
      teamPolicy: teamModelPolicySchema.parse(settings.modelRouting.teamPolicy),
    })
  }

  const teamPolicy = normalizeLegacyTeamModelPolicy(settings, controller)
  return freezeRoutingPolicy({ providerScope: { kind: 'controller-only' }, teamPolicy })
}

function normalizeLegacyTeamModelPolicy(
  settings: Pick<TeamSettings,
    'childModelId' | 'childModelPolicy' | 'quickModelId' | 'standardModelId' | 'criticalModelId'>,
  controller: ProviderModelRef,
): TeamModelPolicy {
  if (settings.childModelPolicy === 'fixed') {
    const modelId = settings.childModelId.trim()
    return modelId === ''
      ? { kind: 'inherit' }
      : { kind: 'fixed', model: { modelProvider: controller.modelProvider, modelId } }
  }
  if (settings.childModelPolicy === 'automatic') {
    return {
      kind: 'automatic',
      tierCandidates: {
        quick: legacyCandidate(settings.quickModelId, controller),
        standard: legacyCandidate(settings.standardModelId, controller),
        critical: legacyCandidate(settings.criticalModelId, controller),
      },
    }
  }
  return { kind: 'inherit' }
}

function legacyCandidate(modelId: string, controller: ProviderModelRef): readonly ProviderModelRef[] {
  const normalized = modelId.trim()
  return normalized === ''
    ? Object.freeze([])
    : Object.freeze([{ modelProvider: controller.modelProvider, modelId: normalized }])
}

function freezeRoutingPolicy(policy: ModelRoutingPolicy): ModelRoutingPolicy {
  const providerScope = policy.providerScope.kind === 'controller-only'
    ? Object.freeze({ kind: 'controller-only' as const })
    : Object.freeze({
      kind: 'controller-plus-allowlist' as const,
      providerAllowlist: Object.freeze([...policy.providerScope.providerAllowlist]),
    })
  const teamPolicy = policy.teamPolicy.kind === 'inherit'
    ? Object.freeze({ kind: 'inherit' as const })
    : policy.teamPolicy.kind === 'fixed'
      ? Object.freeze({ kind: 'fixed' as const, model: Object.freeze({ ...policy.teamPolicy.model }) })
      : Object.freeze({
        kind: 'automatic' as const,
        tierCandidates: Object.freeze({
          quick: freezeModels(policy.teamPolicy.tierCandidates.quick),
          standard: freezeModels(policy.teamPolicy.tierCandidates.standard),
          critical: freezeModels(policy.teamPolicy.tierCandidates.critical),
        }),
      })
  return Object.freeze({ providerScope, teamPolicy })
}

function freezeModels(models: readonly ProviderModelRef[]): readonly ProviderModelRef[] {
  return Object.freeze(models.map(model => Object.freeze({ ...model })))
}
