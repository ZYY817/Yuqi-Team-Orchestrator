import { afterEach, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { createSidecarStore } from '../../src/client/sidecar-store.ts'
import { reduceSidecarSession } from '../../src/client/sidecar-projection.ts'
import type { TeamSidecarEvent } from '../../src/domain/team-sidecar-web-contract.ts'
import { completeTeamEvents } from '../fixtures.ts'

const disposers: Array<() => void> = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); vi.useRealTimers() })
const facts = (): TeamSidecarEvent[] => [{ type: 'yuqi/team-event', seq: 1, time: 1, ignorable: true,
  data: JSON.parse(JSON.stringify({ events: completeTeamEvents() })) }]
const record = (sessionId = 'controller') => ({ sessionId, source: 'sidecar', events: facts() })
const ok = (sessions: unknown[] = [], nextCursor?: string) => ({ ok: true, value: { mode: 'sidecar', sessions, ...(nextCursor === undefined ? {} : { nextCursor }) } })
function fixture(ids = ['native'], teamIds = ids) {
  const nativeSummary = reduceSidecarSession('native', facts())!
  const native = Object.freeze({ ids, byId: Object.freeze(Object.fromEntries(ids.map(id => [id,
    Object.freeze({ id, displayTitle: id, projectionValues: Object.freeze(teamIds.includes(id) ? { yuqiTeam: nativeSummary } : {}) })]))) })
  const listeners = new Set<() => void>()
  const sessions = { list: { getSnapshot: () => native, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } } },
    binding: () => ({ session: { projections: { faceOf: () => ({ getSnapshot: () => nativeSummary }) } } }),
  } as unknown as ClientContext['sessions']
  const call = vi.fn(async (..._args: unknown[]): Promise<unknown> => ok())
  const store = createSidecarStore({ call } as unknown as ClientConnectionRpc, sessions)
  disposers.push(store.dispose)
  return { store, call, native, nativeSummary, sessions }
}

it('isolates unavailable records, clears stale actions and restores only after a successful refresh', async () => {
  const h = fixture(['bad', 'healthy'])
  h.call.mockResolvedValue(ok([
    { sessionId: 'bad', source: 'unavailable', events: [] }, record('healthy'),
  ]))
  await h.store.refresh()
  expect(h.store.getSnapshot().status).toBe('ready')
  expect(h.store.getSnapshot().unavailable?.has('bad')).toBe(true)
  expect(h.store.catalog.getSnapshot().ids).not.toContain('bad')
  expect(h.store.summary('bad')).toBeUndefined()
  expect(h.store.summary('healthy')).toBeDefined()
  expect(h.native.byId.bad).toBeDefined()
  h.call.mockResolvedValue(ok([record('bad'), record('healthy')]))
  await h.store.refresh()
  expect(h.store.getSnapshot().unavailable?.size).toBe(0)
  expect(h.store.catalog.getSnapshot().ids).toContain('bad')
  expect(h.store.summary('bad')).toBeDefined()
})

it('publishes complete paged streams and never mutates native rows or fabricates native address/status', async () => {
  const h = fixture()
  h.call.mockResolvedValueOnce(ok([record()], 'page2')).mockResolvedValueOnce(ok([record('second')]))
  await h.store.refresh()
  expect(h.store.getSnapshot().status).toBe('ready')
  expect(h.call.mock.calls[1]?.[2]).toEqual({ cursor: 'page2' })
  expect(h.call.mock.calls[2]?.[2]).toEqual({ sessionIds: ['native'] })
  expect(h.store.summary('controller')?.team.id).toBeDefined()
  expect(h.store.summary('native')).toBeUndefined()
  expect(h.native.byId.native?.projectionValues.yuqiTeam).toBe(h.nativeSummary)
  expect(h.store.catalog.getSnapshot().byId['controller' as never]).not.toHaveProperty('available')
  expect(h.store.catalog.getSnapshot().byId['controller' as never]).not.toHaveProperty('address')
})

it('accepts only explicit legacy mode or verified per-session source, including cold UI identities', async () => {
  const h = fixture(Array.from({ length: 201 }, (_, i) => `id-${i}`))
  h.call.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok([{ sessionId: 'id-0', source: 'legacy', events: [] }])).mockResolvedValueOnce(ok())
  await h.store.refresh()
  expect(h.store.summary('id-0')).toBe(h.nativeSummary)
  expect(h.store.summary('id-1')).toBeUndefined()
  expect((h.call.mock.calls[1]?.[2] as { sessionIds: string[] }).sessionIds).toHaveLength(200)
  expect(h.call.mock.calls[2]?.[2]).toEqual({ sessionIds: ['id-200'] })
  h.call.mockResolvedValue({ ok: true, value: { mode: 'legacy', sessions: [] } })
  await h.store.refresh()
  expect(h.store.catalog.getSnapshot()).toBe(h.native)
})

it('does not verify ordinary conversations while loading cold Team rows', async () => {
  const h = fixture(['team', 'ordinary'], ['team'])
  h.call.mockResolvedValue(ok())
  await h.store.refresh()
  expect(h.call.mock.calls[1]?.[2]).toEqual({ sessionIds: ['team'] })
})

it.each(['rpc', 'schema', 'cursor', 'sequence'] as const)('clears stale actions on %s failure without native fallback', async kind => {
  const h = fixture([])
  h.call.mockResolvedValue(ok([record()]))
  await h.store.refresh()
  expect(h.store.summary('controller')).toBeDefined()
  h.call.mockResolvedValue(kind === 'rpc' ? { ok: false, error: { message: 'failed' } }
    : kind === 'schema' ? { ok: true, value: { sessions: [] } }
      : kind === 'cursor' ? ok([], 'repeat') : ok([{ ...record(), events: [{ ...facts()[0], seq: 2 }] }]))
  await h.store.refresh()
  expect(h.store.getSnapshot().status).toBe('error')
  expect(h.store.summary('controller')).toBeUndefined()
  expect(h.store.getSnapshot().summaries.size).toBe(0)
  h.call.mockResolvedValue(ok())
  await h.store.refresh()
  expect(h.store.getSnapshot().mode).toBe('sidecar')
  expect(h.store.getSnapshot().status).toBe('ready')
})

it('retries a transient startup failure and restores Team data without manual refresh', async () => {
  vi.useFakeTimers()
  const h = fixture([])
  h.call.mockResolvedValueOnce({ ok: false, error: { message: 'Host starting' } }).mockResolvedValueOnce(ok([record()]))
  await h.store.refresh()
  expect(h.store.getSnapshot().status).toBe('error')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(h.store.getSnapshot().status).toBe('ready')
  expect(h.store.summary('controller')).toBeDefined()
})

it('refreshes the durable projection immediately after target recovery succeeds', async () => {
  const h = fixture([])
  h.call.mockImplementation(async (_channel, method) => method === 'recover-target' ? { ok: true, value: {} } : ok([record()]))
  await h.store.refresh()
  expect(h.store.summary('controller')).toBeDefined()

  h.call.mockImplementation(async (_channel, method) => method === 'recover-target' ? { ok: true, value: {} } : ok())
  await h.store.recoverTarget('team-1', 'controller')

  expect(h.call.mock.calls.slice(-2).map(call => call[1])).toEqual(['recover-target', 'snapshot'])
  expect(h.store.getSnapshot().status).toBe('ready')
  expect(h.store.summary('controller')).toBeUndefined()
})

it('does not refresh or replace the current projection when target recovery is rejected', async () => {
  const h = fixture([])
  h.call.mockResolvedValue(ok([record()]))
  await h.store.refresh()
  const before = h.store.getSnapshot()
  h.call.mockClear()
  h.call.mockResolvedValue({ ok: false, error: { message: 'Recovery rejected' } })

  await expect(h.store.recoverTarget('team-1', 'controller')).rejects.toThrow('Recovery rejected')

  expect(h.call).toHaveBeenCalledTimes(1)
  expect(h.call.mock.calls[0]?.[1]).toBe('recover-target')
  expect(h.store.getSnapshot()).toBe(before)
})

it('does not restart loading when recovery succeeds after the user cancelled', async () => {
  const h = fixture([])
  let resolveRecovery!: (value: unknown) => void
  h.call.mockImplementation((_channel, method) => method === 'recover-target'
    ? new Promise(done => { resolveRecovery = done })
    : Promise.resolve(ok([record()])))
  await h.store.refresh()
  h.call.mockClear()

  const recovery = h.store.recoverTarget('team-1', 'controller')
  h.store.cancel()
  resolveRecovery({ ok: true, value: {} })
  await recovery

  expect(h.call).toHaveBeenCalledTimes(1)
  expect(h.call.mock.calls[0]?.[1]).toBe('recover-target')
  expect(h.store.getSnapshot().status).toBe('cancelled')
})

it('retains snapshot identity throughout slow background polling and unchanged success', async () => {
  vi.useFakeTimers()
  const h = fixture([])
  h.call.mockResolvedValue(ok([record()]))
  await h.store.refresh()
  const before = h.store.getSnapshot()
  const summary = h.store.summary('controller')
  let resolve!: (value: unknown) => void
  h.call.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  await vi.advanceTimersByTimeAsync(5_000)
  expect(h.store.getSnapshot()).toBe(before)
  expect(h.store.summary('controller')).toBe(summary)
  resolve(ok([record()]))
  await vi.advanceTimersByTimeAsync(0)
  expect(h.store.summary('controller')).toBe(summary)
  expect(h.store.getSnapshot().status).toBe('ready')
})

it('aborts superseded/cancelled requests and ignores late results, with a bounded timeout', async () => {
  vi.useFakeTimers()
  const h = fixture([])
  let resolve!: (value: unknown) => void
  h.call.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const first = h.store.refresh()
  const signal = h.call.mock.calls[0]?.[3] as AbortSignal
  await h.store.refresh()
  expect(signal.aborted).toBe(true)
  resolve(ok([record()]))
  await first
  expect(h.store.summary('controller')).toBeUndefined()
  h.call.mockImplementation(() => new Promise(() => {}))
  void h.store.refresh()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(h.store.getSnapshot().status).toBe('error')
  h.store.cancel()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(h.store.getSnapshot().status).toBe('cancelled')
})

it('replays bridge revisions, tombstones and later binding generations without resurrecting stale cuts', () => {
  const bridge = { controllerSessionId: 'controller', events: completeTeamEvents(), sourceEventCount: completeTeamEvents().length,
    bindingGeneration: 1, activationGeneration: 1, bridgeRevision: 2 }
  const envelope = (type: string, data: unknown, seq: number): TeamSidecarEvent => ({ type, data: JSON.parse(JSON.stringify(data)), seq, time: seq, ignorable: true })
  const first = envelope('yuqi/team-projection-bridge', bridge, 1)
  const tombstone = envelope('yuqi/team-parent-detached', { controllerSessionId: 'controller', bindingGeneration: 1 }, 2)
  expect(reduceSidecarSession('parent', [first])?.controllerSessionId).toBe('controller')
  expect(reduceSidecarSession('parent', [first, tombstone, { ...first, seq: 3 }])).toBeUndefined()
  expect(reduceSidecarSession('parent', [first, tombstone, envelope('yuqi/team-projection-bridge', { ...bridge, bindingGeneration: 2, bridgeRevision: 3 }, 3)])?.controllerSessionId).toBe('controller')
})
