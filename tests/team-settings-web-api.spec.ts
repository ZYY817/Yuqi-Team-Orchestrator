import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { installTeamSettingsWebApi } from '../src/host/harness/team-settings-web-api.ts'

describe('Team settings Web API bridge', () => {
  it('exposes only the Yuqi namespace and preserves official settings methods', async () => {
    const official = {
      describe: vi.fn(async (request: { rpcId: string; payload: object }) => ({
        rpcId: request.rpcId,
        result: { ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } },
      })),
      openDocument: vi.fn(),
      update: vi.fn(async (request: { rpcId: string; payload: object }) => ({ rpcId: request.rpcId, result: { ok: false as const, error: { code: 'official', message: 'official', details: {} } } })),
      replace: vi.fn(),
      mutate: vi.fn(),
    }
    const apiProxy = { settings: official }
    const settings = {
      describe: vi.fn(() => [{
        ns: 'yuqi-team-orchestrator', schema: { type: 'object' }, value: { maxConcurrency: 7 },
        base: { maxConcurrency: 100 }, applies: 'live' as const, secrets: [], revision: 2,
      }]),
      update: vi.fn(async () => undefined),
      replace: vi.fn(async () => undefined),
      mutate: vi.fn(async () => undefined),
    }
    let cleanup: (() => void) | undefined
    const ctx = {
      get: (name: string) => name === 'apiProxy' ? apiProxy : undefined,
      settings,
      effect: (factory: () => () => void) => { cleanup = factory() },
    } as unknown as Context

    installTeamSettingsWebApi(ctx)

    const described = await apiProxy.settings.describe({ rpcId: 'describe', payload: {} })
    expect(described.result).toMatchObject({ ok: true, value: { namespaces: [{ ns: 'yuqi-team-orchestrator', revision: 2 }] } })
    const updated = await apiProxy.settings.update({
      rpcId: 'update', payload: { ns: 'yuqi-team-orchestrator', patch: { maxConcurrency: 8 }, expectedRevision: 2 },
    })
    expect(updated.result).toMatchObject({ ok: true, value: { ns: 'yuqi-team-orchestrator' } })
    expect(settings.update).toHaveBeenCalledWith('yuqi-team-orchestrator', { maxConcurrency: 8 }, 2)

    await apiProxy.settings.update({ rpcId: 'other', payload: { ns: 'ui-theme', patch: {} } })
    expect(official.update).toHaveBeenCalledOnce()

    cleanup?.()
    expect(apiProxy.settings).toBe(official)
  })

  it('does nothing when the Host has no API proxy', () => {
    const ctx = { get: () => undefined } as unknown as Context
    expect(() => installTeamSettingsWebApi(ctx)).not.toThrow()
  })

  it('preserves official responses and delegates non-Yuqi writes', async () => {
    const officialView = { ns: 'yuqi-team-orchestrator', schema: {}, value: {}, applies: 'live' as const, secrets: [], revision: 1 }
    const official = {
      describe: vi.fn(async (request: { rpcId: string; payload: object }) => ({ rpcId: request.rpcId, result: { ok: true as const, value: { writable: true, hasDocument: true, namespaces: [officialView] } } })),
      openDocument: vi.fn(),
      update: vi.fn(async (request: { rpcId: string; payload: object }) => ({ rpcId: request.rpcId, result: { ok: true as const, value: officialView } })),
      replace: vi.fn(async (request: { rpcId: string; payload: object }) => ({ rpcId: request.rpcId, result: { ok: true as const, value: officialView } })),
      mutate: vi.fn(async (request: { rpcId: string; payload: object }) => ({ rpcId: request.rpcId, result: { ok: true as const, value: officialView } })),
    }
    const apiProxy = { settings: official }
    const settings = { describe: vi.fn(() => []), update: vi.fn(), replace: vi.fn(), mutate: vi.fn() }
    let cleanup: (() => void) | undefined
    const ctx = {
      get: () => apiProxy, settings,
      effect: (factory: () => () => void) => { cleanup = factory() },
    } as unknown as Context
    installTeamSettingsWebApi(ctx)
    expect((await apiProxy.settings.describe({ rpcId: 'd', payload: {} })).result).toMatchObject({ ok: true })
    await apiProxy.settings.update({ rpcId: 'u', payload: { ns: 'other', patch: {} } })
    await apiProxy.settings.replace({ rpcId: 'r', payload: { ns: 'other', section: {} } })
    await apiProxy.settings.mutate({ rpcId: 'm', payload: { ns: 'other', ops: [] } })
    expect(official.update).toHaveBeenCalledOnce()
    expect(official.replace).toHaveBeenCalledOnce()
    expect(official.mutate).toHaveBeenCalledOnce()
    apiProxy.settings = official
    cleanup?.()
    expect(apiProxy.settings).toBe(official)
  })

  it('bridges replace and mutate and returns structured write failures', async () => {
    const official = {
      describe: vi.fn(async (request: { rpcId: string; payload: object }) => ({ rpcId: request.rpcId, result: { ok: false as const, error: { code: 'offline', message: 'offline', details: {} } } })),
      openDocument: vi.fn(), update: vi.fn(), replace: vi.fn(), mutate: vi.fn(),
    }
    const apiProxy = { settings: official }
    let revision = 2
    const conflict = Object.assign(new Error('stale revision'), { code: 'SETTINGS_CONFLICT', expected: 1, actual: 2 })
    const settings = {
      describe: vi.fn(() => [{
        ns: 'yuqi-team-orchestrator', schema: {}, value: { maxConcurrency: 7 }, user: { maxConcurrency: 7 },
        applies: 'live' as const, secrets: [{ path: ['token'], set: true }], revision,
      }]),
      update: vi.fn(async () => { throw conflict }),
      replace: vi.fn(async () => { revision += 1 }),
      mutate: vi.fn(async () => { throw 'mutation rejected' }),
    }
    const ctx = { get: () => apiProxy, settings, effect: () => undefined } as unknown as Context
    installTeamSettingsWebApi(ctx)
    expect((await apiProxy.settings.describe({ rpcId: 'd', payload: {} })).result).toMatchObject({ ok: false })
    expect((await apiProxy.settings.update({ rpcId: 'u', payload: { ns: 'yuqi-team-orchestrator', patch: {}, expectedRevision: 1 } })).result)
      .toMatchObject({ ok: false, error: { code: 'settings-conflict', details: { expected: 1, actual: 2 } } })
    expect((await apiProxy.settings.replace({ rpcId: 'r', payload: { ns: 'yuqi-team-orchestrator', section: {}, expectedRevision: 2 } })).result)
      .toMatchObject({ ok: true, value: { revision: 3, user: { maxConcurrency: 7 } } })
    expect((await apiProxy.settings.mutate({ rpcId: 'm', payload: { ns: 'yuqi-team-orchestrator', ops: [] } })).result)
      .toMatchObject({ ok: false, error: { code: 'settings-rejected', message: 'mutation rejected' } })
  })
})
