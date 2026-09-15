import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type { GitWorkspacePort } from '../src/application/workspace-ports.ts'
import { CHILD_EXECUTION_TIMEOUT_MS, HarnessContinuableChildPort } from '../src/host/harness/continuable-child.ts'

function fixture() {
  const listeners = new Set<(info: SubagentRunEndInfo) => void>()
  const controller = {
    id: SessionId('controller'), session: { header: {} },
    ctx: { on(_name: string, listener: (info: SubagentRunEndInfo) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    } },
  } as unknown as Agent
  const child = { session: { header: { parentSession: controller.id } }, cancel: vi.fn() } as unknown as Agent
  const subagents = {
    startContinuable: vi.fn(async () => ({ childId: SessionId('child'), messageId: 'message' })),
    interrupt: vi.fn(),
  }
  const sessions = { get: () => undefined }
  const ctx = { subagents, sessions, get: (name: string) => name === 'sessions' ? sessions : undefined,
    sessionPersistence: { load: async () => undefined } } as unknown as Context
  const port = new HarnessContinuableChildPort(ctx, controller, {} as GitWorkspacePort,
    id => id === controller.id ? controller : id === 'child' ? child : undefined)
  const request = { subagentProvider: 'spawn', label: 'review', prompt: [],
    modelProvider: 'mock', modelId: 'mock', maxDepth: 1, signal: new AbortController().signal }
  const end = (id = 'child') => {
    const info = { id: SessionId(id), runId: 'run', provider: 'spawn', stopReason: 'completed', lastAssistantMessage: [] } as unknown as SubagentRunEndInfo
    for (const listener of [...listeners]) listener(info)
  }
  return { port, request, subagents, controller, child, end, listeners }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('continuable child execution timer ownership', () => {
  it('clears the timer on native end without any application onEnd subscriber', async () => {
    const f = fixture()
    await f.port.start(f.request)
    expect(vi.getTimerCount()).toBe(1)
    f.end()
    expect(vi.getTimerCount()).toBe(0)
    expect(f.listeners.size).toBe(0)
    await vi.advanceTimersByTimeAsync(CHILD_EXECUTION_TIMEOUT_MS)
    expect(f.subagents.interrupt).not.toHaveBeenCalled()
  })

  it('never arms a timer for an end emitted before admission returns', async () => {
    const f = fixture()
    f.subagents.startContinuable.mockImplementation(async () => {
      f.end('unrelated')
      f.end()
      return { childId: SessionId('child'), messageId: 'message' }
    })
    await expect(f.port.start(f.request)).resolves.toEqual({ childSessionId: 'child', messageId: 'message' })
    expect(vi.getTimerCount()).toBe(0)
    expect(f.listeners.size).toBe(0)
    await vi.advanceTimersByTimeAsync(CHILD_EXECUTION_TIMEOUT_MS)
    expect(f.subagents.interrupt).not.toHaveBeenCalled()
  })

  it('ignores unrelated early and late ends and retains the 30-minute safety valve', async () => {
    const f = fixture()
    f.subagents.startContinuable.mockImplementation(async () => {
      f.end('other')
      return { childId: SessionId('child'), messageId: 'message' }
    })
    await f.port.start(f.request)
    f.end('other')
    await vi.advanceTimersByTimeAsync(CHILD_EXECUTION_TIMEOUT_MS - 1)
    expect(f.subagents.interrupt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.subagents.interrupt).toHaveBeenCalledExactlyOnceWith('child', { kind: 'ancestor', agent: f.controller })
    expect(f.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves application end delivery even when the end precedes admission', async () => {
    const f = fixture()
    const listener = vi.fn()
    const unsubscribe = f.port.onEnd(listener)
    f.subagents.startContinuable.mockImplementation(async () => {
      f.end()
      return { childId: SessionId('child'), messageId: 'message' }
    })
    await f.port.start(f.request)
    await vi.advanceTimersByTimeAsync(0)
    expect(listener).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      childSessionId: 'child', runId: 'run', stopReason: 'completed', hasAssistantOutput: false,
    }))
    expect(vi.getTimerCount()).toBe(0)
    expect(f.listeners.size).toBe(1)
    unsubscribe()
    expect(f.listeners.size).toBe(0)
  })

  it('releases its end listener after admission fails', async () => {
    const f = fixture()
    f.subagents.startContinuable.mockRejectedValue(new Error('admission failed'))
    await expect(f.port.start(f.request)).rejects.toThrow('admission failed')
    expect(f.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps concurrent child timers isolated', async () => {
    const f = fixture()
    f.subagents.startContinuable.mockResolvedValueOnce({ childId: SessionId('first'), messageId: 'one' })
      .mockResolvedValueOnce({ childId: SessionId('second'), messageId: 'two' })
    await Promise.all([f.port.start(f.request), f.port.start(f.request)])
    expect(vi.getTimerCount()).toBe(2)
    f.end('first')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(CHILD_EXECUTION_TIMEOUT_MS)
    expect(f.subagents.interrupt).toHaveBeenCalledExactlyOnceWith('second', { kind: 'ancestor', agent: f.controller })
    expect(f.listeners.size).toBe(0)
  })

  it.each(['interrupt', 'cancel'] as const)('%s clears timer and observer without requiring another end', async method => {
    const f = fixture()
    await f.port.start(f.request)
    await f.port[method]('child')
    expect(f.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(CHILD_EXECUTION_TIMEOUT_MS)
    expect(f.subagents.interrupt).toHaveBeenCalledTimes(1)
    expect(f.child.cancel).toHaveBeenCalledTimes(method === 'cancel' ? 1 : 0)
  })

  it('still owns cleanup after the application unsubscribes from onEnd', async () => {
    const f = fixture()
    const listener = vi.fn()
    const unsubscribe = f.port.onEnd(listener)
    await f.port.start(f.request)
    unsubscribe()
    f.end()
    await vi.advanceTimersByTimeAsync(CHILD_EXECUTION_TIMEOUT_MS)
    expect(listener).not.toHaveBeenCalled()
    expect(f.subagents.interrupt).not.toHaveBeenCalled()
    expect(f.listeners.size).toBe(0)
  })

  it('cleans up even when the native timeout interrupt throws', async () => {
    const f = fixture()
    f.subagents.interrupt.mockImplementation(() => { throw new Error('released controller') })
    await f.port.start(f.request)
    await vi.advanceTimersByTimeAsync(CHILD_EXECUTION_TIMEOUT_MS)
    expect(f.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(f.subagents.interrupt).toHaveBeenCalledTimes(1)
  })
})
