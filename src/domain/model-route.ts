/** Host-neutral contracts for deterministic, experimental model routing. */

import { z } from 'zod'

const nonEmpty = z.string().trim().min(1)
const uniqueNonEmpty = z.array(nonEmpty).superRefine((items, context) => {
  if (new Set(items).size !== items.length) {
    context.addIssue({ code: 'custom', message: 'provider allowlist entries must be unique' })
  }
})

/** A model identity. It deliberately contains neither credentials nor an execution adapter. */
export const providerModelRefSchema = z.object({
  modelProvider: nonEmpty,
  modelId: nonEmpty,
}).strict()

export const providerScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('controller-only') }).strict(),
  z.object({
    kind: z.literal('controller-plus-allowlist'),
    providerAllowlist: uniqueNonEmpty,
  }).strict(),
])

export const modelRouteTaskTiers = ['quick', 'standard', 'critical'] as const

const tierCandidatesSchema = z.object({
  quick: z.array(providerModelRefSchema).default([]),
  standard: z.array(providerModelRefSchema).default([]),
  critical: z.array(providerModelRefSchema).default([]),
}).strict()

/** Team-wide policy. Automatic candidates are ordered user configuration, not a score. */
export const teamModelPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inherit') }).strict(),
  z.object({ kind: z.literal('fixed'), model: providerModelRefSchema }).strict(),
  z.object({ kind: z.literal('automatic'), tierCandidates: tierCandidatesSchema }).strict(),
])

/** Per-task intent, including the provider-less model id used by legacy task contracts. */
export const taskModelRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exact'), model: providerModelRefSchema }).strict(),
  z.object({ kind: z.literal('tier'), tier: z.enum(modelRouteTaskTiers) }).strict(),
  z.object({ kind: z.literal('default') }).strict(),
  z.object({ kind: z.literal('legacy'), modelId: nonEmpty }).strict(),
])

/**
 * Public catalog fact. `routable` means the Host can name a route; it is not a
 * claim that credentials are present, valid, or authorized for a live call.
 */
export const modelCatalogFactSchema = z.object({
  model: providerModelRefSchema,
  metadataResolved: z.boolean(),
  routable: z.boolean(),
}).strict()

export interface ProviderModelRef {
  readonly modelProvider: string
  readonly modelId: string
}
export type ProviderScope =
  | { readonly kind: 'controller-only' }
  | { readonly kind: 'controller-plus-allowlist'; readonly providerAllowlist: readonly string[] }
export type ModelRouteTaskTier = (typeof modelRouteTaskTiers)[number]
export type TeamModelPolicy =
  | { readonly kind: 'inherit' }
  | { readonly kind: 'fixed'; readonly model: ProviderModelRef }
  | {
    readonly kind: 'automatic'
    readonly tierCandidates: Readonly<Record<ModelRouteTaskTier, readonly ProviderModelRef[]>>
  }
export type TaskModelRequest =
  | { readonly kind: 'exact'; readonly model: ProviderModelRef }
  | { readonly kind: 'tier'; readonly tier: ModelRouteTaskTier }
  | { readonly kind: 'default' }
  | { readonly kind: 'legacy'; readonly modelId: string }
export interface ModelCatalogFact {
  readonly model: ProviderModelRef
  readonly metadataResolved: boolean
  readonly routable: boolean
}

export interface ModelRoutingPolicy {
  readonly providerScope: ProviderScope
  readonly teamPolicy: TeamModelPolicy
}
