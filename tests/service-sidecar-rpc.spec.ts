import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError } from '@deepseek-ai/dsh-session-persistence'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { completeTeamEvents } from './fixtures.ts'
import { YuqiTeamOrchestratorService } from '../src/host/harness/service.ts'
import { OwnedEventStore, OWNED_EVENT_STORE_LIMITS, type OwnedEventRecord, type OwnedEventTable } from '../src/host/storage/owned-event-store.ts'
import { TEAM_SIDECAR_CHANNEL, TEAM_SIDECAR_MAX_RESPONSE_BYTES, teamSidecarSnapshotRequestSchema, teamSidecarSnapshotSchema } from '../src/domain/team-sidecar-web-contract.ts'

class Table implements OwnedEventTable {
  records = new Map<string, OwnedEventRecord>()
  get(key: string) { return this.records.get(key) }
  entries() { return this.records.entries() }
  async put(key: string, value: OwnedEventRecord) { this.records.set(key, value) }
  async update(key: string, transform: (value: OwnedEventRecord) => OwnedEventRecord) {
    const value = transform(this.records.get(key)!)
    await this.put(key, value)
    return value
  }
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.restoreAllMocks() })

/** Real constructor and registered RPC -> real reader/readiness/bind/restore.
 * Only external Connection/storage/persistence are fixtures. No service method
 * replacement; this is not an HTTP browser-trust integration test.
 */
async function host(
  inspectOrOptions?: ((id: string, signal?: AbortSignal) => Promise<unknown>) | {
    inspect?: (id: string, signal?: AbortSignal) => Promise<unknown>
    persistenceList?: () => Promise<any[]>
    persistenceOpen?: (id: any, access: 'read', options?: any) => Promise<any>
    persistenceLoad?: (id: any) => Promise<any>
  },
) {
  const options = typeof inspectOrOptions === 'function' ? { inspect: inspectOrOptions } : (inspectOrOptions ?? {})
  const ctx = new Context()
  const sessions = new Map<string, Session>()
  const table = new Table()
  const close = vi.fn(async () => {})
  const open = vi.fn(async () => ({ table: () => table, close }))
  const getSession = vi.fn((id: string): Session | undefined => sessions.get(id))
  const load = vi.fn(options.persistenceLoad ?? (async (_id: string): Promise<{ meta: Session['header']; events: [] } | undefined> => undefined))
  const list = vi.fn(options.persistenceList ?? (async (): Promise<Session['header'][]> => []))
  let handler: Parameters<HostConnectionHandle['rpc']['handle']>[1] | undefined
  const register = vi.fn((channel: string, next: NonNullable<typeof handler>, _options: { authority: string }) => {
    if (channel === TEAM_SIDECAR_CHANNEL) handler = next
    return async () => {}
  })
  ctx.provide('sessions', { get: getSession, list: () => [...sessions.values()], flush: async () => true } as never)
  ctx.provide('sessionPersistence', {
    load,
    list,
    ...(options.inspect === undefined ? {} : { inspect: options.inspect }),
    ...(options.persistenceOpen === undefined ? {} : { open: options.persistenceOpen }),
    ensureMaterialized: async () => {},
  } as never)
  ctx.provide('subagents', {} as never)
  ctx.provide('llm', {} as never)
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: process.cwd() }) } as never)
  ctx.provide('connection' as never, { rpc: { handle: register } } as never)
  new YuqiTeamOrchestratorService(ctx)
  await vi.waitFor(() => expect(handler).toBeDefined())
  const domainDisposers: (() => Promise<void>)[] = []
  const originalEffect = ctx.effect.bind(ctx)
  vi.spyOn(ctx, 'effect').mockImplementation((...args) => {
    const [setup, label] = args
    if (label === undefined) {
      const dispose = setup() as () => Promise<void>
      domainDisposers.push(dispose)
      return dispose as ReturnType<Context['effect']>
    }
    return originalEffect(...args)
  })
  // Real Cordis provide is required to trigger the service's optional
  // storage-domain injection; replacing ctx.get after construction does not.
  let removeDomain = ctx.provide('storageDomain' as never, { open } as never)
  const shutdown = async () => { for (const dispose of domainDisposers.splice(0)) await dispose() }
  cleanups.push(shutdown)
  return { sessions, table, getSession, list, load, open, close, register, shutdown,
    removeFacility: () => { removeDomain(); removeDomain = () => {} },
    call: (payload: unknown = {}) => handler!('snapshot', payload, new AbortController().signal),
  }
}
async function seed(table: Table, id: string) {
  const store = new OwnedEventStore({ table, controllerSessionId: id })
  await store.commit({ expectedRevision: 0, operationId: 'seed', events: [
    { type: 'yuqi/probe', seq: 1, time: 1, ignorable: true, data: { identity: id } },
  ] })
}

describe('service read-only sidecar RPC wiring', () => {
  it('uses cancellable inspection without acquiring the resume load reservation', async () => {
    const cold = Session.create(SessionId('reserved-controller'))
    const inspect = vi.fn(async () => ({ meta: cold.header, events: [] }))
    const h = await host(inspect)
    h.load.mockImplementation(() => new Promise(() => {}))
    expect(await h.call({ sessionIds: [String(cold.id)] })).toMatchObject({ ok: true })
    expect(inspect).toHaveBeenCalledExactlyOnceWith(cold.id, expect.any(AbortSignal))
    expect(h.load).not.toHaveBeenCalled()
  })
  it('lists cold Teams from the durable catalog without reading their native transcript', async () => {
    const h = await host()
    const cold = Session.create(SessionId('cold-controller'))
    const facts = completeTeamEvents().slice(0, 8)
    await new OwnedEventStore({ table: h.table, controllerSessionId: String(cold.id) }).commit({
      expectedRevision: 0, operationId: 'seed-cold', events: [
        { type: 'yuqi/team-event', seq: 1, time: 1, ignorable: true, data: { events: facts } },
      ],
    })
    h.list.mockResolvedValue([cold.header])
    h.load.mockResolvedValue({ meta: cold.header, events: [] })
    const before = JSON.stringify([...h.table.entries()])
    expect(await h.call()).toMatchObject({ ok: true, value: { sessions: [
      { sessionId: String(cold.id), source: 'sidecar', events: [{ data: { events: facts } }] },
    ] } })
    expect(h.load).not.toHaveBeenCalled()
    expect(JSON.stringify([...h.table.entries()])).toBe(before)
  })
  it('shares one native header enumeration across concurrently inspected cold catalog rows', async () => {
    const h = await host()
    const first = Session.create(SessionId('cold-first')), second = Session.create(SessionId('cold-second'))
    await seed(h.table, String(first.id))
    await seed(h.table, String(second.id))
    let release!: (headers: Session['header'][]) => void
    h.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = h.call()
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledOnce())
    release([first.header, second.header])
    expect(await pending).toMatchObject({ ok: true, value: { sessions: [
      { sessionId: String(first.id), source: 'sidecar' }, { sessionId: String(second.id), source: 'sidecar' },
    ] } })
    expect(h.list).toHaveBeenCalledOnce()
  })
  it('marks a deleted cold sidecar identity unavailable without loading or exposing its facts', async () => {
    const h = await host()
    await seed(h.table, 'deleted-controller')
    h.list.mockResolvedValue([])
    expect(await h.call()).toMatchObject({ ok: true, value: { sessions: [
      { sessionId: 'deleted-controller', source: 'unavailable', events: [] },
    ] } })
    expect(h.load).not.toHaveBeenCalled()
  })
  it('inspects only explicitly selected cold sessions when handle persistence is also available', async () => {
    const cold = Session.create(SessionId('selected-cold'))
    const inspect = vi.fn(async () => ({ meta: cold.header, events: [] }))
    const read = vi.fn(async () => ({ events: [] }))
    const h = await host({ inspect, persistenceOpen: async () => ({ header: cold.header, read, close: async () => {} }) })
    await seed(h.table, String(cold.id))
    h.list.mockResolvedValue([cold.header])
    expect(await h.call({ sessionIds: [String(cold.id)] })).toMatchObject({ ok: true })
    expect(inspect).toHaveBeenCalledExactlyOnceWith(cold.id, expect.any(AbortSignal))
    expect(read).not.toHaveBeenCalled()
  })
  it('isolates corrupt native logs without changing healthy sessions or leaking the error', async () => {
    const h = await host()
    expect(await h.call({ sessionIds: [] })).toMatchObject({ ok: true })
    h.sessions.set('healthy', Session.create(SessionId('healthy')))
    h.load.mockRejectedValueOnce(new Error('corrupt Zstandard session log: complete frame contains a torn JSONL record secret'))
    const result = await h.call({ sessionIds: ['bad', 'healthy'] })
    expect(result).toMatchObject({ ok: true, value: { sessions: [
      { sessionId: 'bad', source: 'unavailable', events: [] },
      { sessionId: 'healthy', source: 'sidecar', events: [] },
    ] } })
    expect(JSON.stringify(result)).not.toContain('secret')
    h.sessions.set('bad', Session.create(SessionId('bad')))
    expect(await h.call({ sessionIds: ['bad'] })).toMatchObject({ ok: true, value: {
      sessions: [{ sessionId: 'bad', source: 'sidecar', events: [] }],
    } })
  })
  it.each(['native', 'serialized'])('isolates the official subagent header validation defect (%s) without weakening global failures', async shape => {
    const h = await host()
    h.sessions.set('healthy', Session.create(SessionId('healthy')))
    await seed(h.table, 'healthy')
    const message = 'stored session "bad" failed validation: Error: session header isSeeded must be a boolean'
    h.load.mockRejectedValueOnce(shape === 'native' ? new SessionPersistenceCorruptionError(message, {})
      : new Error(`SessionPersistenceCorruptionError: ${message}`))
    const result = await h.call({ sessionIds: ['bad', 'healthy'] })
    expect(result).toMatchObject({ ok: true, value: { sessions: [
      { sessionId: 'bad', source: 'unavailable', events: [] },
      { sessionId: 'healthy', source: 'sidecar', events: [{ data: { identity: 'healthy' } }] },
    ] } })
    h.load.mockRejectedValueOnce(new Error('SessionPersistenceCorruptionError: stored session "other" failed validation: Error: session header isSeeded must be a boolean'))
    expect(await h.call({ sessionIds: ['bad'] })).toMatchObject({ ok: false, error: { code: 'internal' } })
    h.load.mockRejectedValueOnce(new Error('storage backend unavailable'))
    expect(await h.call({ sessionIds: ['bad'] })).toMatchObject({ ok: false, error: { code: 'internal' } })
  })
  it.each([
    new SessionPersistenceCorruptionError('stored session "other" failed validation: Error: session header isSeeded must be a boolean', {}),
    new SessionPersistenceCorruptionError('stored session "bad" failed validation: Error: session header version is invalid', {}),
    new Error('stored session "bad" failed validation: Error: session header isSeeded must be a boolean'),
    Object.assign(new Error('stored session "bad" failed validation: Error: session header isSeeded must be a boolean'), { name: 'PermissionError' }),
    Object.assign(new Error('permission denied'), { name: 'SessionPersistenceCorruptionError' }),
  ])('does not isolate other corruption, identity or permission errors: %s', async error => {
    const h = await host()
    h.load.mockRejectedValueOnce(error)
    expect(await h.call({ sessionIds: ['bad'] })).toMatchObject({ ok: false, error: { code: 'internal' } })
  })
  it('records the actual native-load stage while keeping an unknown failure closed', async () => {
    const stderr = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await host()
    h.load.mockRejectedValueOnce(new Error('private storage failure'))
    expect(await h.call({ sessionIds: ['private-session'] })).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('stage=native-persistence requestedSessionCount=1'))
    expect(JSON.stringify(stderr.mock.calls)).not.toContain('private')
  })
  it('registers loopback, initializes once, and returns genuine complete plugin events', async () => {
    const h = await host()
    h.sessions.set('a', Session.create(SessionId('a')))
    await seed(h.table, 'a')
    const result = await h.call({ sessionIds: ['a'] })
    expect(h.register).toHaveBeenCalledWith(TEAM_SIDECAR_CHANNEL, expect.any(Function), { authority: 'loopback' })
    expect(result).toMatchObject({ ok: true, value: { mode: 'sidecar', sessions: [{ sessionId: 'a', source: 'sidecar', events: [{ seq: 1, data: { identity: 'a' } }] }] } })
    await h.call({ sessionIds: ['a'] })
    expect(h.open).toHaveBeenCalledOnce()
  })
  it('rejects live identity mismatch during initialization and permits a later retry', async () => {
    const h = await host()
    await seed(h.table, 'a')
    h.getSession.mockReturnValue(Session.create(SessionId('wrong')))
    expect(await h.call()).toMatchObject({ ok: false, error: { code: 'internal' } })
    h.getSession.mockReturnValue(Session.create(SessionId('a')))
    expect(await h.call()).toMatchObject({ ok: true })
    expect(h.open).toHaveBeenCalledOnce()
  })
  it('rejects live identity mismatch after readiness, before labeling returned facts', async () => {
    const h = await host()
    expect(await h.call({ sessionIds: [] })).toMatchObject({ ok: true })
    h.getSession.mockReturnValue(Session.create(SessionId('wrong')))
    expect(await h.call({ sessionIds: ['a'] })).toMatchObject({ ok: false, error: { code: 'internal' } })
  })
  it('rejects persisted metadata mismatch rather than omitting it as missing', async () => {
    const h = await host()
    const wrong = Session.create(SessionId('wrong'))
    h.load.mockResolvedValue({ meta: wrong.header, events: [] })
    expect(await h.call({ sessionIds: ['a'] })).toMatchObject({ ok: false, error: { code: 'internal' } })
  })
  it('never returns legacy after the initialized repository closes', async () => {
    const h = await host()
    expect(await h.call()).toMatchObject({ ok: true, value: { mode: 'sidecar' } })
    await h.shutdown()
    h.removeFacility()
    expect(await h.call()).toMatchObject({ ok: false, error: { code: 'internal' } })
  })
  it('does not downgrade an already initialized sidecar after its provider unregisters', async () => {
    const h = await host()
    h.removeFacility()
    expect(await h.call()).toEqual({ ok: true, value: { mode: 'sidecar', sessions: [] } })
    expect(h.open).toHaveBeenCalledOnce()
  })
  it('paginates 201 verified legacy records and rejects a cursor reused with another selection', async () => {
    const h = await host()
    for (let i = 0; i < 201; i++) {
      const id = String(i).padStart(3, '0')
      const session = Session.create(SessionId(id), [
        { type: 'yuqi/probe', data: { legacy: true }, seq: 0, time: 1, ignorable: true },
      ] as unknown as SessionEvent[])
      h.sessions.set(id, session)
    }
    const first = await h.call()
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('Expected first page')
    const page = teamSidecarSnapshotSchema.parse(first.value)
    expect(page.sessions).toHaveLength(200)
    expect(page.sessions.every(record => record.source === 'legacy' && record.events.length === 0)).toBe(true)
    expect(page.nextCursor).toBeDefined()
    expect(await h.call({ cursor: page.nextCursor, sessionIds: ['200'] })).toMatchObject({ ok: false })
    const second = await h.call({ cursor: page.nextCursor })
    expect(second).toMatchObject({ ok: true, value: { sessions: [{ sessionId: '200', source: 'legacy', events: [] }] } })
    if (!second.ok) throw new Error('Expected second page')
    expect(teamSidecarSnapshotSchema.parse(second.value).nextCursor).toBeUndefined()
  })
  it('bounds input before invoking service readiness and sanitizes read failures', async () => {
    const h = await host()
    expect(await h.call({ sessionIds: Array.from({ length: 201 }, (_, i) => String(i)) })).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(h.open).toHaveBeenCalledOnce()
    h.load.mockRejectedValue(new Error('secret credential'))
    const result = await h.call({ sessionIds: ['a'] })
    expect(result).toMatchObject({ ok: false })
    expect(JSON.stringify(result)).not.toContain('secret')
  })
  it('accepts worst-case escaped 2048-code-unit cursor and rejects the cursor limit plus one', () => {
    const cursor = Buffer.from(JSON.stringify(['a'.repeat(64), '\ud800'.repeat(2048)])).toString('base64url')
    expect(cursor.length).toBeGreaterThan(4096)
    expect(teamSidecarSnapshotRequestSchema.safeParse({ cursor }).success).toBe(true)
    expect(teamSidecarSnapshotRequestSchema.safeParse({ cursor: 'x'.repeat(20481) }).success).toBe(false)
    expect(TEAM_SIDECAR_MAX_RESPONSE_BYTES).toBe(OWNED_EVENT_STORE_LIMITS.recordBytes + 64 * 1024)
  })
  it('handles DSH 0.1.5-rc.2 snapshot-based listing and handle-based session persistence', async () => {
    const header = { id: SessionId('dsh-15'), version: SESSION_FORMAT_VERSION, isSeeded: false, createdAt: 1, cwd: 'F:\\test' } as unknown as Session['header']
    const h = await host({
      persistenceList: async () => [{ header, revision: 'rev-1' }],
      persistenceOpen: async () => ({
        header,
        inheritedEventCount: 0,
        read: async () => ({ events: [] }),
        close: async () => {},
      }),
    })
    const result = await h.call({ sessionIds: ['dsh-15'] })
    expect(result).toMatchObject({
      ok: true,
      value: {
        mode: 'sidecar',
        sessions: [{ sessionId: 'dsh-15', source: 'sidecar', events: [] }],
      },
    })
  })
  it('gracefully isolates unreadable legacy session errors without crashing sidecar snapshot', async () => {
    const h = await host({
      persistenceOpen: async () => {
        const err = new Error('Stored session "old-1" has format version 1, older than the supported version 3')
        err.name = 'SessionFormatUnsupportedError'
        throw err
      },
    })
    const result = await h.call({ sessionIds: ['old-1'] })
    expect(result).toMatchObject({
      ok: true,
      value: {
        mode: 'sidecar',
        sessions: [{ sessionId: 'old-1', source: 'unavailable', events: [] }],
      },
    })
  })
})
