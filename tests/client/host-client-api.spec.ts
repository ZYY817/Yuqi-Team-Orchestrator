import { describe, expect, it, vi } from 'vitest'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { hostClientApi } from '../../src/client/host-client-api.ts'

function fixture() {
  const workspace = { phase: 'ready', state: 'idle', items: [{ workspaceId: 'w', path: 'F:/test', sessionIds: ['s'] }], archivedSessionIds: [] }
  const remote = {
    agentPresets: { list: vi.fn(async () => ({ ok: true, value: { presets: [] } })) },
    session: {
      create: vi.fn(async (request: unknown) => ({ ok: true, value: request })),
      prompt: vi.fn(async () => ({ ok: true, value: {} })),
      modelCatalog: vi.fn(async () => ({ ok: true, value: { default: { provider: 'p', model: 'default' }, routableProviders: ['p'], groups: [], failures: [] } })),
      follow: vi.fn(async function* () { yield { type: 'snapshot', cursor: 12, records: [{ type: 'event', event: { seq: 12 } }], hasMore: true } }),
      page: vi.fn(async () => ({ ok: true, value: { records: [], hasMore: false } })),
    },
  }
  const ctx = { get: () => ({}), 'remote.session': remote.session, 'remote.agentPresets': remote.agentPresets,
    workspaces: { list: { getSnapshot: () => workspace } },
    sessions: { list: { getSnapshot: () => ({ byId: { s: { projectionValues: { modelSelection: { next: { provider: 'p', model: 'chosen' } } } } } }) } },
  } as unknown as ClientContext
  return { api: hostClientApi(ctx), workspace, remote }
}

describe('official Client Remote boundary', () => {
  it('uses the synchronized workspace registry and refuses pending state', async () => {
    const { api, workspace } = fixture()
    expect((await api.workspace.list({})).result).toMatchObject({ ok: true, value: { items: workspace.items } })
    workspace.state = 'loading'
    await expect(api.workspace.list({})).rejects.toThrow('not ready')
  })
  it('forwards create/prompt once and does not swallow a rejected result', async () => {
    const { api, remote } = fixture()
    const request = { sessionId: 's' as SessionId, cwd: 'F:/test', agentPreset: 'yuqi-team' }
    await api.sessions.create(request)
    expect(remote.session.create).toHaveBeenCalledExactlyOnceWith(request)
    remote.session.prompt.mockResolvedValueOnce({ ok: false, error: { code: 'denied', message: 'no' } } as never)
    const prompt = { sessionId: 's' as SessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: 'test' }] }
    expect((await api.sessions.prompt(prompt)).result).toMatchObject({ ok: false, error: { code: 'denied' } })
    expect(remote.session.prompt).toHaveBeenCalledExactlyOnceWith({ ...prompt, requestId: expect.any(String) })
  })
  it('reads current model from the Session projection, not the global default', async () => {
    const { api } = fixture()
    expect((await api.sessions.models({ sessionId: 's' as SessionId })).result).toMatchObject({ ok: true, value: { current: { model: 'chosen' }, routable: true } })
  })
  it('preserves the continuation request identity at the modern prompt boundary', async () => {
    const { api, remote } = fixture()
    await api.sessions.prompt({ sessionId: 's' as SessionId, mode: 'queue', requestId: 'stable-continuation', content: [{ type: 'text', text: 'new requirement' }] })
    expect(remote.session.prompt).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'stable-continuation', sessionId: 's' }))
  })
  it('uses the official opening cursor for older evidence and closes its read signal', async () => {
    const { api, remote } = fixture()
    await api.sessions.history({ sessionId: 's' as SessionId, beforeSeq: 8, maxMessages: 5 })
    expect(remote.session.page).toHaveBeenCalledWith({ address: { kind: 'session', sessionId: 's' }, throughSeq: 12, beforeSeq: 8, maxMessages: 5 }, expect.any(AbortSignal))
    expect((remote.session.follow.mock.calls as unknown as [unknown, AbortSignal][])[0]![1].aborted).toBe(true)
  })
})
