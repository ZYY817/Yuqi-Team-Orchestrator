import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForCommandDelivery, waitForCommandOutcome, YuqiCommandOutcomeError, resolveCommandOutcomeSource, type CommandOutcomeSource } from '../../src/client/command-outcome.ts'

afterEach(() => vi.useRealTimers())

it('keeps instruction receipt persistence failures uncertain instead of authorizing a resend', async () => {
  const state = source()
  const result = waitForCommandOutcome(state, '/yuqi message all payload request')
  state.publish([{ kind: 'command', name: 'yuqi', args: 'message all payload request',
    outcome: { kind: 'error', text: 'Yuqi MESSAGE_DELIVERY_UNCERTAIN: receipt flush failed' } }])
  await expect(result).rejects.toMatchObject({ disposition: 'unknown' })
})

function source() {
  let nodes: ReturnType<CommandOutcomeSource['getSnapshot']>['nodes'] = []
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => ({ nodes }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    publish(next: typeof nodes) { nodes = next; for (const listener of listeners) listener() },
    listenerCount: () => listeners.size,
  }
}

describe('public command outcome observation', () => {
  it('bounds a native command bridge that never settles, so the UI can leave its submitting state', async () => {
    vi.useFakeTimers()
    const never = new Promise<never>(() => undefined)
    const result = waitForCommandDelivery(never, 100)
    const assertion = expect(result).rejects.toMatchObject({ disposition: 'unknown', message: expect.stringContaining('[command:delivery-unknown]') })
    await vi.advanceTimersByTimeAsync(100)
    await assertion
  })

  it('reads the official separated Chat source and observes its exact command lifecycle', async () => {
    const state = source()
    state.publish([{ kind: 'command', commandId: 'old', name: 'yuqi', outcome: { kind: 'success' } }])
    const legacy = { getSnapshot: vi.fn(() => { throw new Error('Session has lifecycle only') }), subscribe: vi.fn() }
    const activate = vi.fn()
    const target = vi.fn(() => ({ getSnapshot: () => ({ legacy: state.getSnapshot() }), subscribe: state.subscribe }))
    const binding = vi.fn(() => ({ activate, target }))
    const observed = resolveCommandOutcomeSource({ binding }, 'parent-session', legacy)
    expect(binding).toHaveBeenCalledWith('parent-session')
    expect(activate).toHaveBeenCalledWith('chat')
    expect(target).toHaveBeenCalledWith('chat')
    const previousCommandIds = new Set(observed.getSnapshot().nodes.map(node => node.commandId!))
    const result = waitForCommandOutcome(observed, '/yuqi resume team controller request', { previousCommandIds })
    state.publish([{ kind: 'command', commandId: 'new', name: 'yuqi', args: null }])
    expect(state.listenerCount()).toBe(1)
    state.publish([{ kind: 'command', commandId: 'new', name: 'yuqi', args: null, outcome: { kind: 'success' } }])
    await expect(result).resolves.toBe(true)
    expect(state.listenerCount()).toBe(0)
    expect(legacy.getSnapshot).not.toHaveBeenCalled()
    expect(legacy.subscribe).not.toHaveBeenCalled()
  })

  it('rejects an unavailable official Chat target instead of silently using legacy or an empty baseline', () => {
    const legacy = source()
    const observed = resolveCommandOutcomeSource({ binding: () => ({ activate: () => {}, target: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) }) }, 'parent', legacy)
    expect(() => observed.getSnapshot()).toThrow('[command:snapshot-shape-invalid]')
  })

  it('supports the old unified Session source only when the official split service is absent', () => {
    const legacy = source()
    legacy.publish([{ kind: 'command', commandId: 'known', name: 'yuqi' }])
    expect(resolveCommandOutcomeSource(undefined, 'parent', legacy).getSnapshot().nodes[0]?.commandId).toBe('known')
  })
  it.each([false, true])('requires a synchronized read-only memory refresh (synced=%s)', async panelSynced => {
    const state = source()
    const args = 'knowledge-refresh team controller request-1'
    state.publish([{ kind: 'command', name: 'yuqi', args, outcome: { kind: 'success', text: JSON.stringify({ saved: false, panelSynced }) } }])
    const result = waitForCommandOutcome(state, `/yuqi ${args}`)
    if (panelSynced) await expect(result).resolves.toBe(true)
    else await expect(result).rejects.toMatchObject({ disposition: 'unknown' })
  })
  it.each([false, true])('distinguishes saved cleanup from synchronized UI (synced=%s)', async panelSynced => {
    const state = source()
    const args = 'knowledge-delete pitfalls lesson team controller request-1'
    state.publish([{ kind: 'command', name: 'yuqi', args, outcome: { kind: 'success', text: JSON.stringify({ saved: true, panelSynced }) } }])
    const result = waitForCommandOutcome(state, `/yuqi ${args}`)
    if (panelSynced) await expect(result).resolves.toBe(true)
    else await expect(result).rejects.toMatchObject({ disposition: 'unknown' })
    expect(state.listenerCount()).toBe(0)
  })
  it('waits for the exact bound request rather than another command or admission', async () => {
    const state = source()
    const result = waitForCommandOutcome(state, '/yuqi cancel team controller request-1')
    state.publish([{ kind: 'command', name: 'yuqi', args: ' cancel team controller other', outcome: { kind: 'success' } }])
    expect(state.listenerCount()).toBe(1)
    state.publish([{ kind: 'command', name: 'yuqi', args: ' cancel team controller request-1', outcome: { kind: 'success' } }])
    await expect(result).resolves.toBe(true)
    expect(state.listenerCount()).toBe(0)
  })

  it('preserves an already recorded Host rejection', async () => {
    const state = source()
    state.publish([{ kind: 'command', name: 'yuqi', args: ' cancel team controller request-2', outcome: { kind: 'error', text: 'CONTROL_OPERATION_CONFLICT' } }])
    await expect(waitForCommandOutcome(state, '/yuqi cancel team controller request-2'))
      .rejects.toMatchObject({ disposition: 'rejected', message: 'CONTROL_OPERATION_CONFLICT' })
    expect(state.listenerCount()).toBe(0)
  })

  it('pairs a Host command whose public envelope omits args by the new lifecycle id', async () => {
    const state = source()
    const result = waitForCommandOutcome(state, '/yuqi broadcast team-1 hello', {
      previousCommandIds: new Set(['cmd-old']),
    })
    state.publish([
      { kind: 'command', commandId: 'cmd-old', name: 'yuqi', args: null, outcome: { kind: 'success' } },
      { kind: 'command', commandId: 'cmd-new', name: 'yuqi', args: null, outcome: { kind: 'success', text: 'forwarded' } },
    ])
    await expect(result).resolves.toBe(true)
  })

  it('does not guess when two new same-name commands are concurrent', async () => {
    vi.useFakeTimers()
    const state = source()
    const result = waitForCommandOutcome(state, '/yuqi broadcast team-1 hello', {
      previousCommandIds: new Set(['cmd-old']),
      timeoutMs: 100,
    })
    state.publish([
      { kind: 'command', commandId: 'cmd-a', name: 'yuqi', args: null, outcome: { kind: 'success' } },
      { kind: 'command', commandId: 'cmd-b', name: 'yuqi', args: null, outcome: { kind: 'success' } },
    ])
    const assertion = expect(result).rejects.toMatchObject({ disposition: 'unknown' })
    await vi.advanceTimersByTimeAsync(100)
    await assertion
  })

  it('reports timeout as unknown, not success or rejection, and releases its observer', async () => {
    vi.useFakeTimers()
    const state = source()
    const result = waitForCommandOutcome(state, '/yuqi pause team controller request-3', 100)
    const assertion = expect(result).rejects.toBeInstanceOf(YuqiCommandOutcomeError)
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    expect(state.listenerCount()).toBe(0)
  })
})
