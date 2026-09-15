import { createHash } from 'node:crypto'
import { z } from 'zod'

export interface OwnedEventBatch { operationId: string; events: unknown[] }
export interface OwnedEventRecord {
  schemaVersion: 1
  controllerSessionId: string
  revision: number
  batches: OwnedEventBatch[]
}
/** Structural subset of the public storage-domain KvTable; no backend dependency. */
export interface OwnedEventTable {
  get(key: string): OwnedEventRecord | undefined
  put(key: string, value: OwnedEventRecord): Promise<void>
  update(key: string, transform: (current: OwnedEventRecord) => OwnedEventRecord): Promise<OwnedEventRecord>
  entries(): IterableIterator<[string, OwnedEventRecord]>
}
export interface OwnedEventSnapshot { revision: number; events: unknown[] }
export interface OwnedCommitResult { revision: number; replayed: boolean }
const COMPACTED_PROJECTION = 'yuqi/team-projection-compacted'

interface ProjectionBridgeEnvelope {
  readonly seq: unknown
  readonly time: unknown
  readonly data: {
    readonly controllerSessionId: string
    readonly bindingGeneration?: number
    readonly bridgeRevision?: number
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function projectionBridgeEnvelope(value: unknown): ProjectionBridgeEnvelope | undefined {
  if (!isRecord(value) || value.type !== 'yuqi/team-projection-bridge' || value.ignorable !== true
    || !isRecord(value.data) || typeof value.data.controllerSessionId !== 'string') return undefined
  const bindingGeneration = typeof value.data.bindingGeneration === 'number'
    && Number.isSafeInteger(value.data.bindingGeneration) ? value.data.bindingGeneration : undefined
  const bridgeRevision = typeof value.data.bridgeRevision === 'number'
    && Number.isSafeInteger(value.data.bridgeRevision) ? value.data.bridgeRevision : undefined
  return {
    seq: value.seq,
    time: value.time,
    data: {
      controllerSessionId: value.data.controllerSessionId,
      ...(bindingGeneration === undefined ? {} : { bindingGeneration }),
      ...(bridgeRevision === undefined ? {} : { bridgeRevision }),
    },
  }
}

/** Only obsolete, rebuildable parent cuts may lose their payload. Keep their
 * envelope/operation positions and content hash for sequence and retry safety. */
function compactSupersededProjections(record: OwnedEventRecord, incoming: readonly unknown[]): void {
  const next = incoming.length === 1 ? projectionBridgeEnvelope(incoming[0]) : undefined
  if (next === undefined) return
  let first = true
  for (const batch of record.batches) {
    const old = batch.events.length === 1 ? projectionBridgeEnvelope(batch.events[0]) : undefined
    if (old === undefined || old.data.controllerSessionId !== next.data.controllerSessionId) continue
    // The first cut preserves legacy first-seen activation ordering across
    // controllers. Newest cuts retain all binding/revision metadata.
    if (first) { first = false; continue }
    if ((old.data.bindingGeneration ?? 0) > (next.data.bindingGeneration ?? 0)
      // Old bridge envelopes predate bridgeRevision. Their position before a
      // newly committed cut proves they are superseded; only an explicit newer
      // revision may protect an otherwise rebuildable old cut.
      || (old.data.bridgeRevision !== undefined && next.data.bridgeRevision !== undefined
        && old.data.bridgeRevision >= next.data.bridgeRevision)) continue
    const digest = createHash('sha256').update(encode(batch.events)).digest('hex')
    batch.events = [{ type: COMPACTED_PROJECTION, seq: old.seq, time: old.time,
      ignorable: true, data: { digest } }]
  }
}

function matchesCompactedOperation(events: unknown[], content: string): boolean {
  const marker = events.length === 1 && isRecord(events[0]) ? events[0] : undefined
  return marker?.type === COMPACTED_PROJECTION && marker.ignorable === true
    && isRecord(marker.data) && marker.data.digest === createHash('sha256').update(content).digest('hex')
}
export type OwnedStoreErrorCode = 'INVALID_INPUT' | 'INVALID_JSON' | 'LIMIT_EXCEEDED'
  | 'INVALID_RECORD' | 'IDENTITY_MISMATCH' | 'REVISION_CONFLICT' | 'OPERATION_CONFLICT'

export class OwnedEventStoreError extends Error {
  readonly code: OwnedStoreErrorCode
  constructor(code: OwnedStoreErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'OwnedEventStoreError'
  }
}
export const OWNED_EVENT_STORE_LIMITS = Object.freeze({
  recordBytes: 16 * 1024 * 1024, batchBytes: 1024 * 1024,
  batchEvents: 1000, operations: 10_000, depth: 64, nodes: 200_000, identityBytes: 4096,
})
function fail(code: OwnedStoreErrorCode, message: string): never {
  throw new OwnedEventStoreError(code, message)
}
function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value, 'utf16le') <= OWNED_EVENT_STORE_LIMITS.identityBytes
}

/** Canonical, lossless JSON only. Reject coercions, getters, custom prototypes,
 * symbols, hidden properties, sparse arrays, cycles, -0 and unsafe integers.
 * Object key order is immaterial; array order is significant. No toJSON calls.
 * Caller-supplied proxies are outside the input contract.
 */
function encode(value: unknown): string {
  const ancestors = new Set<object>()
  let nodes = 0
  let bytes = 0
  const add = (text: string): string => {
    bytes += Buffer.byteLength(text)
    if (bytes > OWNED_EVENT_STORE_LIMITS.recordBytes) fail('LIMIT_EXCEEDED', 'JSON exceeds byte limit')
    return text
  }
  const visit = (input: unknown, depth: number): string => {
    if (++nodes > OWNED_EVENT_STORE_LIMITS.nodes || depth > OWNED_EVENT_STORE_LIMITS.depth) {
      fail('LIMIT_EXCEEDED', 'JSON exceeds structural limits')
    }
    if (input === null || typeof input === 'boolean') return add(String(input))
    if (typeof input === 'string') {
      if (input.length > OWNED_EVENT_STORE_LIMITS.recordBytes) fail('LIMIT_EXCEEDED', 'String too large')
      return add(JSON.stringify(input))
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || Object.is(input, -0)
        || (Number.isInteger(input) && !Number.isSafeInteger(input))) fail('INVALID_JSON', 'Non-lossless JSON number')
      return add(JSON.stringify(input))
    }
    if (typeof input !== 'object') fail('INVALID_JSON', 'Value is not JSON')
    if (ancestors.has(input)) fail('INVALID_JSON', 'Cyclic JSON')
    const array = Array.isArray(input)
    const prototype: unknown = Object.getPrototypeOf(input)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      fail('INVALID_JSON', 'Non-plain JSON container')
    }
    ancestors.add(input)
    const keys = Reflect.ownKeys(input)
    if (keys.length > OWNED_EVENT_STORE_LIMITS.nodes) fail('LIMIT_EXCEEDED', 'Too many properties')
    if (keys.some(key => typeof key !== 'string')) fail('INVALID_JSON', 'Symbol property')
    const items: string[] = []
    if (array) {
      if (input.length > OWNED_EVENT_STORE_LIMITS.nodes) fail('LIMIT_EXCEEDED', 'Array too large')
      if (keys.length !== input.length + 1) fail('INVALID_JSON', 'Sparse or decorated array')
      for (let i = 0; i < input.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(i))
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('INVALID_JSON', 'Invalid array property')
        if (i) add(',')
        items.push(visit(descriptor.value, depth + 1))
      }
    } else {
      for (const key of (keys as string[]).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!
        if (!('value' in descriptor) || !descriptor.enumerable) fail('INVALID_JSON', 'Accessor or hidden property')
        if (items.length) add(',')
        items.push(add(JSON.stringify(key)) + add(':') + visit(descriptor.value, depth + 1))
      }
    }
    ancestors.delete(input)
    return add(array ? '[' : '{') + items.join(',') + add(array ? ']' : '}')
  }
  return visit(value, 0)
}

function validateRecord(value: unknown): OwnedEventRecord {
  // Validate BEFORE schema parsing / cloning could strip or coerce properties.
  const serialized = encode(value)
  const record = JSON.parse(serialized) as OwnedEventRecord
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || Object.keys(record).sort().join(',') !== 'batches,controllerSessionId,revision,schemaVersion'
    || record.schemaVersion !== 1 || !validIdentity(record.controllerSessionId)
    || !Array.isArray(record.batches) || record.batches.length === 0 || record.batches.length > OWNED_EVENT_STORE_LIMITS.operations
    || !Number.isSafeInteger(record.revision) || record.revision !== record.batches.length) {
    fail('INVALID_RECORD', 'Invalid owned event record')
  }
  const ids = new Set<string>()
  for (const batch of record.batches) {
    if (!batch || typeof batch !== 'object' || Array.isArray(batch)
      || Object.keys(batch).sort().join(',') !== 'events,operationId'
      || !validIdentity(batch.operationId) || ids.has(batch.operationId)
      || !Array.isArray(batch.events) || batch.events.length === 0
      || batch.events.length > OWNED_EVENT_STORE_LIMITS.batchEvents) fail('INVALID_RECORD', 'Invalid stored batch')
    if (Buffer.byteLength(encode(batch.events)) > OWNED_EVENT_STORE_LIMITS.batchBytes) fail('LIMIT_EXCEEDED', 'Stored batch too large')
    ids.add(batch.operationId)
  }
  return record
}

/** Suitable for domainTable(ownedEventRecordSchema), including durable-open validation. */
export const ownedEventRecordSchema = z.unknown().transform((value, ctx): OwnedEventRecord => {
  try { return validateRecord(value) }
  catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid owned event record' })
    return z.NEVER
  }
})

/** Declarative DomainSpec, passed by the owner to defineDomain/open.
 * Use the authoritative `single` layout: no disposable-record skip or migration.
 * This module neither opens a domain nor mounts/enables a production consumer.
 */
export const ownedEventDomainSpec = {
  name: 'yuqi_team_owned_events',
  version: 1,
  layout: 'single' as const,
  tables: { sessions: { valueSchema: ownedEventRecordSchema } },
}

// Coordination only, NEVER cached records. Official table handles are stable.
// All adapters for a table must share that exact object and own its writes;
// external put/delete and distinct wrappers defeat this initialization gate.
const tableGates = new WeakMap<OwnedEventTable, Promise<void>>()
async function withTableGate<T>(table: OwnedEventTable, job: () => Promise<T>): Promise<T> {
  const previous = tableGates.get(table) ?? Promise.resolve()
  const result = previous.then(job)
  const tail = result.then(() => {}, () => {})
  tableGates.set(table, tail)
  try { return await result }
  finally { if (tableGates.get(table) === tail) tableGates.delete(table) }
}

/** Plugin-owned journal data over the official Domain table, NOT Session events.
 * Durability/write serialization belong to the injected official table.
 * Single-process contract only. No filesystem backend, locks or fact cache.
 * read() clones domain memory; a cold read requires the owner to close/reopen
 * the domain and inject its new table. Merely creating an adapter is not cold IO.
 */
export class OwnedEventStore {
  readonly controllerSessionId: string
  readonly key: string
  private readonly table: OwnedEventTable

  constructor(options: { table: OwnedEventTable; controllerSessionId: string }) {
    if (!validIdentity(options.controllerSessionId)) fail('INVALID_INPUT', 'Invalid controllerSessionId')
    this.table = options.table
    this.controllerSessionId = options.controllerSessionId
    // UTF-16 avoids collisions from UTF-8 replacement of distinct lone surrogates.
    this.key = createHash('sha256').update(this.controllerSessionId, 'utf16le').digest('hex')
  }

  read(): OwnedEventSnapshot {
    const current = this.table.get(this.key)
    if (current === undefined) return { revision: 0, events: [] }
    const record = this.checked(current)
    return { revision: record.revision, events: record.batches.flatMap(batch => batch.events) }
  }

  /** One nonempty batch increments revision once. An identical operation retry
   * returns CURRENT revision, ignoring stale expectedRevision. Different content
   * rejects. No caller data is retained; no table-owned value is mutated.
   */
  async commit(input: { expectedRevision: number; operationId: string; events: readonly unknown[] }): Promise<OwnedCommitResult> {
    return this.commitBatch(input, false)
  }

  /** Atomically append a derived cut and compact only its superseded copies.
   * Never called for controller facts, bindings, checkpoints or tombstones. */
  async commitProjection(input: { expectedRevision: number; operationId: string; events: readonly unknown[] }): Promise<OwnedCommitResult> {
    return this.commitBatch(input, true)
  }

  private async commitBatch(input: { expectedRevision: number; operationId: string; events: readonly unknown[] }, compactProjection: boolean): Promise<OwnedCommitResult> {
    const { expectedRevision, operationId } = input
    if (!validIdentity(operationId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      fail('INVALID_INPUT', 'Invalid operationId or expectedRevision')
    }
    if (!Array.isArray(input.events) || input.events.length === 0) fail('INVALID_INPUT', 'A nonempty batch is required')
    if (input.events.length > OWNED_EVENT_STORE_LIMITS.batchEvents) fail('LIMIT_EXCEEDED', 'Too many batch events')
    const content = encode(input.events)
    if (Buffer.byteLength(content) > OWNED_EVENT_STORE_LIMITS.batchBytes) fail('LIMIT_EXCEEDED', 'Batch too large')
    const events = JSON.parse(content) as unknown[]
    return withTableGate(this.table, async () => {
      // update rejects missing-key, so publish the FIRST complete batch via put.
      // Never expose a separate persisted empty initialization record.
      if (this.table.get(this.key) === undefined) {
        if (expectedRevision !== 0) fail('REVISION_CONFLICT', 'Expected revision does not match absent record')
        const first = validateRecord({ schemaVersion: 1, controllerSessionId: this.controllerSessionId,
          revision: 1, batches: [{ operationId, events }] })
        await this.table.put(this.key, first)
        return { revision: 1, replayed: false }
      }
      // Private sentinel stops official update before writing/emitting on a retry.
      const retry = Symbol('identical-operation')
      let replayRevision = 0
      try {
        const next = await this.table.update(this.key, current => {
          const record = this.checked(current)
          const previous = record.batches.find(batch => batch.operationId === operationId)
          if (previous) {
            if (encode(previous.events) !== content && !matchesCompactedOperation(previous.events, content)) fail('OPERATION_CONFLICT', 'operationId already has different content')
            replayRevision = record.revision
            throw retry
          }
          if (record.revision !== expectedRevision) fail('REVISION_CONFLICT', 'Expected revision does not match current record')
          if (compactProjection) compactSupersededProjections(record, events)
          record.batches.push({ operationId, events })
          record.revision++
          return validateRecord(record)
        })
        return { revision: next.revision, replayed: false }
      } catch (error) {
        if (error === retry) return { revision: replayRevision, replayed: true }
        throw error
      }
    })
  }

  private checked(value: unknown): OwnedEventRecord {
    const record = validateRecord(value)
    if (record.controllerSessionId !== this.controllerSessionId) fail('IDENTITY_MISMATCH', 'Controller session identity mismatch')
    return record
  }
}
