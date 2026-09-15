// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { createTeamHandoffAdapter, openHandoffTarget } from '../../src/client/team-handoff-adapter.ts'

afterEach(() => { vi.useRealTimers(); localStorage.clear() })

function fixture() {
  const rows: Record<string, { cwd: string; running: boolean; agentPreset: string }> = {
    source: { cwd: 'F:\\test-project', running: false, agentPreset: 'standard' },
  }
  const listeners = new Set<() => void>()
  const open = vi.fn()
  const workspaces = [{ workspaceId: 'owner', path: 'F:\\test-project', sessionIds: ['source'] }]
  const list = vi.fn(async () => ({ result: { ok: true, value: { items: workspaces, archivedSessionIds: [] } } }))
  const create = vi.fn(async (_request: unknown) => {
    rows.target = { cwd: 'F:\\test-project', running: false, agentPreset: 'yuqi-team' }
    const workspaceId = (_request as { workspaceId?: string }).workspaceId
    workspaces.find(workspace => workspace.workspaceId === workspaceId)?.sessionIds.unshift('target')
    return { result: { ok: true, value: { sessionId: 'target', agentPreset: 'yuqi-team' } } }
  })
  const prompt = vi.fn(async (_request: unknown) => ({ result: { ok: true, value: { accepted: true } } }))
  const ctx = { sessions: { list: { getSnapshot: () => ({ byId: rows }), subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener) }
  } }, open } } as unknown as ClientContext
  const api = { sessions: { create, prompt }, workspace: { list } } as unknown as ConnectionHandle['api']
  return { ctx, api, create, prompt, open, rows, listeners, workspaces, list, handoff: createTeamHandoffAdapter(ctx, api) }
}
const request = { sourceSessionId: 'source', targetSessionId: 'target', context: { goal: 'Write one paragraph', summary: 'No other files' } }

describe('real public-API handoff adapter', () => {
  it('creates the requested Team identity in the same cwd and forwards only confirmed text', async () => {
    const f = fixture()
    expect(await f.handoff(request)).toMatchObject({ kind: 'opened', sessionId: 'target' })
    expect(f.list).toHaveBeenCalledWith({})
    expect(f.create).toHaveBeenCalledWith({ sessionId: 'target', workspaceId: 'owner', agentPreset: 'yuqi-team' })
    expect(f.workspaces[0]?.sessionIds).toEqual(['target', 'source'])
    expect(f.prompt).toHaveBeenCalledOnce()
    expect(f.prompt.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'target', mode: 'queue', content: [
      { type: 'text', text: expect.stringContaining('Write one paragraph') },
    ] })
    expect(f.rows.source?.agentPreset).toBe('standard')
    expect(f.open).toHaveBeenCalledWith('target')
  })
  it('inherits membership rather than matching cwd, display order, or a recent workspace', async () => {
    const f = fixture()
    f.workspaces.unshift({ workspaceId: 'other', path: 'F:\\test-project', sessionIds: ['other-session'] })
    expect(await f.handoff(request)).toMatchObject({ kind: 'opened' })
    expect(f.create).toHaveBeenCalledWith({ sessionId: 'target', workspaceId: 'owner', agentPreset: 'yuqi-team' })
    expect(f.workspaces[0]?.sessionIds).toEqual(['other-session'])
  })
  it.each([
    ['F:/test-project', 'F:\\test-project'],
    ['f:\\test-project\\', 'F:/test-project'],
    ['F:\\test-project', 'f:/test-project/'],
    ['f:\\', 'F:/'],
  ])('accepts equivalent Windows directory spelling %s and %s', async (cwd, root) => {
    const f = fixture()
    f.rows.source!.cwd = cwd
    f.workspaces[0]!.path = root
    expect(await f.handoff(request)).toMatchObject({ kind: 'opened' })
    expect(f.create).toHaveBeenCalledExactlyOnceWith({ sessionId: 'target', workspaceId: 'owner', agentPreset: 'yuqi-team' })
    expect(f.prompt).toHaveBeenCalledOnce()
    expect(f.rows.source!.cwd).toBe(cwd)
    expect(f.workspaces[0]?.sessionIds).toEqual(['target', 'source'])
  })
  it.each(['F:\\test-project\\website', 'F:\\alias-project', 'F:/TEST-project', 'F:/test-project/website/..', 'F:/test-project/.', 'F:test-project'])('rejects unverified cwd mismatch %s without changing directory or losing ownership', async cwd => {
    const f = fixture()
    f.rows.source!.cwd = cwd
    expect(await f.handoff(request)).toMatchObject({ kind: 'rejected', retryable: true,
      message: expect.stringContaining('未创建团队会话') })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.prompt).not.toHaveBeenCalled()
    expect(f.open).not.toHaveBeenCalled()
    expect(f.rows.source!.cwd).toBe(cwd)
    expect(f.workspaces[0]?.sessionIds).toEqual(['source'])
  })
  it('preserves a genuinely ungrouped source without guessing ownership from cwd', async () => {
    const f = fixture()
    f.workspaces[0]!.sessionIds = []
    expect(await f.handoff(request)).toMatchObject({ kind: 'opened' })
    expect(f.create).toHaveBeenCalledWith({ sessionId: 'target', cwd: 'F:\\test-project', agentPreset: 'yuqi-team' })
  })
  it('does not create or prompt when ownership lookup fails or conflicts', async () => {
    const f = fixture()
    f.list.mockRejectedValueOnce(new Error('disconnected'))
    expect(await f.handoff(request)).toMatchObject({ kind: 'rejected', retryable: true })
    f.list.mockResolvedValueOnce({ result: { ok: false, error: { message: 'registry unavailable' } } } as never)
    expect(await f.handoff(request)).toMatchObject({ kind: 'rejected', retryable: true })
    f.workspaces.push({ workspaceId: 'conflict', path: 'F:\\other', sessionIds: ['source'] })
    expect(await f.handoff(request)).toMatchObject({ kind: 'rejected' })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.prompt).not.toHaveBeenCalled()
  })
  it('rechecks source after the asynchronous ownership query', async () => {
    const f = fixture()
    f.list.mockImplementationOnce(async () => {
      f.rows.source!.running = true
      return { result: { ok: true, value: { items: f.workspaces, archivedSessionIds: [] } } }
    })
    expect(await f.handoff(request)).toMatchObject({ kind: 'rejected' })
    expect(f.create).not.toHaveBeenCalled()
  })
  it('never falls back to cwd or prompts after workspace attachment failure', async () => {
    const f = fixture()
    f.create.mockResolvedValueOnce({ result: { ok: false, error: { code: 'workspace-attach-failed', message: 'attach failed' } } } as never)
    expect(await f.handoff(request)).toMatchObject({ kind: 'unknown', sessionId: 'target', retryable: false })
    expect(f.create).toHaveBeenCalledExactlyOnceWith({ sessionId: 'target', workspaceId: 'owner', agentPreset: 'yuqi-team' })
    expect(f.prompt).not.toHaveBeenCalled()
  })
  it('rechecks source eligibility immediately before any mutation', async () => {
    const f = fixture()
    f.rows.source!.running = true
    expect(await f.handoff(request)).toMatchObject({ kind: 'rejected' })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.prompt).not.toHaveBeenCalled()
  })
  it('does not prompt after ambiguous create failure or an unconfirmed preset', async () => {
    const f = fixture()
    f.create.mockResolvedValueOnce({ result: { ok: false, error: { code: 'workspace-attach-failed', message: 'Already created; attach failed' } } } as never)
    expect(await f.handoff(request)).toMatchObject({ kind: 'unknown' })
    f.create.mockResolvedValueOnce({ result: { ok: true, value: { sessionId: 'target', agentPreset: 'standard' } } })
    expect(await f.handoff(request)).toMatchObject({ kind: 'unknown' })
    expect(f.prompt).not.toHaveBeenCalled()
  })
  it('opens the existing target after an uncertain prompt, without an automatic resend', async () => {
    const f = fixture()
    f.prompt.mockRejectedValueOnce(new Error('connection lost'))
    expect(await f.handoff(request)).toMatchObject({ kind: 'unknown', sessionId: 'target' })
    expect(f.prompt).toHaveBeenCalledOnce()
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.open).toHaveBeenCalledWith('target')
  })
  it('reports a created conversation when prompt admission is rejected', async () => {
    const f = fixture()
    f.prompt.mockResolvedValueOnce({ result: { ok: false, error: { message: 'model unavailable' } } } as never)
    expect(await f.handoff(request)).toMatchObject({ kind: 'created', message: 'model unavailable' })
    expect(f.open).toHaveBeenCalledWith('target')
  })
  it('waits for list publication, unsubscribes, and never invents a session on timeout', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const pending = openHandoffTarget(f.ctx, 'later')
    expect(f.open).not.toHaveBeenCalled()
    f.rows.later = { cwd: 'F:\\test-project', running: false, agentPreset: 'yuqi-team' }
    for (const listener of f.listeners) listener()
    expect(await pending).toBe(true)
    expect(f.listeners.size).toBe(0)
    const timeout = openHandoffTarget(f.ctx, 'missing')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await timeout).toBe(false)
    expect(f.listeners.size).toBe(0)
    expect(f.open).toHaveBeenCalledTimes(1)
  })
})
