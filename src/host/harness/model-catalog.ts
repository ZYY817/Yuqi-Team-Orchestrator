/** Harness public LLM-directory adapter for exact fixed-model resolution. */

import type { Context } from '@deepseek-ai/cordis'
import { automaticModelCandidates } from '../../application/model-routing.ts'
import type { ModelCatalogEntry, ModelCatalogPort } from '../../application/workspace-ports.ts'
import type { ModelCatalogFact, ProviderModelRef, ProviderScope } from '../../domain/model-route.ts'

export interface InspectAutomaticRoutesInput {
  readonly configuredCandidates: readonly ProviderModelRef[]
  readonly controllerModel: ProviderModelRef
  readonly providerScope: ProviderScope
}

export class HarnessModelCatalogPort implements ModelCatalogPort {
  readonly #ctx: Context

  constructor(ctx: Context) {
    this.#ctx = ctx
  }

  async listModels(modelProvider: string, signal?: AbortSignal): Promise<readonly ModelCatalogEntry[]> {
    signal?.throwIfAborted()
    const models = await this.#ctx.llm.listModels(modelProvider)
    signal?.throwIfAborted()
    return Object.freeze(models.map(model => Object.freeze({
      modelProvider: model.provider,
      modelId: model.id,
      available: true,
      displayName: model.name,
    })))
  }

  async resolveModel(modelProvider: string, modelId: string, signal?: AbortSignal): Promise<ModelCatalogEntry> {
    const resolved = await this.#ctx.llm.resolveModelInfo(modelProvider, modelId, signal)
    return Object.freeze({
      modelProvider: resolved.provider,
      modelId: resolved.id,
      available: true,
      displayName: resolved.name,
    })
  }

  /**
   * Enumerate automatic candidates from public Provider catalogs, then resolve
   * each exact route as metadata evidence. One Provider catalog or exact-route
   * failure is local to that source/candidate and never widens Provider scope.
   */
  async inspectAutomaticRoutes(
    input: InspectAutomaticRoutesInput,
    signal?: AbortSignal,
  ): Promise<readonly ModelCatalogFact[]> {
    // Automatic routing may inspect every Provider explicitly allowed by the
    // Team policy. Provider order is stable so catalog enumeration remains
    // deterministic, while a failed source stays local to that Provider.
    const providers = [...new Set([
      input.controllerModel.modelProvider,
      ...(input.providerScope.kind === 'controller-plus-allowlist' ? input.providerScope.providerAllowlist : []),
    ])]
    const catalogRoutes: ProviderModelRef[] = []
    for (const modelProvider of providers) {
      signal?.throwIfAborted()
      try {
        const models = await this.listModels(modelProvider, signal)
        catalogRoutes.push(...models
          .filter(model => model.available)
          .map(model => ({ modelProvider: model.modelProvider, modelId: model.modelId })))
      } catch (cause) {
        signal?.throwIfAborted()
      }
    }
    const routes = automaticModelCandidates({
      ...input,
      catalog: catalogRoutes.map(model => ({ model, metadataResolved: true, routable: true })),
    })
    return this.inspectRoutes(routes, signal)
  }

  /**
   * Inspect route metadata only. A positive fact means the Host directory can
   * name the route; it deliberately says nothing about live credentials.
   */
  async inspectRoutes(routes: readonly ProviderModelRef[], signal?: AbortSignal): Promise<readonly ModelCatalogFact[]> {
    const unique = [...new Map(routes.map(route => [`${route.modelProvider}\u0000${route.modelId}`, route])).values()]
    const facts = await Promise.all(unique.map(async route => {
      signal?.throwIfAborted()
      try {
        const resolved = await this.#ctx.llm.resolveModelInfo(route.modelProvider, route.modelId, signal)
        const matches = resolved.provider === route.modelProvider && resolved.id === route.modelId
        return Object.freeze({ model: Object.freeze({ ...route }), metadataResolved: matches, routable: matches })
      } catch (cause) {
        signal?.throwIfAborted()
        return Object.freeze({ model: Object.freeze({ ...route }), metadataResolved: false, routable: false })
      }
    }))
    return Object.freeze(facts)
  }
}
