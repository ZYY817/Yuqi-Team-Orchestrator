import { randomUUID } from 'node:crypto'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { OwnedEventStore, type OwnedEventTable } from './owned-event-store.ts'

const bindings = new WeakMap<object, { repository: SidecarRepository; store: OwnedEventStore }>()
// Share coordination across repositories and distinct live objects for the same ID.
const queues = new WeakMap<OwnedEventTable, Map<string, Promise<void>>>()

function binding(session: unknown) {
  if (typeof session !== 'object' || session === null) return undefined
  const found = bindings.get(session)
  if (found?.repository.disposed) throw new Error('Sidecar repository is disposed')
  return found
}

function assertNoLegacy(session: Session): void {
  // Deliberately read the native surface: readSessionEvents may route to us.
  const snapshot: unknown = Reflect.get(session, 'snapshotEvents')
  const events: unknown = typeof snapshot === 'function'
    ? Reflect.apply(snapshot, session, []) : Reflect.get(session, 'events')
  if (!Array.isArray(events)) throw new TypeError('Session must expose snapshotEvents() or events')
  if (events.some(event => typeof event?.type === 'string' && event.type.startsWith('yuqi/'))) {
    throw new Error('Cannot bind sidecar: Session contains legacy yuqi/ facts; migration is not supported')
  }
}

function read(store: OwnedEventStore): { revision: number; events: SessionEvent[] } {
  const snapshot = store.read()
  if (snapshot.events.length !== snapshot.revision) throw new Error('Invalid sidecar revision/envelope count')
  for (const [index, value] of snapshot.events.entries()) {
    const event = value as Partial<SessionEvent> | null
    if (!event || typeof event !== 'object' || Array.isArray(event)
      || typeof event.type !== 'string' || !event.type.startsWith('yuqi/')
      || event.ignorable !== true || event.seq !== index + 1
      || typeof event.time !== 'number' || !Number.isFinite(event.time)
      || !Object.hasOwn(event, 'data')) throw new Error('Invalid sidecar SessionEvent envelope')
  }
  return { revision: snapshot.revision, events: snapshot.events as SessionEvent[] }
}

/** Owns annotations for all Session roles in one official domain table.
 * The caller owns the domain lifecycle; dispose poisons bindings, never closes it.
 * Disposed bindings throw rather than allowing native-log fallback. An explicit
 * bind to a new repository can restore access after validating persisted facts.
 * Already running commits drain; queued appends reject after disposal.
 */
export class SidecarRepository {
  #disposed = false
  private readonly table: OwnedEventTable
  private readonly beforeAppend: ((session: Session) => Promise<void>) | undefined

  constructor(table: OwnedEventTable, options?: { beforeAppend?: (session: Session) => Promise<void> }) {
    this.table = table
    this.beforeAppend = options?.beforeAppend
  }

  get disposed(): boolean { return this.#disposed }

  bind(session: Session): void {
    this.assertActive()
    assertNoLegacy(session)
    const existing = bindings.get(session)
    const previous = existing?.repository.disposed ? undefined : existing
    if (previous && previous.repository !== this) throw new Error('Session is already bound to another sidecar repository')
    if (previous) return
    const store = new OwnedEventStore({ table: this.table, controllerSessionId: session.id })
    read(store) // Reject invalid persisted facts before changing the read source.
    bindings.set(session, { repository: this, store })
  }

  listSessionIds(): string[] {
    this.assertActive()
    return [...this.table.entries()].map(([key, record]) => {
      const store = new OwnedEventStore({ table: this.table, controllerSessionId: record.controllerSessionId })
      if (store.key !== key) throw new Error('Invalid sidecar session key')
      return record.controllerSessionId
    })
  }

  /** Read validated, detached sidecar facts without creating/binding a Session. */
  readStoredEvents(sessionId: string): readonly SessionEvent[] {
    this.assertActive()
    return read(new OwnedEventStore({ table: this.table, controllerSessionId: sessionId })).events
  }

  dispose(): void { this.#disposed = true }

  private assertActive(): void {
    if (this.#disposed) throw new Error('Sidecar repository is disposed')
  }

  /** Internal entry used by the module-level Session API. */
  async append(session: Session, store: OwnedEventStore, type: string, data: unknown): Promise<SessionEvent> {
    this.assertActive()
    if (typeof type !== 'string' || !type.startsWith('yuqi/')) throw new TypeError('Only yuqi/ events are allowed in sidecar')
    let tableQueue = queues.get(this.table)
    if (!tableQueue) { tableQueue = new Map(); queues.set(this.table, tableQueue) }
    const queue = tableQueue
    const result = (queue.get(store.key) ?? Promise.resolve()).then(async () => {
      this.assertActive()
      assertNoLegacy(session)
      // The owner may persist the native header here. Keep this prerequisite
      // inside the session queue and allocate the revision only after it succeeds.
      if (this.beforeAppend) {
        await this.beforeAppend(session)
        this.assertActive()
        assertNoLegacy(session)
      }
      const { revision } = read(store)
      const event = { type, data, seq: revision + 1, time: Date.now(), ignorable: true } as SessionEvent
      const input = { expectedRevision: revision, operationId: randomUUID(), events: [event] }
      if (type === 'yuqi/team-projection-bridge') await store.commitProjection(input)
      else await store.commit(input)
      // Return the committed clone, never caller-owned data or an optimistic fact.
      return read(store).events[revision]!
    })
    const tail = result.then(() => {}, () => {})
    queue.set(store.key, tail)
    try { return await result }
    finally { if (queue.get(store.key) === tail) queue.delete(store.key) }
  }
}

export function readSidecarEvents(session: unknown): readonly SessionEvent[] | undefined {
  const found = binding(session)
  return found ? read(found.store).events : undefined
}

export function hasSidecarSession(session: unknown): boolean {
  return binding(session) !== undefined
}

export async function appendSidecarEvent(session: Session, type: string, data: unknown): Promise<SessionEvent> {
  const found = binding(session)
  if (!found) throw new Error('Session is not bound to an active sidecar repository')
  return found.repository.append(session, found.store, type, data)
}
