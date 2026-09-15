import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { HarnessContinuableChildPort } from '../src/host/harness/continuable-child.ts'
import type { GitWorkspacePort } from '../src/application/workspace-ports.ts'

function fixture() {
  const parent = { id: SessionId('parent') } as Agent
  const child = { id: SessionId('child'), session: { header: { parentSession: parent.id } }, cancel: vi.fn() }
  const registry = new Map<string, unknown>([['parent', parent], ['child', child]])
  const subagents = { interrupt: vi.fn(), drainContinuableDescendants: vi.fn().mockResolvedValue(undefined) }
  const ctx = { agents: { get: (id: string) => registry.get(id) }, subagents } as unknown as Context
  const port = new HarnessContinuableChildPort(ctx, parent, {} as GitWorkspacePort,
    id => registry.get(id) as Agent | undefined)
  return { parent, child, registry, subagents, port, ctx }
}

describe('exact-child cancellation', () => {
  it('uses the injected registry capability without reading agents from the base Cordis scope', async () => {
    const f = fixture()
    Object.defineProperty(f.ctx, 'agents', { get() { throw new Error('cannot get property "agents" without inject') } })
    await expect(f.port.cancel('child')).resolves.toBeUndefined()
    expect(f.child.cancel).toHaveBeenCalledWith({ kind: 'parent' })
  })
  it('fails explicitly if the injected registry capability has been released', async () => {
    const f = fixture()
    f.registry.clear()
    await expect(f.port.cancel('child')).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    expect(f.child.cancel).not.toHaveBeenCalled()
  })
  it('keeps ordinary interrupt separate from queue cancellation', () => {
    const f = fixture()
    f.port.interrupt('child')
    expect(f.subagents.interrupt).toHaveBeenCalledWith('child', { kind: 'ancestor', agent: f.parent })
    expect(f.child.cancel).not.toHaveBeenCalled()
  })
  it('on the older Host cancels only the authorized child inbox and descendants', async () => {
    const f = fixture()
    await f.port.cancel('child')
    expect(f.child.cancel).toHaveBeenCalledWith({ kind: 'parent' })
    expect(f.subagents.drainContinuableDescendants).toHaveBeenCalledWith([f.child])
    expect(f.subagents.drainContinuableDescendants.mock.invocationCallOrder[0])
      .toBeLessThan(f.child.cancel.mock.invocationCallOrder[0]!)
  })
  it('uses the newer selected-child native lifecycle when available', async () => {
    const f = fixture()
    const drain = vi.fn().mockResolvedValue(undefined)
    Object.assign(f.subagents, { drainContinuableChildren: drain })
    await f.port.cancel('child')
    expect(drain).toHaveBeenCalledWith(f.parent, ['child'])
    expect(f.child.cancel).not.toHaveBeenCalled()
    expect(f.subagents.drainContinuableDescendants).not.toHaveBeenCalled()
  })
  it('never clears another parent child or uses a stale controller', async () => {
    const f = fixture()
    f.child.session.header.parentSession = SessionId('other')
    await expect(f.port.cancel('child')).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
    expect(f.child.cancel).not.toHaveBeenCalled()
    f.registry.set('parent', { id: f.parent.id })
    await expect(f.port.cancel('child')).rejects.toMatchObject({ code: 'CONTROL_RUNTIME_UNCERTAIN' })
  })
  it('preserves native authorization and drain failures', async () => {
    const f = fixture()
    f.subagents.interrupt.mockImplementationOnce(() => { throw new Error('unauthorized') })
    await expect(f.port.cancel('child')).rejects.toThrow('unauthorized')
    expect(f.child.cancel).not.toHaveBeenCalled()
    f.subagents.drainContinuableDescendants.mockRejectedValueOnce(new Error('drain failed'))
    await expect(f.port.cancel('child')).rejects.toThrow('drain failed')
  })
  it('does not invent a terminal event when the child already left the registry', async () => {
    const f = fixture()
    f.registry.delete('child')
    await expect(f.port.cancel('child')).resolves.toBeUndefined()
    expect(f.child.cancel).not.toHaveBeenCalled()
  })
})
