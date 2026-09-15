import { describe, expect, it, vi } from 'vitest'
import { HarnessModelCatalogPort } from '../src/host/harness/model-catalog.ts'

describe('Harness model catalog metadata adapter', () => {
  it('reports only metadata/routability and re-inspects on a later attempt', async () => {
    const resolveModelInfo = vi.fn()
      .mockResolvedValueOnce({ provider: 'external', id: 'model-a', name: 'Model A' })
      .mockRejectedValueOnce(new Error('metadata missing'))
      .mockResolvedValueOnce({ provider: 'external', id: 'model-b', name: 'Model B' })
    const catalog = new HarnessModelCatalogPort({ llm: { resolveModelInfo } } as never)

    await expect(catalog.inspectRoutes([
      { modelProvider: 'external', modelId: 'model-a' },
      { modelProvider: 'external', modelId: 'model-b' },
    ])).resolves.toEqual([
      { model: { modelProvider: 'external', modelId: 'model-a' }, metadataResolved: true, routable: true },
      { model: { modelProvider: 'external', modelId: 'model-b' }, metadataResolved: false, routable: false },
    ])
    await expect(catalog.inspectRoutes([{ modelProvider: 'external', modelId: 'model-b' }])).resolves.toEqual([
      { model: { modelProvider: 'external', modelId: 'model-b' }, metadataResolved: true, routable: true },
    ])
    expect(resolveModelInfo).toHaveBeenCalledTimes(3)
  })

  it('inspects automatic evidence from every currently allowed Provider', async () => {
    const listModels = vi.fn()
      .mockRejectedValueOnce(new Error('controller catalog unavailable'))
      .mockResolvedValueOnce([
        { provider: 'external', id: 'external-a', name: 'External A' },
        { provider: 'external', id: 'configured', name: 'Configured duplicate' },
      ])
    const resolveModelInfo = vi.fn(async (provider: string, id: string) => {
      if (id === 'configured' || id === 'controller-main') throw new Error('unresolvable candidate')
      return { provider, id, name: id }
    })
    const catalog = new HarnessModelCatalogPort({ llm: { listModels, resolveModelInfo } } as never)

    await expect(catalog.inspectAutomaticRoutes({
      configuredCandidates: [{ modelProvider: 'external', modelId: 'configured' }],
      controllerModel: { modelProvider: 'controller', modelId: 'controller-main' },
      providerScope: { kind: 'controller-plus-allowlist', providerAllowlist: ['external'] },
    })).resolves.toEqual([
      { model: { modelProvider: 'external', modelId: 'configured' }, metadataResolved: false, routable: false },
      { model: { modelProvider: 'controller', modelId: 'controller-main' }, metadataResolved: false, routable: false },
      { model: { modelProvider: 'external', modelId: 'external-a' }, metadataResolved: true, routable: true },
    ])
    expect(listModels).toHaveBeenNthCalledWith(1, 'controller')
    expect(listModels).toHaveBeenNthCalledWith(2, 'external')
    expect(listModels).toHaveBeenCalledTimes(2)
    expect(resolveModelInfo).toHaveBeenCalledTimes(3)
  })

  it('does not enumerate or resolve Providers outside the allowlist', async () => {
    const listModels = vi.fn().mockResolvedValue([])
    const resolveModelInfo = vi.fn(async (provider: string, id: string) => ({ provider, id, name: id }))
    const catalog = new HarnessModelCatalogPort({ llm: { listModels, resolveModelInfo } } as never)

    await catalog.inspectAutomaticRoutes({
      configuredCandidates: [{ modelProvider: 'blocked', modelId: 'blocked-model' }],
      controllerModel: { modelProvider: 'controller', modelId: 'controller-main' },
      providerScope: { kind: 'controller-only' },
    })

    expect(listModels).toHaveBeenCalledTimes(1)
    expect(listModels).toHaveBeenCalledWith('controller')
    expect(resolveModelInfo).not.toHaveBeenCalledWith('blocked', 'blocked-model', undefined)
  })
})
