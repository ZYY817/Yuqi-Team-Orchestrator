import { describe, expect, it, vi } from 'vitest'
import {
  OWNED_EVENT_STORE_LIMITS as limits, OwnedEventStore, OwnedEventStoreError,
  ownedEventDomainSpec, ownedEventRecordSchema,
} from '../src/host/storage/owned-event-store.ts'
import type { OwnedEventRecord, OwnedEventTable } from '../src/host/storage/owned-event-store.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** Unit double of Domain's public semantics, not an alternate storage backend.
 * Keeps returned references, serializes transforms, and publishes only after
 * durability acknowledgment. Real official close/open is tested by integration.
 */
class Table implements OwnedEventTable {
  records = new Map<string, OwnedEventRecord>()
  writes = 0
  puts = 0
  updates = 0
  beforeWrite: () => Promise<void> = async () => {}
  private tail: Promise<unknown> = Promise.resolve()
  get(key: string) { return this.records.get(key) }
  entries() { return new Map(this.records).entries() }
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job)
    this.tail = next.catch(() => {})
    return next
  }
  put(key: string, value: OwnedEventRecord): Promise<void> {
    this.puts++
    return this.enqueue(async () => {
      await this.beforeWrite()
      this.records.set(key, value)
      this.writes++
    })
  }
  update(key: string, transform: (current: OwnedEventRecord) => OwnedEventRecord): Promise<OwnedEventRecord> {
    this.updates++
    return this.enqueue(async () => {
      const current = this.records.get(key)
      if (!current) throw new Error('missing-key')
      const next = transform(current)
      await this.beforeWrite()
      this.records.set(key, next)
      this.writes++
      return next
    })
  }
}
const session = 'controller/../中文'
const record = (): OwnedEventRecord => ({ schemaVersion: 1, controllerSessionId: session,
  revision: 1, batches: [{ operationId: 'one', events: [{ type: 'created', nested: { n: 1 } }] }] })
function setup(table = new Table(), controllerSessionId = session) {
  return { table, store: new OwnedEventStore({ table, controllerSessionId }) }
}
function commit(store: OwnedEventStore, expectedRevision = 0, operationId = 'one', events: unknown[] = [{ type: 'created' }]) {
  return store.commit({ expectedRevision, operationId, events })
}
function bridge(controllerSessionId: string, bridgeRevision: number, events: unknown[] = [bridgeRevision]) {
  return [{ type: 'yuqi/team-projection-bridge', ignorable: true, seq: bridgeRevision, time: bridgeRevision,
    data: { controllerSessionId, bindingGeneration: 1, bridgeRevision, events } }]
}

describe('OwnedEventStore over a Domain table', () => {
  it('exports the authoritative single-layout schema declaration', () => {
    expect(ownedEventDomainSpec).toMatchObject({ name: 'yuqi_team_owned_events', version: 1, layout: 'single' })
    expect(ownedEventDomainSpec.tables.sessions.valueSchema).toBe(ownedEventRecordSchema)
    expect(ownedEventRecordSchema.parse(record())).toEqual(record())
  })

  it('starts absent and commits full ordered batches with one revision per batch', async () => {
    const { table, store } = setup()
    expect(store.read()).toEqual({ revision: 0, events: [] })
    expect(table.writes).toBe(0)
    expect(await commit(store, 0, 'one', [1, 2])).toEqual({ revision: 1, replayed: false })
    expect(await commit(store, 1, 'two', [3])).toEqual({ revision: 2, replayed: false })
    expect(store.read()).toEqual({ revision: 2, events: [1, 2, 3] })
    expect(table.puts).toBe(1)
    expect(table.updates).toBe(1)
    expect([...table.entries()]).toHaveLength(1)
  })

  it('hashes session identities into distinct safe keys, including lone surrogates', () => {
    const table = new Table()
    const ids = ['../../escape', 'C:\\elsewhere', '\ud800', '\ud801', '中文']
    const keys = ids.map(id => setup(table, id).store.key)
    expect(new Set(keys).size).toBe(ids.length)
    for (const key of keys) expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(setup(table, ids[0]).store.key).toBe(keys[0])
  })

  it('serializes two absent-key initializations without overwriting the first batch', async () => {
    const { table, store } = setup()
    const other = setup(table).store
    const entered = deferred(), release = deferred()
    table.beforeWrite = async () => { entered.resolve(); await release.promise }
    const first = commit(store)
    await entered.promise
    const second = commit(other, 0, 'two', ['second'])
    const secondCheck = expect(second).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(other.read()).toEqual({ revision: 0, events: [] })
    expect(table.puts).toBe(1)
    release.resolve()
    await first
    await secondCheck
    expect(table.puts).toBe(1)
    expect(other.read()).toEqual({ revision: 1, events: [{ type: 'created' }] })
  })

  it('rejects one of competing updates and permits a subsequent correct revision', async () => {
    const { table, store } = setup()
    await commit(store)
    const results = await Promise.allSettled([
      commit(store, 1, 'two', [2]), commit(setup(table).store, 1, 'three', [3]),
    ])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(results[1]).toMatchObject({ reason: { code: 'REVISION_CONFLICT' } })
    await commit(store, 2, 'three', [3])
    expect(store.read().events).toEqual([{ type: 'created' }, 2, 3])
  })

  it('checks revision inside the queued update transform', async () => {
    const { table, store } = setup()
    await commit(store)
    // Simulate an official queued writer ahead of this adapter's queue slot.
    const entered = deferred(), release = deferred()
    table.beforeWrite = async () => { entered.resolve(); await release.promise }
    const preceding = table.update(store.key, current => ({ ...current, revision: 2,
      batches: [...current.batches, { operationId: 'preceding', events: [2] }] }))
    await entered.promise
    const pending = commit(store, 1, 'later')
    const check = expect(pending).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    release.resolve()
    await preceding
    await check
    expect(store.read().revision).toBe(2)
  })

  it('does not share facts or block independent table instances', async () => {
    const first = setup(), second = setup()
    const entered = deferred(), release = deferred()
    first.table.beforeWrite = async () => { entered.resolve(); await release.promise }
    const pending = commit(first.store)
    await entered.promise
    try {
      await commit(second.store, 0, 'other', [2])
      expect(first.store.read().revision).toBe(0)
      expect(second.store.read().events).toEqual([2])
    } finally { release.resolve(); await pending }
  })

  it.each([false, true])('leaves facts unchanged on backend failure (existing=%s) and releases gate', async existing => {
    const { table, store } = setup()
    if (existing) await commit(store)
    const before = store.read()
    const reference = table.get(store.key)
    const failure = new Error('durability failed')
    table.beforeWrite = async () => { throw failure }
    await expect(commit(store, before.revision, 'retry', [2, 3])).rejects.toBe(failure)
    expect(table.get(store.key)).toBe(reference)
    expect(store.read()).toEqual(before)
    table.beforeWrite = async () => {}
    expect(await commit(setup(table).store, before.revision, 'retry', [2, 3]))
      .toEqual({ revision: before.revision + 1, replayed: false })
  })

  it('exposes neither partial batches nor modified records before acknowledgment', async () => {
    const { table, store } = setup()
    await commit(store)
    const reference = table.get(store.key)
    const entered = deferred(), release = deferred()
    table.beforeWrite = async () => { entered.resolve(); await release.promise }
    const pending = commit(store, 1, 'two', [2, 3])
    await entered.promise
    expect(table.get(store.key)).toBe(reference)
    expect(store.read()).toEqual({ revision: 1, events: [{ type: 'created' }] })
    release.resolve()
    await pending
    expect(store.read()).toEqual({ revision: 2, events: [{ type: 'created' }, 2, 3] })
  })

  it('deduplicates simultaneous identical operations and returns current revision on later retry', async () => {
    const { table, store } = setup()
    const other = setup(table).store
    expect(await Promise.all([commit(store), commit(other)])).toEqual([
      { revision: 1, replayed: false }, { revision: 1, replayed: true },
    ])
    await commit(other, 1, 'two', [2])
    expect(await commit(store)).toEqual({ revision: 2, replayed: true })
    expect(table.writes).toBe(2)
    await expect(commit(store, 0, 'one', ['changed'])).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
    expect(table.writes).toBe(2)
  })

  it('atomically compacts only superseded derived cuts and preserves their retry identity', async () => {
    const { store, table } = setup()
    await store.commitProjection({ expectedRevision: 0, operationId: 'cut-1', events: bridge('controller-a', 1) })
    await store.commitProjection({ expectedRevision: 1, operationId: 'cut-other', events: bridge('controller-b', 1) })
    await store.commitProjection({ expectedRevision: 2, operationId: 'cut-2', events: bridge('controller-a', 2) })
    await store.commitProjection({ expectedRevision: 3, operationId: 'cut-3', events: bridge('controller-a', 3) })

    const record = table.get(store.key)!
    expect(record.revision).toBe(4)
    expect(record.batches.map(batch => batch.events[0])).toMatchObject([
      bridge('controller-a', 1)[0], bridge('controller-b', 1)[0],
      { type: 'yuqi/team-projection-compacted', ignorable: true, seq: 2, time: 2 }, bridge('controller-a', 3)[0],
    ])
    expect((record.batches[2]!.events[0] as { data: { digest: string } }).data.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(await store.commitProjection({ expectedRevision: 0, operationId: 'cut-2', events: bridge('controller-a', 2) }))
      .toEqual({ revision: 4, replayed: true })
    await expect(store.commitProjection({ expectedRevision: 4, operationId: 'cut-2', events: bridge('controller-a', 99) }))
      .rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
  })

  it('compacts a legacy bridge without bridgeRevision only after preserving its first activation cut', async () => {
    const { store } = setup()
    await store.commitProjection({ expectedRevision: 0, operationId: 'first', events: bridge('controller-a', 1) })
    const legacy = bridge('controller-a', 2)
    delete (legacy[0] as { data: { bridgeRevision?: number } }).data.bridgeRevision
    await store.commitProjection({ expectedRevision: 1, operationId: 'legacy', events: legacy })
    await store.commitProjection({ expectedRevision: 2, operationId: 'latest', events: bridge('controller-a', 3) })
    expect(store.read().events.map(event => (event as { type: string }).type)).toEqual([
      'yuqi/team-projection-bridge', 'yuqi/team-projection-compacted', 'yuqi/team-projection-bridge',
    ])
  })

  it('does not expose a partially compacted record when the atomic update fails', async () => {
    const { store, table } = setup()
    await store.commitProjection({ expectedRevision: 0, operationId: 'first', events: bridge('controller-a', 1) })
    await store.commitProjection({ expectedRevision: 1, operationId: 'middle', events: bridge('controller-a', 2) })
    const before = store.read()
    table.beforeWrite = async () => { throw new Error('durability failed') }
    await expect(store.commitProjection({ expectedRevision: 2, operationId: 'latest', events: bridge('controller-a', 3) }))
      .rejects.toThrow('durability failed')
    expect(store.read()).toEqual(before)
    table.beforeWrite = async () => {}
    await expect(store.commitProjection({ expectedRevision: 2, operationId: 'latest', events: bridge('controller-a', 3) }))
      .resolves.toEqual({ revision: 3, replayed: false })
  })

  it('compacts a near-limit historical projection before appending the next cut', async () => {
    const { store } = setup()
    // The record is just below the structural cap that previously made the
    // next full-history bridge fail before the table could accept it.
    const historical = Array.from({ length: 199_740 }, (_, index) => index % 2)
    await store.commitProjection({ expectedRevision: 0, operationId: 'first-cut', events: bridge('controller-a', 1) })
    await store.commitProjection({ expectedRevision: 1, operationId: 'large-cut', events: bridge('controller-a', 2, historical) })
    await expect(store.commitProjection({ expectedRevision: 2, operationId: 'next-cut', events: bridge('controller-a', 3) }))
      .resolves.toEqual({ revision: 3, replayed: false })
    const snapshot = store.read()
    expect(snapshot.revision).toBe(3)
    expect(snapshot.events).toHaveLength(3)
    expect(snapshot.events[0]).toMatchObject({ type: 'yuqi/team-projection-bridge', seq: 1 })
    expect(snapshot.events[1]).toMatchObject({ type: 'yuqi/team-projection-compacted', seq: 2 })
    expect(snapshot.events[2]).toMatchObject({ type: 'yuqi/team-projection-bridge', data: { bridgeRevision: 3 } })
  })

  it('ignores object key order for idempotency but preserves array order', async () => {
    const { table, store } = setup()
    await commit(store, 0, 'one', [{ a: 1, b: 2 }, [1, 2]])
    expect(await commit(store, 0, 'one', [{ b: 2, a: 1 }, [1, 2]])).toEqual({ revision: 1, replayed: true })
    await expect(commit(store, 1, 'one', [{ a: 1, b: 2 }, [2, 1]])).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' })
    expect(table.writes).toBe(1)
  })

  it('isolates sessions sharing the same table and operation IDs', async () => {
    const { table, store } = setup()
    const other = setup(table, 'other').store
    await Promise.all([commit(store, 0, 'one', [1]), commit(other, 0, 'one', [2])])
    expect(store.read().events).toEqual([1])
    expect(other.read().events).toEqual([2])
  })

  it.each([0, 2])('rejects stale/future revision %s for an existing record', async revision => {
    const { table, store } = setup()
    await commit(store)
    await expect(commit(store, revision, 'two')).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(table.writes).toBe(1)
  })

  it('rejects nonzero initial revision and empty batches without writing', async () => {
    const { table, store } = setup()
    await expect(commit(store, 1)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await expect(commit(store, 0, 'empty', [])).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(table.puts).toBe(0)
    await commit(store)
    await expect(commit(store, 1, 'empty', [])).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(table.writes).toBe(1)
  })

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid revision %s', async revision => {
    await expect(commit(setup().store, revision)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it.each(['', 'x'.repeat(limits.identityBytes)])('rejects invalid identities of length %s', async id => {
    expect(() => setup(new Table(), id)).toThrow(OwnedEventStoreError)
    await expect(commit(setup().store, 0, id)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('preserves JSON values and clones inputs, snapshots and schema results deeply', async () => {
    const { table, store } = setup()
    const events = [JSON.parse('{"__proto__":{"polluted":true},"nested":{"n":1}}') as Record<string, unknown>,
      null, true, false, 0, 0.125, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER, '中文\ud800', []]
    const original = structuredClone(events)
    const pending = commit(store, 0, 'one', events)
    ;(events[0] as Record<string, unknown>).nested = { n: 99 }
    events.push('later')
    await pending
    expect(store.read().events).toEqual(original)
    const snapshot = store.read()
    ;(snapshot.events[0] as Record<string, unknown>).nested = { n: 100 }
    snapshot.events.push('mutation')
    expect(store.read().events).toEqual(original)
    expect(Object.prototype).not.toHaveProperty('polluted')
    const parsed = ownedEventRecordSchema.parse(table.get(store.key))
    parsed.batches[0]!.events.length = 0
    expect(store.read().events).toEqual(original)
  })

  it('accepts repeated noncyclic references and null-prototype JSON objects', async () => {
    const shared = { n: 1 }
    const plain = Object.assign(Object.create(null) as Record<string, unknown>, { a: 2 })
    const { store } = setup()
    await commit(store, 0, 'one', [shared, shared, plain])
    expect(store.read().events).toEqual([{ n: 1 }, { n: 1 }, { a: 2 }])
  })

  const invalidValues: [string, () => unknown][] = [
    ['undefined', () => undefined], ['NaN', () => NaN], ['infinity', () => Infinity],
    ['negative zero', () => -0], ['unsafe integer', () => Number.MAX_SAFE_INTEGER + 1],
    ['bigint', () => 1n], ['function', () => () => {}], ['symbol', () => Symbol('s')],
    ['date', () => new Date()], ['map', () => new Map()], ['typed array', () => new Uint8Array(1)],
    ['undefined property', () => ({ a: undefined })],
    ['sparse array', () => Array(2)], ['decorated array', () => Object.assign([1], { extra: true })],
    ['symbol key', () => ({ [Symbol('s')]: 1 })],
    ['hidden key', () => Object.defineProperty({}, 'hidden', { value: 1 })],
    ['cycle', () => { const x: unknown[] = []; x.push(x); return x }],
  ]
  it.each(invalidValues)('rejects lossy JSON: %s', async (_label, make) => {
    const { table, store } = setup()
    await expect(commit(store, 0, 'one', [make()])).rejects.toMatchObject({ code: 'INVALID_JSON' })
    expect(table.puts).toBe(0)
    expect(store.read().revision).toBe(0)
  })

  it('rejects accessors/toJSON without invoking them', async () => {
    const getter = vi.fn(() => 1), toJSON = vi.fn(() => ({}))
    const accessor = Object.defineProperty({}, 'a', { get: getter, enumerable: true })
    const { store } = setup()
    await expect(commit(store, 0, 'one', [accessor])).rejects.toMatchObject({ code: 'INVALID_JSON' })
    await expect(commit(store, 0, 'one', [{ toJSON }])).rejects.toMatchObject({ code: 'INVALID_JSON' })
    expect(getter).not.toHaveBeenCalled()
    expect(toJSON).not.toHaveBeenCalled()
  })

  it('enforces event count, encoded byte and nesting limits before writes', async () => {
    const { store, table } = setup()
    await expect(commit(store, 0, 'one', Array(limits.batchEvents + 1).fill(null))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    await expect(commit(store, 0, 'one', ['中'.repeat(limits.batchBytes / 2)])).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    let nested: unknown = null
    for (let i = 0; i <= limits.depth; i++) nested = [nested]
    await expect(commit(store, 0, 'one', [nested])).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(table.writes).toBe(0)
  })

  it('rejects aggregate record size and operation count overflow', async () => {
    const { store, table } = setup()
    const current = record()
    current.batches = Array.from({ length: limits.operations }, (_, i) => ({ operationId: String(i), events: [null] }))
    current.revision = current.batches.length
    table.records.set(store.key, current)
    await expect(commit(store, current.revision, 'overflow')).rejects.toMatchObject({ code: 'INVALID_RECORD' })
    const oversized = { ...record(), batches: [{ operationId: 'one', events: ['x'.repeat(limits.recordBytes)] }] }
    expect(ownedEventRecordSchema.safeParse(oversized).success).toBe(false)
    expect(table.writes).toBe(0)
  })

  it('rejects mismatched controller identity on reads and commits', async () => {
    const { table, store } = setup()
    table.records.set(store.key, { ...record(), controllerSessionId: 'wrong' })
    expect(() => store.read()).toThrow(expect.objectContaining({ code: 'IDENTITY_MISMATCH' }))
    await expect(commit(store, 1, 'two')).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' })
    expect(table.writes).toBe(0)
  })

  it.each([
    ['schema', { ...record(), schemaVersion: 2 }],
    ['revision', { ...record(), revision: 2 }],
    ['existing zero-batch record', { ...record(), revision: 0, batches: [] }],
    ['unknown field', { ...record(), extra: 1 }],
    ['duplicate operation', { ...record(), revision: 2, batches: [record().batches[0], record().batches[0]] }],
    ['empty stored batch', { ...record(), batches: [{ operationId: 'one', events: [] }] }],
    ['malformed batches', { ...record(), batches: null }],
    ['bad JSON value', { ...record(), batches: [{ operationId: 'one', events: [undefined] }] }],
    ['JSON text rather than record', '{bad JSON'],
  ])('rejects invalid stored %s rather than silently replacing it', async (_label, value) => {
    const { table, store } = setup()
    table.records.set(store.key, value as OwnedEventRecord)
    expect(ownedEventRecordSchema.safeParse(value).success).toBe(false)
    expect(() => store.read()).toThrow(OwnedEventStoreError)
    await expect(commit(store, 1, 'two')).rejects.toBeInstanceOf(OwnedEventStoreError)
    expect(table.get(store.key)).toBe(value)
    expect(table.writes).toBe(0)
  })

  it('reconstructs from a serialized table snapshot without adapter fact caches', async () => {
    const { table, store } = setup()
    await commit(store, 0, 'one', [1, 2])
    await commit(store, 1, 'two', [3])
    // Unit serialization round trip only; this is NOT official domain cold-open.
    const serialized = JSON.stringify([...table.entries()])
    const reopened = new Table()
    for (const [key, value] of JSON.parse(serialized) as [string, unknown][]) {
      reopened.records.set(key, ownedEventRecordSchema.parse(value))
    }
    const restored = setup(reopened).store
    expect(restored.read()).toEqual({ revision: 2, events: [1, 2, 3] })
    expect(await commit(restored, 0, 'one', [1, 2])).toEqual({ revision: 2, replayed: true })
    reopened.records.set(restored.key, record())
    expect(restored.read().revision).toBe(1)
    expect(store.read().revision).toBe(2)
  })
})
